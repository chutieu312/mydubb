"""How a detected term is written for review and how candidates are deduplicated.

* **Display form** (kept for review): Unicode NFC, typographic apostrophes as `'`, any run of
  whitespace as one space. Spelling and capitalization are otherwise exactly as detected.
* **Key** (deduplication): the display form in NFKC (compatibility characters such as
  full-width letters fold to plain ones), then capitalization is folded **only** when it can
  be explained by position: a word whose only capital is its first letter ("Kernel" at the
  start of a sentence, "Docker") folds to lowercase. Any other capital is significant, so an
  acronym or a CamelCase name keeps its exact case: `REST` and `rest`, `VMs` and `vms`,
  `GitHub` and `Github` are different keys. This matches the glossary's own rule, where an
  ordinary line ignores case and a `=TERM` line is exact; the case policy is chosen when a
  candidate is approved.
* Plurals are **not** merged ("container" and "containers" are two candidates): stripping an
  "s" would be wrong for words such as "process" or "Linux"-like names. The glossary already
  matches a plural "s", and the review tool points out a candidate that an approved or
  existing term would cover.
"""

import unicodedata

_APOSTROPHES = str.maketrans({"’": "'", "‘": "'"})  # noqa: RUF001 (typographic quotes are intended)


def display_form(text: str) -> str:
    return " ".join(unicodedata.normalize("NFC", text).translate(_APOSTROPHES).split())


def candidate_key(text: str) -> str:
    words = unicodedata.normalize("NFKC", display_form(text)).split(" ")
    if any(any(char.isupper() for char in word[1:]) for word in words):
        return " ".join(words)
    return " ".join(words).casefold()
