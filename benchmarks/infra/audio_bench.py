"""Audio pipeline benchmark harness. Runs INSIDE the MyDubb app image (see run-audio.sh).

What is real: the product's JobPipeline, FfmpegAudioProcessor (real ffmpeg/ffprobe), the result
store (local disk), the database transitions (PostgreSQL) and the timed-transcript parser/plan.
What is fake: translation (the product's MockTranslationProvider, no network) and speech (pre-made
synthetic WAV files copied into the job's work dir, standing in for Azure Speech output). Azure
latency, rate limits and real speech content are therefore NOT represented.

Writes one JSON object per line to --out (results survive an OOM kill of the container).
"""

import argparse
import array
import json
import math
import os
import random
import shutil
import statistics
import sys
import tempfile
import threading
import time
import uuid
import wave
from pathlib import Path

sys.path.append("/backend_src")  # product scripts (synthetic transcript); /app stays first
sys.path.insert(0, str(Path(__file__).resolve().parent))  # supervise.py, checks.py (python -I)

from checks import validate_run  # noqa: E402
from supervise import DiskGuard, hard_stop, kill_by_name, supervise  # noqa: E402

import app.main  # noqa: E402,F401  (imports every model so the mappers resolve, as the app does)
from app.audio import ffmpeg as ffmpeg_module  # noqa: E402
from app.audio.ffmpeg import locate_tools  # noqa: E402
from app.audio.fitter import FfmpegAudioProcessor  # noqa: E402
from app.audio.speed import AudioSpeed  # noqa: E402
from app.config import load_settings  # noqa: E402
from app.db import create_db_engine, create_session_factory, session_scope  # noqa: E402
from app.jobs import service  # noqa: E402
from app.jobs.models import Job  # noqa: E402
from app.jobs.pipeline import JobInput, JobPipeline  # noqa: E402
from app.speech.base import SpeechAudio, TimedSpeechAudio  # noqa: E402
from app.speech.voices import Voice  # noqa: E402
from app.storage.result_store import LocalFileResultStore  # noqa: E402
from app.transcript.cleaning import clean_transcript  # noqa: E402
from app.transcript.timed import parse_timed_transcript  # noqa: E402
from app.translation.mock import MockTranslationProvider  # noqa: E402
from scripts.timed_benchmark import RATE, _clip, synthetic_transcript  # noqa: E402

# name -> words of the synthetic transcript (150 words per minute in its timestamps).
WORKLOADS = {"short": 150, "guest_limit": 1000, "long": 3000}
SPEECH_OVER_BASELINE = 1.2  # plain mode: speech is 20% longer than the target (needs a tempo-up)
MAX_TEMP_MB = 3072  # disk guard (a periodic check, not a quota; see supervise.py)
RUN_TIMEOUT_SECONDS = 900
STOP_GRACE_SECONDS = 15
SCHEMA = 2  # record layout; schema 1 (first PR commit) had weaker validation

def read_rss_kb() -> dict[int, tuple[str, int]]:
    out = {}
    for entry in os.listdir("/proc"):
        if not entry.isdigit():
            continue
        try:
            with open(f"/proc/{entry}/status") as handle:
                fields = dict(line.split(":", 1) for line in handle if ":" in line)
            out[int(entry)] = (fields["Name"].strip(), int(fields.get("VmRSS", "0 kB").split()[0]))
        except (OSError, KeyError, ValueError):
            continue
    return out


def cgroup_value(name: str, key: str | None = None) -> int | None:
    try:
        text = Path("/sys/fs/cgroup", name).read_text()
    except OSError:
        return None
    if key is None:
        return int(text.strip())
    for line in text.splitlines():
        if line.startswith(key + " "):
            return int(line.split()[1])
    return None


class Sampler(threading.Thread):
    """Samples process RSS (python vs ffmpeg/ffprobe) every `period` seconds."""

    def __init__(self, period: float = 0.05) -> None:
        super().__init__(daemon=True)
        self.period, self.stop_flag = period, threading.Event()
        self.peak_python_kb = self.peak_ffmpeg_kb = self.peak_total_kb = 0
        self.peak_ffmpeg_procs = 0

    def run(self) -> None:
        me = os.getpid()
        while not self.stop_flag.is_set():
            procs = read_rss_kb()
            py = procs.get(me, ("", 0))[1]
            ff = [kb for pid, (name, kb) in procs.items() if name in ("ffmpeg", "ffprobe")]
            self.peak_python_kb = max(self.peak_python_kb, py)
            self.peak_ffmpeg_kb = max(self.peak_ffmpeg_kb, sum(ff))
            self.peak_ffmpeg_procs = max(self.peak_ffmpeg_procs, len(ff))
            self.peak_total_kb = max(self.peak_total_kb, py + sum(ff))
            time.sleep(self.period)


def make_wav(path: Path, seconds: float, seed: int) -> None:
    """Speech stand-in written in chunks (tone 'words' and short pauses); bounded memory."""
    rng = random.Random(seed)  # noqa: S311 (synthetic data)
    pattern = array.array("h")
    while len(pattern) < RATE * 10:
        count = int(rng.uniform(0.2, 0.45) * RATE)
        freq = rng.choice((220, 330, 440, 550))
        pattern.extend(int(9000 * math.sin(2 * math.pi * freq * n / RATE)) for n in range(count))
        pattern.extend(array.array("h", bytes(int(0.08 * RATE) * 2)))
    frames_left = int(seconds * RATE)
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(RATE)
        while frames_left > 0:
            chunk = pattern[: min(len(pattern), frames_left)]
            handle.writeframes(chunk.tobytes())
            frames_left -= len(chunk)


class Fixtures:
    """Pre-made speech files for one workload; built before any measurement."""

    def __init__(self, directory: Path, mode: str, words: int, seed: int) -> None:
        raw = synthetic_transcript(words, seed)
        self.raw = raw
        self.timed = parse_timed_transcript(raw)
        self.baseline = int(self.timed.source_baseline)
        self.cleaned = clean_transcript(raw)
        self.mode = mode
        self.clips: list[Path] = []
        self.plain_wav: Path | None = None
        self.plan = self.timed.plan(self.baseline, AudioSpeed.X1)
        if mode == "plain":
            self.plain_wav = directory / "plain.wav"
            make_wav(self.plain_wav, self.baseline * SPEECH_OVER_BASELINE, seed)
        else:
            rng = random.Random(seed)  # noqa: S311
            bounds = self.plan.boundaries(RATE)
            for i in range(len(self.timed.blocks)):
                frame = (bounds[i + 1] - bounds[i]) / RATE
                clip = directory / f"clip-{i:05d}.wav"
                _clip(clip, max(0.6, frame * rng.uniform(0.75, 1.4)), rng)
                self.clips.append(clip)
        self.input_bytes = (
            self.plain_wav.stat().st_size if self.plain_wav else sum(c.stat().st_size for c in self.clips)
        )


class Timed:
    """Accumulates wall time of calls into a shared stage table."""

    def __init__(self, stages: dict[str, float], lock: threading.Lock) -> None:
        self.stages, self.lock = stages, lock

    def record(self, name: str, seconds: float) -> None:
        with self.lock:
            self.stages[name] = self.stages.get(name, 0.0) + seconds


class FakeSpeech:
    name = "bench-fake-speech"
    produces_fixture = False

    def __init__(self, fx: Fixtures, rec: Timed) -> None:
        self.fx, self.rec = fx, rec

    def synthesize(self, text, voice, work_dir, terms=None, language=None):
        started = time.perf_counter()
        target = work_dir / "speech.wav"
        shutil.copyfile(self.fx.plain_wav, target)
        self.rec.record("speech_fake_copy", time.perf_counter() - started)
        return SpeechAudio(path=target, is_fixture=False, lossless_path=target)

    def synthesize_blocks(self, texts, voice, work_dir, terms=None, language=None):
        started = time.perf_counter()
        clips = []
        for clip in self.fx.clips:
            target = work_dir / clip.name
            shutil.copyfile(clip, target)
            clips.append(target)
        self.rec.record("speech_fake_copy", time.perf_counter() - started)
        return TimedSpeechAudio(clips=tuple(clips), is_fixture=False, requests=len(clips))


class TimedAudio:
    """The real FfmpegAudioProcessor with its stage wall time recorded."""

    def __init__(self, inner: FfmpegAudioProcessor, rec: Timed) -> None:
        self.inner, self.rec = inner, rec
        self.name, self.places_timeline = inner.name, inner.places_timeline

    def fit_to_duration(self, speech, target, work_dir):
        started = time.perf_counter()
        try:
            return self.inner.fit_to_duration(speech, target, work_dir)
        finally:
            self.rec.record("audio_ffmpeg", time.perf_counter() - started)

    def fit_timeline(self, speech, plan, work_dir):
        started = time.perf_counter()
        try:
            return self.inner.fit_timeline(speech, plan, work_dir)
        finally:
            self.rec.record("audio_ffmpeg", time.perf_counter() - started)

    def close(self) -> None:
        self.inner.close()


def count_tool_starts(counter: dict[str, list[float]], lock: threading.Lock):
    original = ffmpeg_module.run_tool

    def counted(args, **kwargs):
        name = Path(args[0]).stem
        started = time.perf_counter()
        try:
            return original(args, **kwargs)
        finally:
            with lock:
                entry = counter.setdefault(name, [0, 0.0])
                entry[0] += 1
                entry[1] += time.perf_counter() - started

    ffmpeg_module.run_tool = counted
    return original


def one_run(args, fx, session_factory, store, tmp_root, run_no) -> dict:
    stages: dict[str, float] = {}
    lock = threading.Lock()
    rec = Timed(stages, lock)
    tools = locate_tools()
    audio = TimedAudio(FfmpegAudioProcessor(tools), rec)
    pipeline = JobPipeline(
        session_factory=session_factory,
        translator=MockTranslationProvider(),
        speech=FakeSpeech(fx, rec),
        audio=audio,
        result_store=store,
        result_ttl_seconds=3600,
    )
    tool_counts: dict[str, list[float]] = {}
    original = count_tool_starts(tool_counts, lock)
    job_ids, inputs = [], []
    with session_scope(session_factory) as db:
        for _ in range(args.concurrency):
            job = service.create_job(
                db,
                session_id=None,
                voice=Voice.ANDREW.value,
                first_sentence_start_seconds=0,
                last_sentence_start_seconds=max(fx.baseline, 1),
                transcript_char_count=len(fx.cleaned),
                translation_provider="mock-translation",
                speech_provider=FakeSpeech.name,
                audio_processor=audio.name,
                runner_id="bench",
            )
            job_ids.append(job.id)
            inputs.append(
                JobInput(
                    job_id=job.id,
                    transcript=fx.cleaned if fx.mode == "plain" else "\n".join(b.text for b in fx.timed.blocks),
                    voice=Voice.ANDREW,
                    baseline_seconds=fx.baseline,
                    speed=AudioSpeed.X1,
                    timed=fx.timed if fx.mode == "timed" else None,
                )
            )
    sampler = Sampler()
    guard = DiskGuard([tmp_root, Path(store._root)], args.max_temp_mb * 1024**2)  # noqa: SLF001
    walls = [0.0] * len(inputs)
    errors: list[str] = []

    def work(i):
        started = time.perf_counter()
        try:
            pipeline.run(inputs[i])
        except BaseException as exc:  # noqa: BLE001 (recorded; the run is then invalid)
            errors.append(type(exc).__name__)
        walls[i] = time.perf_counter() - started

    cpu0 = cgroup_value("cpu.stat", "usage_usec")
    oom0 = cgroup_value("memory.events", "oom_kill")
    self_cpu0 = time.process_time()
    sampler.start()
    guard.start()
    started = time.perf_counter()
    threads = [threading.Thread(target=work, args=(i,), daemon=True) for i in range(len(inputs))]
    for t in threads:
        t.start()
    # The deadline and the disk guard are checked every 50 ms while the jobs run; a trip calls
    # audio.close() (kills FFmpeg, later calls fail) and then waits a bounded grace period.
    outcome = supervise(
        threads,
        timeout_s=args.run_timeout,
        tripped=guard.is_tripped,
        stop=audio.close,
        grace_s=args.stop_grace,
    )
    wall = time.perf_counter() - started
    guard.finish()
    sampler.stop_flag.set()
    sampler.join()
    cpu1 = cgroup_value("cpu.stat", "usage_usec")
    oom1 = cgroup_value("memory.events", "oom_kill")
    ffmpeg_module.run_tool = original
    # Nothing of this run may keep running during cleanup: kill any tool that survived.
    stray = kill_by_name(("ffmpeg", "ffprobe"))
    stuck_threads = outcome.stuck

    statuses, out_bytes, samples = [], [], []
    with session_scope(session_factory) as db:
        for job_id in job_ids:
            job = db.get(Job, job_id)
            statuses.append(str(getattr(job.status, "value", job.status)) if job else "missing")
    for job_id in job_ids:
        result = store.get(job_id)
        if result is not None:
            out_bytes.append(result.audio_path.stat().st_size)
            rep = result.duration_report or {}
            samples.append(
                {"decoded": rep.get("mp3_decoded_samples"), "target": rep.get("target_samples")}
            )
            store.delete(job_id)
    leftovers = [p.name for p in tmp_root.iterdir()] if tmp_root.exists() else []
    cpu_s = (cpu1 - cpu0) / 1e6 if cpu0 is not None and cpu1 is not None else None
    record = {
        "type": "run",
        "schema": SCHEMA,
        "workload": args.workload,
        "mode": args.mode,
        "concurrency": args.concurrency,
        "run": run_no,
        "words": WORKLOADS[args.workload],
        "audio_seconds": fx.baseline,
        "blocks": len(fx.timed.blocks) if fx.mode == "timed" else None,
        "wall_s": round(wall, 3),
        "job_wall_s": [round(w, 3) for w in walls],
        "stage_s_summed_over_jobs": {k: round(v, 3) for k, v in stages.items()},
        "ffmpeg_tools": {
            k: {"starts": v[0], "seconds_summed": round(v[1], 3)} for k, v in tool_counts.items()
        },
        "status": statuses,
        "stop_reason": outcome.reason,  # None, "timeout" or "disk_guard"
        "timed_out": outcome.reason == "timeout",
        "disk_guard_aborted": outcome.reason == "disk_guard",
        "stuck_threads": stuck_threads,
        "errors": errors,
        "stray_processes": stray,
        "disk_guard_limit_mb": args.max_temp_mb,
        "disk_guard_note": "periodic check (200 ms), not a filesystem quota: may overshoot",
        "output_bytes": out_bytes,
        "mp3_samples": samples,
        "peak_rss_python_mb": round(sampler.peak_python_kb / 1024, 1),
        "peak_rss_ffmpeg_mb": round(sampler.peak_ffmpeg_kb / 1024, 1),
        "peak_ffmpeg_procs": sampler.peak_ffmpeg_procs,
        "peak_rss_total_mb": round(sampler.peak_total_kb / 1024, 1),
        "peak_temp_disk_mb": round(guard.peak / 1024**2, 1),
        "container_cpu_seconds": round(cpu_s, 3) if cpu_s is not None else None,
        "python_cpu_seconds": round(time.process_time() - self_cpu0, 3),
        "fixture_input_mb": round(fx.input_bytes / 1024**2, 1),
        "work_dirs_left": leftovers,
        "oom_kill_events_delta": (oom1 - oom0) if oom0 is not None and oom1 is not None else None,
    }
    record["invalid_reasons"] = validate_run(record, args.concurrency)
    return record


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--workload", choices=WORKLOADS, required=True)
    parser.add_argument("--mode", choices=("plain", "timed"), required=True)
    parser.add_argument("--concurrency", type=int, default=1)
    parser.add_argument("--repeats", type=int, default=4)
    parser.add_argument("--seed", type=int, default=7)
    parser.add_argument("--run-timeout", type=float, default=RUN_TIMEOUT_SECONDS)
    parser.add_argument("--stop-grace", type=float, default=STOP_GRACE_SECONDS)
    parser.add_argument("--max-temp-mb", type=int, default=MAX_TEMP_MB)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()

    out = open(args.out, "a", buffering=1)
    base = Path(tempfile.mkdtemp(prefix="bench-"))
    failures: list[str] = []
    runs_done = 0
    stuck = False
    engine = None
    try:
        settings = load_settings()
        engine = create_db_engine(settings.sqlalchemy_url, 10)
        session_factory = create_session_factory(engine)
        os.environ["TMPDIR"] = str(base / "tmp")
        tmp_root = base / "tmp"
        tmp_root.mkdir()
        tempfile.tempdir = str(tmp_root)  # job work dirs land here and are measured
        store = LocalFileResultStore(base / "results")
        fixtures_dir = base / "fixtures"
        fixtures_dir.mkdir()
        started = time.perf_counter()
        fx = Fixtures(fixtures_dir, args.mode, WORKLOADS[args.workload], args.seed)
        out.write(
            json.dumps(
                {
                    "type": "fixture",
                    "workload": args.workload,
                    "mode": args.mode,
                    "build_s": round(time.perf_counter() - started, 1),
                }
            )
            + "\n"
        )
        rss_idle = read_rss_kb()[os.getpid()][1] / 1024
        for run_no in range(1, args.repeats + 1):
            result = one_run(args, fx, session_factory, store, tmp_root, run_no)
            result["harness_rss_before_run_mb"] = round(rss_idle, 1)
            out.write(json.dumps(result) + "\n")
            runs_done += 1
            if result["invalid_reasons"]:
                failures.append(f"run {run_no}: " + "; ".join(result["invalid_reasons"]))
            if result["stuck_threads"]:
                stuck = True
                break
            if result["stop_reason"] is not None:
                break  # timeout or disk guard: no further runs of this case
    except BaseException as exc:  # noqa: BLE001
        # Only the exception type is recorded: its text can carry connection details.
        out.write(json.dumps({"type": "error", "error": type(exc).__name__}) + "\n")
        failures.append(f"exception {type(exc).__name__}")
    finally:
        if engine is not None and not stuck:
            engine.dispose()
    if runs_done != args.repeats:
        failures.append(f"{runs_done} of {args.repeats} runs completed")
    if not stuck:
        shutil.rmtree(base, ignore_errors=True)
    cleanup_ok = not base.exists()
    if not cleanup_ok:
        failures.append("temporary directory not removed")
    out.write(
        json.dumps(
            {
                "type": "summary",
                "schema": SCHEMA,
                "ok": not failures,
                "failures": failures,
                "expected_runs": args.repeats,
                "runs_done": runs_done,
                "cleanup_ok": cleanup_ok,
            }
        )
        + "\n"
    )
    out.close()
    if stuck:
        # Work is still running in threads that cannot be stopped: end the process now (also
        # kills FFmpeg) instead of cleaning up underneath it.
        hard_stop(3)
    return 0 if not failures else 1


if __name__ == "__main__":
    sys.exit(main())
