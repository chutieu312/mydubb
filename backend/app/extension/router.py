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

Guests ("Try as guest" in the extension, EXTENSION_GUEST_ENABLED): the same flow, approved on the
website by its guest session (`POST /api/extension/guest/authorize`) instead of an account. The
token is then a guest token of that very guest session, so the website and the extension share
its jobs and quotas; the server finds the session from the code, never from the request.
"""

import base64
import hashlib
import hmac
import secrets
import uuid
from datetime import UTC, datetime, timedelta
from typing import Literal
from urllib.parse import urlencode

from fastapi import APIRouter, Depends, Request, Response, status
from pydantic import BaseModel, Field
from sqlalchemy import update
from sqlalchemy.orm import Session

from app.auth.models import ExtensionAuthCode, UserSession
from app.auth.principal import Principal
from app.auth.service import open_extension_session, revoke_user_session, sha256_hex
from app.dependencies import (
    account_principal,
    get_db,
    get_services,
    require_csrf,
    require_extension_session,
    require_guest_csrf,
)
from app.errors import ApiError
from app.guest.models import GuestSession
from app.guest.router import QuotaOut
from app.guest.service import issue_extension_token, quota_status, revoke_extension_token
from app.quotas.router import AccountUsageResponse, usage_response
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


def _require_guest_enabled(services: AppServices) -> None:
    if services.guest is None or not services.settings.extension_guest_active:
        raise ApiError(
            status.HTTP_404_NOT_FOUND,
            "extension_guest_disabled",
            "Trying MyDubb as a guest in the Chrome extension is not available on this server.",
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


@router.post("/guest/authorize", response_model=AuthorizeResponse)
def authorize_guest(
    body: AuthorizeRequest,
    request: Request,
    principal: Principal = Depends(require_guest_csrf),
    db: Session = Depends(get_db),
    services: AppServices = Depends(get_services),
) -> AuthorizeResponse:
    """The website's guest session lets the extension continue it (guest cookie + CSRF + Origin).
    No new guest session, no quota and no job: the code only names this guest session."""
    _require_enabled(services)
    _require_guest_enabled(services)
    _check_client(services, body.client_id, body.redirect_uri)
    if account_principal(request, db, services) is not None:
        # Signing in ends the guest session; an account connects with Connect instead.
        raise ApiError(
            status.HTTP_409_CONFLICT,
            "already_signed_in",
            "You are signed in to an account. Choose Connect to MyDubb in the extension instead.",
        )
    guest_session = db.get(GuestSession, principal.session_id)
    assert guest_session is not None  # the session was just resolved in this transaction
    code = secrets.token_urlsafe(32)
    now = datetime.now(UTC)
    db.add(
        ExtensionAuthCode(
            id=uuid.uuid4(),
            code_hash=sha256_hex(code),
            guest_session_id=guest_session.id,
            client_id=body.client_id,
            redirect_uri=body.redirect_uri,
            code_challenge=body.code_challenge,
            auth_started_at=guest_session.created_at,
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


class ExtensionGuest(BaseModel):
    # The guest session (the same id the website's GET /api/guest/session reports).
    id: uuid.UUID


class TokenResponse(BaseModel):
    access_token: str
    token_type: Literal["Bearer"] = "Bearer"  # noqa: S105 (a scheme name)
    expires_at: datetime
    # "account": `user` is set; "guest": `guest` is set and `user` is null.
    kind: Literal["account", "guest"] = "account"
    user: ExtensionUser | None
    guest: ExtensionGuest | None = None


class ExtensionSessionResponse(BaseModel):
    kind: Literal["account", "guest"] = "account"
    user: ExtensionUser | None
    guest: ExtensionGuest | None = None
    expires_at: datetime
    # Today's usage limits of the account (as GET /api/account/usage), or the guest session's job
    # quota (as GET /api/guest/session `quota`). Read only: every admission is decided on its own.
    usage: AccountUsageResponse | None = None
    quota: QuotaOut | None = None


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
    if code.guest_session_id is not None:
        if services.guest is None or not settings.extension_guest_active:
            raise _invalid_grant()
        issued_guest = issue_extension_token(
            db, guest_session_id=code.guest_session_id, client_id=code.client_id, ttl_seconds=ttl
        )
        if issued_guest is None:
            # The guest session ended or expired since the approval.
            raise _invalid_grant()
        return TokenResponse(
            access_token=issued_guest.token,
            expires_at=issued_guest.expires_at,
            kind="guest",
            user=None,
            guest=ExtensionGuest(id=issued_guest.guest_session_id),
        )
    if code.user_id is None:  # never: the CHECK constraint gives every code one owner
        raise _invalid_grant()
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
def session(
    request: Request,
    response: Response,
    principal: Principal = Depends(require_extension_session),
    db: Session = Depends(get_db),
    services: AppServices = Depends(get_services),
) -> ExtensionSessionResponse:
    """Whether the extension's token is still valid, whose it is, and its usage limits."""
    response.headers["Cache-Control"] = "no-store"
    if principal.guest:
        guest = services.guest
        assert guest is not None  # a guest token is accepted only with guest access on
        status_ = quota_status(
            db,
            guest_session_id=principal.session_id,
            ip_key=guest.network_key(request),
            policy=guest.policy,
        )
        return ExtensionSessionResponse(
            kind="guest",
            user=None,
            guest=ExtensionGuest(id=principal.session_id),
            expires_at=principal.expires_at,
            quota=QuotaOut.build(status_, guest),
        )
    assert principal.user is not None
    user = principal.user
    return ExtensionSessionResponse(
        user=ExtensionUser(id=user.id, email=user.email, display_name=user.display_name),
        expires_at=principal.expires_at,
        usage=usage_response(db, principal),
    )


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
def logout(
    principal: Principal = Depends(require_extension_session),
    db: Session = Depends(get_db),
) -> Response:
    """Ends this extension token only: the website session, or the guest session, is not
    touched."""
    if principal.guest:
        assert principal.bearer_token_id is not None
        revoke_extension_token(db, principal.bearer_token_id)
    else:
        revoke_user_session(db, principal.session_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
