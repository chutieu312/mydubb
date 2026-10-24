"""The real Cognito HTTP client against a fake transport (no network), and Cognito settings."""

import base64
import hashlib
import hmac
import json
import logging

import httpx
import pytest
from pydantic import SecretStr

from app.auth.cognito import (
    AuthChallengeStep,
    AuthTokens,
    CognitoError,
    CognitoErrorKind,
    HttpCognitoClient,
    secret_hash,
)
from app.config import ConfigurationError, Settings, load_settings
from tests.conftest import COGNITO_SETTINGS

CLIENT_ID = "testclientid123"
SECRET = "client-secret-value"


def make_client(handler, secret: str | None = None) -> HttpCognitoClient:
    return HttpCognitoClient(
        region="us-west-2",
        client_id=CLIENT_ID,
        client_secret=SecretStr(secret) if secret else None,
        timeout_seconds=5,
        transport=httpx.MockTransport(handler),
    )


def ok(body: dict) -> httpx.Response:
    return httpx.Response(200, json=body, headers={"x-amzn-requestid": "req-1"})


def aws_error(type_name: str, status: int = 400, message: str = "secret detail") -> httpx.Response:
    return httpx.Response(status, json={"__type": type_name, "message": message})


def test_initiate_auth_request_shape_and_secret_hash():
    seen = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return ok(
            {"AuthenticationResult": {"AccessToken": "at", "IdToken": "id", "RefreshToken": "rt"}}
        )

    outcome = make_client(handler, SECRET).initiate_password_auth("Lan@Example.com", "pw")
    assert outcome == AuthTokens(access_token="at")  # ID and refresh tokens are dropped
    request = seen[0]
    assert str(request.url) == "https://cognito-idp.us-west-2.amazonaws.com/"
    assert request.headers["x-amz-target"] == "AWSCognitoIdentityProviderService.InitiateAuth"
    assert request.headers["content-type"] == "application/x-amz-json-1.1"
    assert "authorization" not in request.headers  # no AWS credentials
    body = json.loads(request.content)
    assert body["AuthFlow"] == "USER_PASSWORD_AUTH" and body["ClientId"] == CLIENT_ID
    expected = base64.b64encode(
        hmac.new(SECRET.encode(), b"Lan@Example.com" + CLIENT_ID.encode(), hashlib.sha256).digest()
    ).decode()
    assert body["AuthParameters"] == {
        "USERNAME": "Lan@Example.com",
        "PASSWORD": "pw",
        "SECRET_HASH": expected,
    }
    assert secret_hash(SECRET, "Lan@Example.com", CLIENT_ID) == expected


def test_no_secret_hash_without_a_client_secret():
    seen = []

    def handler(request):
        seen.append(json.loads(request.content))
        return ok({"AuthenticationResult": {"AccessToken": "at"}})

    make_client(handler).initiate_password_auth("a@b.co", "pw")
    assert "SECRET_HASH" not in seen[0]["AuthParameters"]


def test_new_password_challenge_uses_the_real_username():
    seen = []

    def handler(request):
        body = json.loads(request.content)
        seen.append(body)
        if body.get("AuthFlow"):
            return ok(
                {
                    "ChallengeName": "NEW_PASSWORD_REQUIRED",
                    "Session": "sess",
                    "ChallengeParameters": {"USER_ID_FOR_SRP": "uuid-user", "userAttributes": "{}"},
                }
            )
        return ok({"AuthenticationResult": {"AccessToken": "at"}})

    client = make_client(handler, SECRET)
    step = client.initiate_password_auth("a@b.co", "temp")
    assert step == AuthChallengeStep(
        name="NEW_PASSWORD_REQUIRED", session="sess", username="uuid-user"
    )
    assert client.respond_new_password("uuid-user", "sess", "new") == AuthTokens("at")
    answer = seen[1]
    assert answer["ChallengeName"] == "NEW_PASSWORD_REQUIRED" and answer["Session"] == "sess"
    assert answer["ChallengeResponses"]["USERNAME"] == "uuid-user"
    assert answer["ChallengeResponses"]["SECRET_HASH"] == secret_hash(
        SECRET, "uuid-user", CLIENT_ID
    )


def test_get_user_and_verification_calls():
    def handler(request):
        target = request.headers["x-amz-target"].split(".")[-1]
        body = json.loads(request.content)
        assert body["AccessToken"] == "at"
        if target == "GetUser":
            return ok(
                {
                    "Username": "uuid-user",
                    "UserAttributes": [
                        {"Name": "sub", "Value": "uuid-user"},
                        {"Name": "email", "Value": "a@b.co"},
                        {"Name": "email_verified", "Value": "false"},
                    ],
                }
            )
        if target == "GetUserAttributeVerificationCode":
            assert body["AttributeName"] == "email"
            return ok(
                {"CodeDeliveryDetails": {"Destination": "a***@b***", "DeliveryMedium": "EMAIL"}}
            )
        assert target == "VerifyUserAttribute" and body["Code"] == "123456"
        return ok({})

    client = make_client(handler)
    user = client.get_user("at")
    assert (user.sub, user.email, user.email_verified, user.name) == (
        "uuid-user",
        "a@b.co",
        False,
        None,
    )
    assert client.send_email_verification_code("at") == "a***@b***"
    client.verify_email("at", "123456")


def test_get_user_without_sub_or_email_is_unexpected():
    client = make_client(
        lambda request: ok({"UserAttributes": [{"Name": "email", "Value": "a@b.co"}]})
    )
    with pytest.raises(CognitoError) as caught:
        client.get_user("at")
    assert caught.value.kind is CognitoErrorKind.UNAVAILABLE


def test_recovery_calls_carry_secret_hash():
    seen = []

    def handler(request):
        seen.append(json.loads(request.content))
        return ok({})

    client = make_client(handler, SECRET)
    client.forgot_password("a@b.co")
    client.confirm_forgot_password("a@b.co", "123456", "new-password")
    assert seen[0] == {
        "ClientId": CLIENT_ID,
        "Username": "a@b.co",
        "SecretHash": secret_hash(SECRET, "a@b.co", CLIENT_ID),
    }
    assert seen[1]["ConfirmationCode"] == "123456" and seen[1]["Password"] == "new-password"


@pytest.mark.parametrize(
    ("response", "kind"),
    [
        (aws_error("NotAuthorizedException"), CognitoErrorKind.NOT_AUTHORIZED),
        (aws_error("UserNotFoundException"), CognitoErrorKind.NOT_AUTHORIZED),
        (aws_error("PasswordResetRequiredException"), CognitoErrorKind.NOT_AUTHORIZED),
        (
            aws_error("com.amazonaws.cognito.identity.idp.model#CodeMismatchException"),
            CognitoErrorKind.CODE_INVALID,
        ),
        (aws_error("ExpiredCodeException"), CognitoErrorKind.CODE_INVALID),
        (aws_error("InvalidPasswordException"), CognitoErrorKind.INVALID_PASSWORD),
        (aws_error("TooManyRequestsException"), CognitoErrorKind.RATE_LIMITED),
        (aws_error("LimitExceededException"), CognitoErrorKind.RATE_LIMITED),
        (aws_error("InvalidParameterException"), CognitoErrorKind.INVALID_PARAMETER),
        (aws_error("ResourceNotFoundException"), CognitoErrorKind.UNAVAILABLE),
        (aws_error("InternalErrorException", 500), CognitoErrorKind.UNAVAILABLE),
        (
            httpx.Response(400, headers={"x-amzn-ErrorType": "NotAuthorizedException:http://x"}),
            CognitoErrorKind.NOT_AUTHORIZED,
        ),
        (httpx.Response(400, content=b"<html>"), CognitoErrorKind.UNAVAILABLE),
        (
            httpx.Response(302, headers={"location": "https://elsewhere.example/"}),
            CognitoErrorKind.UNAVAILABLE,
        ),
        (httpx.Response(200, content=b"not json"), CognitoErrorKind.UNAVAILABLE),
        (ok({"Unexpected": True}), CognitoErrorKind.UNAVAILABLE),
    ],
)
def test_error_mapping(response, kind):
    with pytest.raises(CognitoError) as caught:
        make_client(lambda request: response).initiate_password_auth("a@b.co", "pw")
    assert caught.value.kind is kind


def test_redirects_are_not_followed():
    calls = []

    def handler(request):
        calls.append(str(request.url))
        return httpx.Response(307, headers={"location": "https://elsewhere.example/"})

    with pytest.raises(CognitoError):
        make_client(handler).initiate_password_auth("a@b.co", "pw")
    assert calls == ["https://cognito-idp.us-west-2.amazonaws.com/"]


@pytest.mark.parametrize("error", [httpx.ReadTimeout("t"), httpx.ConnectError("c")])
def test_network_failures_are_unavailable_and_not_retried(error):
    calls = []

    def handler(request):
        calls.append(1)
        raise error

    with pytest.raises(CognitoError) as caught:
        make_client(handler).initiate_password_auth("a@b.co", "pw")
    assert caught.value.kind is CognitoErrorKind.UNAVAILABLE
    assert len(calls) == 1


def test_oversized_answers_are_rejected():
    client = make_client(lambda request: httpx.Response(200, content=b"{" + b" " * 300_000 + b"}"))
    with pytest.raises(CognitoError):
        client.get_user("at")


def test_client_logs_no_secrets(caplog):
    caplog.set_level(logging.DEBUG)
    client = make_client(
        lambda request: aws_error("NotAuthorizedException", message="detail-xyz"), SECRET
    )
    with pytest.raises(CognitoError):
        client.initiate_password_auth("lan@example.com", "the-password")
    assert "NotAuthorizedException" in caplog.text
    for secret in ("lan@example.com", "the-password", SECRET, "detail-xyz"):
        assert secret not in caplog.text


# -- settings ---------------------------------------------------------------------------------


def settings_with(make_settings, **overrides) -> Settings:
    return make_settings(**{**COGNITO_SETTINGS, **overrides})


def test_cognito_mode_does_not_need_an_access_code(make_settings):
    settings = settings_with(make_settings)
    assert settings.access_code is None
    assert settings.cognito_issuer.endswith("us-west-2_TestPool1")


@pytest.mark.parametrize(
    ("overrides", "field"),
    [
        ({"cognito_region": None}, "COGNITO_REGION"),
        ({"cognito_region": "us-west-2.evil.example"}, "COGNITO_REGION"),
        ({"cognito_user_pool_id": None}, "COGNITO_USER_POOL_ID"),
        ({"cognito_user_pool_id": "us-east-1_Abc"}, "COGNITO_USER_POOL_ID"),
        ({"cognito_client_id": None}, "COGNITO_CLIENT_ID"),
        ({"cognito_client_id": "bad id"}, "COGNITO_CLIENT_ID"),
        ({"auth_token_encryption_key": None}, "AUTH_TOKEN_ENCRYPTION_KEY"),
        ({"auth_token_encryption_key": "dG9vLXNob3J0"}, "AUTH_TOKEN_ENCRYPTION_KEY"),
        ({"cognito_client_secret": "has space"}, "COGNITO_CLIENT_SECRET"),
    ],
)
def test_incomplete_cognito_configuration_refuses_to_start(make_settings, overrides, field):
    with pytest.raises(ValueError, match=field):
        settings_with(make_settings, **overrides)


def test_access_code_mode_still_requires_the_code(make_settings):
    with pytest.raises(ValueError, match="ACCESS_CODE"):
        make_settings(access_code=None)


def test_cognito_configuration_errors_never_include_secret_values(monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)
    for name, value in {
        "APP_ENV": "production",
        "DATABASE_URL": "postgresql://u:TOPSECRET-DB@h/db",
        "PROVIDER_MODE": "mock",
        "ALLOW_MOCK_PROVIDERS_IN_PRODUCTION": "true",
        "AUTH_MODE": "cognito",
        "COGNITO_REGION": "us-west-2",
        "COGNITO_USER_POOL_ID": "us-west-2_Pool1",
        "COGNITO_CLIENT_ID": "client1",
        "COGNITO_CLIENT_SECRET": "TOPSECRET-CLIENT",
        "AUTH_TOKEN_ENCRYPTION_KEY": "TOPSECRET-short-key",
    }.items():
        monkeypatch.setenv(name, value)
    with pytest.raises(ConfigurationError) as caught:
        load_settings()
    assert "AUTH_TOKEN_ENCRYPTION_KEY" in str(caught.value)
    assert "TOPSECRET" not in str(caught.value)


def test_production_cognito_configuration_is_accepted(make_settings):
    settings = settings_with(
        make_settings,
        app_env="production",
        cookie_secure=True,
        allow_mock_providers_in_production=True,
        cognito_client_secret="a-client-secret",
    )
    assert settings.auth_mode == "cognito"
