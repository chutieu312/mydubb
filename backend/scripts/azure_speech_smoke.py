"""Live Azure Speech smoke test: writes MP3 samples for a Product Owner to LISTEN to.

Run from `backend/` after setting AZURE_SPEECH_KEY and AZURE_SPEECH_REGION (and having
ffmpeg and ffprobe on PATH) in your shell or in the git-ignored `backend/.env`:

    uv run python -m scripts.azure_speech_smoke                 # both voices, 2 requests
    uv run python -m scripts.azure_speech_smoke --multi-chunk   # also exercises joining

It sends only the synthetic transcript below (no user data), once per voice, and writes
`speech-AndrewMultilingual.mp3` / `speech-EmmaMultilingual.mp3` (and
`speech-multi-chunk-<voice>.mp3`) into `--output-dir` (default `speech-samples/`,
git-ignored). Each voice costs about 260 characters; `--multi-chunk` adds the same again per
voice, in 4 requests (one per line) through a tiny chunk limit, to test chunking and joining
without spending quota. That is 10 requests in all, under the Free (F0) limit of 20 per minute.

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

# The synthetic transcript the Product Owner auditioned and accepted for both voices. It
# contains the terms to evaluate: neural network, gradient descent, loss function, Spring Boot,
# Dependency Injection, REST API, JSON, pipeline and CI/CD.
SAMPLE = (
    "Hôm nay chúng ta tìm hiểu cách một neural network học từ dữ liệu.\n"
    "Mô hình sử dụng gradient descent để giảm thiểu loss function.\n"
    "Spring Boot sử dụng Dependency Injection để quản lý các đối tượng.\n"
    "Ứng dụng gọi REST API, nhận dữ liệu JSON và chạy pipeline CI/CD."
)
# The same text with a tiny chunk limit: one chunk (request) per line, to test joining.
MULTI_CHUNK_LIMIT = 80  # below the app's minimum on purpose


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
        jobs.append(("speech-multi-chunk", SAMPLE, MULTI_CHUNK_LIMIT))

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
