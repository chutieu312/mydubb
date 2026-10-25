"""Caption checks and the timestamped transcript written for the form (no network)."""

import math

import pytest

from app.transcript.cleaning import clean_transcript
from app.youtube_import.captions import (
    CaptionError,
    RawCaption,
    build_track,
    caption_text,
    format_caption_time,
)


def track(*captions: tuple[object, object, object]):
    return build_track(
        "en", [RawCaption(text, offset, duration) for text, offset, duration in captions]
    )


@pytest.mark.parametrize(
    ("ms", "expected"),
    [
        (0, "0:00.000"),
        (480, "0:00.480"),
        (1, "0:00.001"),
        (59_999, "0:59.999"),
        (60_000, "1:00.000"),
        (754_321, "12:34.321"),
        (3_599_999, "59:59.999"),
        (3_600_000, "1:00:00.000"),
        (3_723_004, "1:02:03.004"),
        (36_000_000 + 5, "10:00:00.005"),
        (99 * 3_600_000 + 3_599_999, "99:59:59.999"),
    ],
)
def test_caption_times_keep_milliseconds(ms, expected):
    assert format_caption_time(ms) == expected


def test_the_transcript_is_one_time_line_then_one_text_line_per_caption():
    result = track(
        ("Welcome back.", 480, 2000),
        ("Today: gradient descent!", 2960, 1500),
        ("Bye", 3_723_004, 900),
    )
    assert result.transcript == (
        "0:00.480\nWelcome back.\n0:02.960\nToday: gradient descent!\n1:02:03.004\nBye"
    )
    assert [c.start_ms for c in result.captions] == [480, 2960, 3_723_004]
    assert result.language == "en"
    assert result.skipped_empty == 0


def test_words_punctuation_unicode_and_repetitions_are_kept_exactly():
    texts = [
        "So, so, so... we use Node.js and C++ (and C#).",
        "So, so, so... we use Node.js and C++ (and C#).",  # a repeated caption stays
        "uh uh I I think it's 10:30 now, naïve café — “quoted” 日本語 🙂",
        'Spring Boot\'s REST API returns JSON; e.g. {"id": 1} & <b>not html</b>',
        "&amp; &#39; stay as sent",
        "[Music]",
    ]
    result = track(*((text, i * 1000, 500) for i, text in enumerate(texts)))
    assert [c.text for c in result.captions] == texts
    assert result.transcript.split("\n")[1::2] == texts


def test_line_breaks_inside_a_caption_become_one_space_and_nothing_else_changes():
    assert caption_text("first line\nsecond line") == "first line second line"
    assert caption_text("  a  \r\n  b\rc\u2028d  ") == "a b c d"
    assert caption_text("a\n\n\nb") == "a b"
    assert caption_text("double  space  kept") == "double  space  kept"
    result = track(("one\ntwo", 0, 1), ("three", 1000, 1))
    assert result.transcript == "0:00.000\none two\n0:01.000\nthree"


def test_equal_start_times_are_kept_in_the_provider_order():
    result = track(("b second", 5100, 1), ("a first", 5100, 1), ("c", 5100, 0))
    assert [c.text for c in result.captions] == ["b second", "a first", "c"]


def test_decreasing_start_times_are_refused_not_sorted():
    with pytest.raises(CaptionError) as error:
        track(("one", 2000, 1), ("two", 1999, 1))
    assert error.value.code == "youtube_import_invalid_response"


@pytest.mark.parametrize(
    "bad",
    [True, False, None, "1000", [1000], {"ms": 1}, -1, -0.5, math.inf, -math.inf, math.nan],
)
@pytest.mark.parametrize("field", ["offset", "duration"])
def test_times_must_be_finite_non_negative_numbers(bad, field):
    offset, duration = (bad, 1) if field == "offset" else (0, bad)
    with pytest.raises(CaptionError) as error:
        track(("text", offset, duration))
    assert error.value.code == "youtube_import_invalid_response"


def test_huge_integer_times_are_refused_without_crashing():
    with pytest.raises(CaptionError):
        track(("text", 10**400, 1))
    with pytest.raises(CaptionError):
        track(("text", 100 * 3_600_000, 1))  # 100 hours needs a third hour digit
    # A huge duration does not matter: only start times are used.
    assert track(("text", 0, 10**400)).captions[0].duration_ms == 10**400


def test_fractional_milliseconds_round_half_up_to_one_millisecond():
    result = track(("a", 1000.4, 1.5), ("b", 1000.5, 0), ("c", 2999.9, 0))
    assert [c.start_ms for c in result.captions] == [1000, 1001, 3000]
    assert result.captions[0].duration_ms == 2


@pytest.mark.parametrize("text", [None, 12, ["a"], {"t": "a"}, True])
def test_caption_text_must_be_a_string(text):
    with pytest.raises(CaptionError) as error:
        track((text, 0, 1))
    assert error.value.code == "youtube_import_invalid_response"


def test_empty_captions_are_left_out_and_counted():
    result = track(
        ("", 0, 1), ("hello", 1000, 1), ("   ", 1500, 1), ("\n", 1700, 1), ("bye", 2000, 1)
    )
    assert [c.text for c in result.captions] == ["hello", "bye"]
    assert result.skipped_empty == 3
    # The first caption with text gives the first start.
    assert result.first_start_ms == 1000


def test_captions_without_any_text_are_refused():
    for captions in ([], [("", 0, 1), (" ", 1000, 1)]):
        with pytest.raises(CaptionError) as error:
            track(*captions)
        assert error.value.code == "youtube_import_empty_captions"


@pytest.mark.parametrize(
    "text",
    # "16:9" alone is not a time for cleaning.py, but a timed reader that takes any short
    # colon-separated number line for a timestamp would stop on it, so it is refused too.
    ["10:30", "0:05", "1:02:03", "00:01:02.500", "[0:05]", "(1:00)", "3:07,25", "16:9"],
)
def test_a_caption_that_is_only_a_time_is_refused(text):
    with pytest.raises(CaptionError) as error:
        track(("intro", 0, 1), (text, 1000, 1))
    assert error.value.code == "youtube_import_ambiguous_caption"


@pytest.mark.parametrize(
    "text", ["10:30 is our meeting time.", "at 0:05", "16:9 screens", "1:2:3:4", "v1.2"]
)
def test_times_inside_spoken_text_are_fine(text):
    result = track(("intro", 0, 1), (text, 1000, 1))
    assert result.captions[1].text == text


def test_suggested_start_times_come_from_caption_starts_truncated_to_seconds():
    result = track(("first", 10_999, 4000), ("middle", 200_000, 1), ("last", 370_480, 9000))
    # Start of the last caption, never its end (370.48 + 9 s) or anything added.
    assert result.suggested_starts() == ("00:00:10", "00:06:10")
    assert (result.first_start_ms, result.last_start_ms) == (10_999, 370_480)
    long = track(("a", 0, 1), ("b", 3_723_999, 1))
    assert long.suggested_starts() == ("00:00:00", "01:02:03")


def test_no_suggestion_without_two_different_start_seconds():
    assert track(("only one", 4200, 1)).suggested_starts() is None
    assert track(("a", 4200, 1), ("b", 4200, 1)).suggested_starts() is None
    # Different milliseconds in the same second: the fields cannot express a baseline.
    assert track(("a", 4100, 1), ("b", 4900, 1)).suggested_starts() is None
    assert track(("a", 4900, 1), ("b", 5000, 1)).suggested_starts() == ("00:00:04", "00:00:05")


def test_the_plain_transcript_cleaning_reads_the_format_back_as_the_caption_texts():
    # What a job does with an imported transcript today: the time lines are removed and every
    # caption's text stays, in order, one per line.
    texts = [
        "Welcome back. Today we look at gradient descent.",
        "It minimizes the loss function",
        "of a neural network, step by step.",
        "[Music]",
        "10:30 is our meeting time.",
        "Done after an hour.",
    ]
    offsets = [480, 2960, 5100, 5100, 9250, 3_723_004]
    result = track(*((t, o, 1) for t, o in zip(texts, offsets, strict=True)))
    assert clean_transcript(result.transcript) == "\n".join(texts)
