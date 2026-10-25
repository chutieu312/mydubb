"""Grouping timeline frames whose speech would need an extreme tempo (timed mode).

Each block of a timed transcript has a frame on the output timeline (after the selected baseline
and the speed). Some frames are far too short for their speech: the last block, which also holds
the last caption, often has well under a second; a one-word sentence between two captions too.
Fitting such a clip alone means a tempo of 4-6x. Grouping reads neighbouring blocks in one frame
instead, which spreads the speech over a longer span; the internal boundary is dropped and the
blocks inside a group follow each other at one tempo.

Rules, measured on the clips already synthesized (nothing is synthesized again):

* `ratio = audio_samples / frame_samples` per frame, where the audio is what must be heard (the
  clip without its silent tail). `TEMPO_TARGET` (2x) is the level above which a frame is a
  candidate and the level grouping tries to reach; it is a warning level, not a product limit.
* The candidate with the highest ratio goes first. A frame shorter than `MIN_FRAME_SECONDS` is
  merged into the frame before it (the first frame into the one after); another frame is merged
  with whichever neighbour gives the lower ratio.
* A merge must lower the candidate's ratio. A merge for tempo alone may not make a frame longer
  than `MAX_GROUP_SECONDS` (short frames are exempt), and the transcript is never merged into one
  single frame: grouping trades some alignment for intelligibility, not all of it.
* A candidate that no allowed merge improves stays as it is and is reported (`unresolved`):
  grouping cannot help when the speech is long for its whole neighbourhood.

Frames of zero samples (possible when the selected baseline is much shorter than the source one)
have an infinite ratio and are always merged. The baseline, `source_first`/`source_last` and the
total target never change: grouping only removes boundaries between two blocks.
"""

from dataclasses import dataclass

TEMPO_TARGET = 2.0
MIN_FRAME_SECONDS = 1.0
MAX_GROUP_SECONDS = 12.0
# Variant under evaluation (not the default): only frames that stand out from the transcript as a
# whole are grouped, see `relative_target`.
RELATIVE_FACTOR = 1.25


def relative_target(
    frames: list[int], clip_samples: list[int], audible_samples: list[int]
) -> float:
    """max(TEMPO_TARGET, RELATIVE_FACTOR x the overall ratio of the transcript).

    When the speech as a whole needs more than 2x (slow speech at a high speed), no grouping can
    reach 2x; this target groups only local peaks instead of most of the timeline.
    """
    overall = (sum(clip_samples[:-1]) + audible_samples[-1]) / sum(frames)
    return max(TEMPO_TARGET, RELATIVE_FACTOR * overall)


@dataclass(frozen=True)
class Grouping:
    groups: list[tuple[int, int]]  # (first block, last block), inclusive, in order
    unresolved: list[tuple[int, int]]  # groups still above TEMPO_TARGET

    @property
    def removed_boundaries(self) -> list[int]:
        """Blocks whose own start boundary is no longer a frame start."""
        return [block for first, last in self.groups for block in range(first + 1, last + 1)]


def group_frames(
    frames: list[int],
    clip_samples: list[int],
    audible_samples: list[int],
    sample_rate: int,
    *,
    enabled: bool = True,
    target: float = TEMPO_TARGET,
) -> Grouping:
    """Groups of consecutive blocks; `frames[i]` is block i's frame, `clip_samples[i]` its whole
    clip and `audible_samples[i]` the clip without its silent tail."""
    count = len(frames)
    if not (count == len(clip_samples) == len(audible_samples)) or count == 0:
        raise ValueError("one frame, clip and audible length per block")
    groups = [(index, index) for index in range(count)]

    def frame(group: tuple[int, int]) -> int:
        return sum(frames[group[0] : group[1] + 1])

    def ratio(group: tuple[int, int]) -> float:
        # Inside a group the earlier clips play whole (their tails are pauses between sentences).
        audio = sum(clip_samples[group[0] : group[1]]) + audible_samples[group[1]]
        length = frame(group)
        return audio / length if length else float("inf")

    def over(group: tuple[int, int]) -> bool:
        return frame(group) == 0 or ratio(group) > target

    if not enabled:
        # Zero-length frames still cannot hold anything: they join the next frame.
        merged = _zero_frames_only(frames)
        return Grouping(merged, [g for g in merged if over(g)])

    stuck: set[tuple[int, int]] = set()
    while len(groups) > 1:
        candidates = [g for g in groups if over(g) and g not in stuck]
        if not candidates:
            break
        group = max(candidates, key=lambda g: (ratio(g), -g[0]))
        index = groups.index(group)
        short = frame(group) < MIN_FRAME_SECONDS * sample_rate
        if short:
            neighbours = [index - 1] if index > 0 else [index + 1]
        else:
            neighbours = [n for n in (index - 1, index + 1) if 0 <= n < len(groups)]
        best = None
        for neighbour in neighbours:
            low, high = sorted((index, neighbour))
            merged = (groups[low][0], groups[high][1])
            # A zero-length frame cannot hold anything: it always merges.
            allowed = frame(group) == 0 or (
                ratio(merged) < ratio(group)
                and (short or frame(merged) <= MAX_GROUP_SECONDS * sample_rate)
                and not (len(groups) == 2 and count > 2)
            )
            if allowed and (best is None or ratio(merged) < ratio(best[1])):
                best = (low, merged)
        if best is None:
            stuck.add(group)
            continue
        low, merged = best
        groups[low : low + 2] = [merged]
    return Grouping(groups, [g for g in groups if over(g)])


def _zero_frames_only(frames: list[int]) -> list[tuple[int, int]]:
    """Each zero-length frame joins the next one (trailing ones join the last real frame)."""
    merged: list[tuple[int, int]] = []
    start: int | None = None
    for index, length in enumerate(frames):
        if start is None:
            start = index
        if length > 0:
            merged.append((start, index))
            start = None
    if start is not None:
        if merged:
            merged[-1] = (merged[-1][0], len(frames) - 1)
        else:
            merged.append((start, len(frames) - 1))
    return merged
