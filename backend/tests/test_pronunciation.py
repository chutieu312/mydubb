# ruff: noqa: RUF001  (a typographic quote and a full-width letter are test input on purpose)
"""English left in a translation: classification, spans, SSML and chunking (no network, no DB).

The sample (`scripts/pronunciation_smoke.py`) is the synthetic transcript the Product Owner
supplied for acceptance and the real Azure Translator output for it (F0, 2026-10-23, with the
glossary of this change).
"""

import itertools
import random
import unicodedata
import xml.etree.ElementTree as ET

import pytest

from app.pronunciation.detector import (
    MAX_CANDIDATES_PER_JOB,
    CandidateKind,
    SpanKind,
    SpeechTerms,
    detect_english,
)
from app.pronunciation.keys import candidate_key, display_form
from app.pronunciation.vietnamese import may_be_vietnamese
from app.speech.chunker import SpeechTextTooLongError, speech_text, split_for_speech
from app.speech.ssml import (
    build_ssml,
    build_ssml_from_spans,
    chunk_language_spans,
    language_spans,
)
from app.speech.voices import Voice
from app.translation.glossary import Glossary, default_glossary
from scripts.pronunciation_smoke import SAMPLE_EN, SAMPLE_VI
from tests.audio_helpers import ssml_spans

GLOSSARY = default_glossary()

# Vietnamese sentences (with diacritics) used to check that no Vietnamese word, once its
# diacritics are removed, is ever taken for English.
VIETNAMESE_CORPUS = [
    SAMPLE_VI,
    "Hôm nay chúng ta tìm hiểu cách một neural network học từ dữ liệu.",
    "Người dùng không thể nghiêng điện thoại khi đang chuyển khoản qua ngân hàng.",
    "Quyển sách này của trường đại học được viết bởi giáo sư Nguyễn Văn An ở Huế.",
    "Khuya rồi, anh ấy vẫn ngồi uống nước và suy nghĩ về tương lai của gia đình.",
    "Đường phố Sài Gòn luôn đông đúc, xe cộ chen chúc nhau từ sáng tới khuya.",
    "Chúng tôi yêu cầu khách hàng xoay khuỷu tay và ngoẹo đầu sang trái một chút.",
    "Bộ nhớ đệm giúp truy xuất dữ liệu nhanh hơn, nhưng cũng làm tăng độ phức tạp.",
    "Hướng dẫn này giải thích tại sao chương trình của bạn chạy chậm khi tải nặng.",
    "Thuở nhỏ, ông ngoại thường kể chuyện cổ tích bên bếp lửa hồng.",
    "Giường ngủ, quả bưởi, con hươu, ngoằn ngoèo, khuyên bảo, nguyệt quế, thuyền buồm.",
]


def strip_diacritics(text: str) -> str:
    decomposed = unicodedata.normalize("NFD", text.replace("đ", "d").replace("Đ", "D"))
    return "".join(char for char in decomposed if unicodedata.category(char) != "Mn")


def english_spans(detection) -> list[tuple[str, str]]:
    return [(span.kind.value, span.text) for span in detection.spans]


# --- Vietnamese syllables -------------------------------------------------------------------


def test_every_vietnamese_word_without_diacritics_may_be_vietnamese():
    for sentence in VIETNAMESE_CORPUS:
        plain = strip_diacritics(sentence)
        for word in plain.replace("'", " ").split():
            word = word.strip(".,!?;:'")
            if word.isalpha() and not word.isascii():
                pytest.fail(f"diacritics left in {word!r}")
            if word.isalpha() and word.lower() not in _ENGLISH_IN_CORPUS:
                assert may_be_vietnamese(word), word


_ENGLISH_IN_CORPUS = {
    "container",
    "containers",
    "runtime",
    "docker",
    "kernel",
    "linux",
    "proc",
    "trenchcoat",
    "neural",
    "network",
}


@pytest.mark.parametrize(
    "word",
    [
        "runtime", "container", "Containers", "kernel", "Linux", "Docker", "VMs", "trenchcoat",
        "process", "weird", "fun", "real", "features", "with", "and", "is", "look", "JSON",
        "you", "Kubernetes", "aren't", "x86",
    ],
)  # fmt: skip
def test_english_words_cannot_be_vietnamese_syllables(word):
    assert not may_be_vietnamese(word)


@pytest.mark.parametrize(
    "word",
    ["an", "to", "do", "con", "ban", "run", "Nguyen", "Hoang", "trong", "nhau", "Go", "me"],
)
def test_words_that_could_be_vietnamese_are_ambiguous(word):
    assert may_be_vietnamese(word)


# --- the Product Owner's sample ---------------------------------------------------------------


def test_sample_classification_with_the_real_translation():
    detection = detect_english(SAMPLE_EN, SAMPLE_VI, GLOSSARY)
    assert english_spans(detection) == [
        ("glossary", "container runtime"),
        ("glossary", "Docker"),
        ("term", "Container"),
        ("term", "container"),
        ("term", "Kernel"),
        ("code", "/proc"),
        ("glossary", "linux"),
        ("term", "containers"),
        ("term", "container"),
        ("glossary", "linux kernel"),
        ("term", "trenchcoat"),
    ]
    # Glossary terms and code are never candidates; "trenchcoat" is one, as a pending word
    # for review (nothing approves or promotes it).
    assert [(c.key, c.term, c.kind) for c in detection.candidates] == [
        ("container", "Container", CandidateKind.WORD),
        ("kernel", "Kernel", CandidateKind.WORD),
        ("containers", "containers", CandidateKind.WORD),
        ("trenchcoat", "trenchcoat", CandidateKind.WORD),
    ]
    assert detection.counts() == {
        "glossary": 4,
        "term": 6,
        "untranslated": 0,
        "code": 1,
        "candidates": 4,
        "ambiguous_tokens": 0,
        "unmatched_tokens": 0,
    }


def test_sample_ssml_reads_detected_english_in_en_us_and_keeps_every_character():
    detection = detect_english(SAMPLE_EN, SAMPLE_VI, GLOSSARY)
    for line in SAMPLE_VI.split("\n"):
        spans = ssml_spans(build_ssml(line, Voice.EMMA, detection.speech_terms).encode())
        assert "".join(text for _, text in spans) == line
    second = SAMPLE_VI.split("\n")[1]
    english = [
        text
        for language, text in language_spans(second, detection.speech_terms)
        if language == "en-US"
    ]
    assert english == ["Container", "container", "Kernel", "/proc"]
    # Without detection (glossary only, as before) none of them had an English span.
    assert [t for lang, t in language_spans(second, GLOSSARY) if lang == "en-US"] == []


def test_detection_never_changes_the_translation_text():
    detection = detect_english(SAMPLE_EN, SAMPLE_VI, GLOSSARY)
    for span in detection.spans:
        assert SAMPLE_VI[span.start : span.end] == span.text


# --- glossary priority ---------------------------------------------------------------------------


def test_known_glossary_terms_keep_priority_over_detection():
    source = "The container runtime and the kernel."
    translation = "container runtime và kernel."
    detection = detect_english(source, translation, GLOSSARY)
    assert english_spans(detection) == [
        ("glossary", "container runtime"),
        ("term", "kernel"),
    ]
    assert [c.key for c in detection.candidates] == ["kernel"]


def test_glossary_matches_are_unchanged_when_nothing_else_is_english():
    text = "Mô hình sử dụng gradient descent để giảm thiểu loss function."
    detection = detect_english("Gradient descent minimizes the loss function.", text, GLOSSARY)
    assert detection.speech_terms.find_matches(text) == GLOSSARY.find_matches(text)
    assert detection.candidates == ()


# --- what is NOT English --------------------------------------------------------------------------


def test_vietnamese_words_without_diacritics_copied_from_the_source_stay_vietnamese():
    source = "Our teacher Nguyen Van An lives in Hoi An and loves pho."
    translation = "Thầy giáo Nguyen Van An của chúng tôi sống ở Hoi An và yêu pho."
    detection = detect_english(source, translation, GLOSSARY)
    assert detection.spans == ()
    assert detection.candidates == ()
    assert detection.ambiguous_tokens == 6  # counted, not forced into English


def test_a_word_that_is_not_in_the_source_is_not_english():
    detection = detect_english("Nothing here.", "Một từ lạ: kernel.", GLOSSARY)
    assert detection.spans == ()
    assert detection.unmatched_tokens == 1


def test_short_english_words_shaped_like_vietnamese_stay_vietnamese():
    # Documented limit: "run", "Go" could be Vietnamese syllables, so they are not guessed.
    detection = detect_english("We run Go code.", "Chúng tôi run Go code.", GLOSSARY)
    assert english_spans(detection) == [("term", "code")]
    assert detection.ambiguous_tokens == 2


def test_an_acronym_copied_with_its_exact_case_is_english():
    detection = detect_english("Our CEO uses AI.", "CEO của chúng tôi dùng AI.", GLOSSARY)
    assert english_spans(detection) == [("term", "CEO"), ("term", "AI")]
    assert {c.kind for c in detection.candidates} == {CandidateKind.ACRONYM}
    # Lowercase "ceo" in a Vietnamese text is not an acronym copied from the source.
    assert detect_english("Our CEO.", "ceo của chúng tôi.", GLOSSARY).spans == ()


def test_an_ordinary_english_word_kept_by_the_translation_is_a_candidate_only():
    # "model" has an everyday meaning, so it is not in the glossary. When the translation keeps
    # it, it is English (read en-US) and a pending candidate; nothing makes it a glossary term.
    detection = detect_english("The model works.", "model hoạt động.", GLOSSARY)
    assert english_spans(detection) == [("term", "model")]
    assert GLOSSARY.find_matches("model") == []


# --- code -----------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    "token",
    [
        "/proc",
        "/proc/self/status",
        "~/projects",
        "./run.sh",
        "https://example.com/a?b=1&c=2",
        "www.example.com",
        "admin@example.com",
        "os.path",
        "max_len",
        "__init__",
        "main()",
        "--verbose",
        "Node.js",
        "C:\\Windows",
    ],
)
def test_code_copied_from_the_source_is_code_and_never_a_candidate(token):
    detection = detect_english(f"Look at {token} now.", f"Hãy xem {token} ngay.", GLOSSARY)
    assert english_spans(detection) == [("code", token)]
    assert detection.candidates == ()


def test_code_changed_by_the_translation_is_not_marked():
    detection = detect_english("Open /proc now.", "Mở /Proc ngay.", GLOSSARY)
    assert detection.spans == ()
    assert detection.unmatched_tokens == 1


def test_abbreviations_and_glossary_slashes_are_not_code():
    detection = detect_english("Use CI/CD, e.g. here.", "Dùng CI/CD, ví dụ ở đây.", GLOSSARY)
    assert english_spans(detection) == [("glossary", "CI/CD")]


def test_a_url_containing_a_glossary_term_is_one_code_span():
    url = "https://github.com/x/y"
    detection = detect_english(f"See {url}.", f"Xem {url}.", GLOSSARY)
    assert english_spans(detection) == [("code", url)]


def test_sentence_punctuation_is_not_part_of_a_path():
    detection = detect_english("in /proc.", "trong /proc.", GLOSSARY)
    assert english_spans(detection) == [("code", "/proc")]


# --- phrases, untranslated English, kinds --------------------------------------------------------


def test_adjacent_english_words_from_the_source_form_a_phrase_candidate():
    detection = detect_english("Build an image layer.", "Tạo một image layer.", GLOSSARY)
    assert english_spans(detection) == [("term", "image layer")]
    assert [(c.term, c.kind) for c in detection.candidates] == [
        ("image layer", CandidateKind.PHRASE)
    ]


def test_an_ambiguous_word_joins_only_when_the_whole_sequence_is_in_the_source():
    source = "five kernel features in trenchcoat"
    joined = detect_english(source, "năm kernel features in trenchcoat", GLOSSARY)
    assert english_spans(joined) == [("untranslated", "kernel features in trenchcoat")]
    assert joined.candidates == ()  # an English clause, not a term

    apart = detect_english(source, "kernel an trenchcoat", GLOSSARY)
    assert english_spans(apart) == [("term", "kernel"), ("term", "trenchcoat")]


def test_english_left_untranslated_is_read_in_english_but_not_stored():
    detection = detect_english("Docker is weird.", "Docker is weird.", GLOSSARY)
    assert english_spans(detection) == [("glossary", "Docker"), ("untranslated", "is weird")]
    assert detection.candidates == ()


def test_candidate_kinds():
    source = "Buildah and Buildah, NICs and GitHub-like iPhone tools."
    translation = "Buildah và tôi dùng Buildah, NICs và iPhone."
    detection = detect_english(source, translation, GLOSSARY)
    kinds = {c.term: c.kind for c in detection.candidates}
    # Capitalized inside a sentence upgrades the sentence-initial sighting to a name.
    assert kinds == {
        "Buildah": CandidateKind.PROPER_NAME,
        "NICs": CandidateKind.ACRONYM,
        "iPhone": CandidateKind.PROPER_NAME,
    }


def test_a_term_seen_many_times_in_one_job_is_one_candidate():
    detection = detect_english("kernel kernel Kernel", "kernel, kernel và Kernel.", GLOSSARY)
    assert [(c.key, c.term) for c in detection.candidates] == [("kernel", "kernel")]


def test_candidates_per_job_are_bounded():
    words = [f"zz{chr(97 + i // 26)}{chr(97 + i % 26)}" for i in range(MAX_CANDIDATES_PER_JOB + 5)]
    text = ", ".join(words)
    detection = detect_english(text, text, GLOSSARY)
    assert len(detection.candidates) == MAX_CANDIDATES_PER_JOB
    assert detection.dropped_candidates == 5


# --- keys -----------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("text", "display", "key"),
    [
        ("Kernel", "Kernel", "kernel"),
        ("kernel", "kernel", "kernel"),
        ("VMs", "VMs", "VMs"),
        ("REST", "REST", "REST"),
        ("rest", "rest", "rest"),
        ("GitHub", "GitHub", "GitHub"),
        ("Github", "Github", "github"),
        ("container\u00a0  image", "container image", "container image"),
        ("Container Image", "Container Image", "container image"),
        ("can’t", "can't", "can't"),
        ("Ｄocker", "Ｄocker", "docker"),  # full-width letter (NFKC)
        ("containers", "containers", "containers"),  # plurals are not merged
    ],
)
def test_display_form_and_key(text, display, key):
    assert display_form(text) == display
    assert candidate_key(text) == key


# --- SSML, chunking, invariants -----------------------------------------------------------------


def test_hostile_text_is_escaped_with_detected_spans():
    source = '<b>kernel</b> & </lang><audio src="x"/> trenchcoat'
    detection = detect_english(source, source, GLOSSARY)
    raw = build_ssml(source, Voice.ANDREW, detection.speech_terms).encode()
    root = ET.fromstring(raw)
    assert [child.tag.split("}")[1] for child in root] == ["voice"]
    spans = ssml_spans(raw)
    assert "".join(text for _, text in spans) == source
    assert ("en-US", "kernel") in spans and ("en-US", "trenchcoat") in spans
    assert {language for language, _ in spans} <= {"vi-VN", "en-US"}


def test_chunks_never_cut_a_detected_phrase():
    source = "image layer registry " * 3
    translation = ("Một image layer ở đây và một image layer nữa. " * 12).strip()
    terms = SpeechTerms(GLOSSARY, english=["image layer"])
    chunks = split_for_speech(translation, terms, 40)
    assert " ".join(chunks).split() == translation.split()
    assert all(not chunk.endswith("image") for chunk in chunks)
    assert all(not chunk.startswith("layer") for chunk in chunks)
    assert detect_english(source, translation, GLOSSARY).candidates[0].term == "image layer"


def test_random_mixtures_partition_exactly_and_never_overlap():
    rng = random.Random(1234)  # noqa: S311 (reproducible test data)
    pieces = [
        "kernel", "Kernel", "containers", "trenchcoat", "/proc", "os.path", "an", "to",
        "Nguyen", "neural network", "Docker", "vẫn", "chạy", "tiến trình", "là", "&", "<",
        "'x'", "e.g.", "CI/CD", "is", "in", "VMs", "https://example.com/a", "\u00a0",
    ]  # fmt: skip
    for _ in range(300):
        words = [rng.choice(pieces) for _ in range(rng.randint(1, 25))]
        text = "".join(word + rng.choice([" ", "  ", ", ", ". ", "\t"]) for word in words)
        detection = detect_english(text, text, GLOSSARY)
        spans = language_spans(text, detection.speech_terms)
        assert "".join(piece for _, piece in spans) == text
        matches = detection.speech_terms.find_matches(text)
        assert all(a.end <= b.start for a, b in itertools.pairwise(matches))
        for span in detection.spans:
            assert text[span.start : span.end] == span.text
        ET.fromstring(build_ssml(text, Voice.ANDREW, detection.speech_terms).encode())


def test_speech_terms_without_detection_behave_like_the_glossary():
    glossary = Glossary.from_text("=REST\nneural network")
    terms = SpeechTerms(glossary)
    text = "REST và rest với neural networks."
    assert terms.find_matches(text) == glossary.find_matches(text)
    assert [kind for _, kind in terms.classified_matches(text)] == [SpanKind.GLOSSARY] * 2


# --- end to end: detection -> chunks -> SSML (review findings on PR #20) -------------------------


def speech_pipeline(source: str, translation: str, max_chars: int):
    """What Azure Speech does with a translation: detect, chunk, decide languages, build SSML."""
    detection = detect_english(source, translation, GLOSSARY)
    chunks = split_for_speech(translation, detection.speech_terms, max_chars)
    spans = chunk_language_spans(speech_text(translation), chunks, detection.speech_terms)
    for chunk, chunk_spans in zip(chunks, spans, strict=True):
        assert len(chunk) <= max_chars
        assert "".join(piece for _, piece in chunk_spans) == chunk  # nothing lost or added
        raw = build_ssml_from_spans(chunk_spans, Voice.ANDREW).encode()
        assert ssml_spans(raw) == chunk_spans  # escaped, one voice, same spans
    # All chunks together are the whole text, in order, nothing repeated (chunk_language_spans
    # also checked that they are consecutive pieces of the normalized text).
    assert " ".join(chunks).split() == translation.split()
    return detection, chunks, spans


def no_letters(piece: str) -> bool:
    return not any(char.isalpha() for char in piece)


def test_a_long_english_span_is_cut_at_words_and_every_piece_stays_english():
    text = " ".join(["widget registry"] * 160)  # 2559 characters, one English clause
    assert len(split_for_speech(text, GLOSSARY, 2000)) == 2  # glossary only: fine before
    detection, chunks, spans = speech_pipeline(text, text, 2000)
    assert [(span.kind, len(span.text)) for span in detection.spans] == [
        (SpanKind.UNTRANSLATED, 2559)
    ]
    assert len(chunks) == 2
    assert all(language == "en-US" for chunk_spans in spans for language, _ in chunk_spans)
    assert detection.candidates == ()  # a long clause is never a candidate


def test_long_english_keeps_glossary_terms_and_short_phrases_whole():
    clause = "widgets image layer and neural network are fine with "
    translation = "Dùng image layer ở đây.\n" + (clause * 40).strip()
    detection, chunks, spans = speech_pipeline(translation, translation, 60)
    assert len(chunks) > 10
    for chunk in chunks:
        # Never cut inside the glossary term or the short phrase detected on line 1.
        assert not chunk.endswith(("image", "neural"))
        assert not chunk.startswith(("layer", "network"))
    long_line = [s for c, s in zip(chunks, spans, strict=True) if "Dùng" not in c]
    for chunk_spans in long_line:
        assert all(language == "en-US" or no_letters(piece) for language, piece in chunk_spans)
        # The glossary term keeps its own span (glossary priority).
        if "neural network" in "".join(piece for _, piece in chunk_spans):
            assert ("en-US", "neural network") in chunk_spans
    assert spans[0][:3] == [("vi-VN", "Dùng "), ("en-US", "image layer"), ("vi-VN", " ở đây.")]
    assert [(c.term, c.kind) for c in detection.candidates] == [
        ("image layer", CandidateKind.PHRASE)
    ]


def test_a_short_detected_phrase_longer_than_the_limit_is_still_not_cut():
    terms = SpeechTerms(GLOSSARY, english=["widget registry"])
    with pytest.raises(SpeechTextTooLongError):
        split_for_speech("một widget registry", terms, 10)


@pytest.mark.parametrize("gap", ["\t", "   ", " ", " \t "])
def test_english_stays_english_whatever_the_whitespace(gap):
    source = "We use widget registry."
    translation = f"Một widget{gap}registry ở đây."
    detection, chunks, spans = speech_pipeline(source, translation, 2000)
    assert chunks == ["Một widget registry ở đây."]
    assert spans == [[("vi-VN", "Một "), ("en-US", "widget registry"), ("vi-VN", " ở đây.")]]
    assert [(c.term, c.kind) for c in detection.candidates] == [
        ("widget registry", CandidateKind.PHRASE)
    ]
    # Spelling, order and the original whitespace of the translation are untouched.
    assert [span.text for span in detection.spans] == [f"widget{gap}registry"]


def test_whitespace_inside_a_long_span_and_across_lines():
    translation = "Câu một.\nwidget  registry\tand   more widgets\nCâu hai."
    _, _, spans = speech_pipeline(translation, translation, 2000)
    assert spans == [
        [
            ("vi-VN", "Câu một.\n"),
            ("en-US", "widget registry and more widgets"),
            ("vi-VN", "\nCâu hai."),
        ]
    ]


def test_chunk_language_spans_refuses_chunks_that_are_not_the_text():
    with pytest.raises(ValueError, match="consecutive"):
        chunk_language_spans("một hai", ["một", "ba"], GLOSSARY)
