# ruff: noqa: RUF001 (Chinese punctuation is the subject of these tests)
"""Timed-mode Mandarin blocks: requests, spans and the mapping checks (fake voice, no Azure).

The fake voice reads each Han character as one syllable and every other token by a hand-written
reading (`READINGS`), independent of `mandarin_syllables`, so the checks are exercised against an
estimate that is only approximately right, as with a real voice.
"""

import re
import xml.etree.ElementTree as ET
from collections.abc import Callable
from pathlib import Path

import httpx
import pytest

from app.languages import TargetLanguage
from app.processing_errors import ProcessingError
from app.speech.blocks import BREAK_MS, MAX_BLOCKS_PER_REQUEST, plan_block_requests
from app.speech.mandarin import MANDARIN_MAX_CHUNK_CHARS
from app.speech.voices import Voice
from app.translation.glossary import default_glossary
from tests.audio_helpers import tone_samples, wav_bytes
from tests.test_speech_blocks import PITCHES, pieces_of, pitch_of, provider_for, silence

MANDARIN = TargetLanguage.MANDARIN
NS = "{http://www.w3.org/2001/10/synthesis}"
XML_LANG = "{http://www.w3.org/XML/1998/namespace}lang"
SYLLABLE_SECONDS = 0.22

BLOCKS = [
    "总的来说，如果有人想让一家公司运转起来，他们就应该非常努力地工作。",
    "嗯，除了失败的可能性相当大之外。",
    "我们用Kubernetes和一个REST API部署服务。",
    "错误率从2%降到了0.4%，那是在2026年。",
    "我们调用API，然后把1,024条数据存到SQL里。",
]
# How the fake voice reads tokens other than Han characters (syllables).
READINGS = {
    "Kubernetes": 4,
    "REST": 1,  # read as the word "rest"
    "API": 3,
    "SQL": 3,
    "2%": 4,  # 百分之二
    "0.4%": 6,  # 百分之零点四
    "2026": 4,  # 二零二六, a year read digit by digit (the estimate says 6)
    "1,024": 6,  # 一千零二十四
}
_TOKENS = re.compile(r"[一-鿿]|[A-Za-z]+|\d[\d.,]*%?|\S")


def real_syllables(text: str) -> int:
    count = 0
    for token in _TOKENS.findall(text):
        if re.fullmatch(r"[一-鿿]", token):
            count += 1
        elif token in READINGS:
            count += READINGS[token]
        elif token.isalnum():
            raise AssertionError(f"no reading for {token}")
    return count


def mandarin_voice(
    texts: list[str], *, slow_block: int | None = None, drop_break: int | None = None
) -> Callable[[httpx.Request], httpx.Response]:
    """Each piece at SYLLABLE_SECONDS per real syllable and the block's pitch; a short pause after
    each comma or full stop; inserted breaks as 3 s of low noise."""

    def respond(request: httpx.Request) -> httpx.Response:
        samples = silence(0.05)
        for number, piece in enumerate(pieces_of(request)):
            if number:
                gap = 0.4 if number - 1 == drop_break else BREAK_MS / 1000
                samples.extend(silence(gap, 60))
            block = next(i for i, text in enumerate(texts) if piece in text)
            slow = 3 if block == slow_block else 1
            for clause in re.split(r"(?<=[，。！？])", piece):
                if not clause:
                    continue
                seconds = real_syllables(clause) * SYLLABLE_SECONDS * slow
                samples.extend(tone_samples(seconds, PITCHES[block % len(PITCHES)]))
                samples.extend(silence(0.25))
        samples.extend(silence(0.3))
        return httpx.Response(200, content=wav_bytes(samples))

    return respond


@pytest.fixture
def work_dir(tmp_path: Path) -> Path:
    directory = tmp_path / "work"
    directory.mkdir()
    return directory


def test_mandarin_blocks_with_numbers_acronyms_and_terms_map_to_their_own_clips(
    work_dir: Path,
) -> None:
    provider, calls = provider_for(mandarin_voice(BLOCKS))
    speech = provider.synthesize_blocks(BLOCKS, Voice.ANDREW, work_dir, language=MANDARIN)
    assert len(calls) == 1 and speech.requests == 1
    assert pieces_of(calls[0]) == BLOCKS  # every character, in order
    assert [pitch_of(clip) for clip in speech.clips] == PITCHES[: len(BLOCKS)]


def test_each_mandarin_request_has_one_voice_and_only_zh_cn_and_en_us_spans(
    work_dir: Path,
) -> None:
    provider, calls = provider_for(mandarin_voice(BLOCKS))
    provider.synthesize_blocks(BLOCKS, Voice.EMMA, work_dir, language=MANDARIN)
    root = ET.fromstring(calls[0].content)
    [voice] = root.findall(f"{NS}voice")
    assert voice.get("name") == "en-US-EmmaMultilingualNeural"
    spans = [(child.get(XML_LANG), child.text) for child in voice if child.tag == f"{NS}lang"]
    assert {language for language, _ in spans} == {"zh-CN", "en-US"}
    english = [text for language, text in spans if language == "en-US"]
    assert english == ["Kubernetes", "REST API", "API", "SQL"]


def test_a_mandarin_block_read_three_times_too_long_is_rejected(
    work_dir: Path, caplog: pytest.LogCaptureFixture
) -> None:
    provider, calls = provider_for(mandarin_voice(BLOCKS, slow_block=1))
    with pytest.raises(ProcessingError) as error:
        provider.synthesize_blocks(BLOCKS, Voice.ANDREW, work_dir, language=MANDARIN)
    assert error.value.code == "speech_block_split_failed"
    assert "inconsistent_rate" in caplog.text and len(calls) == 1  # no retry


def test_a_missing_break_fails_a_mandarin_request_without_retry(work_dir: Path) -> None:
    provider, calls = provider_for(mandarin_voice(BLOCKS, drop_break=0))
    with pytest.raises(ProcessingError) as error:
        provider.synthesize_blocks(BLOCKS, Voice.ANDREW, work_dir, language=MANDARIN)
    assert error.value.code == "speech_block_split_failed"
    assert len(calls) == 1


def test_mandarin_requests_stay_within_the_mandarin_limit_and_split_long_blocks() -> None:
    long_block = "这个系统包含很多不同的模块，每个模块都有自己的职责。" * 30  # 780 characters
    texts = [BLOCKS[0], long_block, BLOCKS[1]]
    requests = plan_block_requests(texts, default_glossary(), 2000, MANDARIN)
    assert all(request.chars <= MANDARIN_MAX_CHUNK_CHARS for request in requests)
    assert all(request.language is MANDARIN for request in requests)
    pieces = [piece for request in requests for piece in request.pieces]
    assert [piece.block for piece in pieces] == sorted(piece.block for piece in pieces)
    for index, text in enumerate(texts):
        assert "".join(p.text for p in pieces if p.block == index) == text
    # Vietnamese keeps its own limit for the same configuration.
    vietnamese = ["Nhìn chung, " + "mọi thứ đều ổn. " * 150]
    [request] = plan_block_requests(vietnamese, default_glossary(), 4000)
    assert request.chars > MANDARIN_MAX_CHUNK_CHARS
    assert request.language is TargetLanguage.VIETNAMESE


def test_a_long_mandarin_block_is_joined_back_from_two_requests(work_dir: Path) -> None:
    long_block = "这个系统包含很多不同的模块，每个模块都有自己的职责。" * 30
    texts = [BLOCKS[0], long_block, BLOCKS[1]]
    provider, calls = provider_for(mandarin_voice(texts))
    speech = provider.synthesize_blocks(texts, Voice.ANDREW, work_dir, language=MANDARIN)
    assert len(calls) >= 2
    assert "".join(piece for call in calls for piece in pieces_of(call)) == "".join(texts)
    assert len(speech.clips) == 3
    assert [pitch_of(clip) for clip in speech.clips] == PITCHES[:3]


def test_the_block_limit_per_request_is_the_same_for_mandarin() -> None:
    texts = [f"第{i}句。" + "很好" * 3 for i in range(MAX_BLOCKS_PER_REQUEST + 5)]
    requests = plan_block_requests(texts, default_glossary(), 2000, MANDARIN)
    assert [len(r.pieces) for r in requests] == [MAX_BLOCKS_PER_REQUEST, 5]
