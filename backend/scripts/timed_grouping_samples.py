"""Before/after samples of frame grouping, from block clips that were already synthesized.

Run from `backend/` with ffmpeg/ffprobe on PATH. Azure is NOT called: the lossless block clips
written by `scripts.timed_speech_smoke` are placed on the timeline again, without grouping and with
grouping (audio/grouping.py), at several speeds.

    uv run python -m scripts.timed_grouping_samples --clips main=DIR --clips held-out=DIR \\
        --output-dir OUT

DIR holds `AndrewMultilingual-clips/block-NN.wav` and `EmmaMultilingual-clips/...` (the
`--output-dir` of the smoke run). OUT receives one MP3 per dataset, voice, speed and mode,
`report.json` and `index.html` (players, the transcript, and per block: frame, audio length,
tempo before and after grouping; open it locally in a browser).
"""

import argparse
import html
import json
import statistics
import sys
import tempfile
import time
from pathlib import Path

from app.audio import ffmpeg as ffmpeg_module
from app.audio.ffmpeg import locate_tools
from app.audio.fitter import FfmpegAudioProcessor
from app.audio.grouping import MAX_GROUP_SECONDS, MIN_FRAME_SECONDS, TEMPO_TARGET
from app.audio.speed import AudioSpeed
from app.speech.base import TimedSpeechAudio
from app.speech.voices import Voice
from app.transcript.timed import parse_timed_transcript
from scripts.timed_speech_smoke import DATASETS

SPEEDS = [AudioSpeed.X1, AudioSpeed.X1_25, AudioSpeed.X1_5, AudioSpeed.X1_75]
# (name, grouping, relative target): the rule as decided, and a variant for comparison.
MODES = [
    ("ungrouped", False, False),
    ("grouped", True, False),
    ("relative", True, True),
]
MODE_LABELS = {
    "ungrouped": "Before grouping",
    "grouped": "Grouped (2x rule)",
    "relative": "Variant: local peaks only",
}
VOICES = [Voice.ANDREW, Voice.EMMA]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--clips", action="append", required=True, help="DATASET=DIR")
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()
    tools = locate_tools()
    if tools is None:
        print("ffmpeg/ffprobe must be on PATH")
        return 2
    out = args.output_dir
    out.mkdir(parents=True, exist_ok=True)

    starts = [0]
    original = ffmpeg_module.run_tool

    def counted(arguments, **kwargs):
        starts[0] += 1
        return original(arguments, **kwargs)

    ffmpeg_module.run_tool = counted
    report: dict = {
        "rules": {
            "tempo_warning_level": TEMPO_TARGET,
            "min_frame_seconds": MIN_FRAME_SECONDS,
            "max_group_seconds": MAX_GROUP_SECONDS,
        },
        "datasets": {},
    }
    try:
        for item in args.clips:
            name, _, directory = item.partition("=")
            source, vietnamese, _ = DATASETS[name]
            runs = []
            for _ in range(20):
                started = time.perf_counter()
                timed = parse_timed_transcript(source)
                for speed in SPEEDS:
                    timed.boundaries(timed.source_baseline, speed, 24000)
                runs.append(time.perf_counter() - started)
            entry = {
                "parse_and_timeline_ms_median": round(statistics.median(runs) * 1000, 3),
                "source_first": timed.source_first,
                "source_last": timed.source_last,
                "blocks": [
                    {"start": float(b.start), "english": b.text, "vietnamese": vietnamese[i]}
                    for i, b in enumerate(timed.blocks)
                ],
                "runs": [],
            }
            report["datasets"][name] = entry
            for voice in VOICES:
                clip_dir = Path(directory) / f"{voice.value}-clips"
                clips = tuple(clip_dir / f"block-{i:02d}.wav" for i in range(len(timed.blocks)))
                speech = TimedSpeechAudio(clips, is_fixture=False, requests=1)
                for speed in SPEEDS:
                    for mode in MODES:
                        entry["runs"].append(
                            render(tools, timed, speech, voice, speed, mode, out, name, starts)
                        )
                        print(summary_line(name, entry["runs"][-1]))
    finally:
        ffmpeg_module.run_tool = original
    (out / "report.json").write_text(json.dumps(report, indent=2, ensure_ascii=False), "utf-8")
    (out / "index.html").write_text(page(report), "utf-8")
    print(f"Wrote {out / 'index.html'}")
    return 0


def render(tools, timed, speech, voice, speed, mode, out, name, starts) -> dict:
    mode_name, grouping, relative = mode
    plan = timed.plan(timed.source_baseline, speed)
    file = f"{name}-{voice.value}-{speed.label}-{mode_name}.mp3"
    with tempfile.TemporaryDirectory(prefix="grouping-") as work_name:
        work = Path(work_name)
        before = starts[0]
        started = time.perf_counter()
        processed = FfmpegAudioProcessor(tools).fit_timeline(
            speech, plan, work, grouping=grouping, relative=relative
        )
        seconds = time.perf_counter() - started
        (out / file).write_bytes(processed.path.read_bytes())
    timeline = processed.timeline
    duration = processed.duration_report
    tempos = [f.tempo_factor or 1.0 for f in timeline.frames]
    return {
        "voice": voice.value,
        "speed": speed.number,
        "mode": mode_name,
        "file": file,
        "ffmpeg_seconds": round(seconds, 3),
        "ffmpeg_starts": starts[0] - before,
        "target_samples": duration.target_samples,
        "mp3_decoded_samples": duration.mp3_decoded_samples,
        "mp3_header_samples": duration.mp3_header_samples,
        "max_tempo": round(max(tempos), 3),
        "frames_over_2x": sum(1 for t in tempos if t > TEMPO_TARGET),
        **{k: v for k, v in timeline.as_dict().items() if k not in ("boundaries",)},
    }


def summary_line(name: str, run: dict) -> str:
    return (
        f"{name:8} {run['voice']:<19} {run['speed']:>4}x "
        f"{run['mode']:<9} target={run['grouping_target']:.2f}x frames={run['frames']:>2} "
        f"removed={len(run['removed_boundaries']):>2} max_tempo={run['max_tempo']:>5} "
        f"over_2x={run['frames_over_2x']} "
        f"est_max_shift={run['estimated_max_displacement_seconds']:.2f}s "
        f"ffmpeg={run['ffmpeg_seconds']:.2f}s/{run['ffmpeg_starts']} starts "
        f"exact={run['mp3_decoded_samples'] == run['target_samples']}"
    )


def page(report: dict) -> str:
    rate = 24000
    parts = [
        "<!doctype html><html lang='vi'><head><meta charset='utf-8'>",
        "<meta name='viewport' content='width=device-width,initial-scale=1'>",
        "<title>Grouping samples</title><style>",
        ":root{--bg:#fff;--fg:#1b1b1b;--muted:#666;--line:#ddd;--warn:#b3261e;--ok:#1e6b34}",
        "@media (prefers-color-scheme:dark){:root{--bg:#161616;--fg:#eee;--muted:#aaa;",
        "--line:#333;--warn:#ff8a80;--ok:#7bd88f}}",
        "body{background:var(--bg);color:var(--fg);font:15px/1.45 system-ui,sans-serif;",
        "margin:0 auto;max-width:1100px;padding:16px}",
        "table{border-collapse:collapse;width:100%;margin:8px 0 20px;font-size:13px}",
        "th,td{border-bottom:1px solid var(--line);padding:4px 6px;text-align:left;",
        "vertical-align:top}td.n{text-align:right;font-variant-numeric:tabular-nums}",
        ".warn{color:var(--warn);font-weight:600}.muted{color:var(--muted)}",
        ".pair{display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px}audio{width:100%}",
        "h2{margin-top:36px}h3{margin:24px 0 4px}.wrap{overflow-x:auto}",
        "@media (max-width:640px){.pair{grid-template-columns:1fr}}",
        "</style></head><body><h1>Frame grouping: before / after</h1>",
        "<p class='muted'>Same synthesized clips (no new Azure call). Tempo = audio / frame; ",
        "the variant groups only frames above max(2x, 1.25 x the transcript's overall ratio). ",
        f"warning level {TEMPO_TARGET}x. Frames under {MIN_FRAME_SECONDS:g} s join the frame ",
        f"before; a tempo merge never makes a frame longer than {MAX_GROUP_SECONDS:g} s; the ",
        "transcript is never one single frame. Baseline from the first and last caption.</p>",
    ]
    for name, entry in report["datasets"].items():
        parts.append(f"<h2>{html.escape(name)} transcript</h2>")
        parts.append(
            f"<p class='muted'>Captions {entry['source_first']} s to {entry['source_last']} s; "
            f"parse + timeline (4 speeds) {entry['parse_and_timeline_ms_median']} ms median.</p>"
        )
        parts.append("<div class='wrap'><table><tr><th>#</th><th>Start (s)</th>")
        parts.append("<th>English</th><th>Vietnamese (read)</th></tr>")
        for index, block in enumerate(entry["blocks"]):
            parts.append(
                f"<tr><td class='n'>{index}</td><td class='n'>{block['start']:.3f}</td>"
                f"<td>{html.escape(block['english'])}</td>"
                f"<td>{html.escape(block['vietnamese'])}</td></tr>"
            )
        parts.append("</table></div>")
        runs = entry["runs"]
        for voice in VOICES:
            for speed in SPEEDS:
                pair = [r for r in runs if r["voice"] == voice.value and r["speed"] == speed.number]
                by_mode = {r["mode"]: r for r in pair}
                parts.append(f"<h3>{voice.label}, {speed.label}</h3><div class='pair'>")
                for mode_name, label in MODE_LABELS.items():
                    run = by_mode[mode_name]
                    parts.append(
                        f"<div><b>{label}</b> <span class='muted'>{run['frames']} frames, "
                        f"max tempo {run['max_tempo']}x, {run['frames_over_2x']} over 2x, "
                        f"{len(run['removed_boundaries'])} boundaries removed, estimated max shift "
                        f"{run['estimated_max_displacement_seconds']:.2f} s, FFmpeg "
                        f"{run['ffmpeg_seconds']:.2f} s</span><br>"
                        f"<audio controls preload='none' src='{run['file']}'></audio></div>"
                    )
                parts.append("</div>")
                parts.append(table(entry, by_mode, rate))
    parts.append("</body></html>")
    return "".join(parts)


def table(entry: dict, runs: dict, rate: int) -> str:
    def owner(run: dict, block: int) -> dict:
        return next(f for f in run["frame_fits"] if f["first_block"] <= block <= f["last_block"])

    def mark(value: float) -> str:
        text = f"{value:.2f}x"
        return f"<span class='warn'>{text}</span>" if value > TEMPO_TARGET else text

    before = runs["ungrouped"]
    rows = [
        "<div class='wrap'><table><tr><th rowspan='2'>#</th><th rowspan='2'>Frame (s)</th>",
        "<th rowspan='2'>Audio (s)</th><th rowspan='2'>Tempo before</th>",
        "<th colspan='4'>Grouped (2x rule)</th><th colspan='4'>Variant: local peaks only</th>",
        "</tr><tr>",
        "<th>Group</th><th>Frame (s)</th><th>Tempo</th><th>Estimated start shift (s)</th>" * 2,
        "</tr>",
    ]
    for index in range(len(entry["blocks"])):
        alone = owner(before, index)
        cells = [
            f"<td class='n'>{index}</td><td class='n'>{alone['frame_samples'] / rate:.3f}</td>",
            f"<td class='n'>{alone['audible_samples'] / rate:.3f}</td>",
            f"<td class='n'>{mark(alone['tempo_factor'] or 1.0)}</td>",
        ]
        for mode_name in ("grouped", "relative"):
            run = runs[mode_name]
            group = owner(run, index)
            shifts = {
                r["block"]: (r["estimated_sample"] - r["planned_sample"]) / rate
                for r in run["removed_boundaries"]
            }
            span = (
                f"{group['first_block']}-{group['last_block']}"
                if group["first_block"] != group["last_block"]
                else "-"
            )
            cells.append(
                f"<td>{span}</td><td class='n'>{group['frame_samples'] / rate:.3f}</td>"
                f"<td class='n'>{mark(group['tempo_factor'] or 1.0)}</td>"
                f"<td class='n'>{f'{shifts[index]:+.2f}' if index in shifts else ''}</td>"
            )
        rows.append(f"<tr>{''.join(cells)}</tr>")
    rows.append("</table></div>")
    return "".join(rows)


if __name__ == "__main__":
    sys.exit(main())
