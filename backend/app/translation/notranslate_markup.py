"""HTML "no-translate" markup for providers that support it (Azure `textType=html`).

The transcript is untrusted plain text. It is escaped first, and the only markup that ever
reaches the provider is the `<span class="notranslate">` wrapper this module adds around
glossary terms, so user content can never create tags or no-translate directives. The
provider's answer is parsed strictly back to plain text: anything other than text and our
wrapper is rejected instead of being passed on.
"""

import html
from collections import Counter
from collections.abc import Sequence
from dataclasses import dataclass
from html.parser import HTMLParser

from app.translation.glossary import TermMatch

OPEN_TAG = '<span class="notranslate">'
CLOSE_TAG = "</span>"
WRAPPER_OVERHEAD = len(OPEN_TAG) + len(CLOSE_TAG)


class InvalidMarkupError(ValueError):
    """The provider returned markup other than text and no-translate spans."""


class TermsNotPreservedError(ValueError):
    """Protected terms are missing, altered or duplicated in the translation."""


def escape_text(text: str) -> str:
    """Escape `&`, `<` and `>` so the text is inert in HTML."""
    return html.escape(text, quote=False)


def to_markup(text: str, matches: Sequence[TermMatch]) -> str:
    """Escape `text` and wrap each (non-overlapping, sorted) match in a no-translate span."""
    parts: list[str] = []
    position = 0
    for match in matches:
        parts.append(escape_text(text[position : match.start]))
        parts.append(f"{OPEN_TAG}{escape_text(match.text)}{CLOSE_TAG}")
        position = match.end
    parts.append(escape_text(text[position:]))
    return "".join(parts)


@dataclass(frozen=True)
class ParsedTranslation:
    text: str  # plain text, markup removed and entities decoded
    protected_terms: tuple[str, ...]  # contents of the no-translate spans, in order


class _Parser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.text: list[str] = []
        self.terms: list[str] = []
        self._term: list[str] | None = None

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        classes = ()
        if tag == "span" and self._term is None:
            classes = tuple(dict(attrs).get("class", "").split())
        if "notranslate" not in classes:
            raise InvalidMarkupError("unexpected tag in translated text")
        self._term = []

    def handle_endtag(self, tag: str) -> None:
        if tag != "span" or self._term is None:
            raise InvalidMarkupError("unexpected closing tag in translated text")
        self.terms.append("".join(self._term))
        self._term = None

    def handle_data(self, data: str) -> None:
        self.text.append(data)
        if self._term is not None:
            self._term.append(data)

    @property
    def has_unclosed_span(self) -> bool:
        return self._term is not None

    def _reject(self, *_: object) -> None:
        raise InvalidMarkupError("unexpected markup in translated text")

    handle_startendtag = handle_comment = handle_decl = handle_pi = unknown_decl = _reject


def parse_translated_markup(markup: str) -> ParsedTranslation:
    """Turn the provider's HTML back into plain text plus the protected-term spans.

    Raises InvalidMarkupError for any tag other than a flat no-translate span, comments,
    declarations, processing instructions or an unclosed span.
    """
    parser = _Parser()
    try:
        parser.feed(markup)
        parser.close()
    except InvalidMarkupError:
        raise
    except Exception as exc:  # HTMLParser can raise on malformed input
        raise InvalidMarkupError("translated text is not valid markup") from exc
    if parser.has_unclosed_span:
        raise InvalidMarkupError("unclosed no-translate span in translated text")
    # Providers may turn spaces next to markup into no-break spaces; the cleaned input has none.
    text = "".join(parser.text).replace("\xa0", " ")
    terms = tuple(term.replace("\xa0", " ") for term in parser.terms)
    return ParsedTranslation(text=text, protected_terms=terms)


def verify_terms_preserved(expected: Sequence[str], parsed: ParsedTranslation) -> None:
    """Every protected term of the source must come back exactly once per occurrence.

    Order may differ (Vietnamese word order differs from English), spelling may not.
    """
    if Counter(expected) != Counter(parsed.protected_terms):
        raise TermsNotPreservedError("protected terms are missing or were altered")
