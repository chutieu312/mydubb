"""SSML for one synthesis request, built only from escaped plain text.

Structure (the one auditioned and accepted by the Product Owner): a single `<voice>` for
the whole request, so one speaker reads everything, containing consecutive
`<lang xml:lang="vi-VN">` spans for the Vietnamese text and `<lang xml:lang="en-US">` spans
for English. Both approved voices are multilingual voices, the case Microsoft documents for
`<lang>`. Speaking rate and everything else keep their defaults. A job in another target language
uses the same structure with that language's locale instead of `vi-VN` (`zh-CN`, `hi-IN`,
`es-ES`, `ar-SA`, `fr-FR`, `ru-RU`, `ja-JP`; `app/languages.py`). `speech/plan.py` decides the
chunks and spans of each language; the skeleton here is shared.

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


def language_spans(text: str, terms: TermMatcher, base: str = VIETNAMESE) -> list[tuple[str, str]]:
    """(language, text) pieces covering `text` exactly: English for the matched terms, `base`
    (the translation's own language) for the rest."""
    spans: list[tuple[str, str]] = []
    position = 0
    for match in terms.find_matches(text):
        if match.start > position:
            spans.append((base, text[position : match.start]))
        spans.append((ENGLISH, text[match.start : match.end]))
        position = match.end
    if position < len(text):
        spans.append((base, text[position:]))
    return spans


def chunk_language_spans(
    full_text: str, chunks: list[str], terms: TermMatcher, base: str = VIETNAMESE
) -> list[list[tuple[str, str]]]:
    """The language spans of each chunk, decided on the whole text.

    `chunks` must be consecutive pieces of `full_text` separated by one character (the chunker's
    output for `chunker.speech_text`). Deciding on the whole text means an English span that the
    chunker had to cut (a long clause left in English) stays en-US in every piece, and a span is
    never lost because a chunk boundary or whitespace differs from the detected text.
    """
    boundaries: list[tuple[int, int, str]] = []
    position = 0
    for language, piece in language_spans(full_text, terms, base=base):
        boundaries.append((position, position + len(piece), language))
        position += len(piece)
    result: list[list[tuple[str, str]]] = []
    found = 0
    for number, chunk in enumerate(chunks):
        if number:
            found += 1  # the separator between two chunks
        if full_text[found : found + len(chunk)] != chunk:
            raise ValueError("chunks are not consecutive pieces of the text")
        end = found + len(chunk)
        spans = [
            (language, full_text[max(found, a) : min(end, b)])
            for a, b, language in boundaries
            if a < end and found < b
        ]
        result.append(spans)
        found = end
    return result


def build_ssml(text: str, voice: Voice, terms: TermMatcher) -> str:
    return build_ssml_from_spans(language_spans(text, terms), voice)


def build_ssml_from_spans(spans: list[tuple[str, str]], voice: Voice) -> str:
    """SSML for (language, text) spans: ENGLISH and the translation's language (VIETNAMESE, or
    the locale of another target language; see `app/languages.py`). Languages come from the
    application, never from user text."""
    body = "".join(
        f'<lang xml:lang="{language}">{escape_text(piece)}</lang>' for language, piece in spans
    )
    return (
        f'<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" '
        f'xml:lang="{ROOT_LANGUAGE}"><voice name="{voice.azure_voice_name}">{body}</voice></speak>'
    )
