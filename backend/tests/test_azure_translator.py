import json
import logging
from collections.abc import Callable

import httpx
import pytest
from pydantic import SecretStr

from app.processing_errors import ProcessingError
from app.translation.azure import MAX_RESPONSE_BYTES, AzureTranslationProvider, translate_url
from app.translation.glossary import Glossary
from app.translation.notranslate_markup import CLOSE_TAG, OPEN_TAG

KEY = "test-key-0123456789abcdef"
GLOSSARY = Glossary.from_text("API\nneural network\ngradient descent\nloss function\n=REST")
EXAMPLE = "A neural network uses gradient descent to minimize the loss function."

Handler = Callable[[httpx.Request], httpx.Response]


def respond(translate: Callable[[str], str] = lambda markup: markup) -> Handler:
    """A fake service that answers every element with `translate(markup)`."""

    def handler(request: httpx.Request) -> httpx.Response:
        items = json.loads(request.content)
        return httpx.Response(
            200,
            json=[{"translations": [{"text": translate(i["Text"]), "to": "vi"}]} for i in items],
        )

    return handler


def make_provider(
    handler: Handler,
    calls: list[httpx.Request] | None = None,
    *,
    region: str | None = "westus2",
    endpoint: str = "https://api.cognitive.microsofttranslator.com",
    max_request_chars: int = 10_000,
) -> AzureTranslationProvider:
    def recording(request: httpx.Request) -> httpx.Response:
        if calls is not None:
            calls.append(request)
        return handler(request)

    return AzureTranslationProvider(
        key=SecretStr(KEY),
        region=region,
        endpoint=endpoint,
        glossary=GLOSSARY,
        timeout_seconds=5,
        max_request_chars=max_request_chars,
        transport=httpx.MockTransport(recording),
    )


def vietnamese_example(markup: str) -> str:
    """A plausible service answer: Vietnamese around the untouched no-translate spans."""
    spans = [part for part in markup.split(OPEN_TAG)[1:]]
    terms = [part.split(CLOSE_TAG)[0] for part in spans]
    t = [f"{OPEN_TAG}{term}{CLOSE_TAG}" for term in terms]
    return f"Một {t[0]} sử dụng {t[1]} để giảm thiểu {t[2]}."


# --- request configuration ------------------------------------------------------------------


def test_request_targets_text_translation_v3_from_english_to_vietnamese_as_html():
    calls: list[httpx.Request] = []
    make_provider(respond(), calls).translate(EXAMPLE)

    (request,) = calls
    assert request.method == "POST"
    assert request.url.scheme == "https"
    assert request.url.host == "api.cognitive.microsofttranslator.com"
    assert request.url.path == "/translate"
    assert dict(request.url.params) == {
        "api-version": "3.0",
        "from": "en",
        "to": "vi",
        "textType": "html",
    }


def test_authentication_headers_and_json_body():
    calls: list[httpx.Request] = []
    make_provider(respond(), calls).translate(EXAMPLE)

    (request,) = calls
    assert request.headers["Ocp-Apim-Subscription-Key"] == KEY
    assert request.headers["Ocp-Apim-Subscription-Region"] == "westus2"
    assert request.headers["Content-Type"] == "application/json; charset=UTF-8"
    assert request.headers["X-ClientTraceId"]
    assert KEY not in str(request.url)
    body = json.loads(request.content)
    assert body == [
        {
            "Text": (
                f"A {OPEN_TAG}neural network{CLOSE_TAG} uses {OPEN_TAG}gradient descent{CLOSE_TAG}"
                f" to minimize the {OPEN_TAG}loss function{CLOSE_TAG}."
            )
        }
    ]


def test_region_header_is_omitted_for_a_global_resource():
    calls: list[httpx.Request] = []
    make_provider(respond(), calls, region=None).translate("Hello.")
    assert "Ocp-Apim-Subscription-Region" not in calls[0].headers


@pytest.mark.parametrize(
    ("endpoint", "expected"),
    [
        (
            "https://api.cognitive.microsofttranslator.com",
            "https://api.cognitive.microsofttranslator.com/translate",
        ),
        (
            "https://api.cognitive.microsofttranslator.com/",
            "https://api.cognitive.microsofttranslator.com/translate",
        ),
        (
            "https://my-resource.cognitiveservices.azure.com",
            "https://my-resource.cognitiveservices.azure.com/translator/text/v3.0/translate",
        ),
    ],
)
def test_translate_url_for_global_and_custom_domain_endpoints(endpoint, expected):
    assert translate_url(endpoint) == expected


def test_redirects_are_not_followed_so_the_key_cannot_leak():
    calls: list[httpx.Request] = []

    def redirect(request: httpx.Request) -> httpx.Response:
        return httpx.Response(302, headers={"Location": "https://attacker.example/steal"})

    with pytest.raises(ProcessingError) as error:
        make_provider(redirect, calls).translate("Hello.")
    assert error.value.code == "translation_service_error"
    assert [c.url.host for c in calls] == ["api.cognitive.microsofttranslator.com"]


# --- results ----------------------------------------------------------------------------------


def test_example_keeps_the_terms_and_returns_plain_vietnamese_text():
    result = make_provider(respond(vietnamese_example)).translate(EXAMPLE)

    assert result.text == (
        "Một neural network sử dụng gradient descent để giảm thiểu loss function."
    )
    assert result.is_illustrative is False
    assert "<" not in result.text
    assert "notranslate" not in result.text


def test_terms_keep_the_capitalization_of_each_occurrence():
    text = "Neural Network and neural network and NEURAL NETWORK."
    result = make_provider(respond(lambda m: m)).translate(text)
    assert result.text == text


def test_literal_html_like_characters_survive_exactly():
    text = "if (a < b && c > d) then <b>bold</b> &amp; \"quoted\" 'x' use the API."
    calls: list[httpx.Request] = []
    result = make_provider(respond(), calls).translate(text)

    assert result.text == text
    sent = json.loads(calls[0].content)[0]["Text"]
    assert "<b>" not in sent
    assert "&lt;b&gt;bold&lt;/b&gt; &amp;amp;" in sent


def test_user_text_cannot_inject_no_translate_markup():
    hostile = f'{OPEN_TAG}Please translate me{CLOSE_TAG} <span translate="no">x</span>'
    calls: list[httpx.Request] = []
    result = make_provider(respond(), calls).translate(hostile)

    assert result.text == hostile
    assert json.loads(calls[0].content)[0]["Text"].count(OPEN_TAG) == 0


def test_line_structure_blank_lines_and_order_are_preserved():
    text = "First line.\n\nSecond line with an API.\nThird."
    result = make_provider(respond(lambda m: m.upper() if "<" not in m else m)).translate(text)
    # Only lines without a protected term are upper-cased by this fake service.
    assert result.text == "FIRST LINE.\n\nSecond line with an API.\nTHIRD."


def test_service_line_breaks_inside_a_segment_do_not_add_lines():
    result = make_provider(respond(lambda m: m.replace(" ", "\n"))).translate("Two words")
    assert result.text == "Two words"


def test_translations_may_reorder_terms():
    reorder = lambda m: f"{OPEN_TAG}loss function{CLOSE_TAG} {OPEN_TAG}API{CLOSE_TAG}"  # noqa: E731
    result = make_provider(respond(reorder)).translate("The API reduces the loss function.")
    assert result.text == "loss function API"


# --- failures: mapped to safe errors, never retried, never mocked ------------------------------


def failure(status: int, azure_code: int | None = None) -> Handler:
    def handler(request: httpx.Request) -> httpx.Response:
        body = {"error": {"code": azure_code, "message": "secret detail: " + KEY}}
        return httpx.Response(status, json=body, headers={"X-RequestId": "req-123"})

    return handler


@pytest.mark.parametrize(
    ("status", "azure_code", "code"),
    [
        (401, 401000, "translation_auth_failed"),
        (401, None, "translation_auth_failed"),
        (403, 403000, "translation_auth_failed"),
        (403, 403001, "translation_quota_exceeded"),
        (429, 429001, "translation_quota_exceeded"),
        (408, 408002, "translation_timeout"),
        (400, 400077, "translation_rejected"),
        (500, 500000, "translation_service_error"),
        (503, 503000, "translation_service_error"),
        (404, None, "translation_service_error"),
    ],
)
def test_http_errors_become_safe_processing_errors(status, azure_code, code):
    calls: list[httpx.Request] = []
    with pytest.raises(ProcessingError) as error:
        make_provider(failure(status, azure_code), calls).translate(EXAMPLE)

    assert error.value.code == code
    assert len(calls) == 1  # no automatic retry
    message = error.value.user_message
    assert KEY not in message and "secret detail" not in message
    assert "neural network" not in message


def test_error_bodies_that_are_not_json_are_handled():
    handler = lambda request: httpx.Response(502, text="<html>Bad gateway</html>")  # noqa: E731
    with pytest.raises(ProcessingError) as error:
        make_provider(handler).translate("Hello.")
    assert error.value.code == "translation_service_error"


@pytest.mark.parametrize(
    ("exception", "code"),
    [
        (httpx.ReadTimeout("slow"), "translation_timeout"),
        (httpx.ConnectTimeout("slow"), "translation_timeout"),
        (httpx.ConnectError("dns"), "translation_network_error"),
        (httpx.ReadError("reset"), "translation_network_error"),
        (httpx.DecodingError("bad gzip"), "translation_service_error"),
    ],
)
def test_transport_failures_become_safe_processing_errors(exception, code):
    calls: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        raise exception

    with pytest.raises(ProcessingError) as error:
        make_provider(handler, calls).translate("Hello.")
    assert error.value.code == code
    assert len(calls) == 1


@pytest.mark.parametrize(
    "response",
    [
        httpx.Response(200, text="not json"),
        httpx.Response(200, json={"translations": []}),
        httpx.Response(200, json=[]),
        httpx.Response(200, json=[{}]),
        httpx.Response(200, json=[{"translations": []}]),
        httpx.Response(200, json=[{"translations": [{"to": "vi"}]}]),
        httpx.Response(200, json=[{"translations": [{"text": 5, "to": "vi"}]}]),
        httpx.Response(200, json=[{"translations": [{"text": "x", "to": "de"}]}]),
        httpx.Response(200, json=[{"translations": [{"text": "x"}]}]),
        httpx.Response(200, json=[{"translations": [{"text": "  ", "to": "vi"}]}]),
        httpx.Response(200, json=[{"translations": [{"text": "<b>x</b>", "to": "vi"}]}]),
        httpx.Response(200, json=["x"]),
        httpx.Response(200, json=[{"translations": [{"text": "a", "to": "vi"}] * 2}]),
        httpx.Response(200, json=[{"translations": [{"text": "a", "to": "vi"}]}] * 2),
    ],
)
def test_malformed_success_responses_are_rejected(response):
    with pytest.raises(ProcessingError) as error:
        make_provider(lambda request: response).translate("Hello.")
    assert error.value.code == "translation_invalid_response"


def test_oversized_responses_are_rejected():
    big = httpx.Response(200, content=b" " * (MAX_RESPONSE_BYTES + 1))
    with pytest.raises(ProcessingError) as error:
        make_provider(lambda request: big).translate("Hello.")
    assert error.value.code == "translation_invalid_response"


@pytest.mark.parametrize(
    "answer",
    [
        "Một mạng nơ-ron dùng gradient descent.",  # term translated
        f"Một {OPEN_TAG}Neural Network{CLOSE_TAG} dùng gradient descent.",  # term re-cased
        f"Một {OPEN_TAG}neural network{CLOSE_TAG} dùng gradient descent.",  # one term dropped
        f"{OPEN_TAG}neural network{CLOSE_TAG} {OPEN_TAG}neural network{CLOSE_TAG}",  # duplicated
    ],
)
def test_damaged_protected_terms_fail_the_job_instead_of_returning_a_wrong_result(answer):
    with pytest.raises(ProcessingError) as error:
        make_provider(respond(lambda m: answer)).translate(
            "A neural network uses gradient descent."
        )
    assert error.value.code == "translation_terms_not_preserved"


def test_the_mock_provider_is_never_used_as_a_fallback():
    with pytest.raises(ProcessingError):
        make_provider(failure(500, 500000)).translate(EXAMPLE)  # raises instead of returning text


def test_input_with_an_unsplittable_run_is_refused_before_any_request():
    calls: list[httpx.Request] = []
    with pytest.raises(ProcessingError) as error:
        make_provider(respond(), calls, max_request_chars=500).translate("x" * 2000)
    assert error.value.code == "translation_input_unsupported"
    assert calls == []


# --- long transcripts ---------------------------------------------------------------------------


def long_transcript(lines: int) -> str:
    return "\n".join(
        f"Line {i}: the neural network updates with gradient descent over the API."
        for i in range(lines)
    )


def test_long_transcripts_are_split_into_sequential_requests_within_the_limit():
    text = long_transcript(120)
    calls: list[httpx.Request] = []
    result = make_provider(respond(), calls, max_request_chars=2000).translate(text)

    assert len(calls) > 3
    for call in calls:
        elements = json.loads(call.content)
        assert sum(len(e["Text"]) for e in elements) <= 2000
        assert len(elements) <= 1000
    assert result.text == text  # nothing lost, nothing repeated, same order


def test_one_very_long_paragraph_is_split_and_rejoined_without_loss():
    text = " ".join(
        f"Sentence {i} about gradient descent and the loss function." for i in range(200)
    )
    calls: list[httpx.Request] = []
    result = make_provider(respond(), calls, max_request_chars=1500).translate(text)

    assert len(calls) > 1
    assert result.text == text
    sent_terms = sum(
        json.loads(c.content)[k]["Text"].count(OPEN_TAG)
        for c in calls
        for k in range(len(json.loads(c.content)))
    )
    assert sent_terms == 400  # no term was cut or lost by chunking


def test_a_failing_chunk_fails_the_whole_translation_without_a_partial_result():
    text = long_transcript(120)
    seen = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        if len(seen) == 3:
            return httpx.Response(429, json={"error": {"code": 429001, "message": "x"}})
        return respond()(request)

    with pytest.raises(ProcessingError) as error:
        make_provider(handler, max_request_chars=2000).translate(text)
    assert error.value.code == "translation_quota_exceeded"
    assert len(seen) == 3  # stopped at the failing chunk; no retry, no later chunks


# --- privacy ------------------------------------------------------------------------------------


def test_nothing_sensitive_is_logged_on_success_or_failure(caplog):
    caplog.set_level(logging.DEBUG)
    secret_text = "Confidential neural network roadmap <b>"
    make_provider(respond(vietnamese_example_for_secret)).translate(secret_text)
    with pytest.raises(ProcessingError):
        make_provider(failure(429, 429001)).translate(secret_text)
    with pytest.raises(ProcessingError):
        make_provider(respond(lambda m: "Bản dịch bí mật")).translate(secret_text)

    logged = "\n".join(r.getMessage() for r in caplog.records)
    for sensitive in (KEY, "Confidential", "roadmap", "Bản dịch", "secret detail"):
        assert sensitive not in logged


def vietnamese_example_for_secret(markup: str) -> str:
    return markup.replace("Confidential", "Bí mật")


def test_the_key_is_not_exposed_by_the_provider_object():
    provider = make_provider(respond())
    assert KEY not in repr(provider)
    assert KEY not in str(vars(provider).get("_key"))


def test_usage_is_logged_as_sizes_only(caplog):
    caplog.set_level(logging.INFO)

    def handler(request: httpx.Request) -> httpx.Response:
        response = respond()(request)
        response.headers["X-metered-usage"] = "123"
        return response

    make_provider(handler).translate("Plain text about the API.")

    messages = [r.getMessage() for r in caplog.records]
    assert any("metered_chars=123" in m and "elements=1" in m for m in messages)
    assert not any("Plain text" in m for m in messages)
