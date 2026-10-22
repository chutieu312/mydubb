"""Transcript normalization.

Users paste transcripts copied from course players, with or without timestamps. Cleaning
removes timing markup while keeping all spoken text in its original order. Formats are
recognized from the structure of the whole document; when a timestamp-like token could be
spoken content, it is preserved.

Supported formats and rules:

* WebVTT (first line starts with "WEBVTT"): the header block, NOTE/STYLE/REGION blocks,
  cue identifiers, cue timing lines and inline cue tags (e.g. "<c>", "<00:00:01.000>",
  "<v Speaker>") are removed; HTML entities in cue text are decoded.
* SRT, or any text containing cue timing lines ("00:00:01,000 --> 00:00:04,000"): timing
  lines are removed, together with a numeric cue index on the line right before a timing
  line (also when the blank lines between cues were lost in copying).
* Bracketed timestamps ("[00:01:02] text", "(0:05) text", or a line that is only
  "[00:01]"): always treated as markers.
* Standalone timestamp lines ("0:05" alone on a line, as in YouTube-style copies): removed
  only when there are at least two and their times never decrease.
* Unbracketed H:MM:SS prefixes ("00:01:02 text"): removed only when at least two lines carry
  one and their times never decrease.

Ambiguous cases that are preserved as spoken content:

* Unbracketed M:SS / HH:MM prefixes ("10:30 is our meeting time.", "16:30 is the aspect
  ratio."), because they are indistinguishable from clock times and ratios.
* A single standalone or prefixed timestamp, or timestamps that go backwards.
* Numeric lines that are not directly followed by a cue timing line.
"""

import html
import re
from itertools import pairwise

_TIME = r"(?:\d{1,2}:)?\d{1,2}:\d{2}(?:[.,]\d{1,3})?"

# "00:00:01,000 --> 00:00:04,000" with optional WebVTT cue settings after it.
_CUE_TIMING = re.compile(rf"^{_TIME}\s*-->\s*{_TIME}(?:\s+.*)?$")
_BRACKETED_ONLY = re.compile(rf"^(?:\[{_TIME}\]|\({_TIME}\))$")
_BRACKETED_PREFIX = re.compile(rf"^(?:\[{_TIME}\]|\({_TIME}\))\s*(?=\S)")
_STANDALONE = re.compile(rf"^({_TIME})$")
_HMS_PREFIX = re.compile(r"^(\d{1,2}:\d{2}:\d{2}(?:[.,]\d{1,3})?)\s+(?=\S)")
_VTT_BLOCK_KEYWORDS = re.compile(r"^(?:WEBVTT|NOTE|STYLE|REGION)(?:\s|$)")
_VTT_TAG = re.compile(r"<[^>]*>")
_WHITESPACE = re.compile(r"\s+")


def clean_transcript(raw: str) -> str:
    """Return the spoken text with timing markup removed and whitespace normalized."""
    lines = [line.strip() for line in raw.replace("\r\n", "\n").replace("\r", "\n").split("\n")]
    first = next((line for line in lines if line), "")
    if first.startswith("WEBVTT"):
        kept = _clean_cue_document(lines, webvtt=True)
    elif any(_CUE_TIMING.match(line) for line in lines):
        kept = _clean_cue_document(lines, webvtt=False)
    else:
        kept = _clean_plain_document(lines)
    normalized = (_WHITESPACE.sub(" ", line).strip() for line in kept)
    return "\n".join(line for line in normalized if line)


def _clean_cue_document(lines: list[str], *, webvtt: bool) -> list[str]:
    kept: list[str] = []
    block_start = True  # the current line is the first line of a blank-separated block
    skipping_block = False  # inside a WebVTT header/NOTE/STYLE/REGION block
    previous_kept = False  # the previous line was kept (so it is kept[-1])
    previous_starts_block = False  # ...and it was the first line of its block

    for line in lines:
        if not line:
            block_start, skipping_block = True, False
            previous_kept = previous_starts_block = False
            continue
        if skipping_block:
            continue
        if webvtt and block_start and _VTT_BLOCK_KEYWORDS.match(line):
            skipping_block, block_start = True, False
            continue
        if _CUE_TIMING.match(line):
            # The line right before a timing line is its cue identifier: a numeric index
            # (SRT; also when blank lines were lost in copying) or, in WebVTT, any text
            # that starts the block.
            if previous_kept and (kept[-1].isdigit() or (webvtt and previous_starts_block)):
                kept.pop()
            block_start = previous_kept = previous_starts_block = False
            continue
        if webvtt:
            line = html.unescape(_VTT_TAG.sub("", line))
        kept.append(line)
        previous_kept, previous_starts_block, block_start = True, block_start, False
    return kept


def _clean_plain_document(lines: list[str]) -> list[str]:
    standalone = [m.group(1) for line in lines if (m := _STANDALONE.match(line))]
    drop_standalone = len(standalone) >= 2 and _non_decreasing(standalone)
    prefixes = [m.group(1) for line in lines if (m := _HMS_PREFIX.match(line))]
    strip_hms_prefix = len(prefixes) >= 2 and _non_decreasing(prefixes)

    kept: list[str] = []
    for line in lines:
        if _BRACKETED_ONLY.match(line):
            continue
        if drop_standalone and _STANDALONE.match(line):
            continue
        line = _BRACKETED_PREFIX.sub("", line)
        if strip_hms_prefix:
            line = _HMS_PREFIX.sub("", line)
        kept.append(line)
    return kept


def _non_decreasing(timestamps: list[str]) -> bool:
    seconds = [_to_seconds(t) for t in timestamps]
    return all(a <= b for a, b in pairwise(seconds))


def _to_seconds(timestamp: str) -> float:
    whole, _, fraction = timestamp.replace(",", ".").partition(".")
    total = 0
    for part in whole.split(":"):
        total = total * 60 + int(part)
    return total + (float(f"0.{fraction}") if fraction else 0.0)
