"""Timestamp parsing and target-duration calculation.

Format for Milestone 1 is HH:MM:SS. Hours have at least two digits and may have more
(e.g. 100:00:00). Minutes and seconds are two digits in the range 00-59.
"""

import re

_TIMESTAMP_RE = re.compile(r"^(\d{2,}):([0-5]\d):([0-5]\d)$")

# Durations are stored as PostgreSQL INTEGER seconds.
MAX_SECONDS = 2**31 - 1


class TimestampError(ValueError):
    pass


def parse_timestamp(value: str) -> int:
    """Return the timestamp as whole seconds."""
    match = _TIMESTAMP_RE.fullmatch(value.strip())
    if match is None:
        raise TimestampError("Timestamp must use the HH:MM:SS format, for example 00:06:10.")
    hours, minutes, seconds = (int(part) for part in match.groups())
    total = hours * 3600 + minutes * 60 + seconds
    if total > MAX_SECONDS:
        raise TimestampError("Timestamp is outside the supported range.")
    return total


def target_duration_seconds(first_sentence_start: int, last_sentence_start: int) -> int:
    """Target = START of the last sentence - START of the first sentence.

    No time is added for reading the final sentence (product decision); the audio must
    still contain the whole transcript, compressed or stretched to this length later.
    """
    if last_sentence_start <= first_sentence_start:
        raise TimestampError(
            "Last Sentence Start Time must be later than First Sentence Start Time."
        )
    return last_sentence_start - first_sentence_start


def format_seconds(total: int) -> str:
    hours, remainder = divmod(total, 3600)
    minutes, seconds = divmod(remainder, 60)
    return f"{hours:02d}:{minutes:02d}:{seconds:02d}"
