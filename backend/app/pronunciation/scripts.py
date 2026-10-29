# ruff: noqa: RUF002 (letters of other scripts are the subject of this module)
"""The letters of a non-Latin target script as word boundaries, for text matching on translations.

The same idea as `han.py` for Mandarin, for the other target languages not written in Latin
letters: Hindi (Devanagari), Arabic, Russian (Cyrillic) and Japanese (Han characters and kana).
Python counts their letters as word characters (`\\w`), so in `Kubernetesом`, `وDocker` or
`Dockerを使う` the glossary and the English detection would not see the Latin word as a whole word.
Masking each character of the script with `<` (one character for one character, positions
unchanged; see `han.py` for why `<`) gives them back the boundary a space gives. Only term
matching uses the masked text; the text itself is never changed.

Spanish and French are written in Latin letters, so nothing is masked for them: a Latin word there
may be Spanish or French (`pronunciation/latin.py`).
"""

import re

from app.languages import TargetLanguage
from app.pronunciation.han import HAN, WORD_MASK
from app.translation.glossary import TermMatch, TermMatcher

# Blocks of each script: letters, combining signs (Devanagari vowel signs and virama, Arabic
# harakat), and the script's own digits and punctuation, which no glossary term contains either.
DEVANAGARI = re.compile("[\u0900-\u097f\ua8e0-\ua8ff]")
ARABIC = re.compile("[\u0600-\u06ff\u0750-\u077f\u08a0-\u08ff\ufb50-\ufdff\ufe70-\ufeff]")
CYRILLIC = re.compile("[\u0400-\u052f\u1c80-\u1c8f\u2de0-\u2dff\ua640-\ua69f]")
# Japanese: Han characters (as `han.HAN`), hiragana, katakana (with the prolonged sound mark ー),
# katakana phonetic extensions, half-width katakana, and 々 〆 ヶ.
JAPANESE = re.compile(
    f"(?:{HAN.pattern}|[\u3040-\u309f\u30a0-\u30ff\u31f0-\u31ff\uff66-\uff9f\u3005\u3006])"
)


def mask_script(text: str, script: re.Pattern[str], mask: str = WORD_MASK) -> str:
    """`text` with each character of `script` replaced by `mask` (one character)."""
    if len(mask) != 1:
        raise ValueError("the mask must be one character")
    return script.sub(mask, text)


class ScriptBoundaryTerms:
    """A `TermMatcher` that treats the characters of `script` as word boundaries."""

    def __init__(self, inner: TermMatcher, script: re.Pattern[str]) -> None:
        self._inner = inner
        self._script = script

    def find_matches(self, text: str) -> list[TermMatch]:
        return self._restore(text, self._inner.find_matches(mask_script(text, self._script)))

    def protected_matches(self, text: str) -> list[TermMatch]:
        return self._restore(text, self._inner.protected_matches(mask_script(text, self._script)))

    @staticmethod
    def _restore(text: str, matches: list[TermMatch]) -> list[TermMatch]:
        return [TermMatch(m.start, m.end, text[m.start : m.end]) for m in matches]


def script_of(language: TargetLanguage) -> re.Pattern[str] | None:
    """The script whose characters are word boundaries in `language`; None for the languages
    written in Latin letters (Vietnamese, Spanish, French)."""
    return _SCRIPTS.get(language)


_SCRIPTS = {
    TargetLanguage.MANDARIN: HAN,
    TargetLanguage.HINDI: DEVANAGARI,
    TargetLanguage.ARABIC: ARABIC,
    TargetLanguage.RUSSIAN: CYRILLIC,
    TargetLanguage.JAPANESE: JAPANESE,
}
