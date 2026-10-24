"""Amazon Cognito user pool client (public and token-authorized API operations only).

The backend acts as the user's client: it calls `InitiateAuth` (`USER_PASSWORD_AUTH`),
`RespondToAuthChallenge` (`NEW_PASSWORD_REQUIRED`), `GetUser`, `GetUserAttributeVerificationCode`,
`VerifyUserAttribute`, `ForgotPassword` and `ConfirmForgotPassword`. None of them accepts or needs
AWS credentials (Cognito developer guide, "List of API operations grouped by authorization
model"), so no IAM key exists in the app. With a confidential app client, requests carry the
`SECRET_HASH` computed from the client secret.

The HTTP shape is the AWS JSON 1.1 protocol of the user pools API: one HTTPS `POST` to
`https://cognito-idp.<region>.amazonaws.com/` with `X-Amz-Target:
AWSCognitoIdentityProviderService.<Operation>`. The official SDK (boto3) was not added: it would
retry by default and pull in a large dependency for seven calls, while `httpx` is already used
for Azure. Every request has a finite total timeout, never follows redirects and is never
retried; a lost answer is reported as `UNAVAILABLE` and the caller decides what the user sees.

Passwords, codes and tokens only travel in request bodies over TLS. Nothing here logs a body,
an email address, a password, a code, a token or Cognito's error message: logs carry the
operation, the HTTP status, the AWS error type and the request id.
"""

import base64
import hashlib
import hmac
import json
import logging
from dataclasses import dataclass
from enum import StrEnum
from typing import Any, Protocol

import httpx
from pydantic import SecretStr

logger = logging.getLogger(__name__)

_MAX_RESPONSE_BYTES = 256 * 1024
NEW_PASSWORD_REQUIRED = "NEW_PASSWORD_REQUIRED"  # noqa: S105 (challenge name)


class CognitoErrorKind(StrEnum):
    # Wrong username/password, unknown or disabled user, expired/used sign-in session, revoked
    # access token (NotAuthorizedException, UserNotFoundException, ...). The caller decides
    # what that means in its step.
    NOT_AUTHORIZED = "not_authorized"
    # The new password breaks the pool's password policy.
    INVALID_PASSWORD = "invalid_password"  # noqa: S105 (an error kind, not a password)
    CODE_INVALID = "code_invalid"  # wrong or expired confirmation/verification code
    RATE_LIMITED = "rate_limited"  # Cognito throttling or per-user attempt limits
    INVALID_PARAMETER = "invalid_parameter"  # e.g. missing required attributes
    UNAVAILABLE = "unavailable"  # timeout, network, 5xx, unexpected answer, configuration


_KIND_BY_TYPE = {
    "NotAuthorizedException": CognitoErrorKind.NOT_AUTHORIZED,
    "UserNotFoundException": CognitoErrorKind.NOT_AUTHORIZED,
    "UserNotConfirmedException": CognitoErrorKind.NOT_AUTHORIZED,
    "PasswordResetRequiredException": CognitoErrorKind.NOT_AUTHORIZED,
    "ExpiredCodeException": CognitoErrorKind.CODE_INVALID,
    "CodeMismatchException": CognitoErrorKind.CODE_INVALID,
    "InvalidPasswordException": CognitoErrorKind.INVALID_PASSWORD,
    "PasswordHistoryPolicyViolationException": CognitoErrorKind.INVALID_PASSWORD,
    "TooManyRequestsException": CognitoErrorKind.RATE_LIMITED,
    "LimitExceededException": CognitoErrorKind.RATE_LIMITED,
    "TooManyFailedAttemptsException": CognitoErrorKind.RATE_LIMITED,
    "InvalidParameterException": CognitoErrorKind.INVALID_PARAMETER,
}


class CognitoError(Exception):
    """A failed Cognito call. `aws_type` is the AWS error type name (safe to log)."""

    def __init__(self, kind: CognitoErrorKind, aws_type: str) -> None:
        super().__init__(f"{kind.value} ({aws_type})")
        self.kind = kind
        self.aws_type = aws_type


@dataclass(frozen=True)
class AuthTokens:
    # Only the access token is used (for GetUser and email verification). ID and refresh
    # tokens are dropped as soon as the response is parsed.
    access_token: str


@dataclass(frozen=True)
class AuthChallengeStep:
    name: str
    session: str
    # The real username (Cognito's USER_ID_FOR_SRP); required to answer the challenge.
    username: str


@dataclass(frozen=True)
class CognitoUser:
    sub: str
    email: str
    email_verified: bool
    name: str | None


class CognitoClient(Protocol):
    def initiate_password_auth(
        self, email: str, password: str
    ) -> AuthTokens | AuthChallengeStep: ...

    def respond_new_password(
        self, username: str, session: str, new_password: str
    ) -> AuthTokens | AuthChallengeStep: ...

    def get_user(self, access_token: str) -> CognitoUser: ...

    def send_email_verification_code(self, access_token: str) -> str | None:
        """Ask Cognito to email a code; returns the masked destination if given."""
        ...

    def verify_email(self, access_token: str, code: str) -> None: ...

    def forgot_password(self, email: str) -> None: ...

    def confirm_forgot_password(self, email: str, code: str, new_password: str) -> None: ...


def secret_hash(client_secret: str, username: str, client_id: str) -> str:
    """Base64(HMAC-SHA256(client secret, username + client id)), per the Cognito guide."""
    digest = hmac.new(
        client_secret.encode("utf-8"), (username + client_id).encode("utf-8"), hashlib.sha256
    ).digest()
    return base64.b64encode(digest).decode("ascii")


class HttpCognitoClient:
    def __init__(
        self,
        *,
        region: str,
        client_id: str,
        client_secret: SecretStr | None,
        timeout_seconds: float,
        transport: httpx.BaseTransport | None = None,
    ) -> None:
        self._url = f"https://cognito-idp.{region}.amazonaws.com/"
        self._client_id = client_id
        self._client_secret = client_secret
        self._http = httpx.Client(
            timeout=httpx.Timeout(timeout_seconds),
            follow_redirects=False,
            transport=transport,
        )

    def close(self) -> None:
        self._http.close()

    # -- operations -------------------------------------------------------------------------

    def initiate_password_auth(self, email: str, password: str) -> AuthTokens | AuthChallengeStep:
        params = {"USERNAME": email, "PASSWORD": password}
        self._add_secret_hash(params, "SECRET_HASH", email)
        body = self._call(
            "InitiateAuth",
            {
                "AuthFlow": "USER_PASSWORD_AUTH",
                "ClientId": self._client_id,
                "AuthParameters": params,
            },
        )
        return _auth_outcome("InitiateAuth", body)

    def respond_new_password(
        self, username: str, session: str, new_password: str
    ) -> AuthTokens | AuthChallengeStep:
        responses = {"USERNAME": username, "NEW_PASSWORD": new_password}
        # The SECRET_HASH of a challenge answer uses the real username, not the email alias.
        self._add_secret_hash(responses, "SECRET_HASH", username)
        body = self._call(
            "RespondToAuthChallenge",
            {
                "ChallengeName": NEW_PASSWORD_REQUIRED,
                "ClientId": self._client_id,
                "Session": session,
                "ChallengeResponses": responses,
            },
        )
        return _auth_outcome("RespondToAuthChallenge", body)

    def get_user(self, access_token: str) -> CognitoUser:
        body = self._call("GetUser", {"AccessToken": access_token})
        attributes = body.get("UserAttributes")
        if not isinstance(attributes, list):
            raise _unexpected("GetUser")
        values: dict[str, str] = {}
        for item in attributes:
            if isinstance(item, dict) and isinstance(item.get("Name"), str):
                value = item.get("Value")
                if isinstance(value, str):
                    values[item["Name"]] = value
        sub, email = values.get("sub"), values.get("email")
        if not sub or not email:
            raise _unexpected("GetUser")
        return CognitoUser(
            sub=sub,
            email=email,
            email_verified=values.get("email_verified") == "true",
            name=values.get("name") or None,
        )

    def send_email_verification_code(self, access_token: str) -> str | None:
        body = self._call(
            "GetUserAttributeVerificationCode",
            {"AccessToken": access_token, "AttributeName": "email"},
        )
        details = body.get("CodeDeliveryDetails")
        if isinstance(details, dict) and isinstance(details.get("Destination"), str):
            return details["Destination"]
        return None

    def verify_email(self, access_token: str, code: str) -> None:
        self._call(
            "VerifyUserAttribute",
            {"AccessToken": access_token, "AttributeName": "email", "Code": code},
        )

    def forgot_password(self, email: str) -> None:
        payload: dict[str, Any] = {"ClientId": self._client_id, "Username": email}
        self._add_secret_hash(payload, "SecretHash", email)
        self._call("ForgotPassword", payload)

    def confirm_forgot_password(self, email: str, code: str, new_password: str) -> None:
        payload: dict[str, Any] = {
            "ClientId": self._client_id,
            "Username": email,
            "ConfirmationCode": code,
            "Password": new_password,
        }
        self._add_secret_hash(payload, "SecretHash", email)
        self._call("ConfirmForgotPassword", payload)

    # -- transport --------------------------------------------------------------------------

    def _add_secret_hash(self, target: dict[str, Any], key: str, username: str) -> None:
        if self._client_secret is not None:
            target[key] = secret_hash(
                self._client_secret.get_secret_value(), username, self._client_id
            )

    def _call(self, operation: str, payload: dict[str, Any]) -> dict[str, Any]:
        headers = {
            "Content-Type": "application/x-amz-json-1.1",
            "X-Amz-Target": f"AWSCognitoIdentityProviderService.{operation}",
        }
        try:
            with self._http.stream(
                "POST", self._url, content=json.dumps(payload), headers=headers
            ) as response:
                raw = b""
                for chunk in response.iter_bytes():
                    raw += chunk
                    if len(raw) > _MAX_RESPONSE_BYTES:
                        raise _unexpected(operation)
        except httpx.TimeoutException:
            logger.warning("Cognito %s timed out", operation)
            raise CognitoError(CognitoErrorKind.UNAVAILABLE, "Timeout") from None
        except httpx.HTTPError as exc:
            logger.warning("Cognito %s failed: %s", operation, type(exc).__name__)
            raise CognitoError(CognitoErrorKind.UNAVAILABLE, type(exc).__name__) from None

        request_id = response.headers.get("x-amzn-requestid", "-")
        if response.status_code == 200:
            try:
                body = json.loads(raw or b"{}")
            except ValueError:
                raise _unexpected(operation) from None
            if not isinstance(body, dict):
                raise _unexpected(operation)
            return body

        aws_type = _error_type(response.headers, raw)
        kind = CognitoErrorKind.UNAVAILABLE
        if 400 <= response.status_code < 500:
            kind = _KIND_BY_TYPE.get(aws_type, CognitoErrorKind.UNAVAILABLE)
        log = logger.info if kind is not CognitoErrorKind.UNAVAILABLE else logger.warning
        log(
            "Cognito %s rejected: status=%d type=%s request_id=%s",
            operation,
            response.status_code,
            aws_type,
            request_id,
        )
        raise CognitoError(kind, aws_type)


def _error_type(headers: httpx.Headers, raw: bytes) -> str:
    # The JSON body carries "__type" (sometimes prefixed with a namespace and "#"); the header
    # x-amzn-ErrorType carries "Type:..." as a fallback.
    candidate = ""
    try:
        body = json.loads(raw)
        if isinstance(body, dict) and isinstance(body.get("__type"), str):
            candidate = body["__type"]
    except ValueError:
        pass
    if not candidate:
        candidate = headers.get("x-amzn-errortype", "")
    name = candidate.split("#")[-1].split(":")[0].strip()
    return name if name.isidentifier() and len(name) <= 80 else "Unknown"


def _unexpected(operation: str) -> CognitoError:
    logger.warning("Cognito %s returned an unexpected answer", operation)
    return CognitoError(CognitoErrorKind.UNAVAILABLE, "UnexpectedResponse")


def _auth_outcome(operation: str, body: dict[str, Any]) -> AuthTokens | AuthChallengeStep:
    result = body.get("AuthenticationResult")
    if isinstance(result, dict):
        token = result.get("AccessToken")
        if isinstance(token, str) and token:
            return AuthTokens(access_token=token)
        raise _unexpected(operation)
    name, session = body.get("ChallengeName"), body.get("Session")
    params = body.get("ChallengeParameters")
    if isinstance(name, str) and isinstance(session, str) and session:
        username = params.get("USER_ID_FOR_SRP") if isinstance(params, dict) else None
        return AuthChallengeStep(
            name=name, session=session, username=username if isinstance(username, str) else ""
        )
    raise _unexpected(operation)
