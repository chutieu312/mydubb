# ruff: noqa: RUF001 (the scripts of the languages are the subject of this module)
"""Spoken-length estimates for Hindi, Spanish, Arabic, French, Russian and Japanese.

Like the Vietnamese (`spoken_length.py`) and Mandarin (`mandarin.mandarin_syllables`) estimates,
used only to compare the speaking rate of the clips cut from one timed-mode response
(`blocks.py`, checks 4 and 5, whose limits are the same for every language), never instead of
measured audio. The checks compare each clip with the request it came from, so an estimate needs
to be consistent within a language, not exact, and its unit (syllable, mora) does not matter.

* **Words** count their vowel nuclei: Latin and Cyrillic words their vowel groups (a French word
  without its silent final "e"/"es"); a Devanagari word its consonants not followed by the virama
  plus its independent vowels, less the final inherent vowel Hindi drops (`नमस्ते` 3, `कंप्यूटर`
  3); an Arabic word, written without its short vowels, half its letters rounded up (`كتاب` 2).
  Japanese counts morae: a kana is one (a small kana such as ゃ is part of the one before, ッ and ー
  count one), a Han character two (its reading is usually one or two morae).
* An all-caps Latin acronym is spelled, one per letter ("CPU" 3); an English word in the
  translation counts its vowel groups, as in the other estimates.
* A **number** counts the words of its reading in the language, by groups of three digits (four
  in Japanese: 万, 億), with the language's syllables for a digit, a tens word, the hundred, the
  group word (mil, mille, тысяча, हज़ार, ألف, 万), the decimal separator (decimals read digit by
  digit) and "%". Any Unicode digits count (Devanagari, Arabic-Indic). Leading zeros or more than
  15 digits are read digit by digit.
* Punctuation is not spoken; other symbols count one.

Limits: as for the other languages, the voice decides the real reading (dates, versions, units,
mixed tokens); Arabic and Japanese spelling does not show the length of every word, so a block of
unusual words can be estimated far from its real reading.
"""

import math
import re
import unicodedata
from collections.abc import Callable
from dataclasses import dataclass

from app.languages import TargetLanguage
from app.pronunciation.han import HAN


@dataclass(frozen=True)
class _Numbers:
    digit: float  # one..nine
    tens: float  # ten..ninety (and the teens)
    hundred: float  # hundred word (its digit is added when above one); Japanese: 千 百 十
    group: float  # thousand, million (万, 億 in Japanese)
    point: float  # decimal separator
    percent: float
    size: int = 3  # digits per group


_NUMBERS = {
    TargetLanguage.HINDI: _Numbers(digit=1.5, tens=2, hundred=1, group=2, point=3, percent=3),
    TargetLanguage.SPANISH: _Numbers(digit=2, tens=2.5, hundred=1.5, group=1, point=2, percent=3),
    TargetLanguage.ARABIC: _Numbers(digit=2.5, tens=3, hundred=2, group=2, point=3, percent=3),
    TargetLanguage.FRENCH: _Numbers(digit=1, tens=1.5, hundred=1, group=1, point=3, percent=2),
    TargetLanguage.RUSSIAN: _Numbers(digit=1.5, tens=2.5, hundred=1.5, group=3, point=3, percent=3),
    TargetLanguage.JAPANESE: _Numbers(
        digit=1.5, tens=2, hundred=2, group=2, point=2, percent=4, size=4
    ),
}

_LATIN = "A-Za-zÀ-ÖØ-öø-ɏ"
_DEVANAGARI = "\u0900-\u097f\ua8e0-\ua8ff"
_ARABIC = "ؠ-ٟٮ-ۓە-ۯۺ-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-ﻼ"
_CYRILLIC = "\u0400-\u052f\u1c80-\u1c8f\u2de0-\u2dff\ua640-\ua69f"
_KANA = "\u3040-\u309f\u30a0-\u30ff\u31f0-\u31ff\uff66-\uff9f\u3005\u3006"
_PIECE = re.compile(
    rf"(?P<number>\d+(?:[.,]\d+)*)"
    rf"|(?P<latin>[{_LATIN}]+(?:['’][{_LATIN}]+)*)"
    rf"|(?P<devanagari>[{_DEVANAGARI}]+)"
    rf"|(?P<arabic>[{_ARABIC}]+)"
    rf"|(?P<cyrillic>[{_CYRILLIC}]+)"
    rf"|(?P<japanese>(?:{HAN.pattern}|[{_KANA}])+)"
    r"|(?P<percent>[%٪])"
    r"|(?P<other>\S)"
)
_LATIN_VOWELS = re.compile("[aeiouyàáâãäåæèéêëìíîïòóôõöøùúûüýÿœ]+", re.IGNORECASE)
_CYRILLIC_VOWELS = re.compile("[аеёиоуыэюяіїєў]+", re.IGNORECASE)
_SMALL_KANA = frozenset(
    "ぁぃぅぇぉゃゅょゎゕゖァィゥェォャュョヮヵヶㇰㇱㇲㇳㇴㇵㇶㇷㇸㇹㇺㇻㇼㇽㇾㇿｧｨｩｪｫｬｭｮ"
)
_VIRAMA = "\u094d"
_NUKTA = "\u093c"


def spoken_estimate(language: TargetLanguage) -> Callable[[str], float]:
    """The estimate for one of the six languages of this module (see module doc)."""
    numbers = _NUMBERS[language]
    french = language is TargetLanguage.FRENCH

    def estimate(text: str) -> float:
        total = 0.0
        for match in _PIECE.finditer(text):
            kind, piece = match.lastgroup, match.group()
            if kind == "number":
                total += _number(piece, numbers)
            elif kind == "percent":
                total += numbers.percent
            elif kind == "latin":
                total += _latin(piece, french)
            elif kind == "devanagari":
                total += _devanagari(piece)
            elif kind == "arabic":
                total += _arabic(piece)
            elif kind == "cyrillic":
                total += max(1, len(_CYRILLIC_VOWELS.findall(piece)))
            elif kind == "japanese":
                total += _morae(piece)
            elif not unicodedata.category(piece).startswith(("P", "M", "Z")):
                total += 1  # a symbol such as "&", "+" or "/"
        return total

    return estimate


def _latin(word: str, french: bool) -> float:
    if len(word) >= 2 and word.isupper():
        return float(len(word))  # spelled acronym
    groups = _LATIN_VOWELS.findall(word)
    count = len(groups)
    if french and count > 1 and re.search("[^aeiouy](?:e|es)$", word, re.IGNORECASE):
        count -= 1  # silent final e
    return float(max(1, count))


def _devanagari(word: str) -> float:
    count = 0
    last_bare = False  # the word ends with a consonant without vowel sign or virama
    for index, char in enumerate(word):
        code = ord(char)
        if 0x0904 <= code <= 0x0914 or code in (0x0960, 0x0961) or 0x0972 <= code <= 0x0977:
            count += 1  # independent vowel
            last_bare = False
        elif 0x0915 <= code <= 0x0939 or 0x0958 <= code <= 0x095F or 0x0978 <= code <= 0x097F:
            following = word[index + 1 : index + 2]
            if following == _NUKTA:
                following = word[index + 2 : index + 3]
            if following == _VIRAMA:
                last_bare = False
                continue
            count += 1
            last_bare = following == "" or not unicodedata.category(following).startswith("M")
        elif char not in (_NUKTA,) and unicodedata.category(char).startswith("M"):
            last_bare = False
    if last_bare and count > 1:
        count -= 1  # final inherent vowel dropped
    return float(max(1, count))


def _arabic(word: str) -> float:
    letters = sum(1 for char in word if unicodedata.category(char).startswith("L"))
    return float(max(1, math.ceil(letters / 2)))


def _morae(text: str) -> float:
    total = 0.0
    for char in text:
        if HAN.match(char):
            total += 2
        elif char not in _SMALL_KANA:
            total += 1
    return total


def _number(token: str, numbers: _Numbers) -> float:
    whole, decimals = _split_number(token)
    total = _integer(whole, numbers)
    if decimals:
        total += numbers.point + numbers.digit * len(decimals)
    return total


def _split_number(number: str) -> tuple[str, str]:
    """Digits before and after the decimal separator; thousands separators removed."""
    parts = re.split(r"[.,]", number)
    whole, rest = parts[0], parts[1:]
    while rest and len(rest[0]) == 3:
        whole += rest.pop(0)
    return whole, "".join(rest)


def _integer(digits: str, numbers: _Numbers) -> float:
    if not digits:
        return 0.0
    if len(digits) > 15 or (len(digits) > 1 and int(digits[0]) == 0):
        return numbers.digit * len(digits)  # read digit by digit
    if int(digits) == 0:
        return numbers.digit
    groups = []
    while digits:
        groups.insert(0, digits[-numbers.size :])
        digits = digits[: -numbers.size]
    total = 0.0
    for index, group in enumerate(groups):
        if int(group) == 0:
            continue
        total += _group(group.zfill(numbers.size), numbers)
        if index < len(groups) - 1:
            total += numbers.group
    return total


def _group(group: str, numbers: _Numbers) -> float:
    values = [int(d) for d in group]
    total = 0.0
    if numbers.size == 4:
        # Japanese: 千, 百 and 十 each follow their digit (except 1), then the units digit.
        for place, value in zip((3, 2, 1, 0), values, strict=True):
            if value:
                total += (numbers.digit if value > 1 or not place else 0) + (
                    numbers.hundred if place else 0
                )
        return total
    hundreds, tens, units = values
    if hundreds:
        total += (numbers.digit if hundreds > 1 else 0) + numbers.hundred
    if tens:
        total += numbers.tens
    if units and tens != 1:
        total += numbers.digit
    return total
