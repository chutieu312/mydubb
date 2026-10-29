# ruff: noqa: RUF001, RUF002 (Chinese punctuation is the subject of this module)
"""Mandarin (Simplified Chinese) speech text: chunks for requests and an estimate of its length.

The Vietnamese chunker (`chunker.py`) and syllable estimate (`spoken_length.py`) rely on spaces:
Vietnamese writes every syllable as a word. Chinese has no spaces, so Mandarin has its own versions
here; the Vietnamese ones are unchanged.

**Chunks** (`chunk_spans`). The text is first normalized exactly like Vietnamese
(`chunker.speech_text`: single spaces inside lines, no blank lines). A line that fits is one unit.
A longer line is cut, in this order of preference, only as far as needed:

1. after sentence-ending punctuation: 。！？!?… (optionally followed by closing quotes or brackets
   such as ”」）), or "." followed by a space;
2. after clause punctuation: ，、；：,;: ;
3. between any two characters.

A cut is never made inside a protected term (`TermMatcher.protected_matches`: glossary terms, code
and short English spans, with Han characters as word boundaries, see `pronunciation/han.py`) and
never between two characters of one Latin or number token ("Kubernetes", "3.14", "Node.js",
"C++", "1,024"): a token is a run of ASCII characters and non-Han letters and digits. A space at a
cut is the separator and is not read; nothing else is dropped, so the chunks joined with the
whitespace between them are exactly the normalized text, in order (checked). A token or term
longer than the limit cannot be split (`SpeechTextTooLongError`), as for Vietnamese.

Lengths are counted in characters, as `AZURE_SPEECH_MAX_CHUNK_CHARS` is, but a Chinese character
is a whole syllable, so the same number of characters is read about four times longer than in
Vietnamese. Mandarin chunks are therefore limited to `MANDARIN_MAX_CHUNK_CHARS` (or the configured
limit, if lower): at an assumed slow 2 characters per second that is 300 s, and with the 40 breaks
a timed request may hold (about 140 s) still far from the 10 minutes after which Azure truncates a
response (`azure.py`). Measured on live responses: see docs/context.md.

**Length** (`mandarin_syllables`). Used, like the Vietnamese estimate, only to compare the speaking
rate of clips cut from one timed-mode response (`blocks.py`); never instead of measured audio:

* a Han character is one syllable;
* an English word counts its vowel groups (at least 1); an all-caps acronym is spelled, one per
  letter (read in English inside an `en-US` span);
* a number counts its Mandarin reading: 2026 "两千零二十六" 6, 10000 "一万" 2, 15 "十五" 2, 3.14
  "三点一四" 4 (decimals digit by digit), "%" adds three ("百分之"); a separator followed by exactly
  three digits groups thousands ("1,024"); leading zeros or more than 16 digits are read digit by
  digit. A year may be read digit by digit instead ("二零二六"), a small difference;
* punctuation is not spoken; other symbols count one.
"""

import re
import unicodedata

from app.pronunciation.han import HAN, HanBoundaryTerms
from app.speech.chunker import SpeechTextTooLongError, speech_text
from app.speech.ssml import language_spans
from app.translation.glossary import TermMatcher

MANDARIN_MAX_CHUNK_CHARS = 600

_SENTENCE_END = frozenset("。！？!?…")
_CLAUSE_END = frozenset("，、；：,;:")
_CLOSERS = frozenset("\"'”’)]}»」』）】》〉")
_LEVELS = 3  # sentence, clause, any character


def _glued(char: str) -> bool:
    """Part of a Latin or number token (which a cut never splits)."""
    if char.isspace():
        return False
    return char.isascii() or (char.isalnum() and not HAN.match(char))


def chunk_spans(
    text: str, terms: TermMatcher, max_chars: int, locale: str
) -> list[list[tuple[str, str]]]:
    """(language, text) spans of each chunk, in order; Chinese text is `locale` (zh-CN).

    `terms` are matched with Han characters as word boundaries. Raises SpeechTextTooLongError
    when a token or protected term is longer than the limit.
    """
    terms = HanBoundaryTerms(terms)
    limit = min(max_chars, MANDARIN_MAX_CHUNK_CHARS)
    full = speech_text(text)
    ranges: list[tuple[int, int]] = []
    position = 0
    for line in full.split("\n"):
        start, end = position, position + len(line)
        position = end + 1
        if line:
            ranges += _Line(full, start, end, terms, limit).fit()
    chunks = _pack(ranges, limit)
    _check_complete(full, chunks)
    boundaries = []
    offset = 0
    for language, piece in language_spans(full, terms, base=locale):
        boundaries.append((offset, offset + len(piece), language))
        offset += len(piece)
    return [
        [(lang, full[max(a, s) : min(b, e)]) for s, e, lang in boundaries if s < b and a < e]
        for a, b in chunks
    ]


class _Line:
    def __init__(self, full: str, start: int, end: int, terms: TermMatcher, limit: int) -> None:
        self._full = full
        self._start = start
        self._end = end
        self._limit = limit
        self._blocked = set()  # positions inside a protected term
        for match in terms.protected_matches(full[start:end]):
            self._blocked.update(range(start + match.start + 1, start + match.end))

    def fit(self) -> list[tuple[int, int]]:
        return self._fit(self._start, self._end, 0)

    def _fit(self, start: int, end: int, level: int) -> list[tuple[int, int]]:
        if end - start <= self._limit:
            return [(start, end)]
        if level >= _LEVELS:
            raise SpeechTextTooLongError("a run of text that cannot be cut exceeds the limit")
        units = self._units(start, end, level)
        if len(units) == 1:
            return self._fit(start, end, level + 1)
        out: list[tuple[int, int]] = []
        group_start, group_end = units[0]
        for unit_start, unit_end in units[1:]:
            if unit_end - group_start <= self._limit:
                group_end = unit_end
            else:
                out += self._fit(group_start, group_end, level + 1)
                group_start, group_end = unit_start, unit_end
        out += self._fit(group_start, group_end, level + 1)
        return out

    def _units(self, start: int, end: int, level: int) -> list[tuple[int, int]]:
        """[start, end) cut at every allowed position of this level; a space at a cut is dropped."""
        units = []
        unit_start = start
        for cut in range(start + 1, end):
            if cut <= unit_start or not self._allowed(cut, level):
                continue
            units.append((unit_start, cut))
            unit_start = cut + 1 if self._full[cut] == " " else cut
        if unit_start < end:
            units.append((unit_start, end))
        return units

    def _allowed(self, cut: int, level: int) -> bool:
        full = self._full
        before, after = full[cut - 1], full[cut]
        if cut in self._blocked or before == " " or (_glued(before) and _glued(after)):
            return False
        if level == 2:
            return True
        index = cut - 1
        while index > self._start and full[index] in _CLOSERS:
            index -= 1
        mark = full[index]
        if level == 0:
            return mark in _SENTENCE_END or (mark == "." and after == " ")
        return mark in _CLAUSE_END


def _pack(ranges: list[tuple[int, int]], limit: int) -> list[tuple[int, int]]:
    """Consecutive ranges joined (with the text between them) while the result fits."""
    chunks: list[tuple[int, int]] = []
    for start, end in ranges:
        if chunks and end - chunks[-1][0] <= limit:
            chunks[-1] = (chunks[-1][0], end)
        else:
            chunks.append((start, end))
    return chunks


def _check_complete(full: str, chunks: list[tuple[int, int]]) -> None:
    """Only whitespace lies outside the chunks: nothing is lost, repeated or reordered."""
    position = 0
    for start, end in chunks:
        if start < position or full[position:start].strip():
            raise ValueError("chunks do not cover the text in order")
        position = end
    if full[position:].strip():
        raise ValueError("chunks do not cover the text")


# --- spoken length -------------------------------------------------------------------------

_TOKEN = re.compile(
    rf"(?P<han>{HAN.pattern})"
    r"|(?P<number>\d+(?:[.,]\d+)*%?)"
    # Latin letters only: Han characters are letters too, and each is its own syllable.
    r"|(?P<word>[A-Za-zÀ-ÖØ-öø-ɏ]+(?:['’][A-Za-zÀ-ÖØ-öø-ɏ]+)*)"
    r"|(?P<other>\S)"
)
_ENGLISH_VOWELS = re.compile("[aeiouy]+", re.IGNORECASE)


def mandarin_syllables(text: str) -> float:
    total = 0.0
    for match in _TOKEN.finditer(text):
        kind, token = match.lastgroup, match.group()
        if kind == "han":
            total += 1
        elif kind == "number":
            total += _number(token)
        elif kind == "word":
            total += _word(token)
        elif not unicodedata.category(token).startswith("P"):
            total += 1  # a symbol such as "&", "+" or "/"
    return total


def _word(token: str) -> float:
    if len(token) >= 2 and token.isupper():
        return float(len(token))  # spelled acronym
    return float(max(1, len(_ENGLISH_VOWELS.findall(token))))


def _number(token: str) -> float:
    syllables = 3.0 * token.count("%")  # 百分之
    whole, decimals = _split_number(token.rstrip("%"))
    syllables += _integer(whole)
    if decimals:
        syllables += 1 + len(decimals)  # 点 and the decimals digit by digit
    return syllables


def _split_number(number: str) -> tuple[str, str]:
    """Digits before and after the decimal separator; thousands separators removed."""
    parts = re.split(r"[.,]", number)
    whole, rest = parts[0], parts[1:]
    while rest and len(rest[0]) == 3:
        whole += rest.pop(0)
    return whole, "".join(rest)


def _integer(digits: str) -> float:
    """Syllables of a Mandarin integer reading, e.g. 1024: "一千零二十四" 6."""
    if not digits:
        return 0.0
    if len(digits) > 16 or (len(digits) > 1 and digits[0] == "0"):
        return float(len(digits))  # read digit by digit
    if int(digits) == 0:
        return 1.0  # 零
    groups = []
    while digits:
        groups.insert(0, digits[-4:])
        digits = digits[:-4]
    syllables = 0
    zero = False  # a 零 is read before the next nonzero digit
    for index, group in enumerate(groups):
        if int(group) == 0:
            zero = syllables > 0
            continue
        group = group if index == 0 else group.zfill(4)
        for position, digit in enumerate(group):
            place = len(group) - 1 - position
            if digit == "0":
                zero = zero or syllables > 0
                continue
            if zero:
                syllables += 1
                zero = False
            if place == 1 and digit == "1" and syllables == 0:
                syllables += 1  # 十 alone at the start: 十五
            else:
                syllables += 2 if place else 1  # digit + 十/百/千, or the units digit
        if index < len(groups) - 1:
            syllables += 1  # 万 / 亿
            zero = False
    return float(syllables)
