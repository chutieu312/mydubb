"""The Aho-Corasick matcher keeps the glossary's matching contract (see `glossary.py`).

`reference_matches` is the matcher as it was before the automaton: one regular expression per
term over the whole text. The new matcher must return exactly the same list.
"""

import random
import re
import sys
import threading
import unicodedata
import xml.etree.ElementTree as ET
from bisect import bisect_left

import pytest

from app.speech.chunker import speech_text, split_for_speech
from app.speech.ssml import build_ssml, chunk_language_spans
from app.speech.voices import DEFAULT_VOICE
from app.translation import glossary as glossary_module
from app.translation.glossary import Glossary, TermMatch, _case_keys, default_glossary
from app.translation.notranslate_markup import parse_translated_markup, to_markup
from app.translation.segmenter import plan_translation
from tests.audio_helpers import ssml_spans, ssml_voice


def reference_matches(terms: list[tuple[str, bool]], text: str) -> list[TermMatch]:
    """The previous `Glossary.find_matches`, kept here as the oracle."""
    patterns = []
    for term, case_sensitive in terms:
        words = r"\s+".join(re.escape(word) for word in term.split(" "))
        plural = "s?" if term[-1].isalnum() and term[-1].lower() != "s" else ""
        flags = 0 if case_sensitive else re.IGNORECASE
        patterns.append(re.compile(rf"(?<!\w){words}{plural}(?!\w)", flags))
    candidates = [
        TermMatch(m.start(), m.end(), m.group()) for p in patterns for m in p.finditer(text)
    ]
    candidates.sort(key=lambda m: (m.start - m.end, m.start))
    ordered: list[TermMatch] = []
    starts: list[int] = []
    for candidate in candidates:
        index = bisect_left(starts, candidate.start)
        before = ordered[index - 1] if index > 0 else None
        after = ordered[index] if index < len(ordered) else None
        if (before and before.end > candidate.start) or (after and after.start < candidate.end):
            continue
        starts.insert(index, candidate.start)
        ordered.insert(index, candidate)
    return ordered


def found(glossary: Glossary, text: str) -> list[str]:
    return [m.text for m in glossary.find_matches(text)]


def glossary_of(*lines: str) -> Glossary:
    return Glossary.from_text("\n".join(lines))


def assert_same_as_reference(glossary: Glossary, text: str) -> list[TermMatch]:
    matches = glossary.find_matches(text)
    assert matches == reference_matches(glossary.terms(), text)
    for match in matches:
        assert text[match.start : match.end] == match.text
    return matches


# --- Capitalization -----------------------------------------------------------------------


def test_ordinary_terms_ignore_capitalization_and_keep_the_input_spelling():
    glossary = glossary_of("SpringBoot")
    text = "SpringBoot, springboot, springBoot and SPRINGBOOT"
    assert found(glossary, text) == ["SpringBoot", "springboot", "springBoot", "SPRINGBOOT"]
    assert_same_as_reference(glossary, text)


def test_exact_terms_need_their_capitalization():
    glossary = glossary_of("=REST", "=REST API", "API")
    text = "REST, Rest, rest; REST API, rest api, REST api"
    assert found(glossary, text) == ["REST", "REST API", "api", "REST", "api"]
    assert_same_as_reference(glossary, text)


def test_an_exact_and_an_ordinary_term_with_the_same_letters_both_work():
    glossary = Glossary([("REST", True), ("rest area", False)])
    assert found(glossary, "REST, Rest Area, rest") == ["REST", "Rest Area"]


# --- Whitespace and aliases ---------------------------------------------------------------


@pytest.mark.parametrize(
    "gap", [" ", "   ", "\t", "\n", "\r\n", " \t\n ", "\u00a0", "\u2003", "\u3000"]
)
def test_words_of_a_term_may_be_separated_by_any_whitespace(gap):
    text = f"Một Spring{gap}Boot app"
    (match,) = assert_same_as_reference(glossary_of("Spring Boot"), text)
    assert match.text == f"Spring{gap}Boot"
    assert (match.start, match.end) == (4, 4 + len(match.text))


def test_spring_boot_and_springboot_are_different_terms_unless_both_are_listed():
    text = "Spring Boot and SpringBoot"
    assert found(glossary_of("Spring Boot"), text) == ["Spring Boot"]
    assert found(glossary_of("SpringBoot"), text) == ["SpringBoot"]
    assert found(glossary_of("Spring Boot", "SpringBoot"), text) == ["Spring Boot", "SpringBoot"]
    assert found(glossary_of("Spring Boot"), "Spring-Boot SpringBoots") == []


def test_long_whitespace_runs_before_a_match_keep_positions_exact():
    text = "a  \n\n\t  b     neural \n\n network   x\t\tAPI"
    matches = assert_same_as_reference(glossary_of("neural network", "API"), text)
    assert [m.text for m in matches] == ["neural \n\n network", "API"]


# --- Whole words, plural, symbols ---------------------------------------------------------


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("capital API rapid", ["API"]),
        ("APIKey API_KEY API2 xAPI", []),  # inside longer words ("_" and digits are word chars)
        ("APIđó đóAPI ăAPI", []),  # Vietnamese letters are word characters too
        ("(API) x-API API.", ["API", "API", "API"]),
        ("APIs APIS apis", ["APIs", "APIS", "apis"]),
        ("APIss", []),
        ("Kubernetes Kubernetess", ["Kubernetes"]),
        ("neural networks", ["neural networks"]),
    ],
)
def test_whole_words_and_the_plural_s(text, expected):
    glossary = glossary_of("API", "Kubernetes", "neural network")
    assert found(glossary, text) == expected
    assert_same_as_reference(glossary, text)


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        (
            "C++ và C# trên .NET, gọi REST API qua CI/CD.",
            ["C++", "C#", ".NET", "REST API", "CI/CD"],
        ),
        ("(C++) [C#] '.NET' CI/CD/", ["C++", "C#", ".NET", "CI/CD"]),
        # Existing contract, unchanged: a term is not matched next to a word character.
        ("ASP.NET C++11 C#s CI/CD2", []),
        ("CI/CDs", ["CI/CDs"]),  # ends in a letter, so it takes the plural "s"
        ("c++ c# .net ci/cd", ["c++", "c#", ".net", "ci/cd"]),
        ("NodeXjs Node.js", ["Node.js"]),
    ],
)
def test_terms_with_symbols(text, expected):
    glossary = glossary_of("C++", "C#", ".NET", "=REST API", "CI/CD", "Node.js")
    assert found(glossary, text) == expected
    assert_same_as_reference(glossary, text)


# --- Overlap ------------------------------------------------------------------------------


def test_the_longest_match_wins_even_when_a_shorter_term_comes_first():
    glossary = glossary_of("machine learning", "learning rate scheduler", "rate")
    assert found(glossary, "machine learning rate scheduler rate") == [
        "learning rate scheduler",
        "rate",
    ]


def test_equal_lengths_go_to_the_earlier_match_and_results_are_in_text_order():
    glossary = glossary_of("a b", "b c", "c d", "e")
    matches = assert_same_as_reference(glossary, "a b c d e")
    spans = [(m.start, m.end, m.text) for m in matches]
    assert spans == [(0, 3, "a b"), (4, 7, "c d"), (8, 9, "e")]


def test_a_plural_counts_in_the_length_of_a_match():
    glossary = glossary_of("network", "networks training", "neural network")
    # "neural networks" (15 characters with its plural) loses to "networks training" (17).
    assert found(glossary, "neural networks training") == ["networks training"]
    assert found(glossary, "neural networks train") == ["neural networks"]


def test_a_term_never_overlaps_itself():
    glossary = glossary_of("a a")
    assert_same_as_reference(glossary, "a a a a a")
    assert_same_as_reference(glossary, "a a as")
    assert found(glossary, "a a a a a") == ["a a", "a a"]


# --- Unicode and positions ----------------------------------------------------------------


def test_positions_count_code_points_including_characters_outside_the_bmp():
    text = "😀😀 Một API 🚀\nneural\u00a0network \U0001d538 Schrödinger equation"
    glossary = glossary_of("API", "neural network", "Schrödinger equation")
    matches = assert_same_as_reference(glossary, text)
    assert [m.text for m in matches] == ["API", "neural\u00a0network", "Schrödinger equation"]
    assert matches[0].start == 7


def test_case_matching_follows_the_regex_engine_for_non_ascii_letters():
    cases = {
        "Schrödinger equation": ["SCHRÖDINGER EQUATION", "schrödinger Equation"],
        "Straße": ["STRAẞE", "straße"],  # capital sharp s; "STRASSE" is not the same word
        "Istanbul": ["İSTANBUL", "\u0131stanbul", "istanbul"],
        "σοφία": ["ΣΟΦΊΑ", "σοφία"],
        "kelvin": ["\u212aelvin"],  # KELVIN SIGN
        "spring": ["\u017fpring"],  # LONG S
    }
    for term, spellings in cases.items():
        glossary = glossary_of(term)
        for spelling in spellings:
            assert found(glossary, f"x {spelling} y") == [spelling]
        assert_same_as_reference(glossary, " ".join([*spellings, "STRASSE", "Strasse"]))
    assert found(glossary_of("Straße"), "STRASSE Strasse") == []


def test_no_unicode_normalization_is_applied_same_as_before():
    composed = "Schrödinger equation"
    decomposed = unicodedata.normalize("NFD", composed)
    assert decomposed != composed
    glossary = glossary_of(composed)
    assert found(glossary, decomposed) == []
    assert found(glossary_of(decomposed), decomposed) == [decomposed]
    assert_same_as_reference(glossary, f"{composed} {decomposed}")


def test_case_keys_give_one_key_to_every_pair_the_regex_engine_treats_as_equal():
    # A cased pattern character can only match a cased character (its lowercase or one of the
    # engine's extra equivalents, all of them cased); an uncased one only matches itself.
    keys = _case_keys()
    cased = "".join(
        char
        for char in map(chr, range(sys.maxunicode + 1))
        if char.lower() != char or char.upper() != char or char.casefold() != char
    )
    assert max(map(ord, cased)) < 0x20000  # the table only covers planes 0 and 1
    for char in cased:
        for match in re.finditer(re.escape(char), cased, re.IGNORECASE):
            other = match.group()
            assert keys.get(ord(other), ord(other)) == keys.get(ord(char), ord(char)), (
                hex(ord(char)),
                hex(ord(other)),
            )


# --- Agreement with the previous matcher on generated text --------------------------------

_TERMS = [
    ("API", False),
    ("REST", True),
    ("REST API", True),
    ("C++", False),
    ("C#", False),
    (".NET", False),
    ("CI/CD", False),
    ("Node.js", False),
    ("neural network", False),
    ("convolutional neural network", False),
    ("network", False),
    ("a b", False),
    ("b c", False),
    ("a a", False),
    ("machine learning", False),
    ("learning rate", False),
    ("Spring Boot", False),
    ("SpringBoot", False),
    ("Kubernetes", False),
    ("Straße", False),
    ("Schrödinger equation", False),
    ("Istanbul", False),
    ("σοφία", False),
    ("x-ray", False),
    ("Dependency Injection", True),
]
_WORDS = [
    *(word for term, _ in _TERMS for word in term.split()),
    *("the", "capital", "APIKey", "ASP.NET", "ss", "s", "'s", "STRASSE", "STRAẞE", "İSTANBUL"),
    *("\N{LATIN SMALL LETTER LONG S}pring", "\N{LATIN SMALL LETTER DOTLESS I}stanbul", "ΣΟΦΊΑ"),
    *("😀", "\N{MATHEMATICAL DOUBLE-STRUCK CAPITAL A}", "Một", "đó", "với", "C++11"),
    *("C#s", "_", "2", "(", ")", ",", ".", "!", "?", "-", "/"),
]
_GAPS = [" ", " ", " ", "  ", "\t", "\n", " \n ", "\r\n", "\u00a0", "\u2003", "", "", "-"]


def _variant(rng: random.Random, word: str) -> str:
    return rng.choice([word, word, word.lower(), word.upper(), word.title(), word.swapcase()])


def test_generated_texts_match_exactly_like_the_previous_matcher():
    rng = random.Random(20261024)  # noqa: S311 (reproducible test data)
    for _ in range(150):
        terms = rng.sample(_TERMS, rng.randint(1, len(_TERMS)))
        glossary = Glossary(terms)
        for _ in range(20):
            pieces = []
            for _ in range(rng.randint(0, 40)):
                pieces += (_variant(rng, rng.choice(_WORDS)), rng.choice(_GAPS))
            assert_same_as_reference(glossary, "".join(pieces))


def test_the_default_glossary_matches_like_the_previous_matcher():
    glossary = default_glossary()
    rng = random.Random(7)  # noqa: S311 (reproducible test data)
    words = [word for term, _ in glossary.terms() for word in term.split()]
    words += ["Một", "mô", "hình", "dùng", "the", "and", "của", "để", ",", ".", "(", ")", "APIs"]
    for _ in range(300):
        pieces = []
        for _ in range(rng.randint(0, 60)):
            pieces += (_variant(rng, rng.choice(words)), rng.choice(_GAPS))
        assert_same_as_reference(glossary, "".join(pieces))


def test_an_empty_glossary_finds_nothing():
    assert Glossary([]).find_matches("API and anything else") == []
    assert len(Glossary.from_text("# only comments\n")) == 0


# --- Integration: translation markup and speech -------------------------------------------

_MIXED = (
    "Một convolutional neural \t network & <b>REST API</b> dùng C++ và C#.\r\n"
    "  😀 Spring \t Boot, SpringBoot với CI/CD; rest api không phải REST API.\n\n"
    "Schrödinger equation và gradient   descent trong machine learning."
)
_MIXED_GLOSSARY = Glossary.from_text(
    "\n".join(
        [
            "convolutional neural network",
            "neural network",
            "=REST API",
            "API",
            "C++",
            "C#",
            "Spring Boot",
            "CI/CD",
            "Schrödinger equation",
            "gradient descent",
            "machine learning",
        ]
    )
)


@pytest.mark.parametrize("max_chars", [10_000, 120, 70])
def test_translation_markup_protects_each_match_and_loses_no_text(max_chars):
    plan = plan_translation(_MIXED, _MIXED_GLOSSARY, max_chars)
    parsed = [parse_translated_markup(segment.markup) for segment in plan.segments]
    assert plan.assemble([p.text for p in parsed]) == _MIXED
    for segment, result in zip(plan.segments, parsed, strict=True):
        assert result.protected_terms == segment.terms
    expected = [
        m.text for line in _MIXED.split("\n") for m in _MIXED_GLOSSARY.find_matches(line.strip())
    ]
    assert [term for segment in plan.segments for term in segment.terms] == expected
    assert "REST API" in expected and "api" in expected  # "rest api" is only "api"
    assert "<b>" not in "".join(segment.markup for segment in plan.segments)


def test_markup_round_trip_keeps_every_character_outside_and_inside_the_spans():
    matches = _MIXED_GLOSSARY.find_matches(_MIXED)
    parsed = parse_translated_markup(to_markup(_MIXED, matches))
    assert parsed.text == _MIXED
    assert parsed.protected_terms == tuple(m.text for m in matches)


@pytest.mark.parametrize("max_chars", [1000, 40, 30])
def test_speech_chunks_never_cut_a_term_and_ssml_keeps_one_voice(max_chars):
    text = speech_text(_MIXED)
    chunks = split_for_speech(_MIXED, _MIXED_GLOSSARY, max_chars)
    terms = [m.text for line in text.split("\n") for m in _MIXED_GLOSSARY.find_matches(line)]
    assert "Spring Boot" in terms and "convolutional neural network" in terms
    chunk_terms = [m.text for chunk in chunks for m in _MIXED_GLOSSARY.find_matches(chunk)]
    assert chunk_terms == terms  # every term whole in one chunk, none lost or added
    english = [
        piece
        for spans in chunk_language_spans(text, chunks, _MIXED_GLOSSARY)
        for language, piece in spans
        if language == "en-US"
    ]
    assert english == terms
    for chunk in chunks:
        ssml = build_ssml(chunk, DEFAULT_VOICE, _MIXED_GLOSSARY).encode()
        assert len(ET.fromstring(ssml)) == 1
        assert ssml_voice(ssml).get("name") == DEFAULT_VOICE.azure_voice_name
        assert "".join(piece for _, piece in ssml_spans(ssml)) == chunk


# --- Built once, reused -------------------------------------------------------------------


def test_the_shared_automaton_is_built_once_and_reused(monkeypatch):
    shared = default_glossary()
    automaton = shared._automaton
    builds = []
    original = glossary_module.ahocorasick.Automaton
    monkeypatch.setattr(
        glossary_module.ahocorasick,
        "Automaton",
        lambda *args: builds.append(1) or original(*args),
    )
    for _ in range(50):
        shared.find_matches(_MIXED)
    plan_translation(_MIXED, default_glossary(), 120)
    split_for_speech(_MIXED, default_glossary(), 40)
    assert default_glossary() is shared
    assert shared._automaton is automaton
    assert builds == []
    assert _case_keys.cache_info().currsize == 1


def test_one_glossary_can_be_searched_from_several_threads():
    glossary = default_glossary()
    text = " ".join([_MIXED, "API neural networks gradient descent"] * 20)
    expected = glossary.find_matches(text)
    results: list[bool] = []

    def search() -> None:
        results.append(all(glossary.find_matches(text) == expected for _ in range(20)))

    threads = [threading.Thread(target=search) for _ in range(8)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert results == [True] * 8
