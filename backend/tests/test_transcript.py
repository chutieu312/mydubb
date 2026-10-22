import pytest

from app.transcript.timestamps import (
    TimestampError,
    format_seconds,
    parse_timestamp,
    target_duration_seconds,
)


def test_reference_example_produces_exactly_360_seconds():
    first = parse_timestamp("00:00:10")
    last = parse_timestamp("00:06:10")
    assert target_duration_seconds(first, last) == 360


def test_target_is_last_start_minus_first_start_without_extra_time():
    assert target_duration_seconds(parse_timestamp("00:00:10"), parse_timestamp("00:05:10")) == 300


def test_hours_may_exceed_two_digits():
    assert parse_timestamp("100:00:01") == 360_001
    assert format_seconds(360_001) == "100:00:01"


@pytest.mark.parametrize(
    "value",
    ["", "0:00:10", "00:00", "00:60:00", "00:00:60", "aa:bb:cc", "00:00:10.5", "-1:00:00", "1:2:3"],
)
def test_malformed_timestamps_are_rejected(value):
    with pytest.raises(TimestampError):
        parse_timestamp(value)


@pytest.mark.parametrize(("first", "last"), [("00:01:00", "00:01:00"), ("00:02:00", "00:01:59")])
def test_last_not_after_first_is_rejected(first, last):
    with pytest.raises(TimestampError):
        target_duration_seconds(parse_timestamp(first), parse_timestamp(last))
