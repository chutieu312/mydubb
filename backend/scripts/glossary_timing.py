"""Glossary matcher timing on synthetic data: build once, then match a transcript many times.

Run from `backend/`:

    uv run python -m scripts.glossary_timing                     # 2,000 terms, ~1,000 words
    uv run python -m scripts.glossary_timing --terms 5000 --words 3000 --repeat 100

Offline: no database, no Azure, no user data. The glossary and the transcript are generated
from a fixed seed, so every run measures the same input. Printed separately:

* the case-key table (`_case_keys`), built once per process on first use;
* building the `Glossary` (parsing the lines, one regular expression per term, the automaton);
* matching the whole transcript with the built glossary, `--repeat` times (min, median, p95);
* matching it line by line, as translation and English detection do.

The numbers describe the machine that runs the script. They say nothing about the Render
instance in production. The script fails if the matcher builds another automaton while
matching or misses one of the planted terms, never because of a duration.
"""

import argparse
import importlib.metadata
import platform
import random
import statistics
import sys
import time
from collections.abc import Callable

from app.translation import glossary as glossary_module
from app.translation.glossary import Glossary, _case_keys

SEED = 20261024
FILLER = [
    *("và", "của", "là", "một", "những", "được", "cho", "với", "này", "trong", "khi", "chúng"),
    *("ta", "có", "thể", "dùng", "để", "the", "and", "of", "to", "we", "use", "it", "when"),
    *("data", "model", "value", "system", "request", "user", "server", "code", "test", "run"),
]
_LETTERS = "abcdefghijklmnopqrstuvwxyz"


def _word(rng: random.Random, low: int, high: int) -> str:
    return "".join(rng.choices(_LETTERS, k=rng.randint(low, high)))


def synthetic_terms(count: int, rng: random.Random) -> list[str]:
    """Glossary lines: acronyms, single names, 2-4 word phrases, symbols and exact terms."""
    lines: list[str] = []
    seen: set[str] = set()
    while len(lines) < count:
        shape = rng.random()
        if shape < 0.2:
            term = _word(rng, 2, 5).upper()
        elif shape < 0.45:
            term = _word(rng, 5, 11).capitalize()
        elif shape < 0.9:
            term = " ".join(_word(rng, 3, 9) for _ in range(rng.randint(2, 4)))
        else:
            term = _word(rng, 1, 4) + rng.choice(["++", "#", ".js", "/CD", ".NET"])
        exact = rng.random() < 0.05
        key = term if exact else term.casefold()
        if key in seen:
            continue
        seen.add(key)
        lines.append(f"={term}" if exact else term)
    return lines


def synthetic_transcript(lines: list[str], words: int, rng: random.Random) -> tuple[str, list[str]]:
    """About `words` words, about 1 in 10 of them inside a planted glossary term."""
    pieces: list[str] = []
    planted: list[str] = []
    count = 0
    while count < words:
        if rng.random() < 0.04:
            term = rng.choice(lines)
            if not term.startswith("="):
                term = rng.choice([term, term.lower(), term.upper()])
            term = term.removeprefix("=")
            planted.append(term)
            pieces.append(term.replace(" ", rng.choice([" ", "  ", "\t"])))
            count += len(term.split())
        else:
            pieces.append(rng.choice(FILLER))
            count += 1
        pieces.append(rng.choice([" "] * 12 + [", ", ". ", ".\n"]))
    return "".join(pieces), planted


def timed(function: Callable[[], object]) -> tuple[float, object]:
    start = time.perf_counter()
    result = function()
    return (time.perf_counter() - start) * 1000, result


def milliseconds(values: list[float]) -> str:
    ordered = sorted(values)
    p95 = ordered[min(len(ordered) - 1, round(0.95 * (len(ordered) - 1)))]
    return f"min {ordered[0]:.3f} ms, median {statistics.median(ordered):.3f} ms, p95 {p95:.3f} ms"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--terms", type=int, default=2000)
    parser.add_argument("--words", type=int, default=1000)
    parser.add_argument("--repeat", type=int, default=200)
    args = parser.parse_args()

    rng = random.Random(SEED)  # noqa: S311 (reproducible synthetic data)
    lines = synthetic_terms(args.terms, rng)
    transcript, planted = synthetic_transcript(lines, args.words, rng)

    print(f"Python {platform.python_version()} ({platform.python_implementation()})")
    print(f"Platform {platform.platform()}, machine {platform.machine()}")
    print(f"Processor {platform.processor() or 'unknown'}")
    print(f"pyahocorasick {importlib.metadata.version('pyahocorasick')}")
    print(
        f"Input: {len(lines)} terms, {len(transcript.split())} words, "
        f"{len(transcript)} characters, {len(planted)} planted terms (seed {SEED})"
    )

    table_ms, _ = timed(_case_keys)
    print(f"Case-key table (once per process): {table_ms:.1f} ms")
    build_ms, glossary = timed(lambda: Glossary.from_text("\n".join(lines)))
    assert isinstance(glossary, Glossary)
    print(f"Glossary build ({len(glossary)} terms, automaton included): {build_ms:.1f} ms")

    builds: list[int] = []
    original = glossary_module.ahocorasick.Automaton
    glossary_module.ahocorasick.Automaton = lambda *a: builds.append(1) or original(*a)
    try:
        matches = glossary.find_matches(transcript)  # warm-up, not timed
        whole = [timed(lambda: glossary.find_matches(transcript))[0] for _ in range(args.repeat)]
        text_lines = transcript.split("\n")
        by_line = [
            timed(lambda: [glossary.find_matches(line) for line in text_lines])[0]
            for _ in range(args.repeat)
        ]
    finally:
        glossary_module.ahocorasick.Automaton = original

    print(f"Matches in the transcript: {len(matches)}")
    print(f"Match whole transcript, {args.repeat} runs: {milliseconds(whole)}")
    print(f"Match {len(text_lines)} lines one by one, {args.repeat} runs: {milliseconds(by_line)}")
    print(f"Automata built while matching: {len(builds)}")

    found = [match.text.casefold().split() for match in matches]
    missing = [term for term in planted if term.casefold().split() not in found]
    if builds or missing:
        print(f"FAILED: {len(builds)} automata built, {len(missing)} planted terms not found")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
