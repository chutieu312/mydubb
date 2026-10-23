import pytest

from app.translation.glossary import (
    DEFAULT_GLOSSARY_PATH,
    Glossary,
    GlossaryError,
    default_glossary,
)

EXAMPLE = "A neural network uses gradient descent to minimize the loss function."


def found(glossary: Glossary, text: str) -> list[str]:
    return [m.text for m in glossary.find_matches(text)]


def glossary_of(*lines: str) -> Glossary:
    return Glossary.from_text("\n".join(lines))


def test_product_example_terms_are_found_with_input_spelling():
    assert found(default_glossary(), EXAMPLE) == [
        "neural network",
        "gradient descent",
        "loss function",
    ]


def test_matches_report_positions_in_the_input():
    text = "Use the API today."
    (match,) = default_glossary().find_matches(text)
    assert text[match.start : match.end] == "API" == match.text


def test_only_terms_present_in_the_input_are_returned():
    assert found(default_glossary(), "Nothing technical happens in this sentence.") == []


def test_capitalization_of_each_occurrence_is_preserved():
    glossary = glossary_of("neural network")
    assert found(glossary, "Neural Network, neural network and NEURAL NETWORK") == [
        "Neural Network",
        "neural network",
        "NEURAL NETWORK",
    ]


def test_case_sensitive_entries_need_the_exact_capitalization():
    glossary = glossary_of("=REST")
    assert found(glossary, "A REST service. Take a rest. Rest well.") == ["REST"]


def test_whole_words_only():
    glossary = glossary_of("API", "Git")
    assert found(glossary, "The capital of a rapid digit, GitHub and APIKey") == []


def test_acronym_inside_longer_words_is_not_matched_but_standalone_is():
    assert found(glossary_of("API"), "capital API rapid") == ["API"]


def test_plural_s_is_part_of_the_match():
    glossary = glossary_of("API", "neural network")
    assert found(glossary, "Many APIs and neural networks.") == ["APIs", "neural networks"]


def test_terms_ending_in_s_do_not_get_a_second_plural():
    assert found(glossary_of("Kubernetes"), "Kubernetes and Kubernetess") == ["Kubernetes"]


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("(API),", ["API"]),
        ("Call the API.", ["API"]),
        ("API? API! API: API;", ["API", "API", "API", "API"]),
        ('He said "API" loudly.', ["API"]),
        ("Docker's CLI", ["Docker"]),
        ("API-first design", ["API"]),
        ("GPU/CPU", ["GPU"]),
        ("Uses CI/CD, Docker.", ["CI/CD", "Docker"]),
    ],
)
def test_punctuation_around_terms(text, expected):
    assert found(glossary_of("API", "Docker", "GPU", "CI/CD"), text) == expected


def test_repeated_term_is_matched_every_time():
    text = "API one, API two and an API three."
    matches = glossary_of("API").find_matches(text)
    assert [m.start for m in matches] == [0, 9, 24]


def test_multi_word_terms_tolerate_any_whitespace_between_words():
    assert found(glossary_of("gradient descent"), "gradient   descent and gradient\tdescent") == [
        "gradient   descent",
        "gradient\tdescent",
    ]


def test_longest_match_wins_when_terms_overlap():
    glossary = glossary_of("neural network", "convolutional neural network", "network")
    assert found(glossary, "A convolutional neural network is a neural network.") == [
        "convolutional neural network",
        "neural network",
    ]


def test_overlapping_terms_prefer_the_longer_one_even_if_it_starts_later():
    glossary = glossary_of("machine learning", "learning rate scheduler")
    assert found(glossary, "machine learning rate scheduler") == ["learning rate scheduler"]


def test_matches_do_not_overlap_and_are_sorted():
    glossary = glossary_of("a b", "b c", "c")
    matches = glossary.find_matches("a b c")
    assert [(m.start, m.end) for m in matches] == [(0, 3), (4, 5)]


def test_special_characters_in_terms_are_literal():
    glossary = glossary_of("C++", "Node.js")
    assert found(glossary, "C++ and Node.js but not NodeXjs") == ["C++", "Node.js"]


def test_comments_and_blank_lines_are_ignored():
    glossary = glossary_of("# comment", "", "  API  ", "# API2")
    assert len(glossary) == 1


@pytest.mark.parametrize(
    "content",
    ["API\napi", "=REST\n=REST", "<b>", "A & B", "x" * 101, "=", "bad\x07term"],
)
def test_invalid_glossary_files_are_rejected(content):
    with pytest.raises(GlossaryError):
        Glossary.from_text(content)


# Everyday words that must not be protected in every context (see the policy in glossary.txt).
AMBIGUOUS_WORDS = {
    "class",
    "model",
    "cell",
    "function",
    "table",
    "key",
    "value",
    "string",
    "object",
    "field",
    "layer",
    "node",
    "tree",
    "thread",
    "memory",
    "spring",
    "go",
    "rust",
    "swift",
    "ruby",
    "java",
    "transformer",
    "it",
    "ai",
}


def test_default_glossary_loads_and_has_the_starter_terms():
    glossary = default_glossary()
    assert len(glossary) >= 40
    for term in ("neural network", "gradient descent", "loss function", "API", "DNA"):
        assert found(glossary, term) == [term]


def test_default_glossary_contains_no_ambiguous_everyday_words():
    lines = [
        line.strip().removeprefix("=")
        for line in DEFAULT_GLOSSARY_PATH.read_text(encoding="utf-8").splitlines()
        if line.strip() and not line.startswith("#")
    ]
    assert not {line.casefold() for line in lines} & AMBIGUOUS_WORDS


def test_default_glossary_does_not_touch_ordinary_sentences():
    text = "The class has a model, a cell and a key to the table. We go to the rest area."
    assert found(default_glossary(), text) == []


def test_audition_terms_are_all_in_the_shared_glossary_as_whole_phrases():
    text = (
        "Một neural network dùng gradient descent cho loss function. Spring Boot dùng "
        "Dependency Injection. Gọi REST API, nhận JSON, chạy pipeline CI/CD."
    )
    assert found(default_glossary(), text) == [
        "neural network",
        "gradient descent",
        "loss function",
        "Spring Boot",
        "Dependency Injection",
        "REST API",  # one term, not "REST" and "API" separately
        "JSON",
        "pipeline",
        "CI/CD",
    ]


def test_rest_api_is_case_sensitive_but_api_alone_still_matches():
    assert found(default_glossary(), "the rest api and Pipelines") == ["api", "Pipelines"]
    assert found(default_glossary(), "A REST APIs call") == ["REST APIs"]
