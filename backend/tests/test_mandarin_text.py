# ruff: noqa: RUF001 (Chinese punctuation is the subject of these tests)
"""Mandarin text handling: language mapping, Translator codes, chunks, spans, SSML and length.

No network: Azure Translator is a fake transport. The Vietnamese paths are checked against fixed
expected output where Mandarin support touched shared code.
"""

import json
import random
import re
import xml.etree.ElementTree as ET
from collections.abc import Callable

import httpx
import pytest
from pydantic import SecretStr

from app.languages import DEFAULT_TARGET_LANGUAGE, TargetLanguage
from app.processing_errors import ProcessingError
from app.pronunciation.han import HanBoundaryTerms, mask_han
from app.speech.chunker import SpeechTextTooLongError, speech_text
from app.speech.mandarin import MANDARIN_MAX_CHUNK_CHARS, chunk_spans, mandarin_syllables
from app.speech.plan import chunk_spans as planned_chunk_spans
from app.speech.spoken_length import spoken_syllables
from app.speech.ssml import build_ssml_from_spans
from app.speech.voices import Voice
from app.translation.azure import AzureTranslationProvider
from app.translation.glossary import Glossary, default_glossary
from app.translation.mock import MockTranslationProvider
from app.translation.notranslate_markup import CLOSE_TAG, OPEN_TAG

GLOSSARY = default_glossary()
ZH = "zh-CN"
SSML_NS = "{http://www.w3.org/2001/10/synthesis}"
XML_LANG = "{http://www.w3.org/XML/1998/namespace}lang"


def chunk_texts(text: str, max_chars: int = 2000, terms=GLOSSARY) -> list[str]:
    return [
        "".join(piece for _, piece in spans) for spans in chunk_spans(text, terms, max_chars, ZH)
    ]


# --- the language mapping -------------------------------------------------------------------


def test_each_product_language_maps_to_fixed_translator_and_speech_codes() -> None:
    assert DEFAULT_TARGET_LANGUAGE is TargetLanguage.VIETNAMESE
    assert [language.value for language in TargetLanguage] == ["vietnamese", "mandarin_simplified"]
    assert TargetLanguage.VIETNAMESE.translator_code == "vi"
    assert TargetLanguage.VIETNAMESE.speech_locale == "vi-VN"
    assert TargetLanguage.MANDARIN.translator_code == "zh-Hans"
    assert TargetLanguage.MANDARIN.speech_locale == "zh-CN"
    assert TargetLanguage.MANDARIN.label == "Chinese — Mandarin (Simplified)"


# --- Azure Translator: the code sent and the code accepted ----------------------------------


def translator(
    handler: Callable[[httpx.Request], httpx.Response], calls: list
) -> AzureTranslationProvider:
    def recording(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        return handler(request)

    return AzureTranslationProvider(
        key=SecretStr("test-key-0123456789abcdef"),
        region="westus2",
        endpoint="https://api.cognitive.microsofttranslator.com",
        glossary=Glossary.from_text("neural network\ngradient descent\nloss function"),
        timeout_seconds=5,
        max_request_chars=10_000,
        transport=httpx.MockTransport(recording),
    )


def answer(
    code: str, render: Callable[[list[str]], str]
) -> Callable[[httpx.Request], httpx.Response]:
    """Answers every element with `render(terms)` (the element's no-translate terms) in `code`."""

    def handler(request: httpx.Request) -> httpx.Response:
        out = []
        for item in json.loads(request.content):
            terms = [part.split(CLOSE_TAG)[0] for part in item["Text"].split(OPEN_TAG)[1:]]
            spans = [f"{OPEN_TAG}{term}{CLOSE_TAG}" for term in terms]
            out.append({"translations": [{"text": render(spans), "to": code}]})
        return httpx.Response(200, json=out)

    return handler


EXAMPLE = "A neural network uses gradient descent to minimize the loss function."


def test_a_mandarin_translation_asks_for_zh_hans_and_keeps_the_protected_terms() -> None:
    calls: list[httpx.Request] = []
    provider = translator(answer("zh-Hans", lambda t: f"{t[0]}使用{t[1]}来最小化{t[2]}。"), calls)
    result = provider.translate(EXAMPLE, TargetLanguage.MANDARIN)
    assert calls[0].url.params["to"] == "zh-Hans"
    assert calls[0].url.params["from"] == "en"
    assert result.text == "neural network使用gradient descent来最小化loss function。"
    assert result.is_illustrative is False


def test_a_vietnamese_translation_still_asks_for_vi_by_default() -> None:
    calls: list[httpx.Request] = []
    provider = translator(answer("vi", lambda t: f"Một {t[0]} dùng {t[1]} cho {t[2]}."), calls)
    assert provider.translate(EXAMPLE).text.startswith("Một neural network")
    assert calls[0].url.params["to"] == "vi"


@pytest.mark.parametrize(
    ("asked", "returned"),
    [(TargetLanguage.MANDARIN, "vi"), (TargetLanguage.VIETNAMESE, "zh-Hans")],
)
def test_an_answer_in_another_language_is_never_used(asked, returned) -> None:
    calls: list[httpx.Request] = []
    provider = translator(answer(returned, lambda t: " ".join(t)), calls)
    with pytest.raises(ProcessingError) as error:
        provider.translate(EXAMPLE, asked)
    assert error.value.code == "translation_invalid_response"
    assert len(calls) == 1  # no retry, no other language


def test_mandarin_translate_lines_keeps_one_line_per_block() -> None:
    calls: list[httpx.Request] = []
    provider = translator(
        answer("zh-Hans", lambda t: "第一句。" if not t else f"{t[0]}很好。"), calls
    )
    result = provider.translate_lines(
        ["Hello there.", "A neural network is good."], TargetLanguage.MANDARIN
    )
    assert result.lines == ("第一句。", "neural network很好。")
    assert calls[0].url.params["to"] == "zh-Hans"


def test_the_mock_labels_mandarin_as_mandarin_and_vietnamese_as_before() -> None:
    mock = MockTranslationProvider()
    mandarin = mock.translate("Hello.\nWorld.", TargetLanguage.MANDARIN)
    assert mandarin.is_illustrative
    assert "Mandarin Chinese" in mandarin.text and "Vietnamese" not in mandarin.text
    assert "(VI mock)" not in mandarin.text and "中文" in mandarin.text
    vietnamese = mock.translate("Hello.\nWorld.")
    assert vietnamese.text == (
        "[Development mock mode - illustrative content, NOT a real Vietnamese translation]\n"
        "(VI mock) Hello.\n(VI mock) World."
    )
    lines = mock.translate_lines(["One.", "Two."], TargetLanguage.MANDARIN).lines
    assert len(lines) == 2 and all("ZH mock" in line for line in lines)


# --- Han characters as word boundaries ------------------------------------------------------


def test_masking_keeps_every_position() -> None:
    text = "使用Kubernetes部署，共3个API。"
    masked = mask_han(text)
    assert len(masked) == len(text)
    assert [i for i, c in enumerate(text) if c != masked[i]] == [0, 1, 12, 13, 15, 17]


def test_glossary_terms_are_found_between_han_characters() -> None:
    terms = HanBoundaryTerms(GLOSSARY)
    text = "我们使用Kubernetes部署REST API，再用machine learning训练。"
    found = [m.text for m in terms.find_matches(text)]
    assert found == ["Kubernetes", "REST API", "machine learning"]
    for match in terms.find_matches(text):
        assert text[match.start : match.end] == match.text
    # Without the Han boundaries the glossary sees one long word and finds nothing.
    assert GLOSSARY.find_matches("我们使用Kubernetes部署") == []


def test_a_multiword_term_never_matches_across_a_han_character() -> None:
    assert HanBoundaryTerms(GLOSSARY).find_matches("machine的learning") == []


# --- chunks -----------------------------------------------------------------------------------

SENTENCES = [
    "神经网络使用gradient descent来最小化loss function。",
    "我们用Kubernetes部署REST API！",
    "版本是3.14吗？",
    "错误率从2%降到0.4%。",
    "“这很重要。”他说。",
    "共有1,024个节点；每个节点运行Node.js和C++程序。",
]


def test_chunks_end_at_chinese_sentence_punctuation_without_spaces() -> None:
    text = "".join(SENTENCES * 4)
    chunks = chunk_texts(text, 120)
    assert "".join(chunks) == text
    assert all(len(chunk) <= 120 for chunk in chunks)
    for chunk in chunks[:-1]:
        assert chunk[-1] in "。！？”", chunk


def test_a_short_line_is_one_chunk_with_zh_cn_and_en_us_spans() -> None:
    [spans] = chunk_spans("我们用Kubernetes部署REST API，版本是3.14。", GLOSSARY, 2000, ZH)
    assert spans == [
        ("zh-CN", "我们用"),
        ("en-US", "Kubernetes"),
        ("zh-CN", "部署"),
        ("en-US", "REST API"),
        ("zh-CN", "，版本是3.14。"),
    ]


def test_mandarin_chunks_are_capped_below_the_configured_vietnamese_limit() -> None:
    text = "".join(SENTENCES * 40)
    chunks = chunk_texts(text, 2000)
    assert max(len(chunk) for chunk in chunks) <= MANDARIN_MAX_CHUNK_CHARS < 2000
    assert len(chunks) > 1
    assert "".join(chunks) == text


def test_a_long_sentence_is_cut_at_clauses_then_between_characters() -> None:
    clauses = "，".join(["这个系统包含很多不同的模块"] * 12) + "。"
    chunks = chunk_texts(clauses, 60)
    assert "".join(chunks) == clauses
    assert all(chunk.endswith(("，", "。")) for chunk in chunks)
    no_punctuation = "这是一个没有标点符号的很长的句子" * 10
    chunks = chunk_texts(no_punctuation, 50)
    assert "".join(chunks) == no_punctuation and all(len(c) <= 50 for c in chunks)


def test_lines_and_spaces_are_kept_and_separators_dropped_only_at_cuts() -> None:
    text = "第一行 hello world 第一行。\n\n  第二行。 Next sentence here. 第二行结束。"
    expected = speech_text(text)
    chunks = chunk_texts(text, 2000)
    assert chunks == [expected]
    small = chunk_texts(text, 15)
    assert re.sub(r"\s", "", "".join(small)) == re.sub(r"\s", "", expected)
    assert all(chunk == chunk.strip() for chunk in small)


def test_a_token_or_term_longer_than_the_limit_cannot_be_split() -> None:
    with pytest.raises(SpeechTextTooLongError):
        chunk_texts("前" + "a" * 250 + "后", 200)


# Tokens a cut must never split: Latin words, numbers, glossary terms.
_ATOMS = re.compile(r"[A-Za-z0-9]+(?:[.,+#'-][A-Za-z0-9]+)*\+*")


@pytest.mark.parametrize("seed", range(25))
def test_random_mandarin_text_is_chunked_completely_in_order_and_never_inside_a_token(
    seed: int,
) -> None:
    rng = random.Random(seed)  # noqa: S311 (test data, not security)
    pieces = [
        *"我们的系统使用了很多不同模块数据处理速度非常快",
        *"。！？，、；：…",
        "Kubernetes", "REST API", "machine learning", "loss function", "Node.js", "C++",
        "3.14", "1,024", "2026", "50%", "API", "run", "hello world", " ", "”", "（注）",
    ]  # fmt: skip
    lines = ["".join(rng.choice(pieces) for _ in range(rng.randint(5, 400))) for _ in range(3)]
    text = "\n".join(lines)
    limit = rng.choice([200, 300, 600, 2000])
    expected = speech_text(text)
    try:
        spans = chunk_spans(text, GLOSSARY, limit, ZH)
    except SpeechTextTooLongError:
        pytest.fail("ordinary text must always be splittable")
    chunks = ["".join(piece for _, piece in s) for s in spans]
    assert all(0 < len(chunk) <= min(limit, MANDARIN_MAX_CHUNK_CHARS) for chunk in chunks)
    # Complete and in order: only whitespace lies between consecutive chunks.
    position = 0
    for chunk in chunks:
        found = expected.index(chunk, position)
        assert expected[position:found].strip() == ""
        position = found + len(chunk)
    assert expected[position:].strip() == ""
    # No cut inside a Latin/number token or a glossary term.
    cuts, offset = set(), 0
    for chunk in chunks:
        offset = expected.index(chunk, offset)
        cuts.update({offset, offset + len(chunk)})
        offset += len(chunk)
    protected = [(m.start(), m.end()) for m in _ATOMS.finditer(expected)]
    for line_start, line in _line_offsets(expected):
        protected += [
            (line_start + m.start, line_start + m.end)
            for m in HanBoundaryTerms(GLOSSARY).protected_matches(line)
        ]
    for start, end in protected:
        assert not any(start < cut < end for cut in cuts), expected[start:end]


def _line_offsets(text: str):
    offset = 0
    for line in text.split("\n"):
        yield offset, line
        offset += len(line) + 1


# --- SSML ---------------------------------------------------------------------------------------


def test_mandarin_ssml_has_one_voice_zh_cn_and_en_us_spans_and_escaped_text() -> None:
    text = "使用Kubernetes处理<tag>&数据，REST API很快。"
    [spans] = chunk_spans(text, GLOSSARY, 2000, ZH)
    ssml = build_ssml_from_spans(spans, Voice.EMMA)
    root = ET.fromstring(ssml)
    voices = root.findall(f"{SSML_NS}voice")
    assert len(voices) == 1 and voices[0].get("name") == "en-US-EmmaMultilingualNeural"
    langs = [(child.get(XML_LANG), child.text) for child in voices[0]]
    assert {lang for lang, _ in langs} == {"zh-CN", "en-US"}
    assert ("en-US", "Kubernetes") in langs and ("en-US", "REST API") in langs
    assert "".join(t for _, t in langs) == text  # content, order and punctuation unchanged
    assert "&lt;tag&gt;&amp;" in ssml and "<tag>" not in ssml


def test_vietnamese_ssml_through_the_language_plan_is_unchanged() -> None:
    text = "Một neural network sử dụng gradient descent để giảm thiểu loss function."
    [spans] = planned_chunk_spans(text, GLOSSARY, 2000, TargetLanguage.VIETNAMESE)
    assert build_ssml_from_spans(spans, Voice.ANDREW) == (
        '<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en-US">'
        '<voice name="en-US-AndrewMultilingualNeural">'
        '<lang xml:lang="vi-VN">Một </lang><lang xml:lang="en-US">neural network</lang>'
        '<lang xml:lang="vi-VN"> sử dụng </lang><lang xml:lang="en-US">gradient descent</lang>'
        '<lang xml:lang="vi-VN"> để giảm thiểu </lang><lang xml:lang="en-US">loss function</lang>'
        '<lang xml:lang="vi-VN">.</lang></voice></speak>'
    )


# --- spoken length ------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("text", "syllables"),
    [
        ("我们", 2),  # one per character
        ("。，！？：；、“”", 0),  # punctuation is not read
        ("2026", 6),  # 两千零二十六
        ("10000", 2),  # 一万
        ("15", 2),  # 十五
        ("105", 4),  # 一百零五
        ("1024", 6),  # 一千零二十四
        ("1,024", 6),  # thousands separator
        ("3.14", 4),  # 三点一四
        ("50%", 5),  # 百分之五十
        ("0", 1),  # 零
        ("007", 3),  # digit by digit
        ("API", 3),  # spelled
        ("Kubernetes", 4),  # vowel groups
        ("4GB", 3),  # 四 G B
        ("使用Kubernetes部署REST API。", 2 + 4 + 2 + 4 + 3),  # all-caps REST is spelled
    ],
)
def test_mandarin_syllable_estimate(text: str, syllables: int) -> None:
    assert mandarin_syllables(text) == syllables


def test_the_vietnamese_estimate_does_not_fit_unspaced_chinese() -> None:
    # Why Mandarin needs its own estimate: a whole sentence without spaces is one "word".
    sentence = "神经网络使用梯度下降来最小化损失函数。"
    assert spoken_syllables(sentence) == 1
    assert mandarin_syllables(sentence) == 18
