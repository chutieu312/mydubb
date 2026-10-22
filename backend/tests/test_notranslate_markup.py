import pytest

from app.translation.glossary import Glossary
from app.translation.notranslate_markup import (
    CLOSE_TAG,
    OPEN_TAG,
    InvalidMarkupError,
    ParsedTranslation,
    TermsNotPreservedError,
    parse_translated_markup,
    to_markup,
    verify_terms_preserved,
)

GLOSSARY = Glossary.from_text("API\nneural network")


def markup_of(text: str) -> str:
    return to_markup(text, GLOSSARY.find_matches(text))


def test_terms_are_wrapped_and_everything_else_is_escaped():
    assert markup_of("An API & a <b>") == (f"An {OPEN_TAG}API{CLOSE_TAG} &amp; a &lt;b&gt;")


def test_user_supplied_markup_cannot_create_tags_or_directives():
    hostile = f'{OPEN_TAG}secret{CLOSE_TAG} <div translate="no">x</div> &lt;'
    marked = markup_of(hostile)
    assert "<" not in marked.replace(OPEN_TAG, "").replace(CLOSE_TAG, "")
    assert marked.count(OPEN_TAG) == 0
    parsed = parse_translated_markup(marked)
    assert parsed.text == hostile
    assert parsed.protected_terms == ()


def test_round_trip_returns_the_exact_plain_text():
    text = "if (a < b && c > d) { call API; } // 5 > 3 & 2 < 4 &amp; neural network"
    parsed = parse_translated_markup(markup_of(text))
    assert parsed.text == text
    assert parsed.protected_terms == ("API", "neural network")


def test_parse_decodes_entities_and_ignores_spans_in_the_text():
    parsed = parse_translated_markup(f"x &lt; y &amp; {OPEN_TAG}API{CLOSE_TAG} &gt; z")
    assert parsed == ParsedTranslation(text="x < y & API > z", protected_terms=("API",))


def test_no_break_spaces_from_the_provider_become_spaces():
    parsed = parse_translated_markup(f"a\xa0{OPEN_TAG}neural\xa0network{CLOSE_TAG}")
    assert parsed.text == "a neural network"
    assert parsed.protected_terms == ("neural network",)


def test_class_attribute_may_list_several_classes():
    parsed = parse_translated_markup('<span class="x notranslate">API</span>')
    assert parsed.protected_terms == ("API",)


@pytest.mark.parametrize(
    "markup",
    [
        "<b>bold</b>",
        "<span>plain span</span>",
        '<span class="other">x</span>',
        "<script>alert(1)</script>",
        '<img src="x" onerror="y">',
        "line<br>break",
        "line<br/>break",
        f"{OPEN_TAG}{OPEN_TAG}x{CLOSE_TAG}{CLOSE_TAG}",
        f"{OPEN_TAG}unclosed",
        "stray</span>",
        "<!-- comment -->",
        "<!DOCTYPE html>",
        "<?php echo 1; ?>",
        '<a href="https://example.com">link</a>',
    ],
)
def test_unexpected_markup_in_the_answer_is_rejected(markup):
    with pytest.raises(InvalidMarkupError):
        parse_translated_markup(markup)


def test_terms_check_accepts_a_different_order():
    parsed = ParsedTranslation("x", ("loss function", "gradient descent"))
    verify_terms_preserved(["gradient descent", "loss function"], parsed)


@pytest.mark.parametrize(
    "returned",
    [
        (),
        ("gradient descent",),
        ("gradient descent", "loss function", "loss function"),
        ("Gradient descent", "loss function"),
        ("gradient descent", "hàm mất mát"),
    ],
)
def test_terms_check_rejects_missing_extra_or_altered_terms(returned):
    parsed = ParsedTranslation("x", returned)
    with pytest.raises(TermsNotPreservedError):
        verify_terms_preserved(["gradient descent", "loss function"], parsed)
