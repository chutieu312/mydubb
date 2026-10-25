"""Live Supadata smoke test: import the English captions of public YouTube videos.

Run by hand from `backend/`, never in CI, after setting SUPADATA_API_KEY in your shell or in the
git-ignored `backend/.env` (never on the command line or in chat):

    uv run python -m scripts.supadata_smoke --confirm-credits 2 \\
        "https://www.youtube.com/watch?v=..." "https://youtu.be/..."

Each link is ONE initial request with `mode=native`, which costs 1 credit, also when the video
has no captions (206). Status polls of an asynchronous job are free. `--confirm-credits` must
equal the number of links, so the spend is stated before anything is sent; nothing is retried.
Supadata's Free plan has 100 credits a month and 1 request per second; this script uses the same
limiter as the app (one request every two seconds) and calls nothing else (no Azure, no job).

For every link it prints the outcome: the returned language, the number of captions, empty
captions left out, the first and last start times in milliseconds, how many start times have a
non-zero millisecond part, the first captions as imported, latency, requests and polls, and the
billed credits Supadata reports (`x-billable-requests`). It also checks that the transcript
reads back through today's plain cleaning as exactly the caption texts. Judging the content
(spelling, technical terms, whether captions were auto-generated) is left to the reader.
Exit code 0 means every link ended with a result or a clean, expected error.
"""

import argparse
import os
import sys

from dotenv import load_dotenv
from pydantic import SecretStr

from app.speech.rate_limit import RequestRateLimiter
from app.transcript.cleaning import clean_transcript
from app.youtube_import.base import ImportFailure
from app.youtube_import.supadata import SupadataCaptionProvider
from app.youtube_import.youtube_url import InvalidYouTubeUrl, parse_youtube_url

PREVIEW_CAPTIONS = 4


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("links", nargs="+", help="public YouTube video links")
    parser.add_argument(
        "--confirm-credits",
        type=int,
        required=True,
        help="credits you allow this run to use: must equal the number of links",
    )
    args = parser.parse_args(argv)
    load_dotenv()
    sys.stdout.reconfigure(encoding="utf-8")

    if args.confirm_credits != len(args.links):
        print(
            f"--confirm-credits is {args.confirm_credits} but {len(args.links)} link(s) were "
            "given; each link costs 1 credit. Nothing was sent."
        )
        return 2
    try:
        videos = [parse_youtube_url(link) for link in args.links]
    except InvalidYouTubeUrl as exc:
        print(f"Invalid link, nothing was sent: {exc}")
        return 2
    key = os.environ.get("SUPADATA_API_KEY", "").strip()
    if not key:
        print("SUPADATA_API_KEY is not set; see docs/DEPLOYMENT.md (YouTube caption import).")
        return 2

    provider = SupadataCaptionProvider(
        key=SecretStr(key),
        limiter=RequestRateLimiter(1, 1),
        timeout_seconds=30,
        deadline_seconds=90,
        poll_interval_seconds=1,
    )
    unexpected = 0
    for video in videos:
        print(f"\n=== {video.canonical_url}")
        try:
            track, stats = provider.fetch(video)
        except ImportFailure as exc:
            print(f"error: {exc.code} (HTTP {exc.status_code} in MyDubb): {exc.message}")
            continue
        except Exception as exc:
            # A smoke test reports anything unexpected, by type only (no provider text).
            print(f"UNEXPECTED {type(exc).__name__}")
            unexpected += 1
            continue
        captions = track.captions
        with_ms = sum(1 for caption in captions if caption.start_ms % 1000)
        print(
            f"language={track.language} captions={len(captions)} "
            f"skipped_empty={track.skipped_empty} first_start_ms={track.first_start_ms} "
            f"last_start_ms={track.last_start_ms} starts_with_milliseconds={with_ms}"
        )
        print(f"suggested time fields: {track.suggested_starts()}")
        print(
            f"latency={stats.latency_seconds:.2f}s requests={stats.requests} polls={stats.polls} "
            f"billed_credits={'-' if stats.billed_credits is None else stats.billed_credits}"
        )
        preview = track.transcript.split("\n")[: 2 * PREVIEW_CAPTIONS]
        print("first captions as imported:\n  " + "\n  ".join(preview))
        cleaned = clean_transcript(track.transcript).split("\n")
        expected = [" ".join(caption.text.split()) for caption in captions]
        print(f"plain cleaning keeps every caption text in order: {cleaned == expected}")
        if cleaned != expected:
            unexpected += 1
    return 1 if unexpected else 0


if __name__ == "__main__":
    sys.exit(main())
