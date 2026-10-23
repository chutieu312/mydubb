"""SSML for one synthesis request, built only from escaped plain text.

Structure (the one auditioned and accepted by the Product Owner): a single `<voice>` for
the whole request, so one speaker reads everything, containing consecutive
`<lang xml:lang="vi-VN">` spans for the Vietnamese text and `<lang xml:lang="en-US">` spans
for English. Both approved voices are multilingual voices, the case Microsoft documents for
`<lang>`. Speaking rate and everything else keep their defaults.

The English spans come from a `TermMatcher`: the shared glossary (known terms, always first)
and, for a job, the English its translation kept (`pronunciation/detector.py`: words that
cannot be Vietnamese and were copied from the source, and code such as `/proc`). Words that
might be Vietnamese stay in a Vietnamese span; nothing is forced into English on a guess.

The spans partition the text exactly: spelling, case, whitespace and order are unchanged, so
concatenating the span texts gives the input back. The text is XML-escaped (and characters XML
cannot carry are removed), so it can only ever be text content of a span: it can never add
elements, attributes or audio URLs. Only the fixed skeleton, the voice name from the `Voice`
enum and the two language tags are written by the application.

Limit: an English word that the glossary does not list and that the detection cannot tell
from Vietnamese (for example `run`) stays inside a Vietnamese span and the voice may
mispronounce it. `en-US` on code such as `/proc` says which language reads it, not that the
symbols are read well.
"""

import re
from xml.sax.saxutils import escape

from app.speech.voices import Voice
from app.translation.glossary import TermMatcher

VIETNAMESE = "vi-VN"
ENGLISH = "en-US"
# The skeleton's own language, as in the accepted sample.
ROOT_LANGUAGE = "en-US"
# Characters that XML 1.0 cannot represent (control characters, lone surrogates, U+FFFE/F).
_XML_INVALID = re.compile("[\x00-\x08\x0b\x0c\x0e-\x1f\ud800-\udfff￾￿]")


def escape_text(text: str) -> str:
    return escape(_XML_INVALID.sub("", text))


def language_spans(text: str, terms: TermMatcher) -> list[tuple[str, str]]:
    """(language, text) pieces covering `text` exactly: English for the matched terms."""
    spans: list[tuple[str, str]] = []
    position = 0
    for match in terms.find_matches(text):
        if match.start > position:
            spans.append((VIETNAMESE, text[position : match.start]))
        spans.append((ENGLISH, text[match.start : match.end]))
        position = match.end
    if position < len(text):
        spans.append((VIETNAMESE, text[position:]))
    return spans


def build_ssml(text: str, voice: Voice, terms: TermMatcher) -> str:
    body = "".join(
        f'<lang xml:lang="{language}">{escape_text(piece)}</lang>'
        for language, piece in language_spans(text, terms)
    )
    return (
        f'<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" '
        f'xml:lang="{ROOT_LANGUAGE}"><voice name="{voice.azure_voice_name}">{body}</voice></speak>'
    )
