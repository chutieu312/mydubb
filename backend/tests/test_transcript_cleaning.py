"""Transcript cleaning: remove timing markup, never spoken content."""

import pytest

from app.transcript.cleaning import clean_transcript

# --- Plain text: timestamp-like content must survive -------------------------------------


@pytest.mark.parametrize(
    "text",
    [
        "10:30 is our meeting time.",
        "16:30 is the aspect ratio.",
        "10:30 is our meeting time.\n16:30 is the aspect ratio.",
        "Spring Boot uses Dependency Injection.\nREST API calls return JSON.",
        "Use a 16:9 ratio, port 8080 and Java 21.\nThe build took 1:05:00 on CI.",
        "The answer is\n42\nand the next step is 3.",
        "Meet at\n10:30",
        "00:01:00 is when we start, and 00:00:30 was the warm-up.\n00:00:10 earlier.",
    ],
)
def test_plain_text_with_times_and_numbers_is_preserved(text):
    assert clean_transcript(text) == text


def test_whitespace_is_normalized_without_reordering():
    raw = "  First   sentence.\n\n\tSecond sentence.  \nFinal sentence."
    assert clean_transcript(raw) == "First sentence.\nSecond sentence.\nFinal sentence."


# --- Supported timestamped formats --------------------------------------------------------


def test_srt_cues_are_cleaned_and_final_sentence_kept():
    raw = (
        "1\n00:00:01,000 --> 00:00:04,000\nSpring Boot uses Dependency Injection.\n\n"
        "2\n00:00:04,500 --> 00:00:08,000\nIt manages objects\nautomatically.\n\n"
        "3\n00:00:08,000 --> 00:00:10,000\n10:30 is the final sentence.\n"
    )
    assert clean_transcript(raw) == (
        "Spring Boot uses Dependency Injection.\n"
        "It manages objects\nautomatically.\n"
        "10:30 is the final sentence."
    )


def test_srt_without_blank_lines_drops_indices_but_keeps_numeric_content():
    raw = (
        "1\n00:00:01,000 --> 00:00:04,000\nThe answer is\n42\n"
        "2\n00:00:04,000 --> 00:00:06,000\nLast sentence."
    )
    assert clean_transcript(raw) == "The answer is\n42\nLast sentence."


def test_webvtt_header_notes_identifiers_and_tags_are_removed():
    raw = (
        "WEBVTT - Lesson 1\nKind: captions\nLanguage: en\n\n"
        "NOTE This is a comment\nspanning two lines\n\n"
        "STYLE\n::cue { color: yellow }\n\n"
        "intro\n00:01.000 --> 00:04.000 align:start position:10%\n"
        "<v Instructor>Welcome to <c.highlight>Kafka</c> &amp; Docker.\n\n"
        "00:04.000 --> 00:06.000\n<00:04.500>16:30 is the aspect ratio.\n"
    )
    assert clean_transcript(raw) == "Welcome to Kafka & Docker.\n16:30 is the aspect ratio."


def test_standalone_timestamp_lines_are_removed_when_structured():
    raw = "0:00\nFirst sentence.\n0:04\nSecond sentence.\n1:02:03\nFinal sentence."
    assert clean_transcript(raw) == "First sentence.\nSecond sentence.\nFinal sentence."


def test_bracketed_timestamps_are_markers():
    raw = "[00:00:01] First sentence.\n(0:05) Second sentence.\n[01:10]\nFinal sentence."
    assert clean_transcript(raw) == "First sentence.\nSecond sentence.\nFinal sentence."


def test_hms_prefixes_are_removed_when_structured():
    raw = "00:00:01 First sentence.\n00:00:05 Second sentence.\n00:01:00 Final sentence."
    assert clean_transcript(raw) == "First sentence.\nSecond sentence.\nFinal sentence."


@pytest.mark.parametrize(
    "raw",
    [
        "00:00:01 Only one prefixed line.",
        "00:05:00 starts here.\n00:01:00 goes backwards.",
    ],
)
def test_ambiguous_hms_prefixes_are_preserved(raw):
    assert clean_transcript(raw) == raw


@pytest.mark.parametrize("raw", ["", "   \n\t ", "00:00:01\n00:00:05\n", "[00:01]\n"])
def test_content_free_input_cleans_to_empty(raw):
    assert clean_transcript(raw) == ""
