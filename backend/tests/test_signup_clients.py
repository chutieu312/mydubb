"""The sign-up HTTP clients against fake transports (no network): Cognito's SignUp,
ConfirmSignUp and ResendConfirmationCode, and Google's reCAPTCHA siteverify. No database."""

import json
import logging
from urllib.parse import parse_qs

import httpx
import pytest
from pydantic import SecretStr

from app.auth.cognito import CognitoError, CognitoErrorKind, secret_hash
from app.auth.recaptcha import SITEVERIFY_URL, CaptchaResult, RecaptchaVerifier
from tests.test_auth_cognito_client import CLIENT_ID, SECRET, aws_error, make_client, ok

EMAIL = "New.User@example.com"
TOKEN = "03AFcWeA-the-user-token"
RECAPTCHA_SECRET = "6Lc_test_secret_key_00000000000000000000"


# -- Cognito ------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("operation", "call", "expected"),
    [
        (
            "SignUp",
            lambda c: c.sign_up(EMAIL, "pw-1"),
            {
                "ClientId": CLIENT_ID,
                "Username": EMAIL,
                "Password": "pw-1",
                "UserAttributes": [{"Name": "email", "Value": EMAIL}],
            },
        ),
        (
            "ConfirmSignUp",
            lambda c: c.confirm_sign_up(EMAIL, "123456"),
            {"ClientId": CLIENT_ID, "Username": EMAIL, "ConfirmationCode": "123456"},
        ),
        (
            "ResendConfirmationCode",
            lambda c: c.resend_confirmation_code(EMAIL),
            {"ClientId": CLIENT_ID, "Username": EMAIL},
        ),
    ],
)
def test_sign_up_requests_always_carry_the_secret_hash(operation, call, expected):
    """With a confidential app client every request needs the hash of the client secret, which
    only the backend has: this is what keeps the public API from being called directly."""
    seen = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return ok({"UserConfirmed": False, "UserSub": "sub-1"})

    call(make_client(handler, SECRET))
    request = seen[0]
    assert request.headers["x-amz-target"] == f"AWSCognitoIdentityProviderService.{operation}"
    assert "authorization" not in request.headers  # no AWS credentials
    body = json.loads(request.content)
    assert body == {**expected, "SecretHash": secret_hash(SECRET, EMAIL, CLIENT_ID)}
    # Never chosen by MyDubb: an email never moves to another user, and no extra attributes.
    assert "ForceAliasCreation" not in body and "ClientMetadata" not in body


@pytest.mark.parametrize(
    ("aws_type", "kind"),
    [
        ("UsernameExistsException", CognitoErrorKind.USER_EXISTS),
        ("AliasExistsException", CognitoErrorKind.USER_EXISTS),
        ("InvalidPasswordException", CognitoErrorKind.INVALID_PASSWORD),
        ("CodeMismatchException", CognitoErrorKind.CODE_INVALID),
        ("ExpiredCodeException", CognitoErrorKind.CODE_INVALID),
        ("TooManyFailedAttemptsException", CognitoErrorKind.RATE_LIMITED),
        ("LimitExceededException", CognitoErrorKind.RATE_LIMITED),
        ("NotAuthorizedException", CognitoErrorKind.NOT_AUTHORIZED),
        ("CodeDeliveryFailureException", CognitoErrorKind.UNAVAILABLE),
    ],
)
def test_sign_up_errors_are_classified(aws_type, kind):
    client = make_client(lambda request: aws_error(aws_type), SECRET)
    with pytest.raises(CognitoError) as caught:
        client.sign_up(EMAIL, "pw-1")
    assert (caught.value.kind, caught.value.aws_type) == (kind, aws_type)


def test_sign_up_is_never_retried():
    calls = []

    def handler(request):
        calls.append(request)
        raise httpx.ConnectTimeout("slow")

    with pytest.raises(CognitoError) as caught:
        make_client(handler, SECRET).sign_up(EMAIL, "pw-1")
    assert caught.value.kind is CognitoErrorKind.UNAVAILABLE and len(calls) == 1


# -- reCAPTCHA ----------------------------------------------------------------------------------


def verifier(handler) -> RecaptchaVerifier:
    return RecaptchaVerifier(
        secret=SecretStr(RECAPTCHA_SECRET),
        allowed_hostnames=["mydubb.com"],
        timeout_seconds=5,
        transport=httpx.MockTransport(handler),
    )


def answer(**body) -> httpx.Response:
    return httpx.Response(200, json=body)


SOLVED = {"success": True, "challenge_ts": "2026-11-09T10:00:00Z", "hostname": "mydubb.com"}


def test_siteverify_request_shape():
    seen = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return answer(**SOLVED)

    assert verifier(handler).verify(TOKEN).result is CaptchaResult.VALID
    request = seen[0]
    assert str(request.url) == SITEVERIFY_URL == "https://www.google.com/recaptcha/api/siteverify"
    assert request.method == "POST"
    assert request.headers["content-type"] == "application/x-www-form-urlencoded"
    form = parse_qs(request.content.decode())
    # The user's IP address is not sent (remoteip is optional).
    assert form == {"secret": [RECAPTCHA_SECRET], "response": [TOKEN]}


@pytest.mark.parametrize(
    ("body", "result"),
    [
        (SOLVED, CaptchaResult.VALID),
        ({**SOLVED, "hostname": "MyDubb.com"}, CaptchaResult.VALID),
        # Solved on someone else's page, or no host name at all.
        ({**SOLVED, "hostname": "evil.example"}, CaptchaResult.REJECTED),
        ({**SOLVED, "hostname": "mydubb.com.evil.example"}, CaptchaResult.REJECTED),
        ({"success": True, "challenge_ts": "2026-11-09T10:00:00Z"}, CaptchaResult.REJECTED),
        # Expired or used before (Google decides), forged, or missing.
        ({"success": False, "error-codes": ["timeout-or-duplicate"]}, CaptchaResult.REJECTED),
        ({"success": False, "error-codes": ["invalid-input-response"]}, CaptchaResult.REJECTED),
        ({"success": False, "error-codes": ["missing-input-response"]}, CaptchaResult.REJECTED),
        ({"success": False}, CaptchaResult.REJECTED),
        # Our key or request is wrong: not the user's fault, sign-up is off for now.
        ({"success": False, "error-codes": ["invalid-input-secret"]}, CaptchaResult.UNAVAILABLE),
        ({"success": False, "error-codes": ["missing-input-secret"]}, CaptchaResult.UNAVAILABLE),
        ({"success": False, "error-codes": ["bad-request"]}, CaptchaResult.UNAVAILABLE),
        ({"success": False, "error-codes": ["something-new"]}, CaptchaResult.UNAVAILABLE),
        # Not the contract: never a pass.
        ({"success": "true", "hostname": "mydubb.com"}, CaptchaResult.UNAVAILABLE),
        ({"hostname": "mydubb.com"}, CaptchaResult.UNAVAILABLE),
    ],
)
def test_only_a_solved_token_from_our_host_passes(body, result):
    assert verifier(lambda request: answer(**body)).verify(TOKEN).result is result


@pytest.mark.parametrize(
    "respond",
    [
        lambda request: httpx.Response(500, text="oops"),
        lambda request: httpx.Response(429, text="Over quota"),
        lambda request: httpx.Response(302, headers={"location": "https://example.com"}),
        lambda request: httpx.Response(200, text="<html>not json</html>"),
        lambda request: httpx.Response(200, json=["not", "an", "object"]),
        lambda request: httpx.Response(200, content=b"{" + b" " * 20_000 + b"}"),
    ],
)
def test_any_unusable_answer_fails_closed(respond):
    assert verifier(respond).verify(TOKEN).result is CaptchaResult.UNAVAILABLE


@pytest.mark.parametrize("error", [httpx.ConnectTimeout("t"), httpx.ConnectError("refused")])
def test_network_failures_fail_closed_and_are_not_retried(error):
    calls = []

    def handler(request):
        calls.append(request)
        raise error

    assert verifier(handler).verify(TOKEN).result is CaptchaResult.UNAVAILABLE
    assert len(calls) == 1


def test_the_token_and_secret_are_never_logged(caplog):
    with caplog.at_level(logging.DEBUG):
        verifier(lambda r: answer(success=False, **{"error-codes": ["bad-request"]})).verify(TOKEN)
        verifier(lambda r: answer(**{**SOLVED, "hostname": "evil.example"})).verify(TOKEN)
        verifier(lambda r: httpx.Response(500)).verify(TOKEN)
    assert TOKEN not in caplog.text and RECAPTCHA_SECRET not in caplog.text
    assert "bad-request" in caplog.text
