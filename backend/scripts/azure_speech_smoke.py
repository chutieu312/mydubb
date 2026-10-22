"""Live Azure Speech smoke test: writes MP3 samples for a Product Owner to LISTEN to.

Run from `backend/` after setting AZURE_SPEECH_KEY and AZURE_SPEECH_REGION (and having
ffmpeg and ffprobe on PATH) in your shell or in the git-ignored `backend/.env`:

    uv run python -m scripts.azure_speech_smoke                 # both voices, 2 requests
    uv run python -m scripts.azure_speech_smoke --multi-chunk   # also exercises joining

It sends only the short synthetic Vietnamese sentences below (no user data) and writes
`speech-HoaiMy.mp3` / `speech-NamMinh.mp3` (and `speech-multi-chunk-<voice>.mp3`) into
`--output-dir` (default `speech-samples/`, git-ignored). Each voice costs about 300
characters; `--multi-chunk` adds about 190 more per voice and 4 requests, using a tiny chunk
limit (one request per sentence) so chunking and joining are tested without spending quota.

Exit code 0 only means the requests succeeded and the MP3 files are structurally valid.
It does NOT prove that the pronunciation is good: a person must listen to the files.
"""

import argparse
import os
import sys
import tempfile
from pathlib import Path

from dotenv import load_dotenv
from pydantic import SecretStr

from app.audio.ffmpeg import locate_tools
from app.processing_errors import ProcessingError
from app.speech.azure import AzureSpeechProvider
from app.speech.rate_limit import RequestRateLimiter
from app.speech.voices import Voice
from app.translation.glossary import default_glossary

# Synthetic Vietnamese text with the terms the Product Owner asked to evaluate.
SAMPLE = (
    "Một neural network sử dụng gradient descent để giảm thiểu loss function. "
    "Spring Boot dùng Dependency Injection để quản lý các đối tượng. "
    "Ứng dụng gọi REST API và nhận dữ liệu JSON sau khi pipeline CI/CD chạy xong."
)
# Used with a tiny chunk limit: one chunk (request) per sentence.
MULTI_CHUNK_SAMPLE = (
    "Đây là câu thứ nhất, nói về neural network. "
    "Đây là câu thứ hai, nói về gradient descent. "
    "Đây là câu thứ ba, nói về loss function và JSON. "
    "Đây là câu thứ tư, nói về Spring Boot và REST API."
)
MULTI_CHUNK_LIMIT = 80  # below the app's minimum on purpose: one chunk per sentence


def main() -> int:
    load_dotenv()
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--output-dir", type=Path, default=Path("speech-samples"))
    parser.add_argument("--multi-chunk", action="store_true", help="also test joining chunks")
    args = parser.parse_args()

    key = os.environ.get("AZURE_SPEECH_KEY", "").strip()
    region = os.environ.get("AZURE_SPEECH_REGION", "").strip()
    if not key or not region:
        print("AZURE_SPEECH_KEY and AZURE_SPEECH_REGION are not set; see docs/DEPLOYMENT.md.")
        return 2
    tools = locate_tools()
    if tools is None:
        print("ffmpeg and ffprobe must be on PATH (they are included in the Docker image).")
        return 2

    args.output_dir.mkdir(parents=True, exist_ok=True)
    jobs = [("speech", SAMPLE, 2000)]
    if args.multi_chunk:
        jobs.append(("speech-multi-chunk", MULTI_CHUNK_SAMPLE, MULTI_CHUNK_LIMIT))

    for voice in Voice:
        for label, text, max_chars in jobs:
            provider = AzureSpeechProvider(
                key=SecretStr(key),
                region=region,
                glossary=default_glossary(),
                tools=tools,
                limiter=RequestRateLimiter(20, 60),
                timeout_seconds=60,
                max_chunk_chars=max_chars,
            )
            with tempfile.TemporaryDirectory(prefix="mydubb-smoke-") as work:
                try:
                    audio = provider.synthesize(text, voice, Path(work))
                except ProcessingError as exc:
                    print(f"FAILED ({exc.code}): {exc.user_message}")
                    return 1
                target = args.output_dir / f"{label}-{voice.value}.mp3"
                target.write_bytes(audio.path.read_bytes())
            print(f"wrote {target} ({target.stat().st_size} bytes)")

    print(
        "\nOK: the requests succeeded and the MP3 files are structurally valid.\n"
        "Now LISTEN to the files: this script cannot tell whether the Vietnamese is clear, the\n"
        "English terms are recognizable, no sentence is lost or repeated, and pauses sound right."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
