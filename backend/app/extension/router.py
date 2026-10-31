"""Connecting the MyDubb Chrome extension to an invited account (mounted with AUTH_MODE=cognito).

OAuth 2.0 Authorization Code with PKCE (S256) for a public client, run by MyDubb itself: the
extension opens /extension/connect on the website with `chrome.identity.launchWebAuthFlow`, the
user signs in there with the normal website sign-in and approves, the website asks
`POST /api/extension/authorize` for a one-time code and goes to the extension's redirect URI, and
the extension exchanges the code and its PKCE verifier for a bearer token
(`POST /api/extension/token`). The extension never sees a password, a cookie or a Cognito token.
Contract and reasons: docs/EXTENSION_AUTH.md.

The client is identified by its Chrome extension ID, which must be listed in EXTENSION_IDS, and
its only redirect URI is `https://<id>.chromiumapp.org/` (compared exactly). With EXTENSION_IDS
empty every endpoint here answers 404 extension_disabled.
"""

import base64
import hashlib
import hmac
import secrets
import uuid
from datetime import UTC, datetime, timedelta
from typing import Literal
from urllib.parse import urlencode

from fastapi import APIRouter, Depends, Response, status
from pydantic import BaseModel, Field
from sqlalchemy import update
from sqlalchemy.orm import Session

from app.auth.models import ExtensionAuthCode, UserSession
from app.auth.principal import Principal
from app.auth.service import open_extension_session, revoke_user_session, sha256_hex
from app.dependencies import get_db, get_services, require_csrf, require_extension_session
from app.errors import ApiError
from app.services import AppServices

router = APIRouter(prefix="/api/extension", tags=["extension"])

CODE_TTL = timedelta(minutes=2)
# RFC 7636: verifier 43-128 unreserved characters; an S256 challenge is 43 base64url characters.
_VERIFIER = r"^[A-Za-z0-9._~-]{43,128}$"
_CHALLENGE = r"^[A-Za-z0-9_-]{43}$"
_STATE = r"^[A-Za-z0-9._~-]{16,128}$"
_CLIENT_ID = r"^[a-p]{32}$"
INVALID_GRANT_MESSAGE = (
    "This connection attempt expired or was already used. Choose Connect in the extension again."
)


def redirect_uri_for(client_id: str) -> str:
    """The only redirect URI of an extension: Chrome's per-extension launchWebAuthFlow host."""
    return f"https://{client_id}.chromiumapp.org/"


def _s256(verifier: str) -> str:
    digest = hashlib.sha256(verifier.encode("ascii")).digest()
    return base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")


def _require_enabled(services: AppServices) -> None:
    if not services.settings.extension_ids:
        raise ApiError(
            status.HTTP_404_NOT_FOUND,
            "extension_disabled",
            "Connecting the Chrome extension is not enabled on this server.",
        )


def _check_client(services: AppServices, client_id: str, redirect_uri: str) -> None:
    if client_id not in services.settings.extension_ids:
        raise ApiError(
            status.HTTP_400_BAD_REQUEST,
            "extension_unknown",
            "This extension is not allowed to connect to MyDubb.",
        )
    if redirect_uri != redirect_uri_for(client_id):
        raise ApiError(
            status.HTTP_400_BAD_REQUEST,
            "redirect_uri_mismatch",
            "The extension's return address is not the one registered for it.",
        )


class AuthorizeRequest(BaseModel):
    client_id: str = Field(pattern=_CLIENT_ID)
    redirect_uri: str = Field(max_length=100)
    state: str = Field(pattern=_STATE)
    code_challenge: str = Field(pattern=_CHALLENGE)
    code_challenge_method: Literal["S256"]


class AuthorizeResponse(BaseModel):
    # Where the website goes next: the extension's redirect URI with `code` and `state`.
    redirect_url: str


@router.post("/authorize", response_model=AuthorizeResponse)
def authorize(
    body: AuthorizeRequest,
    principal: Principal = Depends(require_csrf),
    db: Session = Depends(get_db),
    services: AppServices = Depends(get_services),
) -> AuthorizeResponse:
    """The signed-in website user approves the extension (website session + CSRF + Origin)."""
    _require_enabled(services)
    _check_client(services, body.client_id, body.redirect_uri)
    if principal.user is None or principal.bearer:  # an account's website session only
        raise ApiError(status.HTTP_403_FORBIDDEN, "forbidden", "Sign in on the website first.")
    web = db.get(UserSession, principal.session_id)
    assert web is not None  # the session was just resolved in this transaction
    code = secrets.token_urlsafe(32)
    now = datetime.now(UTC)
    db.add(
        ExtensionAuthCode(
            id=uuid.uuid4(),
            code_hash=sha256_hex(code),
            user_id=principal.user.id,
            client_id=body.client_id,
            redirect_uri=body.redirect_uri,
            code_challenge=body.code_challenge,
            auth_started_at=web.auth_started_at,
            created_at=now,
            expires_at=now + CODE_TTL,
        )
    )
    query = urlencode({"code": code, "state": body.state})
    return AuthorizeResponse(redirect_url=f"{body.redirect_uri}?{query}")


class TokenRequest(BaseModel):
    grant_type: Literal["authorization_code"]
    client_id: str = Field(pattern=_CLIENT_ID)
    redirect_uri: str = Field(max_length=100)
    code: str = Field(min_length=1, max_length=100)
    code_verifier: str = Field(pattern=_VERIFIER)


class ExtensionUser(BaseModel):
    id: uuid.UUID
    email: str
    display_name: str | None


class TokenResponse(BaseModel):
    access_token: str
    token_type: Literal["Bearer"] = "Bearer"  # noqa: S105 (a scheme name)
    expires_at: datetime
    user: ExtensionUser


class ExtensionSessionResponse(BaseModel):
    user: ExtensionUser
    expires_at: datetime


def _invalid_grant() -> ApiError:
    return ApiError(status.HTTP_400_BAD_REQUEST, "invalid_grant", INVALID_GRANT_MESSAGE)


@router.post("/token", response_model=TokenResponse)
def token(
    body: TokenRequest,
    db: Session = Depends(get_db),
    services: AppServices = Depends(get_services),
) -> TokenResponse:
    """Exchange a code for an extension token. The code is consumed by the first attempt, also
    when that attempt fails (wrong verifier, client or redirect URI), so it can never be tried
    twice; every failure gives the same answer."""
    _require_enabled(services)
    _check_client(services, body.client_id, body.redirect_uri)
    now = datetime.now(UTC)
    code = db.scalars(
        update(ExtensionAuthCode)
        .where(
            ExtensionAuthCode.code_hash == sha256_hex(body.code),
            ExtensionAuthCode.consumed_at.is_(None),
            ExtensionAuthCode.expires_at > now,
        )
        .values(consumed_at=now)
        .returning(ExtensionAuthCode)
    ).one_or_none()
    # The consumption is kept even when the request is refused below.
    db.commit()
    if code is None:
        raise _invalid_grant()
    matches = (
        hmac.compare_digest(code.client_id, body.client_id)
        and hmac.compare_digest(code.redirect_uri, body.redirect_uri)
        and hmac.compare_digest(code.code_challenge, _s256(body.code_verifier))
    )
    if not matches:
        raise _invalid_grant()
    settings = services.settings
    ttl = min(settings.extension_session_ttl_seconds, settings.session_ttl_seconds)
    opened = open_extension_session(
        db, user_id=code.user_id, auth_started_at=code.auth_started_at, ttl_seconds=ttl
    )
    if opened is None:
        # Disabled, signed out everywhere or password reset since the approval.
        raise _invalid_grant()
    user, issued = opened
    return TokenResponse(
        access_token=issued.token,
        expires_at=issued.expires_at,
        user=ExtensionUser(id=user.id, email=user.email, display_name=user.display_name),
    )


@router.get("/session", response_model=ExtensionSessionResponse)
def session(principal: Principal = Depends(require_extension_session)) -> ExtensionSessionResponse:
    """Whether the extension's token is still valid, and whose it is."""
    assert principal.user is not None
    user = principal.user
    return ExtensionSessionResponse(
        user=ExtensionUser(id=user.id, email=user.email, display_name=user.display_name),
        expires_at=principal.expires_at,
    )


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
def logout(
    principal: Principal = Depends(require_extension_session),
    db: Session = Depends(get_db),
) -> Response:
    """Ends this extension token only (the website session is not touched)."""
    revoke_user_session(db, principal.session_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
