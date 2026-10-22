import pytest

from app.translation.glossary import Glossary
from app.translation.notranslate_markup import (
    OPEN_TAG,
    parse_translated_markup,
    to_markup,
)
from app.translation.segmenter import (
    SegmentTooLongError,
    plan_translation,
    utf16_length,
)

GLOSSARY = Glossary.from_text("API\nneural network\ngradient descent\nloss function")


def identity_translation(plan):
    """What a provider that returns the markup unchanged would give back, as plain text."""
    return [parse_translated_markup(segment.markup).text for segment in plan.segments]


def round_trip(text: str, max_chars: int) -> str:
    plan = plan_translation(text, GLOSSARY, max_chars)
    return plan.assemble(identity_translation(plan))


def test_each_line_is_one_segment_when_it_fits():
    plan = plan_translation("First line.\nSecond line with an API.", GLOSSARY, 1000)
    assert [s.markup for s in plan.segments] == [
        "First line.",
        f"Second line with an {OPEN_TAG}API</span>.",
    ]
    assert plan.segments[1].terms == ("API",)


def test_blank_lines_and_indentation_survive_without_being_translated():
    text = "  indented line\n\n   \nlast"
    plan = plan_translation(text, GLOSSARY, 1000)
    assert len(plan.segments) == 2
    assert plan.assemble(identity_translation(plan)) == text


def test_markup_counts_towards_the_size():
    text = "API " * 10
    plan = plan_translation(text.strip(), GLOSSARY, 100)
    assert all(segment.size <= 100 for segment in plan.segments)
    assert len(plan.segments) > 1


def test_escaped_characters_count_with_their_escaped_size():
    text = " ".join(["a&b"] * 40)  # each "&" becomes "&amp;"
    plan = plan_translation(text, GLOSSARY, 60)
    assert all(segment.size <= 60 for segment in plan.segments)
    assert round_trip(text, 60) == text


def test_size_is_measured_in_utf16_units():
    assert utf16_length("a\U0001f600") == 3  # emoji outside the BMP use two units
    text = " ".join(["\U0001f600"] * 50)
    plan = plan_translation(text, GLOSSARY, 40)
    assert all(segment.size <= 40 for segment in plan.segments)
    assert round_trip(text, 40) == text


def test_long_lines_are_cut_at_sentence_boundaries_first():
    text = "One short sentence. Another sentence follows. A third one ends here."
    plan = plan_translation(text, GLOSSARY, 30)
    texts = [parse_translated_markup(s.markup).text for s in plan.segments]
    assert texts == [
        "One short sentence.",
        "Another sentence follows.",
        "A third one ends here.",
    ]
    assert plan.assemble(texts) == text


def test_sentences_are_grouped_while_they_fit():
    text = "One. Two. Three. Four."
    plan = plan_translation(text, GLOSSARY, 11)
    assert [s.markup for s in plan.segments] == ["One. Two.", "Three.", "Four."]


def test_a_sentence_longer_than_the_limit_is_cut_between_words():
    text = "word " * 30
    plan = plan_translation(text.strip(), GLOSSARY, 40)
    assert len(plan.segments) > 3
    assert all(segment.size <= 40 for segment in plan.segments)
    assert round_trip(text.strip(), 40) == text.strip()


def test_protected_terms_are_never_cut():
    text = "We use gradient descent on the loss function of a neural network. " * 12
    for limit in (80, 120, 200):
        plan = plan_translation(text.strip(), GLOSSARY, limit)
        terms = [term for segment in plan.segments for term in segment.terms]
        assert terms == ["gradient descent", "loss function", "neural network"] * 12
        assert all(segment.size <= limit for segment in plan.segments)
        assert round_trip(text.strip(), limit) == text.strip()


def test_term_at_the_chunk_boundary_moves_whole_to_the_next_chunk():
    # "neural network" would straddle the 60-character limit if cut by characters.
    text = "aaaa bbbb cccc dddd eeee ffff gggg hhhh iiii jjjj kkkk neural network end"
    plan = plan_translation(text, GLOSSARY, 80)
    joined = [parse_translated_markup(s.markup).text for s in plan.segments]
    assert len(plan.segments) > 1
    assert any("neural network" in piece for piece in joined)
    assert [t for s in plan.segments for t in s.terms] == ["neural network"]
    assert plan.assemble(joined) == text


def test_sentence_end_inside_a_term_is_not_a_cut_point():
    glossary = Glossary.from_text("Dr. Strange Love")
    text = "Hello there Dr. Strange Love is a film"
    plan = plan_translation(text, glossary, 60)
    assert [t for s in plan.segments for t in s.terms] == ["Dr. Strange Love"]


def test_nothing_is_lost_or_repeated_on_reassembly():
    text = "\n".join(
        [
            "Intro line about an API.",
            "",
            "A much longer line. " * 20 + "It ends with gradient descent.",
            "Closing <tag> & more.",
        ]
    )
    for limit in (50, 80, 120, 500):
        assert round_trip(text, limit) == text


def test_assemble_requires_one_translation_per_segment():
    plan = plan_translation("a\nb", GLOSSARY, 100)
    with pytest.raises(ValueError, match="count"):
        plan.assemble(["only one"])


def test_translations_may_change_length_without_touching_structure():
    plan = plan_translation("A. B.\n\nC.", GLOSSARY, 4)
    assert plan.assemble([f"<{i}>" for i in range(len(plan.segments))]).split("\n")[1] == ""


def test_a_run_without_whitespace_longer_than_the_limit_is_refused():
    with pytest.raises(SegmentTooLongError):
        plan_translation("x" * 500, GLOSSARY, 100)


def test_batches_respect_character_and_element_limits_in_order():
    text = "\n".join(f"Line number {i} mentions an API." for i in range(50))
    plan = plan_translation(text, GLOSSARY, 5000)
    batches = list(plan.batches(max_chars=400, max_elements=7))
    assert all(sum(s.size for s in batch) <= 400 and len(batch) <= 7 for batch in batches)
    assert [s for batch in batches for s in batch] == plan.segments
    assert len(batches) > 1


def test_segment_size_matches_the_real_markup_length():
    text = "A & B < C with API and neural network."
    (segment,) = plan_translation(text, GLOSSARY, 1000).segments
    assert segment.size == len(to_markup(text, GLOSSARY.find_matches(text)))
