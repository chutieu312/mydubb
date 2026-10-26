"""Timed transcripts: captions, sentence units, estimated block starts and the timeline (pure)."""

from fractions import Fraction

import pytest

from app.audio.speed import AudioSpeed, DurationTarget
from app.transcript.cleaning import clean_transcript
from app.transcript.timed import (
    MAX_UNIT_WORDS,
    TimedTranscriptError,
    has_timed_structure,
    parse_timed_transcript,
)

RATE = 24000

YOUTUBE = """0:00
Generally, if if somebody's trying to
0:01
make a company work, they should expect
0:03
to grind super hard. Uh except that
0:05
there's like some meaningful chance of
0:06
failure. I could not make a spaceship by
0:08
myself, but but uh with a collection of
0:11
humans, uh we can make spaceships. It's"""


def texts(raw: str) -> list[str]:
    return [block.text for block in parse_timed_transcript(raw).blocks]


def test_the_youtube_sample_becomes_sentences_with_estimated_starts() -> None:
    timed = parse_timed_transcript(YOUTUBE)
    assert [b.text for b in timed.blocks] == [
        "Generally, if if somebody's trying to make a company work, they should expect to grind "
        "super hard.",
        "Uh except that there's like some meaningful chance of failure.",
        # The last caption starts where the baseline ends, so "It's" is read in this block.
        "I could not make a spaceship by myself, but but uh with a collection of humans, uh we "
        "can make spaceships. It's",
    ]
    # "Uh" is word 5 of 7 in the caption from 0:03 to 0:05: 3 + 2 x 4/7 s, not rounded.
    assert [b.start for b in timed.blocks] == [Fraction(0), Fraction(29, 7), Fraction(25, 4)]
    assert [b.estimated_start for b in timed.blocks] == [False, True, True]
    assert (timed.source_first, timed.source_last, timed.source_baseline) == (0, 11, 11)


def test_every_word_and_punctuation_mark_is_kept_in_order() -> None:
    timed = parse_timed_transcript(YOUTUBE)
    assert " ".join(b.text for b in timed.blocks) == " ".join(c.text for c in timed.captions)
    assert clean_transcript(YOUTUBE).replace("\n", " ") == " ".join(b.text for b in timed.blocks)


def test_blocks_link_back_to_their_captions() -> None:
    timed = parse_timed_transcript(YOUTUBE)
    assert [(b.first_caption, b.last_caption) for b in timed.blocks] == [(0, 2), (2, 4), (4, 6)]


def test_the_last_caption_merged_into_an_earlier_block_keeps_the_baseline() -> None:
    # 0:11 is merged into the block that starts at 6.25 s; the baseline is still 0 -> 11.
    timed = parse_timed_transcript(YOUTUBE)
    assert timed.blocks[-1].start < timed.source_last
    assert timed.source_baseline == 11
    assert timed.boundaries(11, AudioSpeed.X1, RATE)[-1] == 11 * RATE


def test_offset_transcripts_measure_from_the_first_caption() -> None:
    shifted = YOUTUBE.replace("0:00", "1:02:00").replace("0:01", "1:02:01")
    for old, new in (("0:03", "1:02:03"), ("0:05", "1:02:05"), ("0:06", "1:02:06")):
        shifted = shifted.replace(old, new)
    shifted = shifted.replace("0:08", "1:02:08").replace("0:11", "1:02:11")
    timed = parse_timed_transcript(shifted)
    assert (timed.source_first, timed.source_last) == (3720, 3731)
    assert timed.blocks[1].start == 3720 + Fraction(29, 7)
    assert timed.ratios()[1] == Fraction(29, 77)


def test_a_caption_with_several_sentences_and_one_cut_mid_sentence() -> None:
    raw = "0:10\nYes. No. Maybe we\n0:14\nshould go. Fine\n0:20\nend."
    timed = parse_timed_transcript(raw)
    assert [b.text for b in timed.blocks] == ["Yes.", "No.", "Maybe we should go.", "Fine end."]
    assert [b.start for b in timed.blocks] == [10, 11, 12, 14 + Fraction(6 * 2, 3)]


def test_an_unfinished_end_is_kept() -> None:
    raw = "0:00\nWe start here.\n0:04\nAnd then we never"
    assert texts(raw) == ["We start here. And then we never"]


def test_a_single_block_uses_the_whole_baseline() -> None:
    timed = parse_timed_transcript("0:00\nOne long sentence without an end\n0:09\nstill going")
    assert len(timed.blocks) == 1
    assert timed.boundaries(9, AudioSpeed.X1_5, RATE) == [0, 6 * RATE]


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("0:00\nAsk Dr. Smith about it.\n0:05\nOkay.", ["Ask Dr. Smith about it. Okay."]),
        ("0:00\nPrices rose 3.5 percent today. Then\n0:06\nfell.", None),
        ("0:00\nWe use Node.js here. It\n0:04\nworks.", None),
        ("0:00\nTools, e.g. Docker and the U.S. Army.\n0:05\nYes.", None),
        ("0:00\nso... we wait. Next\n0:05\nstep.", None),
    ],
)
def test_no_false_sentence_boundaries(raw: str, expected: list[str] | None) -> None:
    blocks = texts(raw)
    if expected is not None:
        assert blocks == expected
    # Nothing is split inside an abbreviation, a decimal, Node.js, an acronym or "...".
    for text in blocks:
        for piece in ("Dr.", "3.5", "Node.js", "e.g.", "U.S.", "so..."):
            if piece in raw and piece in text:
                assert not text.endswith(piece) or text == blocks[-1]
    assert " ".join(blocks) == " ".join(line for line in raw.splitlines() if not line[0].isdigit())


def test_text_without_punctuation_is_grouped_at_caption_starts() -> None:
    captions = [f"0:{2 * i:02d}\nword word word word word word" for i in range(20)]
    timed = parse_timed_transcript("\n".join(captions))
    words = [len(b.text.split()) for b in timed.blocks]
    assert sum(words) == 6 * 20
    assert all(not b.ends_sentence for b in timed.blocks)
    assert all(not b.estimated_start for b in timed.blocks)  # groups start at captions
    assert max(words[:-1]) <= MAX_UNIT_WORDS + 6


def test_equal_timestamps_merge_into_a_block_with_a_positive_frame() -> None:
    raw = "0:00\nOne.\n0:02\nTwo.\n0:02\nThree.\n0:05\nFour."
    timed = parse_timed_transcript(raw)
    assert [b.text for b in timed.blocks] == ["One.", "Two. Three. Four."]
    starts = [b.start for b in timed.blocks]
    assert starts == sorted(set(starts))


@pytest.mark.parametrize(
    ("raw", "code"),
    [
        ("0:00\nA.\n0:05\nB.\n0:03\nC.", "timestamps_decrease"),
        ("0:00\nA.\n0:75\nB.", "invalid_timestamp"),
        ("0:00\nA.\n1:2:03\nB.", "invalid_timestamp"),
        ("0:00\nA.\n0:05.5555\nB.", "invalid_timestamp"),  # more than milliseconds
        ("0:00\nA.\n0:05,500\nB.", "invalid_timestamp"),  # the handoff format uses a dot
        ("0:04.250\nA.\n0:04.250\nB.", "zero_baseline"),
        ("Intro\n0:00\nA.\n0:05\nB.", "text_before_first_timestamp"),
        ("0:00\n0:03\nA.\n0:05\nB.", "timestamp_without_text"),
        ("0:00\nA.\n0:05", "timestamp_without_text"),
        ("0:04\nA.\n0:04\nB.", "zero_baseline"),
        ("Just text without timestamps.", "timestamps_not_found"),
        ("10:30 is our meeting time.\nSee you.", "timestamps_not_found"),
    ],
)
def test_invalid_timed_transcripts_are_rejected_not_guessed(raw: str, code: str) -> None:
    with pytest.raises(TimedTranscriptError) as error:
        parse_timed_transcript(raw)
    assert error.value.code == code
    assert error.value.message


def test_h_mm_ss_and_mm_ss_timestamps() -> None:
    raw = "59:58\nA long video.\n1:00:03\nStill here.\n01:00:09\nEnd."
    timed = parse_timed_transcript(raw)
    assert [c.start for c in timed.captions] == [3598, 3603, 3609]


# --- The caption import's handoff format (milliseconds) -----------------------------------------

IMPORTED = "0:10.480\nWelcome back.\n0:12.960\nGradient descent, step by step.\n6:10.999\nBye!"


def test_milliseconds_are_kept_exactly() -> None:
    timed = parse_timed_transcript(IMPORTED)
    assert [c.start for c in timed.captions] == [
        Fraction(10480, 1000),
        Fraction(12960, 1000),
        Fraction(370999, 1000),
    ]
    assert timed.source_baseline == Fraction(360519, 1000)
    assert [b.text for b in timed.blocks] == [
        "Welcome back.",
        "Gradient descent, step by step. Bye!",  # the last caption joins the block before it
    ]
    assert parse_timed_transcript("1:02:03.004\nA.\n1:02:03.5\nB.").captions[1].start == Fraction(
        3723500, 1000
    )


def test_the_selected_whole_second_baseline_scales_a_millisecond_timeline() -> None:
    # The fields hold 00:00:10 -> 00:06:10 (360 s, truncated); the captions span 360.519 s.
    timed = parse_timed_transcript(IMPORTED)
    boundaries = timed.boundaries(360, AudioSpeed.X1, RATE)
    assert boundaries[-1] == 360 * RATE
    exact = Fraction(12960 - 10480, 360519) * 360 * RATE
    assert boundaries[1] == (2 * exact.numerator + exact.denominator) // (2 * exact.denominator)


def test_first_and_last_caption_in_the_same_second_still_have_a_span() -> None:
    timed = parse_timed_transcript("0:10.100\nHello there.\n0:10.900\nAnd goodbye.")
    assert timed.source_baseline == Fraction(4, 5)


def test_every_imported_transcript_reads_back_as_its_captions_in_timed_mode() -> None:
    from app.youtube_import.captions import RawCaption, build_track

    track = build_track(
        "en",
        [
            RawCaption("Generally, if if somebody's trying to", 0, 1000),
            RawCaption("make a company work. Uh except", 1480, 900),
            RawCaption("that 3.5 percent fail.", 3_600_999, 800),
            RawCaption("Bye", 3_601_500, 500),
        ],
    )
    timed = parse_timed_transcript(track.transcript)
    assert [c.text for c in timed.captions] == [c.text for c in track.captions]
    assert [c.start for c in timed.captions] == [Fraction(c.start_ms, 1000) for c in track.captions]
    assert " ".join(b.text for b in timed.blocks) == " ".join(c.text for c in track.captions)
    # The form's suggestions are the same whole seconds the timed reader would fill.
    assert track.suggested_starts() == ("00:00:00", "01:00:01")


def test_cue_documents_are_not_the_timed_structure() -> None:
    srt = "1\n00:00:01,000 --> 00:00:03,000\nHello.\n\n2\n00:00:04,000 --> 00:00:06,000\nBye."
    vtt = "WEBVTT\n\n00:01.000 --> 00:03.000\nHello.\n\n00:04.000 --> 00:06.000\nBye."
    assert not has_timed_structure(srt) and not has_timed_structure(vtt)
    assert has_timed_structure(YOUTUBE)
    assert not has_timed_structure("0:05\nonly one timestamp")


@pytest.mark.parametrize("speed", list(AudioSpeed))
def test_the_timeline_ends_exactly_at_the_target_at_every_speed(speed: AudioSpeed) -> None:
    timed = parse_timed_transcript(YOUTUBE)
    boundaries = timed.boundaries(11, speed, RATE)
    assert boundaries[0] == 0
    assert boundaries[-1] == DurationTarget(11, speed).samples(RATE)
    assert boundaries == sorted(boundaries)
    # Each start is the exact ratio scaled and rounded half up once (no accumulated rounding).
    exact = Fraction(11 * RATE * 100, speed.value)
    for start, ratio in zip(boundaries, timed.ratios(), strict=False):
        value = ratio * exact
        assert start == (2 * value.numerator + value.denominator) // (2 * value.denominator)


@pytest.mark.parametrize(
    ("speed", "expected"),
    [
        (AudioSpeed.X1, [0, 99429, 150000, 264000]),
        (AudioSpeed.X1_25, [0, 79543, 120000, 211200]),
        (AudioSpeed.X1_5, [0, 66286, 100000, 176000]),
        (AudioSpeed.X1_75, [0, 56816, 85714, 150857]),
    ],
)
def test_boundaries_of_the_youtube_sample(speed: AudioSpeed, expected: list[int]) -> None:
    assert parse_timed_transcript(YOUTUBE).boundaries(11, speed, RATE) == expected


def test_a_manually_selected_baseline_rescales_the_caption_timeline() -> None:
    # The fields say 0:00 -> 0:22 instead of 0:11: every position doubles, no text is dropped.
    timed = parse_timed_transcript(YOUTUBE)
    assert timed.boundaries(22, AudioSpeed.X1, RATE) == [0, 198857, 300000, 528000]
    assert timed.boundaries(22, AudioSpeed.X2, RATE) == timed.boundaries(11, AudioSpeed.X1, RATE)
    with pytest.raises(ValueError):
        timed.plan(0, AudioSpeed.X1)
