"""SSML for one synthesis request, built only from escaped plain text.

The text is always element content of a single `<voice>`: it can never add elements,
attributes or directives. Only the voice name (from the approved `Voice` enum) and the fixed
document skeleton are written by the application. No pronunciation, language or
multilingual markup is used: the two voices read English terms with their default behavior.
"""

import re
from xml.sax.saxutils import escape

from app.speech.voices import Voice

LOCALE = "vi-VN"
# Characters that XML 1.0 cannot represent (control characters, lone surrogates, U+FFFE/F).
_XML_INVALID = re.compile("[\x00-\x08\x0b\x0c\x0e-\x1f\ud800-\udfff￾￿]")


def escape_text(text: str) -> str:
    return escape(_XML_INVALID.sub("", text))


def build_ssml(text: str, voice: Voice) -> str:
    return (
        f'<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="{LOCALE}">'
        f'<voice name="{voice.azure_voice_name}">{escape_text(text)}</voice></speak>'
    )
