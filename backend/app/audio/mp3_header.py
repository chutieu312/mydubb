"""The playable length an MP3 declares for gapless players, read without FFmpeg.

An MP3 stores whole frames, and an encoder adds delay samples at the start and padding at the
end. The Xing/Info header written by LAME and FFmpeg records the frame count, the encoder
delay and the padding, which gapless players (browsers, FFmpeg) use to cut the audio back to
the encoded length. This module reads those fields directly from the first frame, so the
result is an independent check of what FFmpeg/ffprobe report.

    playable samples = frames * samples_per_frame - delay - padding

A player that ignores the header plays up to about 50-70 ms more (see docs/ARCHITECTURE.md).
"""

import struct
from dataclasses import dataclass
from pathlib import Path

# Layer III samples per frame: 1152 for MPEG-1, 576 for MPEG-2 and MPEG-2.5.
_SAMPLES_PER_FRAME = {3: 1152, 2: 576, 0: 576}
_SAMPLE_RATES = {3: (44100, 48000, 32000), 2: (22050, 24000, 16000), 0: (11025, 12000, 8000)}
_LAME_TAG_OFFSET = 120  # from the "Xing"/"Info" tag when all four optional fields are present
_DELAY_OFFSET = _LAME_TAG_OFFSET + 21
_HEADER_SEARCH_BYTES = 4096


class Mp3HeaderError(ValueError):
    """The file has no readable Xing/Info header with encoder delay and padding."""


@dataclass(frozen=True)
class Mp3Gapless:
    sample_rate: int
    frames: int
    samples_per_frame: int
    encoder_delay: int
    padding: int

    @property
    def encoded_samples(self) -> int:
        """Samples in all frames, as a player without gapless support would play."""
        return self.frames * self.samples_per_frame

    @property
    def playable_samples(self) -> int:
        return self.encoded_samples - self.encoder_delay - self.padding


def read_gapless_info(path: Path) -> Mp3Gapless:
    with path.open("rb") as handle:
        data = handle.read(_HEADER_SEARCH_BYTES)
    offset = 0
    if data[:3] == b"ID3" and len(data) >= 10:  # an ID3v2 tag may precede the first frame
        size = 0
        for byte in data[6:10]:
            size = (size << 7) | (byte & 0x7F)
        offset = 10 + size
        with path.open("rb") as handle:
            handle.seek(offset)
            data, offset = handle.read(_HEADER_SEARCH_BYTES), 0
    if len(data) < offset + 4 or data[offset] != 0xFF or data[offset + 1] & 0xE0 != 0xE0:
        raise Mp3HeaderError("no MP3 frame at the start")
    version = (data[offset + 1] >> 3) & 3
    layer = (data[offset + 1] >> 1) & 3
    rate_index = (data[offset + 2] >> 2) & 3
    if version == 1 or layer != 1 or rate_index == 3:
        raise Mp3HeaderError("not an MPEG audio layer III frame")
    mono = (data[offset + 3] >> 6) & 3 == 3
    crc = 2 if not data[offset + 1] & 1 else 0
    side_info = (17 if mono else 32) if version == 3 else (9 if mono else 17)
    tag = offset + 4 + crc + side_info
    if data[tag : tag + 4] not in (b"Xing", b"Info"):
        raise Mp3HeaderError("no Xing/Info header")
    (flags,) = struct.unpack(">I", data[tag + 4 : tag + 8])
    if not flags & 1 or flags & 0xF != 0xF or len(data) < tag + _DELAY_OFFSET + 3:
        raise Mp3HeaderError("the Xing/Info header has no LAME fields")
    (frames,) = struct.unpack(">I", data[tag + 8 : tag + 12])
    first, second, third = data[tag + _DELAY_OFFSET : tag + _DELAY_OFFSET + 3]
    return Mp3Gapless(
        sample_rate=_SAMPLE_RATES[version][rate_index],
        frames=frames,
        samples_per_frame=_SAMPLES_PER_FRAME[version],
        encoder_delay=(first << 4) | (second >> 4),
        padding=((second & 0x0F) << 8) | third,
    )
