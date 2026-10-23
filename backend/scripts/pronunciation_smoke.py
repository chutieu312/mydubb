# ruff: noqa: RUF001  (the sample keeps its typographic apostrophes)
"""English detection on a synthetic sample: classification, SSML and MP3s to LISTEN to.

Run from `backend/`:

    uv run python -m scripts.pronunciation_smoke                # offline: table and SSML only
    uv run python -m scripts.pronunciation_smoke --translate    # + 1 Azure Translator request
    uv run python -m scripts.pronunciation_smoke --speak        # + 4 Azure Speech requests

The sample is the synthetic transcript the Product Owner supplied for acceptance (no user
data). Without `--translate` it uses the Vietnamese that Azure Translator returned for it on
2026-10-23. Nothing is stored in a database.

`--speak` synthesizes the translation once per voice twice: with the shared glossary only
(`before-<voice>.mp3`, how production reads it today) and with the detected English
(`after-<voice>.mp3`), into `--output-dir` (default `pronunciation-samples/`, git-ignored).
That is 4 requests of about 400 characters each on the F0 resource (limit 20 per minute).
Keys come from the environment or the git-ignored `backend/.env`; ffmpeg/ffprobe must be on
PATH (they are in the Docker image). Exit code 0 only means the requests worked and the MP3s
are valid: whether `container`, `Kernel`, `trenchcoat` or `/proc` sound right is for a person
to judge by listening.
"""

import argparse
import os
import sys
import tempfile
from pathlib import Path

from dotenv import load_dotenv
from pydantic import SecretStr

from app.processing_errors import ProcessingError
from app.pronunciation.detector import detect_english
from app.speech.ssml import build_ssml
from app.speech.voices import Voice
from app.translation.glossary import default_glossary

SAMPLE_EN = (
    "I decided to make my own container runtime for fun, and even though I’m still early on, "
    "I’ve learned that Docker is weird.\n"
    "Containers aren’t real. Unlike VMs, containers are just processes with special "
    "restrictions on them. Your kernel is still running that process! And if you know where "
    "to look, you can even find that process in /proc.\n"
    "There’s not really a linux feature that’s just ‘containers’ either. Instead, containers "
    "are really 5 different linux kernel features in trenchcoat."
)
# Azure Translator (F0, Global endpoint) on 2026-10-23 with this branch's glossary.
SAMPLE_VI = (
    "Tôi quyết định tự làm container runtime cho vui, và dù vẫn còn sớm, tôi đã nhận ra "
    "Docker rất kỳ lạ.\n"
    "Container không phải là thật. Không giống như máy ảo, container chỉ là các tiến trình "
    "với những hạn chế đặc biệt. Kernel của bạn vẫn đang chạy tiến trình đó! Và nếu bạn biết "
    "chỗ tìm, bạn thậm chí có thể tìm thấy tiến trình đó trong /proc.\n"
    "Thực ra không có tính năng linux nào chỉ là 'containers' thôi. Thay vào đó, container "
    "thực ra là 5 đặc điểm linux kernel khác nhau trong trenchcoat."
)


def translate() -> str | None:
    from app.config import DEFAULT_AZURE_TRANSLATOR_ENDPOINT
    from app.translation.azure import AzureTranslationProvider

    key = os.environ.get("AZURE_TRANSLATOR_KEY", "").strip()
    if not key:
        print("AZURE_TRANSLATOR_KEY is not set; see docs/DEPLOYMENT.md.")
        return None
    provider = AzureTranslationProvider(
        key=SecretStr(key),
        region=os.environ.get("AZURE_TRANSLATOR_REGION") or None,
        endpoint=os.environ.get("AZURE_TRANSLATOR_ENDPOINT", DEFAULT_AZURE_TRANSLATOR_ENDPOINT),
        glossary=default_glossary(),
        timeout_seconds=30,
        max_request_chars=10_000,
    )
    return provider.translate(SAMPLE_EN).text


def speak(translation: str, terms, output_dir: Path) -> int:
    from app.audio.ffmpeg import locate_tools
    from app.speech.azure import AzureSpeechProvider
    from app.speech.rate_limit import RequestRateLimiter

    key = os.environ.get("AZURE_SPEECH_KEY", "").strip()
    region = os.environ.get("AZURE_SPEECH_REGION", "").strip()
    tools = locate_tools()
    if not key or not region or tools is None:
        print("AZURE_SPEECH_KEY/AZURE_SPEECH_REGION and ffmpeg/ffprobe on PATH are required.")
        return 2
    output_dir.mkdir(parents=True, exist_ok=True)
    limiter = RequestRateLimiter(20, 60)
    for voice in Voice:
        for label, job_terms in (("before", None), ("after", terms)):
            provider = AzureSpeechProvider(
                key=SecretStr(key),
                region=region,
                glossary=default_glossary(),
                tools=tools,
                limiter=limiter,
                timeout_seconds=60,
                max_chunk_chars=2000,
            )
            with tempfile.TemporaryDirectory(prefix="mydubb-pronunciation-") as work:
                audio = provider.synthesize(translation, voice, Path(work), job_terms)
                target = output_dir / f"{label}-{voice.value}.mp3"
                target.write_bytes(audio.path.read_bytes())
            print(f"wrote {target} ({target.stat().st_size} bytes)")
    print(
        "\nOK: 4 requests succeeded and the MP3s are valid. LISTEN to before/after: this script\n"
        "cannot tell whether the English terms, the Vietnamese and the code sound right."
    )
    return 0


def main() -> int:
    load_dotenv()
    sys.stdout.reconfigure(encoding="utf-8")  # type: ignore[union-attr]
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--translate", action="store_true", help="translate live (1 request)")
    parser.add_argument("--speak", action="store_true", help="synthesize (4 requests)")
    parser.add_argument("--output-dir", type=Path, default=Path("pronunciation-samples"))
    args = parser.parse_args()

    try:
        translation = translate() if args.translate else SAMPLE_VI
        if translation is None:
            return 2
        detection = detect_english(SAMPLE_EN, translation, default_glossary())
        print("Vietnamese:\n" + translation + "\n")
        print("en-US spans (kind: text):")
        for span in detection.spans:
            print(f"  {span.kind.value:<12} {span.text}")
        print("glossary candidates (pending review, never approved automatically):")
        for candidate in detection.candidates:
            print(f"  {candidate.kind.value:<12} {candidate.term}  (key {candidate.key!r})")
        print(f"counts: {detection.counts()}\n")
        for number, line in enumerate(translation.split("\n"), start=1):
            ssml = build_ssml(line, Voice.ANDREW, detection.speech_terms)
            print(f"SSML line {number}:\n{ssml}\n")
        if args.speak:
            return speak(translation, detection.speech_terms, args.output_dir)
    except ProcessingError as exc:
        print(f"FAILED ({exc.code}): {exc.user_message}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
