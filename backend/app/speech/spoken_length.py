"""An estimate of how many syllables a speech text is read with (no network, no model).

Speech takes time per syllable, not per character, and several kinds of text MyDubb reads often
are spoken much longer or shorter than their characters suggest. Used only to compare the speaking
rate of the clips cut from one response (speech/blocks.py), so the estimate needs to be consistent,
not exact:

* A Vietnamese word is one syllable (Vietnamese writes syllables separately); an English or other
  Latin word counts its vowel groups ("Kubernetes" 4, "image" 3, at least 1).
* A number counts the syllables of its Vietnamese reading, estimated group by group of three digits
  ("10.000" is "mười nghìn": 2; "1.024" is "một nghìn không trăm hai mươi tư": 7; "99,9" is "chín
  mươi chín phẩy chín": 5). A separator followed by exactly three digits groups thousands
  ("10.000", "10,000"); any other separator is a decimal point ("phẩy"). "%" adds two ("phần
  trăm"). Digit strings with leading zeros or longer than 12 digits count one per digit.
* An all-caps acronym is spelled, one syllable per letter ("API" is "ây-pi-ai"); some acronyms are
  read as words ("JSON"), so this overestimates them.
* Punctuation alone is not spoken; other symbols ("&", "+", "/") count one.

Limits: the voice decides the real reading (dates, units, versions, mixed tokens like "4GB" or
"v2.1"), so a block made only of unusual tokens can still be estimated far from the truth.
"""

import re

_TOKEN = re.compile(r"\S+")
_EDGE_PUNCTUATION = "\"'()[]{}<>.,;:!?…“”‘’«»–—-"  # noqa: RUF001 (typographic quotes are intended)
_VOWELS = re.compile(
    "[aeiouyàáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹ]+", re.IGNORECASE
)
_NUMBER = re.compile(r"\d+(?:[.,]\d+)*")
_LETTERS = re.compile(r"[^\W\d_]+")


def spoken_syllables(text: str) -> float:
    return sum(_token(token) for token in _TOKEN.findall(text))


def _token(raw: str) -> float:
    token = raw.strip(_EDGE_PUNCTUATION)
    if not token:
        return 0.0
    if any(char.isdigit() for char in token):
        return _number(token)
    if not any(char.isalpha() for char in token):
        return 1.0  # a symbol such as "&" or "+"
    letters = "".join(_LETTERS.findall(token))
    if len(letters) >= 2 and letters.isupper():
        return float(len(letters))  # spelled acronym
    return float(max(1, len(_VOWELS.findall(token))))


def _number(token: str) -> float:
    syllables = 2.0 * token.count("%")
    syllables += len("".join(_LETTERS.findall(token)))  # "4GB", "S3", "v2": spelled letters
    for number in _NUMBER.findall(token):
        whole, decimals = _split_number(number)
        syllables += _integer(whole)
        if decimals:
            syllables += 1 + _integer(decimals)  # "phẩy" and the decimals as a number
    return syllables


def _split_number(number: str) -> tuple[str, str]:
    """Digits before and after the decimal separator; thousands separators removed."""
    parts = re.split(r"[.,]", number)
    whole = parts[0]
    rest = parts[1:]
    while rest and len(rest[0]) == 3:
        whole += rest.pop(0)
    return whole, "".join(rest)


def _integer(digits: str) -> float:
    """Syllables of a Vietnamese integer reading, e.g. 2026: "hai nghìn không trăm hai mươi sáu"."""
    if not digits:
        return 0.0
    if len(digits) > 12 or (len(digits) > 1 and digits[0] == "0"):
        return float(len(digits))  # read digit by digit
    if int(digits) == 0:
        return 1.0  # "không"
    groups = []
    while digits:
        groups.insert(0, digits[-3:])
        digits = digits[:-3]
    syllables = 0
    for index, group in enumerate(groups):
        value = int(group)
        if value == 0:
            continue
        leading = index == 0
        hundreds, tens, units = (int(d) for d in group.zfill(3))
        if hundreds or not leading:
            syllables += 2  # "một trăm" / "không trăm"
        if tens > 1:
            syllables += 2  # "hai mươi"
        elif tens == 1:
            syllables += 1  # "mười"
        elif units and (hundreds or not leading):
            syllables += 1  # "lẻ"
        if units:
            syllables += 1
        if index < len(groups) - 1:
            syllables += 1  # "nghìn" / "triệu" / "tỷ"
    return float(syllables)
