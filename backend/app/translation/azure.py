"""Azure Translator (Text Translation API v3.0) provider: English -> the job's target language.

Documentation checked against Microsoft Learn (translate method, authentication, service
limits, prevent-translation) on 2026-10-22:

* `POST {endpoint}/translate?api-version=3.0&from=en&to=<code>&textType=html`, where `<code>` is
  `vi` (Vietnamese) or `zh-Hans` (Mandarin, Simplified Chinese; see `app/languages.py`, checked
  2026-10-29). The answer must name the same code, or it is not used; a global or
  regional resource uses `https://api.cognitive.microsofttranslator.com`, a custom-domain
  (private) endpoint uses `/translator/text/v3.0/translate`.
* Authentication: `Ocp-Apim-Subscription-Key`, plus `Ocp-Apim-Subscription-Region` for
  regional resources.
* Body: JSON array of `{"Text": ...}`; at most 1,000 elements and 50,000 characters per
  request (markup counts). Response: one result per element, each with `translations[].text`.
* API version: v3.0 is used because its contract is fully documented and it has no announced
  retirement. The newer GA `2026-06-06` version (`inputs`/`targets` request, `value` response)
  is not backward compatible; moving to it is a separate, live-tested change.
* `<span class="notranslate">` only works with `textType=html`, so the (escaped) transcript is
  sent as HTML. See `notranslate_markup.py`.

Failures raise ProcessingError with user-safe messages. Requests are never retried here: the
outcome of a timed-out call is unknown and the character quota is limited, so the user gets a
clear error and can submit again. There is no fallback to the mock provider, and a job whose
chunk fails fails as a whole; a partial translation is never returned. Transcript text,
translations and response bodies are never logged.
"""

import json
import logging
import re
import time
import uuid
from collections.abc import Sequence
from urllib.parse import urlsplit

import httpx
from pydantic import SecretStr

from app.languages import DEFAULT_TARGET_LANGUAGE, TargetLanguage
from app.processing_errors import ProcessingError
from app.translation.base import TranslationResult
from app.translation.glossary import Glossary
from app.translation.notranslate_markup import (
    InvalidMarkupError,
    TermsNotPreservedError,
    parse_translated_markup,
    verify_terms_preserved,
)
from app.translation.segmenter import (
    Segment,
    SegmentTooLongError,
    plan_translation,
    utf16_length,
)

logger = logging.getLogger(__name__)

API_VERSION = "3.0"
SOURCE_LANGUAGE = "en"
# Documented limit of array elements per translate request.
MAX_ELEMENTS_PER_REQUEST = 1000
# A 50,000-character request answers with well under a megabyte; this only guards memory.
MAX_RESPONSE_BYTES = 4 * 1024 * 1024

_LINE_BREAKS = re.compile(r"\s*[\r\n]+\s*")
_REQUEST_ID = re.compile(r"[0-9A-Za-z-]{1,64}")
_CUSTOM_DOMAIN_SUFFIX = ".cognitiveservices.azure.com"


def translate_url(endpoint: str) -> str:
    endpoint = endpoint.rstrip("/")
    host = urlsplit(endpoint).hostname or ""
    if host.endswith(_CUSTOM_DOMAIN_SUFFIX):
        return f"{endpoint}/translator/text/v3.0/translate"
    return f"{endpoint}/translate"


_MESSAGES = {
    "translation_auth_failed": (
        "The translation service rejected this server's credentials. This is a server "
        "configuration problem, not an issue with your transcript. Please tell the administrator."
    ),
    "translation_quota_exceeded": (
        "The translation service's quota or rate limit was reached. Please wait a few minutes "
        "and submit again."
    ),
    "translation_timeout": "The translation service did not answer in time. Please submit again.",
    "translation_network_error": (
        "The translation service could not be reached. Please submit again in a moment."
    ),
    "translation_service_error": (
        "The translation service had a temporary problem. Please submit again in a moment."
    ),
    "translation_rejected": (
        "The translation service rejected the request. Please submit again; if it keeps "
        "failing, tell the administrator."
    ),
    "translation_invalid_response": (
        "The translation service returned an unexpected answer, so no translation was "
        "produced. Please submit again."
    ),
    "translation_terms_not_preserved": (
        "The translation changed technical terms that must stay in English, so the result was "
        "discarded instead of showing a wrong translation. Please submit again."
    ),
    "translation_input_unsupported": (
        "The transcript contains a very long run of text without spaces that cannot be split "
        "for translation. Please add spaces or line breaks and submit again."
    ),
}


def _failure(code: str) -> ProcessingError:
    return ProcessingError(code, _MESSAGES[code])


class AzureTranslationProvider:
    name = "azure-translator"

    def __init__(
        self,
        *,
        key: SecretStr,
        region: str | None,
        endpoint: str,
        glossary: Glossary,
        timeout_seconds: float,
        max_request_chars: int,
        transport: httpx.BaseTransport | None = None,
    ) -> None:
        self._key = key
        self._region = region
        self._url = translate_url(endpoint)
        self._glossary = glossary
        self._timeout = timeout_seconds
        self._max_request_chars = max_request_chars
        self._transport = transport

    def translate(
        self, text: str, language: TargetLanguage = DEFAULT_TARGET_LANGUAGE
    ) -> TranslationResult:
        try:
            plan = plan_translation(text, self._glossary, self._max_request_chars)
        except SegmentTooLongError:
            raise _failure("translation_input_unsupported") from None

        translated: list[str] = []
        requests = 0
        timeout = httpx.Timeout(self._timeout, connect=min(10.0, self._timeout))
        with httpx.Client(timeout=timeout, transport=self._transport) as client:
            for batch in plan.batches(self._max_request_chars, MAX_ELEMENTS_PER_REQUEST):
                translated.extend(self._translate_batch(client, batch, language))
                requests += 1
        # Counts only; never content.
        logger.info("Azure translation finished: %d request(s)", requests)
        return TranslationResult(text=plan.assemble(translated), is_illustrative=False)

    def translate_lines(
        self, lines: Sequence[str], language: TargetLanguage = DEFAULT_TARGET_LANGUAGE
    ) -> TranslationResult:
        """Each line is its own segment(s) of the plan (`segmenter.py`), so the translation keeps
        one line per input line; the count is verified rather than assumed."""
        if any("\n" in line or not line.strip() for line in lines):
            raise ValueError("lines must be non-empty and hold no line breaks")
        result = self.translate("\n".join(lines), language)
        translated = result.text.split("\n")
        if len(translated) != len(lines) or not all(line.strip() for line in translated):
            logger.warning("Azure translation lost the line structure of the blocks")
            raise _failure("translation_invalid_response")
        return TranslationResult(text=result.text, is_illustrative=False, lines=tuple(translated))

    def _translate_batch(
        self, client: httpx.Client, batch: list[Segment], language: TargetLanguage
    ) -> list[str]:
        body = self._post(client, [segment.markup for segment in batch], language)
        results = self._parse_results(body, len(batch), language)
        return [
            self._restore(result, segment) for result, segment in zip(results, batch, strict=True)
        ]

    def _post(self, client: httpx.Client, markups: list[str], language: TargetLanguage) -> bytes:
        headers = {
            "Ocp-Apim-Subscription-Key": self._key.get_secret_value(),
            "Content-Type": "application/json; charset=UTF-8",
            "X-ClientTraceId": str(uuid.uuid4()),
        }
        if self._region:
            headers["Ocp-Apim-Subscription-Region"] = self._region
        params = {
            "api-version": API_VERSION,
            "from": SOURCE_LANGUAGE,
            "to": language.translator_code,
            "textType": "html",
        }
        started = time.monotonic()
        try:
            with client.stream(
                "POST",
                self._url,
                params=params,
                headers=headers,
                json=[{"Text": markup} for markup in markups],
            ) as response:
                body = self._read_body(response, started)
                status = response.status_code
                request_id = response.headers.get("X-RequestId", "")
                metered = response.headers.get("X-metered-usage", "")
        except httpx.TimeoutException:
            logger.warning("Azure Translator request timed out")
            raise _failure("translation_timeout") from None
        except httpx.TransportError as exc:
            logger.warning("Azure Translator request failed: %s", type(exc).__name__)
            raise _failure("translation_network_error") from None
        except httpx.HTTPError as exc:
            logger.warning("Azure Translator request failed: %s", type(exc).__name__)
            raise _failure("translation_service_error") from None
        if status != 200:
            raise self._status_error(status, body, request_id)
        # Sizes only. `metered` is the number of characters Microsoft charged, which shows how
        # much the no-translate markup adds to the billed usage.
        logger.info(
            "Azure Translator request ok: elements=%d sent_chars=%d metered_chars=%s",
            len(markups),
            sum(utf16_length(m) for m in markups),
            metered if metered.isdigit() else "-",
        )
        return body

    def _read_body(self, response: httpx.Response, started: float) -> bytes:
        """Read the body within the total time and size limits."""
        chunks: list[bytes] = []
        size = 0
        for chunk in response.iter_bytes():
            size += len(chunk)
            if size > MAX_RESPONSE_BYTES:
                logger.warning("Azure Translator response exceeded the size limit")
                raise _failure("translation_invalid_response")
            if time.monotonic() - started > self._timeout:
                raise httpx.ReadTimeout("total time limit exceeded")
            chunks.append(chunk)
        return b"".join(chunks)

    def _status_error(self, status: int, body: bytes, request_id: str) -> ProcessingError:
        azure_code = _azure_error_code(body)
        logger.warning(
            "Azure Translator returned http_status=%d azure_code=%s request_id=%s",
            status,
            azure_code or "-",
            request_id if _REQUEST_ID.fullmatch(request_id) else "-",
        )
        if status == 401 or (status == 403 and azure_code != "403001"):
            return _failure("translation_auth_failed")
        if status == 429 or azure_code == "403001":
            return _failure("translation_quota_exceeded")
        if status == 408:
            return _failure("translation_timeout")
        if status == 400:
            return _failure("translation_rejected")
        return _failure("translation_service_error")

    @staticmethod
    def _parse_results(body: bytes, expected: int, language: TargetLanguage) -> list[str]:
        try:
            data = json.loads(body)
        except ValueError:
            raise _failure("translation_invalid_response") from None
        if not isinstance(data, list) or len(data) != expected:
            raise _failure("translation_invalid_response")
        texts = []
        for item in data:
            translations = item.get("translations") if isinstance(item, dict) else None
            if not isinstance(translations, list) or len(translations) != 1:
                raise _failure("translation_invalid_response")
            first = translations[0]
            text = first.get("text") if isinstance(first, dict) else None
            code = first.get("to") if isinstance(first, dict) else None
            # A translation into any other language than the one asked for is never used.
            if not isinstance(text, str) or str(code).lower() != language.translator_code.lower():
                raise _failure("translation_invalid_response")
            texts.append(text)
        return texts

    @staticmethod
    def _restore(markup: str, segment: Segment) -> str:
        """Plain text of one translated segment, with every protected term verified."""
        try:
            parsed = parse_translated_markup(markup)
        except InvalidMarkupError:
            raise _failure("translation_invalid_response") from None
        try:
            verify_terms_preserved(segment.terms, parsed)
        except TermsNotPreservedError:
            logger.warning("Azure Translator changed protected terms")
            raise _failure("translation_terms_not_preserved") from None
        text = _LINE_BREAKS.sub(" ", parsed.text).strip()
        if not text:
            raise _failure("translation_invalid_response")
        return text


def _azure_error_code(body: bytes) -> str | None:
    """The documented six-digit error code of an error response, if present."""
    try:
        code = json.loads(body)["error"]["code"]
    except (ValueError, KeyError, TypeError):
        return None
    code = str(code)
    return code if re.fullmatch(r"\d{6}", code) else None
