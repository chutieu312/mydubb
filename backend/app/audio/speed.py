"""Audio speed choice and the output length it implies.

The baseline is `last_sentence_start - first_sentence_start` (whole seconds, from the two
timestamps). Speed 1x keeps the audio at the baseline, every other speed makes the file
`baseline / speed` long. The target is a whole number of samples, computed with integers only:

    target_samples = round_half_up(baseline_seconds * sample_rate / speed)

The seven speeds are exact fractions of 100 (e.g. 1.75 = 175/100), so no float is involved in
the calculation and no error accumulates. Half-up is the one rounding rule used everywhere
(Python's `round` rounds halves to even and is not used).
"""

from dataclasses import dataclass
from enum import Enum
from fractions import Fraction


class AudioSpeed(Enum):
    """The supported speeds; the value is the speed in percent (exact, no float)."""

    X0_5 = 50
    X0_75 = 75
    X1 = 100
    X1_25 = 125
    X1_5 = 150
    X1_75 = 175
    X2 = 200

    @property
    def ratio(self) -> Fraction:
        return Fraction(self.value, 100)

    @property
    def number(self) -> float:
        """The speed as the API sends it (0.5, 0.75, 1.0, ...). Display only; never used to
        compute a length."""
        return self.value / 100

    @property
    def label(self) -> str:
        return f"{self.number:g}x"


DEFAULT_SPEED = AudioSpeed.X1

# API values. All seven are exactly representable as binary floats, so a JSON number maps to
# a speed without any tolerance: 1.2500001 is not 1.25.
_BY_NUMBER = {speed.number: speed for speed in AudioSpeed}
_INVALID = "Speed must be one of 0.5, 0.75, 1, 1.25, 1.5, 1.75 or 2."


def speed_from_percent(percent: int) -> AudioSpeed:
    """The speed stored in the database. An unknown value is an error, never coerced to 1x."""
    return AudioSpeed(percent)


def speed_from_api(value: object) -> AudioSpeed:
    """Strict: only the numbers 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2.

    Booleans (JSON true is 1 in Python), strings, null, lists and any other number are
    rejected.
    """
    if isinstance(value, AudioSpeed):
        return value
    if isinstance(value, bool) or not isinstance(value, int | float):
        raise ValueError(_INVALID)
    # No conversion: an int is compared with the float keys exactly, so a huge JSON integer
    # (10**400) is simply not found instead of overflowing float(); NaN equals nothing.
    speed = _BY_NUMBER.get(value)
    if speed is None:
        raise ValueError(_INVALID)
    return speed


@dataclass(frozen=True)
class DurationTarget:
    """What the audio must last: the baseline from the timestamps, divided by the speed."""

    baseline_seconds: int
    speed: AudioSpeed = DEFAULT_SPEED

    def samples(self, sample_rate: int) -> int:
        """The exact target length in samples at `sample_rate` (half-up rounding)."""
        numerator = self.baseline_seconds * sample_rate * 100
        denominator = self.speed.value
        return (2 * numerator + denominator) // (2 * denominator)

    @property
    def output_seconds(self) -> Fraction:
        """The planned length in seconds, as an exact fraction (before sample rounding)."""
        return Fraction(self.baseline_seconds) / self.speed.ratio
