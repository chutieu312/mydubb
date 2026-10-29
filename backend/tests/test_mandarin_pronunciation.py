# ruff: noqa: RUF001 (Chinese punctuation is the subject of these tests)
"""English left in a Mandarin translation: which spans speech reads in en-US (pure text)."""

from app.pronunciation.detector import SpanKind, detect_english
from app.pronunciation.mandarin import detect_english_mandarin
from app.speech.mandarin import chunk_spans
from app.translation.glossary import default_glossary

GLOSSARY = default_glossary()
SOURCE = (
    "A neural network uses gradient descent to minimize the loss function. We run the service "
    "with Go and map the results. The CEO said the trenchcoat team uses Kubernetes. Visit "
    "https://example.com/docs or read /proc/cpuinfo. It is in the box."
)


def spans(translation: str, source: str = SOURCE) -> list[tuple[str, str]]:
    detection = detect_english_mandarin(source, translation, GLOSSARY)
    return [(span.text, span.kind.value) for span in detection.spans]


def test_glossary_terms_between_han_characters_are_english() -> None:
    assert spans("神经网络使用gradient descent来最小化loss function。") == [
        ("gradient descent", "glossary"),
        ("loss function", "glossary"),
    ]


def test_words_copied_from_the_source_are_english_whatever_their_shape() -> None:
    # For Vietnamese "run", "Go" and "map" may be syllables and stay vi-VN; Chinese has no such
    # words, so a copied Latin word is English.
    assert spans("我们用Go来run服务并map结果。") == [
        ("Go", "term"),
        ("run", "term"),
        ("map", "term"),
    ]
    vietnamese = detect_english(SOURCE, "Chúng ta run dịch vụ với Go.", GLOSSARY)
    assert vietnamese.spans == ()  # unchanged Vietnamese rule: ambiguous words stay vi-VN


def test_acronyms_and_proper_words_copied_from_the_source_are_english() -> None:
    assert spans("CEO说trenchcoat团队使用Kubernetes。") == [
        ("CEO", "term"),
        ("trenchcoat", "term"),
        ("Kubernetes", "glossary"),
    ]


def test_a_latin_word_not_in_the_source_stays_chinese_and_is_only_counted() -> None:
    detection = detect_english_mandarin(SOURCE, "这是pinyin吗？", GLOSSARY)
    assert detection.spans == ()
    assert detection.unmatched_tokens == 1


def test_code_ends_where_the_chinese_text_resumes() -> None:
    assert spans("访问https://example.com/docs了解，或读/proc/cpuinfo。") == [
        ("https://example.com/docs", "code"),
        ("/proc/cpuinfo", "code"),
    ]


def test_an_untranslated_clause_is_english_but_not_a_term() -> None:
    assert spans("他说It is in the box然后离开。") == [("It is in the box", "untranslated")]


def test_mandarin_jobs_record_no_glossary_candidates() -> None:
    detection = detect_english_mandarin(SOURCE, "CEO说trenchcoat团队使用Kubernetes。", GLOSSARY)
    assert detection.candidates == ()


def test_detected_english_becomes_en_us_spans_in_the_speech_chunks() -> None:
    translation = "我们用Go来run服务，CEO使用Kubernetes。"
    terms = detect_english_mandarin(SOURCE, translation, GLOSSARY).speech_terms
    [chunk] = chunk_spans(translation, terms, 2000, "zh-CN")
    assert chunk == [
        ("zh-CN", "我们用"),
        ("en-US", "Go"),
        ("zh-CN", "来"),
        ("en-US", "run"),
        ("zh-CN", "服务，"),
        ("en-US", "CEO"),
        ("zh-CN", "使用"),
        ("en-US", "Kubernetes"),
        ("zh-CN", "。"),
    ]
    assert "".join(text for _, text in chunk) == translation


def test_the_translation_text_is_never_changed() -> None:
    translation = "第一行使用Go。\n\n第二行 run 它。"
    detection = detect_english_mandarin(SOURCE, translation, GLOSSARY)
    for span in detection.spans:
        assert translation[span.start : span.end] == span.text
    assert {span.kind for span in detection.spans} == {SpanKind.TERM}
