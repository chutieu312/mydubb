"""LIVE prototype check of timed speech (several blocks per request, cut at inserted breaks).

Run from `backend/` with ffmpeg/ffprobe on PATH and AZURE_SPEECH_KEY / AZURE_SPEECH_REGION in the
environment or in the file given by --env-file (never printed):

    uv run python -m scripts.timed_speech_smoke --output-dir DIR [--env-file PATH]

It sends exactly four Azure Speech requests with a synthetic timed transcript (14 blocks, written
for this check; no user data) and its hand-written Vietnamese translation:

* Andrew and Emma, all blocks in ONE request each with `<break>` between blocks (the C prototype);
* Andrew and Emma, the same text in one request WITHOUT breaks: the natural rendering, used as an
  independent reference (natural pause lengths; where each clip's sound occurs in it).

The request count and the spoken characters are computed before anything is sent and checked
against the budget (--max-requests, --max-chars); the transport refuses any request beyond the
plan. Nothing is retried. Results go to --output-dir: the raw responses, one WAV per block, the
timed MP3 per voice (1x, baseline from the captions), the reference MP3s and report.json. The
checks cannot hear words: listen to the block clips and the MP3s.
"""

import argparse
import json
import math
import os
import shutil
import sys
import tempfile
import time
from pathlib import Path

import httpx
from dotenv import load_dotenv
from pydantic import SecretStr

from app.audio.ffmpeg import encode_mp3, locate_tools
from app.audio.fitter import FfmpegAudioProcessor
from app.audio.speed import AudioSpeed
from app.audio.wav import read_wav_info
from app.pronunciation.detector import detect_english
from app.speech import blocks as blocks_module
from app.speech.azure import AzureSpeechProvider
from app.speech.base import TimedSpeechAudio
from app.speech.blocks import BlockRequest, plan_block_requests, speech_seconds, split_response
from app.speech.chunker import split_for_speech
from app.speech.rate_limit import RequestRateLimiter
from app.speech.voices import Voice
from app.transcript.cleaning import clean_transcript
from app.transcript.timed import parse_timed_transcript
from app.translation.glossary import default_glossary
from tests.audio_helpers import read_samples

SOURCE = """0:00
Generally, if if somebody's trying to
0:01
make a company work, they should expect
0:03
to grind super hard. Uh except that
0:05
there's like some meaningful chance of
0:06
failure. I could not make a spaceship by
0:08
myself, but but uh with a collection of
0:11
humans, uh we can make spaceships. Right.
0:14
So the next question is... how do we
0:16
deploy it? We use Kubernetes and a REST
0:18
API. Yes. It ran 3.5 times faster, about
0:21
20 percent cheaper. First, we build the
0:23
image; then, we push it, and finally we
0:26
roll it out (slowly, one region at a time).
0:29
Does it work? Mostly. The error rate, which
0:32
was 2%, dropped to 0.4%. Good. Thanks for
0:35
watching. See you next time. Bye"""
# One translation per block (hand-written for this check).
VIETNAMESE = [
    "Nhìn chung, nếu nếu ai đó đang cố gắng làm cho một công ty hoạt động, họ nên chuẩn bị "
    "tinh thần để làm việc cực kỳ vất vả.",
    "Ờ, ngoại trừ việc có một khả năng thất bại khá đáng kể.",
    "Tôi không thể tự mình làm ra một con tàu vũ trụ, nhưng nhưng ờ với một tập thể con người, "
    "ờ chúng ta có thể làm ra tàu vũ trụ.",
    "Đúng vậy.",
    "Vậy câu hỏi tiếp theo là... chúng ta triển khai nó như thế nào?",
    "Chúng ta dùng Kubernetes và một REST API.",
    "Vâng.",
    "Nó chạy nhanh hơn 3,5 lần, rẻ hơn khoảng 20 phần trăm.",
    "Đầu tiên, chúng ta build image; sau đó, chúng ta push nó, và cuối cùng chúng ta triển khai "
    "nó (từ từ, từng region một).",
    "Nó có hoạt động không?",
    "Phần lớn là có.",
    "Tỷ lệ lỗi, vốn là 2%, đã giảm xuống còn 0,4%.",
    "Tốt.",
    "Cảm ơn các bạn đã theo dõi. Hẹn gặp lại lần sau. Tạm biệt",
]
# Held-out check, written after the silence level was calibrated on the set above: other text,
# break requests only (no reference rendering).
HELD_OUT_SOURCE = """0:00
Today we'll look at how a neural network
0:02
learns. First: the loss function measures
0:05
how wrong we are; then gradient descent
0:07
nudges every weight a little. Simple, right?
0:10
Not quite! The learning rate matters a lot
0:13
... too big and it diverges, too small and
0:15
it takes forever. OK. We store the results
0:18
as JSON and ship the model in a Docker
0:20
container. "Does it scale?" people ask. It
0:23
does, up to about 10,000 requests per
0:25
second on 4 GPUs. Great. In the next video
0:28
we'll cover transformers and attention, so"""
HELD_OUT_VIETNAMESE = [
    "Hôm nay chúng ta sẽ xem một neural network học như thế nào.",
    "Đầu tiên: loss function đo mức độ sai của chúng ta; sau đó gradient descent điều chỉnh "
    "từng trọng số một chút.",
    "Đơn giản, đúng không?",
    "Không hẳn!",
    "Learning rate rất quan trọng... quá lớn thì nó phân kỳ, quá nhỏ thì nó mất rất nhiều thời "
    "gian.",
    "OK.",
    "Chúng ta lưu kết quả dưới dạng JSON và đóng gói model trong một Docker container.",
    '"Nó có scale được không?" mọi người hỏi.',
    "Có, lên tới khoảng 10.000 request mỗi giây trên 4 GPU.",
    "Tuyệt.",
    "Trong video tiếp theo, chúng ta sẽ tìm hiểu transformer và attention, vì vậy",
]
DATASETS = {
    "main": (SOURCE, VIETNAMESE, True),
    "held-out": (HELD_OUT_SOURCE, HELD_OUT_VIETNAMESE, False),
}
ENVELOPE_MS = 20
# Shorter sound (one or two syllables) matches many places of the reference by chance.
MIN_LOCATABLE_MS = 1000
SCALES = (0.94, 0.96, 0.98, 1.0, 1.02, 1.04, 1.06)


class ReplayTransport(httpx.BaseTransport):
    """Answers with responses saved by an earlier live run, in order (no network)."""

    def __init__(self, saved: Path) -> None:
        self._saved = saved
        self.sent: list[dict] = []

    def handle_request(self, request: httpx.Request) -> httpx.Response:
        path = self._saved / f"response-{len(self.sent) + 1}.wav"
        self.sent.append({"status": 200, "seconds": None, "file": path.name, "replayed": True})
        return httpx.Response(200, content=path.read_bytes())


class BudgetTransport(httpx.BaseTransport):
    """Sends at most `allowed` requests; keeps each response body and its latency."""

    def __init__(self, allowed: int, keep: Path) -> None:
        self._inner = httpx.HTTPTransport()
        self._allowed = allowed
        self._keep = keep
        self.sent: list[dict] = []

    def handle_request(self, request: httpx.Request) -> httpx.Response:
        if len(self.sent) >= self._allowed:
            raise RuntimeError("request budget exhausted; nothing more is sent")
        started = time.perf_counter()
        response = self._inner.handle_request(request)
        body = response.read()
        elapsed = time.perf_counter() - started
        path = self._keep / f"response-{len(self.sent) + 1}.wav"
        path.write_bytes(body)
        self.sent.append(
            {"status": response.status_code, "seconds": round(elapsed, 3), "file": path.name}
        )
        return httpx.Response(response.status_code, headers=response.headers, content=body)


def envelope(samples, rate: int) -> list[float]:
    window = rate * ENVELOPE_MS // 1000
    # Log energy: speech syllables, not the absolute loudness, shape the curve.
    return [
        math.log10(1 + sum(map(abs, samples[start : start + window])) / window)
        for start in range(0, len(samples) - window + 1, window)
    ]


QUIET = math.log10(1 + blocks_module.SILENCE_PEAK)


def sounding(values: list[float], floor: float = QUIET) -> list[float]:
    loud = [i for i, value in enumerate(values) if value > floor]
    return values[loud[0] : loud[-1] + 1] if loud else []


def _scaled(values: list[float], scale: float) -> list[float]:
    """`values` resampled to `scale` times its length (linear interpolation)."""
    count = max(2, round(len(values) * scale))
    last = len(values) - 1
    out = []
    for index in range(count):
        position = index * last / (count - 1)
        low = int(position)
        high = min(low + 1, last)
        out.append(values[low] + (values[high] - values[low]) * (position - low))
    return out


def locate(clip: list[float], reference: list[float]) -> tuple[int, int, float, float]:
    """Where `clip` correlates best in `reference`: (offset, length, correlation, scale).

    The same sentence is not spoken at exactly the same rate in two requests, so the clip's
    envelope is also tried a few percent shorter and longer (SCALES).
    """
    best = (0, len(clip), -2.0, 1.0)
    for scale in SCALES:
        values = _scaled(clip, scale)
        m = len(values)
        mean = sum(values) / m
        centred = [value - mean for value in values]
        norm = math.sqrt(sum(value * value for value in centred)) or 1.0
        for offset in range(len(reference) - m + 1):
            part = reference[offset : offset + m]
            part_mean = sum(part) / m
            dot = sum(a * (b - part_mean) for a, b in zip(centred, part, strict=True))
            part_norm = math.sqrt(sum((b - part_mean) ** 2 for b in part)) or 1.0
            score = dot / (norm * part_norm)
            if score > best[2]:
                best = (offset, m, score, scale)
    return best


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--env-file", type=Path, default=Path(".env"))
    parser.add_argument("--max-requests", type=int, default=6)
    parser.add_argument("--max-chars", type=int, default=6000)
    parser.add_argument("--dataset", choices=sorted(DATASETS), default="main")
    parser.add_argument(
        "--replay",
        type=Path,
        help="directory of responses saved by a live run: analyse them again, send nothing",
    )
    args = parser.parse_args()
    if args.env_file.is_file():
        load_dotenv(args.env_file, override=False)
    key, region = os.environ.get("AZURE_SPEECH_KEY"), os.environ.get("AZURE_SPEECH_REGION")
    tools = locate_tools()
    if args.replay:
        key, region = key or "replay-without-network-0000000", region or "westus2"
    if not key or not region or tools is None:
        print("Needs AZURE_SPEECH_KEY, AZURE_SPEECH_REGION and ffmpeg/ffprobe on PATH.")
        return 2

    global SOURCE, VIETNAMESE
    SOURCE, VIETNAMESE, with_reference = DATASETS[args.dataset]
    timed = parse_timed_transcript(SOURCE)
    if len(timed.blocks) != len(VIETNAMESE):
        print(f"Source has {len(timed.blocks)} blocks, translation {len(VIETNAMESE)}.")
        return 2
    glossary = default_glossary()
    terms = detect_english(clean_transcript(SOURCE), "\n".join(VIETNAMESE), glossary).speech_terms
    reference_text = " ".join(VIETNAMESE)
    block_requests = plan_block_requests(VIETNAMESE, terms, 2000)
    reference_chunks = split_for_speech(reference_text, terms, 2000)
    voices = [Voice.ANDREW, Voice.EMMA]
    reference_requests = len(reference_chunks) if with_reference else 0
    planned = len(voices) * (len(block_requests) + reference_requests)
    chars = len(voices) * (
        sum(r.chars for r in block_requests) + (len(reference_text) if with_reference else 0)
    )
    print(
        f"Plan: {planned} requests, {chars} spoken characters (budget {args.max_requests}, "
        f"{args.max_chars})"
    )
    if not args.replay and (planned > args.max_requests or chars > args.max_chars):
        print("Over budget; nothing was sent.")
        return 2

    out = args.output_dir
    out.mkdir(parents=True, exist_ok=True)
    raw = args.replay or out / "responses"
    raw.mkdir(exist_ok=True)
    transport = ReplayTransport(raw) if args.replay else BudgetTransport(planned, raw)
    provider = AzureSpeechProvider(
        key=SecretStr(key),
        region=region,
        glossary=glossary,
        tools=tools,
        limiter=RequestRateLimiter(20, 60),
        timeout_seconds=60,
        max_chunk_chars=2000,
        transport=transport,
    )
    report: dict = {
        "blocks": [
            {
                "index": i,
                "source_start": float(b.start),
                "estimated_start": b.estimated_start,
                "english": b.text,
                "vietnamese": VIETNAMESE[i],
            }
            for i, b in enumerate(timed.blocks)
        ],
        "constants": {
            "break_ms": blocks_module.BREAK_MS,
            "min_break_silence_ms": blocks_module.MIN_BREAK_SILENCE_MS,
            "max_natural_silence_ms": blocks_module.MAX_NATURAL_SILENCE_MS,
            "lead_ms": blocks_module.LEAD_MS,
            "tail_ms": blocks_module.TAIL_MS,
            "silence_peak": blocks_module.SILENCE_PEAK,
        },
        "voices": {},
    }
    failures = 0
    for voice in voices:
        entry: dict = {}
        report["voices"][voice.value] = entry
        with tempfile.TemporaryDirectory(prefix="timed-smoke-") as name:
            work = Path(name)
            started = time.perf_counter()
            try:
                speech = provider.synthesize_blocks(VIETNAMESE, voice, work, terms=terms)
            except Exception as exc:  # report and continue with the next voice; no retry
                entry["error"] = getattr(exc, "code", type(exc).__name__)
                failures += 1
                print(f"{voice.value}: blocks request failed: {entry['error']}")
                speech = None
            blocks_seconds = time.perf_counter() - started
            block_http = transport.sent[-1]
            entry["blocks_request"] = {**block_http, "total_seconds": round(blocks_seconds, 3)}
            if not with_reference:
                if speech is not None:
                    entry.update(timeline_and_clips(tools, timed, speech, out, voice, work))
                    _, split = split_response(
                        raw / block_http["file"], block_requests[0], work, "again"
                    )
                    entry["split"] = {
                        "breaks_ms": split.breaks_ms,
                        "longest_natural_in_blocks_ms": split.longest_natural_ms,
                        "leading_ms": split.leading_ms,
                        "trailing_ms": split.trailing_ms,
                    }
                    entry["clips"] = [
                        {
                            "index": i,
                            "chars": len(VIETNAMESE[i]),
                            "speech_seconds": round(speech_seconds(c), 3),
                        }
                        for i, c in enumerate(speech.clips)
                    ]
                continue
            started = time.perf_counter()
            plain = provider.synthesize(reference_text, voice, work, terms=terms)
            entry["reference_request"] = {
                **transport.sent[-1],
                "total_seconds": round(time.perf_counter() - started, 3),
            }
            shutil.copyfile(plain.path, out / f"{voice.value}-reference-natural.mp3")
            reference = read_samples(plain.lossless_path)
            rate = read_wav_info(plain.lossless_path).format.sample_rate
            if speech is None:
                continue
            entry.update(
                analyse(raw / block_http["file"], block_requests[0], speech, reference, rate, work)
            )
            entry.update(timeline_and_clips(tools, timed, speech, out, voice, work))
    report["requests_sent"] = len(transport.sent)
    report["spoken_characters"] = chars
    (out / "report.json").write_text(json.dumps(report, indent=2, ensure_ascii=False), "utf-8")
    print(json.dumps(summary(report), indent=2, ensure_ascii=False))
    return 1 if failures else 0


def timeline_and_clips(tools, timed, speech: TimedSpeechAudio, out: Path, voice, work) -> dict:
    """Block clips (WAV and MP3) and the timed MP3 at 1x, for listening; the timeline report."""
    clip_dir = out / f"{voice.value}-clips"
    clip_dir.mkdir(exist_ok=True)
    for index, clip in enumerate(speech.clips):
        shutil.copyfile(clip, clip_dir / f"block-{index:02d}.wav")
    plan = timed.plan(timed.source_baseline, AudioSpeed.X1)
    started = time.perf_counter()
    processed = FfmpegAudioProcessor(tools).fit_timeline(speech, plan, work)
    seconds = round(time.perf_counter() - started, 3)
    shutil.copyfile(processed.path, out / f"{voice.value}-timed-1x.mp3")
    for index, clip in enumerate(speech.clips):
        encode_mp3(tools, clip, clip_dir / f"block-{index:02d}.mp3", 30)
    duration = processed.duration_report
    return {
        "timeline_seconds": seconds,
        "timeline": {
            "target_samples": duration.target_samples,
            "mp3_decoded_samples": duration.mp3_decoded_samples,
            "mp3_header_samples": duration.mp3_header_samples,
            "frames": [frame.as_dict() for frame in processed.timeline.frames],
        },
    }


def analyse(
    response: Path,
    request: BlockRequest,
    speech: TimedSpeechAudio,
    reference,
    rate: int,
    work: Path,
) -> dict:
    """Independent evidence beyond the runtime checks (see the module doc)."""
    _, split = split_response(response, request, work, "again")
    ref_env = envelope(reference, rate)
    ref_silences = []
    quiet = [value <= QUIET for value in ref_env]
    run = 0
    for flag in quiet:
        if flag:
            run += 1
        elif run:
            ref_silences.append(run * ENVELOPE_MS)
            run = 0
    clips = []
    previous_end = -1
    in_order = True
    for index, clip in enumerate(speech.clips):
        samples = read_samples(clip)
        env = sounding(envelope(samples, rate))
        if not env:
            clips.append({"index": index, "sound": False})
            continue
        entry = {
            "index": index,
            "chars": len(VIETNAMESE[index]),
            "speech_seconds": round(speech_seconds(clip), 3),
        }
        clips.append(entry)
        if len(env) * ENVELOPE_MS < MIN_LOCATABLE_MS:
            entry["located"] = "too short to locate reliably"
            continue
        offset, length, score, scale = locate(env, ref_env)
        if offset < previous_end - 5:  # 100 ms of slack between neighbours
            in_order = False
        previous_end = offset + length
        entry["scale"] = scale
        entry["found_in_reference_at_s"] = round(offset * ENVELOPE_MS / 1000, 2)
        entry["found_until_s"] = round(previous_end * ENVELOPE_MS / 1000, 2)
        entry["correlation"] = round(score, 3)
    return {
        "split": {
            "breaks_ms": split.breaks_ms,
            "longest_natural_in_blocks_ms": split.longest_natural_ms,
            "leading_ms": split.leading_ms,
            "trailing_ms": split.trailing_ms,
        },
        "reference_interior_silences_ms_top5": sorted(ref_silences[1:-1] or [0])[-5:],
        "clips_in_reference_order": in_order,
        "clips": clips,
    }


def summary(report: dict) -> dict:
    result = {"requests_sent": report["requests_sent"], "chars": report["spoken_characters"]}
    for voice, entry in report["voices"].items():
        result[voice] = {
            key: entry.get(key)
            for key in (
                "error",
                "blocks_request",
                "reference_request",
                "split",
                "reference_interior_silences_ms_top5",
                "clips_in_reference_order",
                "timeline_seconds",
            )
        }
        result[voice]["min_correlation"] = min(
            (c["correlation"] for c in entry.get("clips", []) if "correlation" in c), default=None
        )
    return result


if __name__ == "__main__":
    sys.exit(main())
