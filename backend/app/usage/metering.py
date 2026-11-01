"""How billable usage is counted, from Microsoft's documentation (checked 2026-11-01).

Nothing here calls a provider or reads content: the functions take the text a provider call
already built and return numbers. Callers keep only the numbers.

**Translator** (Azure Translator text translation, v3.0). The response header `X-metered-usage`
is documented as "the number of characters for which the user is charged" for that request
(Translator `translate` reference, "Response headers"). That is the only figure recorded as
*actual*. The documentation does not say whether characters are Unicode code points or UTF-16
units, whether the tags of `textType=html` are counted, or whether a failed request is billed, so
no estimate is derived from what was sent: a request without a valid header has *unknown* usage.
What was sent (UTF-16 units of the markup) is stored next to it as a separate figure, which is
not a billing figure.

**Speech** (Azure Speech text to speech, REST). The documentation ("Pricing note", billable
characters) says billing is by "the total number of characters in each successfully processed
request" and lists as billable: "all markup within the text field of the request body in the SSML
format, except for `<speak>` and `<voice>` tags", letters, punctuation, spaces and all
white-space, "every code point defined in Unicode"; and "Each Chinese character is counted as two
characters for billing, including kanji used in Japanese, hanja used in Korean, or hanzi used in
other languages". Audio length does not change the price of standard neural voices. The estimate
therefore is: the SSML of the request without its `<speak>`/`<voice>` tags, counted in code points
as sent (XML-escaped text, so `&` is the five characters `&amp;`), plus one more for every Han
ideograph. Hiragana, katakana and Hangul are not mentioned by the documentation and count as
one. It is an estimate because Microsoft does not publish the exact algorithm; the figure is
labelled with `SPEECH_METHOD` and the method version is part of it.
"""

import re

# Bump the suffix when a rule changes: older rows keep the label of the rule that produced them.
TRANSLATOR_METHOD = "translator-x-metered-usage-v1"
TRANSLATOR_SENT_UNIT = "utf16_code_units_of_markup"
SPEECH_METHOD = "azure-speech-ssml-characters-v1"
SPEECH_SENT_UNIT = "code_points_without_speak_voice_tags"
UNIT = "characters"

# `<speak ...>`, `</speak>`, `<voice ...>`, `</voice>` only. Text is XML-escaped before it is put
# in the SSML, so user text can never form one of these tags.
_NOT_BILLED_TAGS = re.compile(r"</?(?:speak|voice)(?:\s[^>]*)?>")
# Han ideographs: the characters the documentation counts twice (hanzi, kanji, hanja). Hiragana,
# katakana and Hangul are outside these ranges. Extension A, unified, compatibility, and the
# supplementary-plane extensions B-G plus compatibility supplement.
_HAN_RANGES = (
    (0x3400, 0x4DBF),
    (0x4E00, 0x9FFF),
    (0xF900, 0xFAFF),
    (0x20000, 0x2FA1F),
    (0x30000, 0x323AF),
)
_MAX_METERED_DIGITS = 12


def parse_metered_usage(header: str | None) -> int | None:
    """The characters Microsoft says it charged for one Translator request, or None.

    Anything but a plain non-negative integer (missing, empty, signed, decimal, huge) is not a
    figure: the caller records the usage as unknown, never as 0.
    """
    if header is None:
        return None
    value = header.strip()
    if not value.isascii() or not value.isdigit() or len(value) > _MAX_METERED_DIGITS:
        return None
    return int(value)


def speech_billable(ssml: str) -> tuple[int, int]:
    """(code points without the `<speak>`/`<voice>` tags, estimated billable characters)."""
    body = _NOT_BILLED_TAGS.sub("", ssml)
    code_points = len(body)
    han = sum(1 for char in body if _is_han(char))
    return code_points, code_points + han


def _is_han(char: str) -> bool:
    code = ord(char)
    return any(low <= code <= high for low, high in _HAN_RANGES)
