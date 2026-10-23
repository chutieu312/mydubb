"""The audio speed choice: strict API values, exact sample arithmetic, one rounding rule."""

from fractions import Fraction

import pytest

from app.audio.speed import (
    DEFAULT_SPEED,
    AudioSpeed,
    DurationTarget,
    speed_from_api,
    speed_from_percent,
)

RATE = 24000
SEVEN = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2]


def test_there_are_exactly_seven_speeds_and_the_default_is_one_x():
    assert [speed.number for speed in AudioSpeed] == [0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0]
    assert DEFAULT_SPEED is AudioSpeed.X1
    assert [speed.label for speed in AudioSpeed] == [
        "0.5x",
        "0.75x",
        "1x",
        "1.25x",
        "1.5x",
        "1.75x",
        "2x",
    ]


@pytest.mark.parametrize("value", SEVEN)
def test_the_seven_numbers_are_accepted(value):
    assert speed_from_api(value).number == float(value)


@pytest.mark.parametrize(
    "value",
    [
        None,
        True,  # JSON true must not read as the number 1
        False,
        "1",
        "1.25",
        "fast",
        "",
        0,
        -1,
        0.25,
        0.49,
        0.51,
        1.1,
        1.2500001,
        1.9999999,
        2.5,
        3,
        100,
        float("nan"),
        float("inf"),
        float("-inf"),
        [1],
        {"speed": 1},
        (1,),
    ],
)
def test_everything_else_is_rejected(value):
    with pytest.raises(ValueError, match="Speed must be one of"):
        speed_from_api(value)


def test_a_stored_speed_that_is_not_supported_is_an_error_not_one_x():
    assert speed_from_percent(125) is AudioSpeed.X1_25
    with pytest.raises(ValueError):
        speed_from_percent(130)


# Baseline 20 s: the examples of the product decision.
@pytest.mark.parametrize(
    ("speed", "output_seconds", "samples"),
    [
        (AudioSpeed.X0_5, Fraction(40), 960_000),
        (AudioSpeed.X0_75, Fraction(80, 3), 640_000),  # 26.666...
        (AudioSpeed.X1, Fraction(20), 480_000),
        (AudioSpeed.X1_25, Fraction(16), 384_000),
        (AudioSpeed.X1_5, Fraction(40, 3), 320_000),  # 13.333...
        (AudioSpeed.X1_75, Fraction(80, 7), 274_286),  # 11.428571... -> 274285.714 rounds up
        (AudioSpeed.X2, Fraction(10), 240_000),
    ],
)
def test_baseline_twenty_seconds(speed, output_seconds, samples):
    target = DurationTarget(20, speed)
    assert target.output_seconds == output_seconds
    assert target.samples(RATE) == samples
    # The actual duration is samples / rate; it differs from the plan by half a sample at most.
    assert abs(Fraction(target.samples(RATE), RATE) - output_seconds) <= Fraction(1, 2 * RATE)


def test_one_x_is_the_baseline_to_the_sample():
    for baseline in (1, 7, 360, 3600, 36_000):
        assert DurationTarget(baseline).samples(RATE) == baseline * RATE


def test_rounding_is_half_up_not_half_to_even():
    # 1 s at 5 Hz / 2x = 2.5 samples; at 3 Hz 1.5 samples. Half-to-even would give 2 for both.
    assert DurationTarget(1, AudioSpeed.X2).samples(5) == 3
    assert DurationTarget(1, AudioSpeed.X2).samples(3) == 2


@pytest.mark.parametrize("speed", list(AudioSpeed))
def test_no_float_error_even_for_very_long_baselines(speed):
    baseline = 10 * 3600 + 59 * 60 + 59
    exact = Fraction(baseline * RATE * 100, speed.value)
    samples = DurationTarget(baseline, speed).samples(RATE)
    assert samples == int(exact + Fraction(1, 2))  # half-up on the exact rational
    assert abs(samples - exact) <= Fraction(1, 2)
