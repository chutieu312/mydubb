import pytest

from app.speech.chunker import SpeechTextTooLongError, split_for_speech
from app.speech.ssml import language_spans
from app.translation.glossary import Glossary, default_glossary

GLOSSARY = Glossary.from_text("neural network\nDependency Injection\nSpring Boot\nJSON")


def words(text: str) -> list[str]:
    return text.split()


def test_short_text_is_one_chunk_and_blank_text_is_none():
    assert split_for_speech("Xin chào các bạn.", GLOSSARY, 200) == ["Xin chào các bạn."]
    assert split_for_speech("", GLOSSARY, 200) == []
    assert split_for_speech(" \n \r\n ", GLOSSARY, 200) == []


def test_lines_are_packed_in_order_keeping_one_line_break_between_them():
    text = "Dòng một.\n\n  Dòng   hai.\r\nDòng ba."
    # As in the accepted audition: lines stay on separate lines inside a chunk; spaces inside
    # a line are normalized and blank lines dropped.
    assert split_for_speech(text, GLOSSARY, 200) == ["Dòng một.\nDòng hai.\nDòng ba."]


ACCEPTED = (
    "Hôm nay chúng ta tìm hiểu cách một neural network học từ dữ liệu.\n"
    "Mô hình sử dụng gradient descent để giảm thiểu loss function.\n"
    "Spring Boot sử dụng Dependency Injection để quản lý các đối tượng.\n"
    "Ứng dụng gọi REST API, nhận dữ liệu JSON và chạy pipeline CI/CD."
)
ACCEPTED_TERMS = [
    "neural network",
    "gradient descent",
    "loss function",
    "Spring Boot",
    "Dependency Injection",
    "REST API",
    "JSON",
    "pipeline",
    "CI/CD",
]


def test_the_accepted_transcript_is_one_chunk_identical_to_the_audition():
    assert split_for_speech(ACCEPTED, default_glossary(), 2000) == [ACCEPTED]


@pytest.mark.parametrize("limit", [70, 80, 100, 130, 200, 300])
def test_chunking_the_accepted_transcript_keeps_content_order_and_whole_english_spans(limit):
    glossary = default_glossary()
    chunks = split_for_speech(ACCEPTED, glossary, limit)
    assert all(len(chunk) <= limit for chunk in chunks)
    assert words(" ".join(chunks)) == words(ACCEPTED)
    english = [
        span
        for chunk in chunks
        for language, span in language_spans(chunk, glossary)
        if language == "en-US"
    ]
    assert english == ACCEPTED_TERMS  # every term once, whole, in order


def test_chunks_respect_the_limit_and_keep_every_word_in_order():
    sentences = [f"Câu số {i} nói về neural network và Spring Boot." for i in range(60)]
    text = "\n".join(sentences)
    chunks = split_for_speech(text, GLOSSARY, 300)
    assert len(chunks) > 5
    assert all(0 < len(chunk) <= 300 for chunk in chunks)
    assert words(" ".join(chunks)) == words(text)  # nothing lost, repeated or reordered


def test_chunks_end_on_sentence_boundaries_when_sentences_fit():
    sentences = [f"Đây là câu số {i}." for i in range(40)]
    chunks = split_for_speech(" ".join(sentences), GLOSSARY, 100)
    assert all(chunk.endswith(".") for chunk in chunks)


def test_a_long_sentence_is_cut_at_spaces_only():
    sentence = " ".join(f"từ{i}" for i in range(200)) + "."
    chunks = split_for_speech(sentence, GLOSSARY, 120)
    assert len(chunks) > 1
    assert all(len(chunk) <= 120 for chunk in chunks)
    assert words(" ".join(chunks)) == words(sentence)


def test_a_protected_term_is_never_split_across_chunks():
    # The limit forces a cut near every term; the cut must fall before or after it.
    filler = "x" * 20
    text = " ".join(f"{filler} neural network {filler} Dependency Injection" for _ in range(30))
    for limit in range(60, 140, 7):
        chunks = split_for_speech(text, GLOSSARY, limit)
        assert all(len(chunk) <= limit for chunk in chunks)
        for chunk in chunks:
            assert chunk.count("neural") == chunk.count("network")
            assert chunk.count("Dependency") == chunk.count("Injection")
        assert words(" ".join(chunks)) == words(text)


def test_default_glossary_terms_stay_together():
    text = " ".join(["a" * 40 + " loss function"] * 20)
    chunks = split_for_speech(text, default_glossary(), 150)
    for chunk in chunks:
        assert chunk.count("loss") == chunk.count("function")
    assert words(" ".join(chunks)) == words(text)


def test_a_word_longer_than_the_limit_is_an_error_not_a_cut():
    with pytest.raises(SpeechTextTooLongError):
        split_for_speech("a" * 500, GLOSSARY, 200)
    with pytest.raises(SpeechTextTooLongError):
        split_for_speech("ngắn " + "a" * 500 + " ngắn", GLOSSARY, 200)


def test_text_exactly_at_the_limit_is_one_chunk():
    assert split_for_speech("b" * 200, GLOSSARY, 200) == ["b" * 200]
