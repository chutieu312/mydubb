"""Could this Latin word be a Vietnamese syllable written without diacritics?

Vietnamese writes every syllable as its own word, and a syllable has a fixed shape: an
optional initial consonant, a vowel group and an optional final consonant. A word without
that shape (`runtime`, `kernel`, `Linux`, `VMs`, `trenchcoat`) cannot be Vietnamese, with or
without diacritics. A word with that shape (`an`, `to`, `con`, `run`, `Nguyen`, `trong`) may
be Vietnamese, so it is never treated as English on its own.

The check is deliberately permissive: anything that might be a syllable counts as one. A
permissive rule only makes more words "ambiguous" (kept in Vietnamese), never forces a
Vietnamese word into English.
"""

import re

# Initial consonants (with the "đ" of the alphabet already written as "d").
_INITIALS = "ngh|ng|nh|ch|gh|gi|kh|ph|qu|th|tr|b|c|d|g|h|k|l|m|n|p|r|s|t|v|x"
# Vowel groups once the diacritics are removed (â, ă -> a; ê -> e; ô, ơ -> o; ư -> u),
# including the glides that end a syllable (ai, ao, au, ay, oi, ui, iu, eo, ...).
_VOWELS = (
    "oai|oay|oao|oeo|uay|uoi|uou|uya|uye|uyu|ieu|yeu"
    "|ai|ao|au|ay|eo|eu|ia|ie|iu|oa|oe|oi|oo|ua|ue|ui|uo|uu|uy|ye"
    "|a|e|i|o|u|y"
)
_FINALS = "ch|ng|nh|c|m|n|p|t"
_SYLLABLE = re.compile(rf"(?:{_INITIALS})?(?:{_VOWELS})(?:{_FINALS})?")


def may_be_vietnamese(word: str) -> bool:
    """True when `word` (ASCII letters) has the shape of a Vietnamese syllable."""
    return _SYLLABLE.fullmatch(word.lower()) is not None
