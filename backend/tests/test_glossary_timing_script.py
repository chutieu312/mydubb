"""The glossary timing script runs offline and checks results, never durations."""

import sys

from scripts import glossary_timing


def test_the_script_measures_build_and_matching_separately(monkeypatch, capsys):
    argv = ["timing", "--terms", "300", "--words", "200", "--repeat", "3"]
    monkeypatch.setattr(sys, "argv", argv)

    assert glossary_timing.main() == 0

    out = capsys.readouterr().out
    assert "Input: 300 terms" in out
    assert "Glossary build (300 terms, automaton included)" in out
    assert "Match whole transcript, 3 runs" in out
    assert "Automata built while matching: 0" in out


def test_synthetic_input_is_reproducible():
    first = glossary_timing.synthetic_terms(100, glossary_timing.random.Random(1))
    second = glossary_timing.synthetic_terms(100, glossary_timing.random.Random(1))
    assert first == second
    assert len(first) == 100
