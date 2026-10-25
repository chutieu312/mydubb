"""Grouping of timeline frames whose speech would need an extreme tempo (pure, no audio)."""

import random

import pytest

from app.audio.grouping import MAX_GROUP_SECONDS, TEMPO_TARGET, group_frames

RATE = 24000


def seconds(*values: float) -> list[int]:
    return [round(value * RATE) for value in values]


def plan(frames: list[float], audio: list[float], enabled: bool = True):
    clips = seconds(*audio)
    return group_frames(seconds(*frames), clips, clips, RATE, enabled=enabled)


def test_frames_that_fit_are_left_alone() -> None:
    grouping = plan([4, 3, 5], [5, 4, 6])  # 1.25x, 1.33x, 1.2x
    assert grouping.groups == [(0, 0), (1, 1), (2, 2)]
    assert grouping.removed_boundaries == [] and grouping.unresolved == []


def test_a_short_last_frame_with_too_much_speech_joins_the_frame_before() -> None:
    # The last block also holds the last caption: 4.4 s of speech in 0.75 s (5.9x).
    grouping = plan([7, 3, 0.75], [9, 4, 4.4])
    assert grouping.groups == [(0, 0), (1, 2)]
    assert grouping.removed_boundaries == [2]


def test_a_short_first_frame_joins_the_frame_after() -> None:
    grouping = plan([0.5, 6, 6], [2, 6, 6])
    assert grouping.groups[0] == (0, 1)


def test_a_short_frame_whose_speech_fits_is_not_merged() -> None:
    # "Good." (0.29 s) in 0.375 s: below one second but no extreme tempo, so it keeps its start.
    grouping = plan([5, 0.375, 5], [6, 0.29, 6])
    assert grouping.groups == [(0, 0), (1, 1), (2, 2)]


def test_a_long_frame_picks_the_neighbour_that_lowers_its_tempo_more() -> None:
    grouping = plan([3, 2, 6], [3.5, 6, 4])  # middle at 3x; the next frame has more room
    assert grouping.groups == [(0, 0), (1, 2)]


def test_grouping_stops_when_no_allowed_merge_lowers_the_tempo() -> None:
    # 4x, 2.7x, 4x: the first pair merges (3.3x); merging the rest would leave one frame for the
    # whole transcript, which is not allowed, so both frames stay above the warning level.
    grouping = plan([1.5, 1.5, 1.5], [6, 4, 6])
    assert grouping.groups == [(0, 1), (2, 2)]
    assert grouping.unresolved == [(0, 1), (2, 2)]


def test_tempo_merges_do_not_grow_a_frame_beyond_the_cap() -> None:
    long = MAX_GROUP_SECONDS - 1
    grouping = plan([long, 2, long], [long, 5, long])  # middle 2.5x, neighbours full
    assert grouping.groups == [(0, 0), (1, 1), (2, 2)]
    assert grouping.unresolved == [(1, 1)]


def test_never_one_frame_for_the_whole_transcript() -> None:
    # Speech three times longer than every frame (e.g. 1.75x of slow speech): grouping cannot
    # fix that, and it must not collapse the timeline to make the numbers look better.
    grouping = plan([2] * 6, [6] * 6)
    assert len(grouping.groups) > 1
    assert grouping.unresolved


def test_zero_length_frames_are_always_merged() -> None:
    grouping = plan([3, 0, 3], [3, 1, 3])
    assert all(sum(seconds(*[3, 0, 3])[a : b + 1]) > 0 for a, b in grouping.groups)
    assert grouping.groups in ([(0, 1), (2, 2)], [(0, 0), (1, 2)])


def test_disabled_grouping_only_merges_zero_frames() -> None:
    grouping = plan([7, 3, 0.75, 0], [9, 4, 4.4, 1], enabled=False)
    assert grouping.groups == [(0, 0), (1, 1), (2, 3)]


@pytest.mark.parametrize("seed", range(40))
def test_groups_cover_every_block_once_in_order(seed: int) -> None:
    rng = random.Random(seed)  # noqa: S311 (test data)
    count = rng.randint(2, 30)
    frames = [rng.choice([0.0, rng.uniform(0.1, 1.0), rng.uniform(1, 9)]) for _ in range(count)]
    frames[-1] = max(frames[-1], 0.2)
    audio = [rng.uniform(0.3, 9) for _ in range(count)]
    grouping = plan(frames, audio)
    flat = [block for first, last in grouping.groups for block in range(first, last + 1)]
    assert flat == list(range(count))
    for first, last in grouping.groups:
        assert sum(seconds(*frames)[first : last + 1]) > 0
    if count > 2:
        assert len(grouping.groups) > 1
    for group in grouping.unresolved:
        frame = sum(seconds(*frames)[group[0] : group[1] + 1])
        assert sum(seconds(*audio)[group[0] : group[1] + 1]) / frame > TEMPO_TARGET
