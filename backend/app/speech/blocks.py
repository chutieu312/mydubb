"""Several timeline blocks per speech request, separated by inserted breaks (timed mode).

The REST endpoint returns audio only (word and bookmark offsets need the Speech SDK), so the place
where one block ends inside a response is found from the audio: consecutive blocks are separated
by `<break time="BREAK_MS ms"/>`, and the response is cut inside those silences. A response is
used only when every check below holds; if any check fails, the job fails (`BlockSplitError`),
without retry or fallback. Passing the checks does not prove the mapping is right (see the known
limits below): timed mode gives an estimated, group-level synchronization, not an exact one.

1. **Separation margin.** A silent run (10 ms windows whose every sample is at most
   `SILENCE_PEAK`, about -50 dBFS) inside the audio is a break only if it lasts between
   `MIN_BREAK_SILENCE_MS` and `MAX_BREAK_SILENCE_MS` (a band around what Azure was measured to
   render for a 3 s break: 3,380-3,830 ms in 46 breaks of both voices); a natural pause must be
   shorter than `MAX_NATURAL_SILENCE_MS` (measured at most 820 ms). Any other run is ambiguous and
   fails the request.
2. **Count.** Exactly one break per block boundary in the request.
3. **Silence only is removed.** A block's clip keeps `TAIL_MS` after its last sound and `LEAD_MS`
   before its first one (inside the break); the rest of each inserted break, and the silence
   after the last block, is dropped. The clips and the dropped stretches put back together equal
   the response sample for sample, and every dropped sample is at most `SILENCE_PEAK` (checked),
   so no audible sample is removed or repeated.
4. **Each clip has speech, at a consistent rate.** Every clip must contain sound, and a clip of
   at least `MIN_SYLLABLES_FOR_RATE` estimated syllables (`spoken_length.py`) must be spoken at
   0.5-2x the syllables per second of the whole request: a cut in the wrong pause would move
   speech into the neighbouring clip and break this for both, when the moved part is large enough.
5. **Cuts where the speech predicts them.** Walking through the clips, the time actually spoken so
   far is compared at every break with the time the syllable estimate predicts for the text so
   far. Speech moved across a cut shifts this difference until it is moved back, so it must stay
   within `max(MAX_CUMULATIVE_SECONDS, MAX_CUMULATIVE_FRACTION x the request's speech)` (measured
   on live responses: at most 2.4 s, 4.8%, mostly an English term read shorter than estimated).

These are consistency checks on the audio, not a transcript of it: they cannot hear words, so
passing them is strong evidence, not proof, that each clip holds its block. What they guarantee
by construction is check 3: every audible sample of the response is in exactly one clip, in
order. A wrong mapping can therefore misplace speech on the timeline, never drop or repeat it.

Known limits. Checks 4 and 5 estimate syllables, so a block of very unusual tokens can be estimated
far from its real reading. Blocks under `MIN_SYLLABLES_FOR_RATE` syllables are not rate-checked
(they still need their sound and their break). A wrong mapping can pass only if two faults
coincide: Azure leaves out an inserted break AND a natural pause lasts as long as a break
(2.9-4.3 s; never observed, natural pauses measured at most 820 ms), AND the speech moved stays
within the tolerance of checks 4 and 5. That speech then lands in another block's frame; the
content stays complete and in order. In the cases tested, what passed was a few words between two
neighbouring blocks; that is an observation, not a bound (in a long request the cumulative limit
is 10% of its speech, so a larger shift can pass there). Tests: `test_speech_blocks.py`, "missing
break replaced by a natural pause".
"""

import array
import sys
import wave
from collections.abc import Sequence
from dataclasses import dataclass, field
from itertools import pairwise
from pathlib import Path

from app.audio.wav import WavInfo, read_wav_info
from app.speech.chunker import speech_text, split_for_speech
from app.speech.spoken_length import spoken_syllables
from app.speech.ssml import ROOT_LANGUAGE, chunk_language_spans, escape_text
from app.speech.voices import Voice
from app.translation.glossary import TermMatcher

BREAK_MS = 3000
MIN_BREAK_SILENCE_MS = 2900
MAX_BREAK_SILENCE_MS = 4300
MAX_NATURAL_SILENCE_MS = 1200
# Azure does not render a break as digital silence: it holds low-level noise with peaks up to
# about 100 (measured: 33-99 inside 3 s breaks of both voices), which splits a break into pieces
# at the stricter TRIMMABLE_PEAK. 100/32768 is about -50 dBFS, far below speech.
SILENCE_PEAK = 100
# Silence kept around a block's sound: before its first and after its last sound.
LEAD_MS = 100
TAIL_MS = 100
WINDOW_MS = 10
# Bounds the inserted silence per request: 40 breaks are 2 minutes of the 10 minutes a request
# may return.
MAX_BLOCKS_PER_REQUEST = 40
MIN_SYLLABLES_FOR_RATE = 6
RATE_TOLERANCE = 2.0
MAX_CUMULATIVE_SECONDS = 3.0
MAX_CUMULATIVE_FRACTION = 0.10


class BlockSplitError(Exception):
    """A check failed, so the response is not cut into blocks (passing them is no proof)."""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


@dataclass(frozen=True)
class BlockPiece:
    block: int  # index of the block this text belongs to
    spans: list[tuple[str, str]]  # (language, text), as ssml.language_spans

    @property
    def text(self) -> str:
        return "".join(piece for _, piece in self.spans)


@dataclass
class BlockRequest:
    pieces: list[BlockPiece] = field(default_factory=list)

    @property
    def chars(self) -> int:
        return sum(len(piece.text) for piece in self.pieces)

    def ssml(self, voice: Voice) -> str:
        pause = f'<break time="{BREAK_MS}ms"/>'
        body = pause.join(
            "".join(
                f'<lang xml:lang="{language}">{escape_text(text)}</lang>'
                for language, text in piece.spans
            )
            for piece in self.pieces
        )
        return (
            f'<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" '
            f'xml:lang="{ROOT_LANGUAGE}"><voice name="{voice.azure_voice_name}">{body}</voice>'
            "</speak>"
        )


@dataclass(frozen=True)
class SplitReport:
    """Measured on one response (milliseconds), for logs and the benchmark."""

    breaks_ms: list[int]  # each inserted break as found
    longest_natural_ms: int  # longest other silent run inside the audio (0 if none)
    leading_ms: int
    trailing_ms: int


def plan_block_requests(
    texts: Sequence[str], terms: TermMatcher, max_chars: int
) -> list[BlockRequest]:
    """Requests in order; blocks without anything to say (no letter or digit) are left out.

    A block longer than `max_chars` is split like any speech text and continues in the next
    request; its clip is then joined from both. Pieces in one request always belong to different
    blocks, so every break separates two blocks.
    """
    requests: list[BlockRequest] = []
    current = BlockRequest()
    for index, raw in enumerate(texts):
        text = speech_text(raw).replace("\n", " ")
        if not any(char.isalnum() for char in text):
            continue
        pieces = split_for_speech(text, terms, max_chars)
        for spans in chunk_language_spans(text, pieces, terms):
            piece = BlockPiece(index, spans)
            if current.pieces and (
                current.chars + len(piece.text) > max_chars
                or len(current.pieces) >= MAX_BLOCKS_PER_REQUEST
                or current.pieces[-1].block == index
            ):
                requests.append(current)
                current = BlockRequest()
            current.pieces.append(piece)
    if current.pieces:
        requests.append(current)
    return requests


def split_response(
    path: Path, request: BlockRequest, scratch: Path, name: str
) -> tuple[list[Path], SplitReport]:
    """One clip per piece of `request`, cut inside the inserted breaks (see module doc)."""
    info = read_wav_info(path)
    samples = _samples(path, info)
    rate = info.format.sample_rate
    window = rate * WINDOW_MS // 1000
    silent = [_quiet(samples[start : start + window]) for start in range(0, len(samples), window)]
    runs = _runs(silent)
    leading = runs[0][1] if runs and runs[0][0] == 0 else 0
    trailing = runs[-1][1] - runs[-1][0] if runs and runs[-1][1] == len(silent) else 0
    interior = [(a, b) for a, b in runs if a > 0 and b < len(silent)]
    to_ms = WINDOW_MS
    breaks = [
        (a, b)
        for a, b in interior
        if MIN_BREAK_SILENCE_MS <= (b - a) * to_ms <= MAX_BREAK_SILENCE_MS
    ]
    natural = [(b - a) * to_ms for a, b in interior if (b - a) * to_ms < MIN_BREAK_SILENCE_MS]
    too_long = [a for a, b in interior if (b - a) * to_ms > MAX_BREAK_SILENCE_MS]
    report = SplitReport(
        breaks_ms=[(b - a) * to_ms for a, b in breaks],
        longest_natural_ms=max(natural, default=0),
        leading_ms=leading * to_ms,
        trailing_ms=trailing * to_ms,
    )
    if too_long or any(length >= MAX_NATURAL_SILENCE_MS for length in natural):
        raise BlockSplitError("ambiguous_silence")
    if len(breaks) != len(request.pieces) - 1:
        raise BlockSplitError("break_count")

    lead, tail = LEAD_MS // WINDOW_MS * window, TAIL_MS // WINDOW_MS * window
    # [start, end) of each clip in samples; what lies between two clips is dropped silence.
    spans = []
    start = 0
    for run_start, run_end in breaks:
        first, last = run_start * window, run_end * window
        spans.append((start, min(first + tail, last - lead)))
        start = max(last - lead, first + tail)
    end = len(samples)
    if trailing:
        end = min(len(samples), (len(silent) - trailing) * window + tail)
    spans.append((start, end))
    clips = []
    for number, (clip_start, clip_end) in enumerate(spans):
        clip = samples[clip_start:clip_end]
        if all(_quiet(clip[i : i + window]) for i in range(0, len(clip), window)):
            raise BlockSplitError("clip_without_sound")
        target = scratch / f"{name}-{number:03d}.wav"
        _write(target, clip, info)
        clips.append(target)
    # Put back together: clips (read back from disk) and the dropped stretches between them.
    rebuilt = array.array("h")
    edges = [*spans, (len(samples), len(samples))]
    for clip, ((_, clip_end), (next_start, _)) in zip(clips, pairwise(edges), strict=False):
        rebuilt.extend(_samples(clip, read_wav_info(clip)))
        dropped = samples[clip_end:next_start]
        if dropped and max(max(dropped), -min(dropped)) > SILENCE_PEAK:
            raise BlockSplitError("dropped_sound")
        rebuilt.extend(dropped)
    if rebuilt != samples:
        raise BlockSplitError("clips_do_not_rejoin")
    _check_rates(request, clips, rate, window)
    return clips, report


def speech_seconds(path: Path) -> float:
    """From the first to the last sounding window of a clip (its silent edges excluded)."""
    info = read_wav_info(path)
    samples = _samples(path, info)
    window = info.format.sample_rate * WINDOW_MS // 1000
    loud = [
        index
        for index, start in enumerate(range(0, len(samples), window))
        if not _quiet(samples[start : start + window])
    ]
    return (loud[-1] - loud[0] + 1) * WINDOW_MS / 1000 if loud else 0.0


def _check_rates(request: BlockRequest, clips: list[Path], rate: int, window: int) -> None:
    durations = [speech_seconds(clip) for clip in clips]
    syllables = [spoken_syllables(piece.text) for piece in request.pieces]
    overall = sum(syllables) / sum(durations)
    for count, seconds in zip(syllables, durations, strict=True):
        if count < MIN_SYLLABLES_FOR_RATE:
            continue
        ratio = (count / seconds) / overall
        if not 1 / RATE_TOLERANCE <= ratio <= RATE_TOLERANCE:
            raise BlockSplitError("inconsistent_rate")
    total = sum(durations)
    limit = max(MAX_CUMULATIVE_SECONDS, MAX_CUMULATIVE_FRACTION * total)
    difference = 0.0
    for count, seconds in zip(syllables[:-1], durations[:-1], strict=True):
        difference += seconds - count / overall
        if abs(difference) > limit:
            raise BlockSplitError("inconsistent_timing")


def _quiet(window: "array.array") -> bool:
    return not window or max(max(window), -min(window)) <= SILENCE_PEAK


def _runs(flags: list[bool]) -> list[tuple[int, int]]:
    """[start, end) of every run of True."""
    runs, start = [], None
    for index, flag in enumerate(flags):
        if flag and start is None:
            start = index
        elif not flag and start is not None:
            runs.append((start, index))
            start = None
    if start is not None:
        runs.append((start, len(flags)))
    return runs


def _samples(path: Path, info: WavInfo) -> "array.array":
    if info.format.sample_width != 2 or info.format.channels != 1:
        raise BlockSplitError("unsupported_format")
    with path.open("rb") as handle:
        handle.seek(info.data_offset)
        data = handle.read(info.data_bytes)
    samples = array.array("h")
    samples.frombytes(data)
    if sys.byteorder == "big":
        samples.byteswap()
    return samples


def _write(path: Path, samples: "array.array", info: WavInfo) -> None:
    data = array.array("h", samples)
    if sys.byteorder == "big":
        data.byteswap()
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(info.format.sample_rate)
        handle.writeframes(data.tobytes())
