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
_HEADER_SEARCH_BYTES = 4096

# The one FFmpeg muxer defect `set_exact_padding` repairs, measured on FFmpeg 6.1 (CI) and 7.1.5
# (the production image): for 24 kHz MPEG-2 mono with libmp3lame (576 samples per frame, encoder
# delay 576), the end padding written is never more than 1105 (576 + the 529-sample decoder
# delay). When the input is 1-46 samples over a whole number of frames, the encoder emits one more
# frame and the true padding is 1106-1151, so the header claims 1-46 samples that were not encoded.
# Every other input length gets an exact header. Nothing outside this signature is repaired.
FFMPEG_PADDING_CAP = 1105
_DEFECT_RATE = 24000
_DEFECT_SAMPLES_PER_FRAME = 576
_DEFECT_DELAY = 576
MAX_CAPPED_EXCESS = 46


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


def capped_padding_excess(info: Mp3Gapless, encoded_samples: int) -> int | None:
    """Samples the header over-claims because of the known padding cap; None if not that case.

    `encoded_samples` is the exact number of PCM samples that were given to the encoder. The
    result is 1-46 only when every part of the signature above matches; any other mismatch
    (another padding, delay, frame size or sample rate, a header that is short, or a difference
    outside 1-46 samples) is not this defect and returns None.
    """
    true_padding = info.encoded_samples - info.encoder_delay - encoded_samples
    excess = true_padding - info.padding
    if (
        info.sample_rate == _DEFECT_RATE
        and info.samples_per_frame == _DEFECT_SAMPLES_PER_FRAME
        and info.encoder_delay == _DEFECT_DELAY
        and info.padding == FFMPEG_PADDING_CAP
        and 1 <= excess <= MAX_CAPPED_EXCESS
        and info.playable_samples - encoded_samples == excess
    ):
        return excess
    return None


def set_exact_padding(path: Path, encoded_samples: int) -> int:
    """Correct the known FFmpeg padding cap in the header; returns the samples corrected.

    `encoded_samples` must be the exact number of PCM samples the encoder was given (not a
    wished-for target). Returns 0 and changes nothing when the header already declares exactly
    that. Repairs only the signature described at FFMPEG_PADDING_CAP: it rewrites the 12-bit
    padding to the true value (frames x samples per frame - delay - encoded samples) and
    recomputes the LAME tag CRC; the audio frames are not touched. Anything else raises
    Mp3HeaderError and leaves the file unchanged: a header that is too long by any other amount,
    too short, from another encoder configuration, or whose stored tag CRC does not match the
    CRC computed from the untouched header.

    Callers must also make sure that the samples the repair stops playing are silent (the fitter
    decodes them first): the header alone cannot tell padding from audio.
    """
    first = _read_first_frame(path)
    info = first.gapless
    if info.playable_samples == encoded_samples:
        return 0
    excess = capped_padding_excess(info, encoded_samples)
    if excess is None:
        raise Mp3HeaderError(
            f"the header declares {info.playable_samples} samples for {encoded_samples} encoded; "
            "this is not the known padding cap"
        )
    padding = info.padding + excess
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
    return excess
