"""Live Azure Translator smoke test with a short synthetic transcript.

Run from `backend/` after setting AZURE_TRANSLATOR_KEY (and AZURE_TRANSLATOR_REGION for a
regional resource) in your shell or in the git-ignored `backend/.env`:

    uv run python -m scripts.azure_translator_smoke

It sends ONE request of about 250 characters (no user data) to the real service, so it uses
a trivial part of the free quota. It prints the translation and checks that every glossary
term in the sample came back exactly as written. Exit code 0 means the live service,
credentials, no-translate handling and parsing all work; unit tests with fake HTTP cannot
prove that.
"""

import os
import sys

from dotenv import load_dotenv
from pydantic import SecretStr

from app.config import DEFAULT_AZURE_TRANSLATOR_ENDPOINT
from app.processing_errors import ProcessingError
from app.translation.azure import AzureTranslationProvider
from app.translation.glossary import default_glossary

SAMPLE = """A neural network uses gradient descent to minimize the loss function.
Spring Boot uses Dependency Injection to automatically manage objects.
The API returns JSON when a pull request triggers CI/CD, and 5 < 7 & 3 > 2."""


def main() -> int:
    load_dotenv()
    key = os.environ.get("AZURE_TRANSLATOR_KEY", "").strip()
    if not key:
        print("AZURE_TRANSLATOR_KEY is not set; see docs/DEPLOYMENT.md (Azure Translator).")
        return 2

    glossary = default_glossary()
    provider = AzureTranslationProvider(
        key=SecretStr(key),
        region=os.environ.get("AZURE_TRANSLATOR_REGION") or None,
        endpoint=os.environ.get("AZURE_TRANSLATOR_ENDPOINT", DEFAULT_AZURE_TRANSLATOR_ENDPOINT),
        glossary=glossary,
        timeout_seconds=30,
        max_request_chars=10_000,
    )
    try:
        result = provider.translate(SAMPLE)
    except ProcessingError as exc:
        print(f"FAILED ({exc.code}): {exc.user_message}")
        return 1

    print("English:\n" + SAMPLE + "\n\nVietnamese:\n" + result.text + "\n")
    missing = [
        match.text
        for line in SAMPLE.split("\n")
        for match in glossary.find_matches(line)
        if match.text not in result.text
    ]
    if missing:
        print(f"FAILED: terms missing from the translation: {missing}")
        return 1
    print("OK: all glossary terms in the sample are preserved exactly as written.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
