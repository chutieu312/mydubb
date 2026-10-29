# ruff: noqa: RUF003 (Chinese punctuation is intended)
"""Chinese (Han) characters as word boundaries, for text matching on Mandarin translations.

Chinese is written without spaces, and Python's regular expressions count every Han character as
a word character (`\\w`). The glossary and the English detection find whole words with `\\w`
boundaries, so in `使用Kubernetes部署` they would never see `Kubernetes` as a word. Masking each Han
character with a character that is not a word character gives them back the boundary a space gives
in Vietnamese, while every position stays where it was (one character for one character), so a
match found on the masked text is a match on the original.

The mask is `<`: never a word character, never whitespace (so two English words around a Han
character are not read as one phrase, and a glossary term with a space never matches across one),
and the glossary forbids it in terms, so no term can match it. Only Mandarin uses this; Vietnamese
text is matched exactly as before.
"""

import re

from app.translation.glossary import TermMatch, TermMatcher

# CJK Unified Ideographs, Extension A, Compatibility Ideographs and the supplementary planes
# (Extensions B-I). Simplified Chinese text uses these; punctuation such as 。， is not \w anyway.
HAN = re.compile("[㐀-䶿一-鿿豈-﫿\U00020000-\U0003134f]")
WORD_MASK = "<"


def mask_han(text: str, mask: str = WORD_MASK) -> str:
    """`text` with each Han character replaced by `mask` (one character), positions unchanged."""
    if len(mask) != 1:
        raise ValueError("the mask must be one character")
    return HAN.sub(mask, text)


class HanBoundaryTerms:
    """A `TermMatcher` that treats Han characters as word boundaries (see the module doc).

    Matches keep the original text of the span (the masked text only ever differs at Han
    characters, which no English span contains).
    """

    def __init__(self, inner: TermMatcher) -> None:
        self._inner = inner

    def find_matches(self, text: str) -> list[TermMatch]:
        return self._restore(text, self._inner.find_matches(mask_han(text)))

    def protected_matches(self, text: str) -> list[TermMatch]:
        return self._restore(text, self._inner.protected_matches(mask_han(text)))

    @staticmethod
    def _restore(text: str, matches: list[TermMatch]) -> list[TermMatch]:
        return [TermMatch(m.start, m.end, text[m.start : m.end]) for m in matches]
