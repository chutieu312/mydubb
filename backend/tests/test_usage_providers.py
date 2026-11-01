"""Usage metering and attempt recording at the provider boundary (fake HTTP, no database).

Every request a provider sends is one attempt, counted once, whatever its outcome; a missing or
broken figure is unknown, never 0; nothing in a row is text, SSML or a key.
"""

import json
from pathlib import Path

import httpx
import pytest
from pydantic import SecretStr

from app.audio.ffmpeg import AudioTools
from app.languages import TargetLanguage
from app.processing_errors import ProcessingError
from app.speech.azure import AzureSpeechProvider
from app.speech.blocks import BlockPiece, BlockRequest
from app.speech.rate_limit import RequestRateLimiter
from app.speech.ssml import build_ssml_from_spans
from app.speech.voices import Voice
from app.translation.azure import AzureTranslationProvider
from app.translation.glossary import Glossary, default_glossary
from app.usage import metering
from app.usage import recording as usage

SECRET = "usage-test-key-0123456789abcdef"
GLOSSARY = Glossary.from_text("API\nneural network")
TRANSCRIPT_MARKER = "UNIQUE-TRANSCRIPT-MARKER"


class Collector:
    """Stands in for the per-job collector: keeps the rows it is given."""

    def __init__(self) -> None:
        self.rows: list[dict] = []

    def add_attempt(self, row: dict) -> None:
        self.rows.append(row)


@pytest.fixture
def collector():
    sink = Collector()
    token = usage.activate(sink)  # type: ignore[arg-type]
    yield sink
    usage.deactivate(token)


# --- metering rules ------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("header", "expected"),
    [("5", 5), (" 1234 ", 1234), ("0", 0), ("000012", 12)],
)
def test_a_plain_integer_header_is_the_charged_amount(header, expected):
    assert metering.parse_metered_usage(header) == expected


@pytest.mark.parametrize(
    "header", [None, "", " ", "-5", "+5", "1.5", "1e3", "abc", "5 chars", "١٢٣", "9" * 13]
)
def test_a_missing_or_broken_header_is_not_a_figure(header):
    assert metering.parse_metered_usage(header) is None


def ssml(*spans: tuple[str, str]) -> str:
    return build_ssml_from_spans(list(spans), Voice.ANDREW)


def test_speak_and_voice_tags_are_not_billed_but_lang_tags_are():
    text = "Xin chào"
    spans = ("vi-VN", text)
    sent, billable = metering.speech_billable(ssml(spans))
    assert sent == len('<lang xml:lang="vi-VN">') + len(text) + len("</lang>")
    assert billable == sent  # no Han ideograph


def test_every_han_ideograph_counts_twice_but_kana_and_hangul_do_not():
    body = "漢字かなカナ한글"  # 2 Han, 2 hiragana, 2 katakana, 2 hangul
    sent, billable = metering.speech_billable(ssml(("ja-JP", body)))
    assert billable - sent == 2
    assert sent == len('<lang xml:lang="ja-JP">') + len(body) + len("</lang>")


def test_han_outside_the_basic_block_counts_twice():
    # U+20000 (extension B) and U+3400 (extension A)
    sent, billable = metering.speech_billable(ssml(("zh-CN", "\U00020000㐀a")))
    assert billable - sent == 2


def test_breaks_whitespace_and_escaped_characters_are_billed_as_sent():
    request = BlockRequest(
        pieces=[
            BlockPiece(0, [("vi-VN", "Tom & Jerry  ")]),
            BlockPiece(1, [("vi-VN", "Hai")]),
        ]
    )
    sent, billable = metering.speech_billable(request.ssml(Voice.EMMA))
    body = (
        '<lang xml:lang="vi-VN">Tom &amp; Jerry  </lang>'
        '<break time="3000ms"/>'
        '<lang xml:lang="vi-VN">Hai</lang>'
    )
    assert sent == len(body)
    assert billable == sent


def test_user_text_cannot_imitate_the_tags_that_are_not_billed():
    sent, _ = metering.speech_billable(ssml(("vi-VN", "</voice><speak>")))
    # The text is escaped, so all of it is billable body, not a skipped tag.
    assert sent == len('<lang xml:lang="vi-VN">') + len("&lt;/voice&gt;&lt;speak&gt;") + len(
        "</lang>"
    )


# --- translator ----------------------------------------------------------------------------------


def translator(handler, *, max_request_chars: int = 10_000) -> AzureTranslationProvider:
    return AzureTranslationProvider(
        key=SecretStr(SECRET),
        region="westus2",
        endpoint="https://api.cognitive.microsofttranslator.com",
        glossary=GLOSSARY,
        timeout_seconds=5,
        max_request_chars=max_request_chars,
        transport=httpx.MockTransport(handler),
    )


def answer(*, metered: str | None = None, status: int = 200, body: bytes | None = None):
    def handler(request: httpx.Request) -> httpx.Response:
        items = json.loads(request.content)
        headers = {"X-metered-usage": metered} if metered is not None else {}
        payload = [{"translations": [{"text": i["Text"], "to": "vi"}]} for i in items]
        if body is not None:
            return httpx.Response(status, content=body, headers=headers)
        return httpx.Response(status, json=payload, headers=headers)

    return handler


def test_each_translator_request_is_one_attempt_with_the_charged_amount(collector):
    calls = []

    def handler(request):
        calls.append(request)
        return answer(metered=str(100 * len(calls)))(request)

    text = "\n".join(f"Sentence number {i} about an API and a neural network." for i in range(40))
    translator(handler, max_request_chars=300).translate(text, TargetLanguage.VIETNAMESE)

    assert len(calls) > 1  # the transcript was split over several requests
    assert len(collector.rows) == len(calls)  # one attempt per request, counted once
    assert [r["usage_amount"] for r in collector.rows] == [
        100 * n for n in range(1, len(calls) + 1)
    ]
    assert {r["usage_basis"] for r in collector.rows} == {"actual"}
    assert {r["outcome"] for r in collector.rows} == {"ok"}
    assert all(r["usage_method"] == metering.TRANSLATOR_METHOD for r in collector.rows)
    assert all(r["sent_amount"] > 0 and r["items"] >= 1 for r in collector.rows)
    assert sum(r["items"] for r in collector.rows) > len(calls)  # a request holds many elements


@pytest.mark.parametrize("header", [None, "", "abc", "-3", "2.5"])
def test_a_translator_answer_without_a_valid_header_has_unknown_usage_not_zero(collector, header):
    translator(answer(metered=header)).translate("The API works.")
    (row,) = collector.rows
    assert row["outcome"] == "ok"
    assert row["usage_amount"] is None and row["usage_basis"] == "unknown"
    assert row["sent_amount"] and row["sent_unit"] == metering.TRANSLATOR_SENT_UNIT


def test_a_zero_header_is_a_real_zero(collector):
    translator(answer(metered="0")).translate("The API works.")
    assert collector.rows[0]["usage_amount"] == 0
    assert collector.rows[0]["usage_basis"] == "actual"


@pytest.mark.parametrize(
    ("status", "code"),
    [(429, "translation_quota_exceeded"), (401, "translation_auth_failed"), (500, None)],
)
def test_a_failed_translator_request_is_an_attempt_and_not_assumed_free(collector, status, code):
    with pytest.raises(ProcessingError):
        translator(answer(status=status, body=b"{}")).translate("The API works.")
    (row,) = collector.rows
    assert row["outcome"] == "http_error" and row["http_status"] == status
    assert row["usage_amount"] is None and row["usage_basis"] == "unknown"
    if code:
        assert row["error_code"] == code


def test_a_translator_timeout_and_a_network_error_have_their_own_outcomes(collector):
    def timeout(request):
        raise httpx.ReadTimeout("slow", request=request)

    def broken(request):
        raise httpx.ConnectError("down", request=request)

    with pytest.raises(ProcessingError):
        translator(timeout).translate("The API works.")
    with pytest.raises(ProcessingError):
        translator(broken).translate("The API works.")
    assert [r["outcome"] for r in collector.rows] == ["timeout", "network_error"]
    assert all(r["usage_basis"] == "unknown" and r["usage_amount"] is None for r in collector.rows)
    assert collector.rows[0]["error_code"] == "translation_timeout"


def test_an_answer_that_is_charged_but_unusable_keeps_its_attempt(collector):
    with pytest.raises(ProcessingError):
        translator(answer(metered="77", body=b"not json")).translate("The API works.")
    (row,) = collector.rows
    assert row["outcome"] == "ok" and row["usage_amount"] == 77  # it was served and charged
    assert row["usage_basis"] == "actual"


def test_translator_rows_hold_no_text_or_secret(collector):
    translator(answer(metered="9")).translate(f"The API {TRANSCRIPT_MARKER}.")
    dumped = json.dumps(collector.rows, default=str)
    assert TRANSCRIPT_MARKER not in dumped and SECRET not in dumped


def test_without_a_collector_a_provider_works_the_same():
    result = translator(answer(metered="9")).translate("The API works.")
    assert result.text


# --- speech --------------------------------------------------------------------------------------


def speech(handler, limiter=None) -> AzureSpeechProvider:
    return AzureSpeechProvider(
        key=SecretStr(SECRET),
        region="westus2",
        glossary=default_glossary(),
        tools=AudioTools("ffmpeg", "ffprobe"),  # never run: only requests are sent
        limiter=limiter or RequestRateLimiter(1000, 1),
        timeout_seconds=5,
        max_chunk_chars=200,
        transport=httpx.MockTransport(handler),
    )


def send(provider: AzureSpeechProvider, text: str, tmp_path: Path, items: int = 1) -> str:
    """One request through the real request path; returns the SSML that was sent."""
    body = build_ssml_from_spans([("ja-JP", text)], Voice.ANDREW)
    with httpx.Client(transport=provider._transport) as client:
        provider._synthesize_chunk(client, body, tmp_path / "out.wav", items)
    return body


def wav_ok(request):
    from tests.audio_helpers import make_wav

    return httpx.Response(200, content=make_wav(1.0))


def test_a_speech_request_is_estimated_with_the_cjk_rule(collector, tmp_path):
    body = send(speech(wav_ok), "日本語のテキスト", tmp_path)
    (row,) = collector.rows
    sent, billable = metering.speech_billable(body)
    assert row["outcome"] == "ok" and row["usage_basis"] == "estimated"
    assert (row["sent_amount"], row["usage_amount"]) == (sent, billable)
    assert billable == sent + 3  # three Han ideographs; the kana count once
    assert row["usage_method"] == metering.SPEECH_METHOD


def test_a_multi_block_speech_request_is_one_attempt(collector, tmp_path):
    send(speech(wav_ok), "text", tmp_path, items=17)
    (row,) = collector.rows
    assert row["items"] == 17


@pytest.mark.parametrize("status", [400, 401, 429, 503])
def test_a_failed_speech_request_is_an_attempt_with_unknown_usage(collector, tmp_path, status):
    provider = speech(lambda request: httpx.Response(status))
    with pytest.raises(ProcessingError):
        send(provider, "Xin chào", tmp_path)
    (row,) = collector.rows
    assert row["outcome"] == "http_error" and row["http_status"] == status
    assert row["usage_amount"] is None and row["usage_basis"] == "unknown"
    assert row["sent_amount"] > 0  # what was sent is still recorded, apart from usage


def test_a_speech_timeout_is_unknown_not_free(collector, tmp_path):
    def slow(request):
        raise httpx.ReadTimeout("slow", request=request)

    with pytest.raises(ProcessingError):
        send(speech(slow), "Xin chào", tmp_path)
    (row,) = collector.rows
    assert row["outcome"] == "timeout" and row["usage_basis"] == "unknown"


def test_audio_the_service_returned_but_we_reject_is_still_an_estimated_attempt(
    collector, tmp_path
):
    # A 200 whose body is later judged unusable was processed (and billed) by the service.
    provider = speech(wav_ok)
    send(provider, "Xin chào", tmp_path)
    with pytest.raises(ProcessingError):
        provider._validate_chunk(tmp_path / "out.wav", 10_000)  # implausibly short for its text
    assert [r["outcome"] for r in collector.rows] == ["ok"]  # the request itself was recorded once
    assert collector.rows[0]["usage_basis"] == "estimated"


def test_a_closed_limiter_cancels_before_anything_is_sent(collector):
    limiter = RequestRateLimiter(1000, 1)
    limiter.close()
    calls = []
    provider = speech(lambda request: calls.append(request), limiter)
    with pytest.raises(ProcessingError) as error:
        provider._acquire(3)
    assert error.value.code == "speech_cancelled" and calls == []
    (row,) = collector.rows
    assert row["outcome"] == "cancelled" and row["items"] == 3
    assert row["usage_amount"] == 0 and row["usage_basis"] == "none"  # nothing was sent


def test_speech_rows_hold_no_text_or_secret(collector, tmp_path):
    send(speech(wav_ok), TRANSCRIPT_MARKER, tmp_path)
    dumped = json.dumps(collector.rows, default=str)
    assert TRANSCRIPT_MARKER not in dumped and SECRET not in dumped
