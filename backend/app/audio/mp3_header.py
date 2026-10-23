"""The playable length an MP3 declares for gapless players, read without FFmpeg.

An MP3 stores whole frames, and an encoder adds delay samples at the start and padding at the
end. The Xing/Info header written by LAME and FFmpeg records the frame count, the encoder
delay and the padding, which gapless players (browsers, FFmpeg) use to cut the audio back to
the encoded length. This module reads those fields directly from the first frame, so the
result is an independent check of what FFmpeg/ffprobe report.

    playable samples = frames * samples_per_frame - delay - padding

A player that ignores the header plays up to about 50-70 ms more (see docs/ARCHITECTURE.md).

`set_exact_padding` corrects one known defect of FFmpeg's MP3 muxer (see its docstring).
"""

import struct
from dataclasses import dataclass
from pathlib import Path

# Layer III samples per frame: 1152 for MPEG-1, 576 for MPEG-2 and MPEG-2.5.
_SAMPLES_PER_FRAME = {3: 1152, 2: 576, 0: 576}
_SAMPLE_RATES = {3: (44100, 48000, 32000), 2: (22050, 24000, 16000), 0: (11025, 12000, 8000)}
_LAME_TAG_OFFSET = 120  # from the "Xing"/"Info" tag when all four optional fields are present
_DELAY_OFFSET = _LAME_TAG_OFFSET + 21
_TAG_CRC_OFFSET = _LAME_TAG_OFFSET + 34
# The tag CRC is a CRC-16 (reflected 0xA001, initial value 0) of the first 190 bytes of the
# frame, computed with the two CRC bytes set to zero (the LAME tag specification; FFmpeg and
# LAME write it the same way).
_TAG_CRC_COVERS = 190
_MAX_PADDING = 0xFFF  # the padding field is 12 bits
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


@dataclass(frozen=True)
class _FirstFrame:
    data: bytes  # from the start of the first frame
    file_offset: int  # of data[0] in the file
    gapless: Mp3Gapless
    tag: int  # index of "Xing"/"Info" in `data`


def _read_first_frame(path: Path) -> _FirstFrame:
    with path.open("rb") as handle:
        data = handle.read(_HEADER_SEARCH_BYTES)
        offset = 0
        if data[:3] == b"ID3" and len(data) >= 10:  # an ID3v2 tag may precede the first frame
            size = 0
            for byte in data[6:10]:
                size = (size << 7) | (byte & 0x7F)
            offset = 10 + size
            handle.seek(offset)
            data = handle.read(_HEADER_SEARCH_BYTES)
    if len(data) < 4 or data[0] != 0xFF or data[1] & 0xE0 != 0xE0:
        raise Mp3HeaderError("no MP3 frame at the start")
    version = (data[1] >> 3) & 3
    layer = (data[1] >> 1) & 3
    rate_index = (data[2] >> 2) & 3
    if version == 1 or layer != 1 or rate_index == 3:
        raise Mp3HeaderError("not an MPEG audio layer III frame")
    mono = (data[3] >> 6) & 3 == 3
    crc = 2 if not data[1] & 1 else 0
    side_info = (17 if mono else 32) if version == 3 else (9 if mono else 17)
    tag = 4 + crc + side_info
    if data[tag : tag + 4] not in (b"Xing", b"Info"):
        raise Mp3HeaderError("no Xing/Info header")
    (flags,) = struct.unpack(">I", data[tag + 4 : tag + 8])
    if not flags & 1 or flags & 0xF != 0xF or len(data) < tag + _DELAY_OFFSET + 3:
        raise Mp3HeaderError("the Xing/Info header has no LAME fields")
    (frames,) = struct.unpack(">I", data[tag + 8 : tag + 12])
    first, second, third = data[tag + _DELAY_OFFSET : tag + _DELAY_OFFSET + 3]
    gapless = Mp3Gapless(
        sample_rate=_SAMPLE_RATES[version][rate_index],
        frames=frames,
        samples_per_frame=_SAMPLES_PER_FRAME[version],
        encoder_delay=(first << 4) | (second >> 4),
        padding=((second & 0x0F) << 8) | third,
    )
    return _FirstFrame(data=data, file_offset=offset, gapless=gapless, tag=tag)


def read_gapless_info(path: Path) -> Mp3Gapless:
    return _read_first_frame(path).gapless


def _tag_crc(frame: bytes) -> int:
    crc = 0
    for byte in frame[:_TAG_CRC_COVERS]:
        crc ^= byte
        for _ in range(8):
            crc = (crc >> 1) ^ 0xA001 if crc & 1 else crc >> 1
    return crc


def set_exact_padding(path: Path, target_samples: int) -> int:
    """Make the header's playable length equal `target_samples`; returns the samples changed.

    FFmpeg's MP3 muxer writes the end padding capped at 1105 samples. When the encoder needs one
    more frame than the audio fills (the padding would exceed the cap: the target is 1-46
    samples over a whole number of 576-sample frames at 24 kHz), the header then claims up to 46
    samples more than were encoded, and a gapless decoder plays those extra samples. This
    rewrites the padding field to the true value (frames x samples per frame - delay - target)
    and recomputes the LAME tag CRC, so the header says what was encoded.

    It acts only on that situation and only on a header it fully understands: the stored tag
    CRC must match the CRC computed from the untouched header, the true padding must be larger
    than the stored one and fit the 12-bit field. Anything else raises Mp3HeaderError (and the
    caller fails the job): audio is never cut or hidden, and nothing is changed when the
    header already matches. The audio frames are not touched.
    """
    first = _read_first_frame(path)
    info = first.gapless
    padding = info.encoded_samples - info.encoder_delay - target_samples
    if info.playable_samples <= target_samples or padding <= info.padding:
        return 0
    if padding > _MAX_PADDING:
        raise Mp3HeaderError("the padding does not fit the header field")
    crc_at = first.tag + _TAG_CRC_OFFSET
    if len(first.data) < _TAG_CRC_COVERS or crc_at + 2 > _TAG_CRC_COVERS:
        raise Mp3HeaderError("the header frame is too short to carry a tag CRC")
    stored = struct.unpack(">H", first.data[crc_at : crc_at + 2])[0]
    frame = bytearray(first.data[:_TAG_CRC_COVERS])
    frame[crc_at : crc_at + 2] = bytes(2)
    if _tag_crc(bytes(frame)) != stored:
        raise Mp3HeaderError("the tag CRC is not the one this repair understands")
    delay_at = first.tag + _DELAY_OFFSET
    frame[delay_at + 1] = (frame[delay_at + 1] & 0xF0) | (padding >> 8)
    frame[delay_at + 2] = padding & 0xFF
    crc = _tag_crc(bytes(frame))
    frame[crc_at : crc_at + 2] = struct.pack(">H", crc)
    with path.open("r+b") as handle:
        handle.seek(first.file_offset + delay_at + 1)
        handle.write(bytes(frame[delay_at + 1 : delay_at + 3]))
        handle.seek(first.file_offset + crc_at)
        handle.write(bytes(frame[crc_at : crc_at + 2]))
    return padding - info.padding
