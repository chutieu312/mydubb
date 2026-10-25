"""Timed dubbing benchmark: parse cost, Speech request count/wait, and FFmpeg processing.

Run from `backend/`. No credentials and no network: Azure is never called.

    uv run python -m scripts.timed_benchmark --words 1000
        (a) parse + sentence units + blocks + timeline of a synthetic YouTube-style transcript;
        (b) Speech requests and the time the shared F0 rate limiter (20 requests per 60 s) makes
            a job wait, for several block groupings, simulated with the real `RequestRateLimiter`
            on a virtual clock (the per-request latency is an assumption: it was not measured);

    uv run python -m scripts.timed_benchmark --words 1000 --audio
        (c) also places synthetic speech clips (tones and pauses, one per block, about half of
            them longer than their frame) on the timeline with the real FFmpeg, encodes the MP3
            and verifies it; prints wall time and FFmpeg starts. ffmpeg/ffprobe must be on PATH.

The synthetic transcript: sentences of 6-24 words, captions of 5-9 words, 150 words per minute,
whole-second timestamps (so some captions share a timestamp), as YouTube shows them.
"""

import argparse
import array
import math
import random
import statistics
import sys
import tempfile
import time
import wave
from collections import Counter
from pathlib import Path

from app.audio import ffmpeg as ffmpeg_module
from app.audio import timeline as timeline_module
from app.audio.ffmpeg import locate_tools
from app.audio.fitter import FfmpegAudioProcessor
from app.audio.speed import AudioSpeed
from app.speech.base import TimedSpeechAudio
from app.speech.chunker import split_for_speech
from app.speech.rate_limit import RequestRateLimiter
from app.transcript.cleaning import clean_transcript
from app.transcript.timed import parse_timed_transcript
from app.translation.glossary import default_glossary

RATE = 24000
WORDS_PER_MINUTE = 150
# Vietnamese translations of English run longer in characters; used only to estimate how many
# plain-mode speech chunks the translation would need (assumption, not a measurement).
VIETNAMESE_CHAR_RATIO = 1.25
F0_REQUESTS, F0_WINDOW = 20, 60.0
VOCABULARY = (  # noqa: SIM905
    "the a we can make build ship test data model system network code service request cloud "
    "user value people think really very just like company work hard idea time team product "
    "problem solve learn deploy server database query function memory thread process engine "
    "rocket launch orbit failure chance success design simple complex scale fast slow"
).split()


def synthetic_transcript(words: int, seed: int) -> str:
    rng = random.Random(seed)  # noqa: S311 (synthetic data, not security)
    stream: list[str] = []
    while len(stream) < words:
        length = rng.randint(6, 24)
        sentence = [rng.choice(VOCABULARY) for _ in range(length)]
        sentence[0] = sentence[0].capitalize()
        if length > 12 and rng.random() < 0.5:
            sentence[length // 2] += ","
        sentence[-1] += "?" if rng.random() < 0.1 else "."
        stream.extend(sentence)
    lines, position, clock = [], 0, 0.0
    while position < len(stream):
        size = rng.randint(5, 9)
        caption = stream[position : position + size]
        seconds = int(clock)
        stamp = f"{seconds // 60}:{seconds % 60:02d}"
        if seconds >= 3600:
            stamp = f"{seconds // 3600}:{seconds % 3600 // 60:02d}:{seconds % 60:02d}"
        lines += [stamp, " ".join(caption)]
        clock += len(caption) * 60 / WORDS_PER_MINUTE * rng.uniform(0.85, 1.15)
        position += size
    return "\n".join(lines)


def part_a(raw: str, groupings: list[int]) -> None:
    print("(a) parse, sentence units, blocks, timeline (median of 20 runs)")
    for grouping in groupings:
        runs = []
        for _ in range(20):
            started = time.perf_counter()
            timed = parse_timed_transcript(raw, min_block_seconds=grouping)
            timed.boundaries(timed.source_baseline, AudioSpeed.X1_25, RATE)
            runs.append(time.perf_counter() - started)
        print(
            f"    min_block_seconds={grouping:>2}: captions={len(timed.captions)} "
            f"blocks={len(timed.blocks)} median={statistics.median(runs) * 1000:.2f} ms"
        )


def simulated_speech_seconds(requests: int, latency: float, jobs: int) -> float:
    """When the last of `jobs` identical jobs finishes, sharing the process-wide limiter."""
    now = [0.0]

    def wait(seconds: float) -> bool:
        now[0] += seconds
        return False

    limiter = RequestRateLimiter(F0_REQUESTS, F0_WINDOW, clock=lambda: now[0], wait=wait)
    # Jobs run in parallel worker threads, each sending its requests one after another; all of
    # them go through the one limiter. Event simulation: the job that is ready first goes next.
    ready, left, finish = [0.0] * jobs, [requests] * jobs, 0.0
    while any(left):
        job = min((j for j in range(jobs) if left[j]), key=lambda j: ready[j])
        now[0] = max(now[0], ready[job])
        limiter.acquire()
        ready[job] = now[0] + latency
        left[job] -= 1
        finish = max(finish, ready[job])
    return finish


def part_b(raw: str, groupings: list[int], latencies: list[float]) -> None:
    print("(b) Speech requests and F0 rate-limit wait (simulated clock, assumed latency)")
    cleaned = clean_transcript(raw)
    vietnamese_chunk = int(2000 / VIETNAMESE_CHAR_RATIO)
    plain = len(split_for_speech(cleaned.replace("\n", " "), default_glossary(), vietnamese_chunk))
    rows = [("plain mode today (2000-char chunks)", plain)]
    rows.append(("timed, several blocks per request + split (option C)", plain))
    for grouping in groupings:
        blocks = len(parse_timed_transcript(raw, min_block_seconds=grouping).blocks)
        label = "one request per sentence block" if grouping == 0 else f"blocks >= {grouping} s"
        rows.append((f"timed, {label}", blocks))
    header = "    " + f"{'strategy':<56}{'requests':>9}"
    for latency in latencies:
        header += f"  {f'1 job @{latency:g}s':>12}  {f'2 jobs @{latency:g}s':>12}"
    print(header)
    for label, requests in rows:
        line = f"    {label:<56}{requests:>9}"
        for latency in latencies:
            alone = simulated_speech_seconds(requests, latency, 1)
            shared = simulated_speech_seconds(requests, latency, 2)
            line += f"  {alone:>11.0f}s  {shared:>11.0f}s"
        print(line)


def _clip(path: Path, seconds: float, rng: random.Random) -> None:
    """Speech stand-in: 50 ms silence, tone 'words' with short pauses, 300 ms silent tail."""
    samples = array.array("h", bytes(int(0.05 * RATE) * 2))
    remaining = seconds - 0.35
    while remaining > 0:
        word = min(remaining, rng.uniform(0.2, 0.45))
        frequency = rng.choice((220, 330, 440, 550))
        count = int(word * RATE)
        samples.extend(
            int(9000 * math.sin(2 * math.pi * frequency * n / RATE)) for n in range(count)
        )
        gap = int(min(max(remaining - word, 0), 0.08) * RATE)
        samples.extend(array.array("h", bytes(gap * 2)))
        remaining -= word + gap / RATE
    samples.extend(array.array("h", bytes(int(0.3 * RATE) * 2)))
    if sys.byteorder == "big":
        samples.byteswap()
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(RATE)
        handle.writeframes(samples.tobytes())


def part_c(raw: str, groupings: list[int], speeds: list[AudioSpeed], seed: int) -> int:
    tools = locate_tools()
    if tools is None:
        print("(c) skipped: ffmpeg/ffprobe not on PATH")
        return 1
    print("(c) FFmpeg: clips placed on the timeline, MP3 encoded once and verified")
    starts: Counter[str] = Counter()
    seconds: Counter[str] = Counter()
    original = ffmpeg_module.run_tool

    def counted(args, **kwargs):
        name = Path(args[0]).stem
        if name == "ffmpeg":
            if "-filter_complex" in args:
                name = "ffmpeg tempo"
            elif "libmp3lame" in args:
                name = "ffmpeg encode"
            else:
                name = "ffmpeg decode"
        started = time.perf_counter()
        try:
            return original(args, **kwargs)
        finally:
            starts[name] += 1
            seconds[name] += time.perf_counter() - started

    ffmpeg_module.run_tool = counted
    failures = 0
    try:
        for grouping in groupings:
            timed = parse_timed_transcript(raw, min_block_seconds=grouping)
            for speed in speeds:
                for per_process in (timeline_module.MAX_CLIPS_PER_PROCESS, 1):
                    timeline_module.MAX_CLIPS_PER_PROCESS = per_process
                    failures += _run_case(tools, timed, speed, seed, starts, seconds, per_process)
                timeline_module.MAX_CLIPS_PER_PROCESS = 64
    finally:
        ffmpeg_module.run_tool = original
    return 1 if failures else 0


def _run_case(tools, timed, speed, seed, starts, seconds, per_process) -> int:
    rng = random.Random(seed)  # noqa: S311 (synthetic data, not security)
    plan = timed.plan(timed.source_baseline, speed)
    boundaries = plan.boundaries(RATE)
    with tempfile.TemporaryDirectory(prefix="timed-bench-") as name:
        work = Path(name)
        clips = []
        for index in range(len(timed.blocks)):
            frame = (boundaries[index + 1] - boundaries[index]) / RATE
            path = work / f"clip-{index:05d}.wav"
            # About half of the clips are longer than their frame (up to 1.4x), half shorter.
            _clip(path, max(0.6, frame * rng.uniform(0.75, 1.4)), rng)
            clips.append(path)
        starts.clear()
        seconds.clear()
        processor = FfmpegAudioProcessor(tools)
        started = time.perf_counter()
        processed = processor.fit_timeline(
            TimedSpeechAudio(tuple(clips), is_fixture=False, requests=len(clips)), plan, work
        )
        elapsed = time.perf_counter() - started
    report = processed.duration_report
    assert report is not None and processed.timeline is not None
    timeline = processed.timeline
    sped = [frame for frame in timeline.frames if frame.tempo_factor is not None]
    ok = (
        report.mp3_decoded_samples == report.target_samples
        and abs(report.mp3_header_samples - report.target_samples) <= 1
    )
    tools_used = ", ".join(
        f"{name} x{starts[name]} {seconds[name]:.2f}s" for name in sorted(starts)
    )
    print(
        f"    blocks={len(timed.blocks):>3} speed={speed.label:<5} clips/process={per_process:>2} "
        f"audio={report.target_seconds:7.1f}s frames={len(timeline.frames):>3} "
        f"removed={len(timeline.removed):>2} sped_up={len(sped):>3} wall={elapsed:6.2f}s "
        f"target={report.target_samples} decoded={report.mp3_decoded_samples} "
        f"header={report.mp3_header_samples} {'OK' if ok else 'MISMATCH'}"
    )
    print(f"        {tools_used}")
    return 0 if ok else 1


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--words", type=int, default=1000)
    parser.add_argument("--seed", type=int, default=7)
    parser.add_argument("--audio", action="store_true", help="also run (c) with FFmpeg")
    args = parser.parse_args()
    raw = synthetic_transcript(args.words, args.seed)
    groupings = [0, 10, 20, 30]
    print(f"Synthetic transcript: {args.words} words, {len(raw)} characters")
    part_a(raw, groupings)
    part_b(raw, groupings, [0.5, 1.0, 2.0])
    if args.audio:
        return part_c(raw, [0, 20], [AudioSpeed.X1, AudioSpeed.X1_5], args.seed)
    return 0


if __name__ == "__main__":
    sys.exit(main())
