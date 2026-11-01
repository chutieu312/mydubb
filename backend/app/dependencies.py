"""FastAPI dependencies shared by routers: services, DB session, session auth, CSRF, and the
Chrome extension's bearer token."""

import hmac
import logging
from collections.abc import Iterator

from fastapi import Depends, Request, status
from sqlalchemy.orm import Session

from app.access.service import find_active_session
from app.auth.models import SessionClient, UserRole
from app.auth.principal import Principal, UserProfile
from app.auth.service import find_active_user_session
from app.config import AuthMode
from app.errors import ApiError, not_authenticated
from app.guest.service import find_active_session as find_active_guest_session
from app.services import AppServices

logger = logging.getLogger(__name__)

SESSION_COOKIE = "mydubb_session"
# Cognito-mode session cookie. A different name from the Access Code cookie, and a different
# table: neither mode can ever accept the other's session.
AUTH_COOKIE = "mydubb_auth"
# Guest session cookie ("Try as guest"); its own name and table, so a guest session can never be
# taken for an account session or the other way round.
GUEST_COOKIE = "mydubb_guest"
CSRF_HEADER = "X-CSRF-Token"
# The Chrome extension's token (docs/EXTENSION_AUTH.md): `Authorization: Bearer <token>`.
_BEARER_PREFIX = "bearer "
_MAX_BEARER_TOKEN = 100


def get_services(request: Request) -> AppServices:
    return request.app.state.services


def get_db(services: AppServices = Depends(get_services)) -> Iterator[Session]:
    db = services.session_factory()
    try:
        yield db
        db.commit()
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


def account_principal(request: Request, db: Session, services: AppServices) -> Principal | None:
    """The caller's account (Cognito) or Access Code session, or None."""
    if services.settings.auth_mode is AuthMode.COGNITO:
        token = request.cookies.get(AUTH_COOKIE)
        found = find_active_user_session(db, token) if token else None
        if found is None:
            # Expired, revoked, logged out, unknown, or the user is disabled in MyDubb.
            return None
        session, user = found
        return Principal(
            session_id=session.id,
            csrf_token=session.csrf_token,
            expires_at=session.expires_at,
            user=UserProfile(id=user.id, email=user.email, display_name=user.display_name),
            is_admin=user.role == UserRole.ADMIN.value,
        )
    token = request.cookies.get(SESSION_COOKIE)
    record = find_active_session(db, token) if token else None
    if record is None:
        # Expired, revoked (logged out) or unknown sessions are all rejected the same way.
        return None
    return Principal(
        session_id=record.id, csrf_token=record.csrf_token, expires_at=record.expires_at
    )


def guest_principal(request: Request, db: Session, services: AppServices) -> Principal | None:
    """The caller's guest session, or None (also whenever guest access is off)."""
    if services.guest is None:
        return None
    token = request.cookies.get(GUEST_COOKIE)
    record = find_active_guest_session(db, token) if token else None
    if record is None:
        return None
    return Principal(
        session_id=record.id,
        csrf_token=record.csrf_token,
        expires_at=record.expires_at,
        guest=True,
    )


def extension_principal(request: Request, db: Session, services: AppServices) -> Principal | None:
    """The caller's extension session from the Authorization header, or None (also whenever no
    extension is configured). Cookies are never looked at here."""
    if not services.settings.extension_ids:
        return None
    header = request.headers.get("authorization", "")
    if not header.lower().startswith(_BEARER_PREFIX):
        return None
    token = header[len(_BEARER_PREFIX) :].strip()
    if not token or len(token) > _MAX_BEARER_TOKEN:
        return None
    found = find_active_user_session(db, token, SessionClient.EXTENSION)
    if found is None:
        return None
    session, user = found
    return Principal(
        session_id=session.id,
        csrf_token=session.csrf_token,
        expires_at=session.expires_at,
        user=UserProfile(id=user.id, email=user.email, display_name=user.display_name),
        bearer=True,
    )


def _check_csrf(request: Request, principal: Principal) -> Principal:
    submitted = request.headers.get(CSRF_HEADER, "")
    if not submitted or not hmac.compare_digest(submitted, principal.csrf_token):
        raise ApiError(status.HTTP_403_FORBIDDEN, "csrf_failed", "CSRF validation failed.")
    return principal


def require_session(
    request: Request,
    db: Session = Depends(get_db),
    services: AppServices = Depends(get_services),
) -> Principal:
    """An account (or Access Code) session. A guest session is never accepted here."""
    principal = account_principal(request, db, services)
    if principal is None:
        raise not_authenticated()
    return principal


def require_csrf(request: Request, principal: Principal = Depends(require_session)) -> Principal:
    """Synchronizer-token CSRF check for state-changing requests made with a session."""
    return _check_csrf(request, principal)


def require_admin(request: Request, principal: Principal = Depends(require_session)) -> Principal:
    """Internal administration endpoints: the website session of a user whose role, read from the
    database by this request, is admin. So an expired or revoked session, a disabled user and a
    revoked role are all refused from the next request on. A request with an Authorization header
    is refused whatever its cookies are (an extension token never reaches administration)."""
    if "authorization" in request.headers:
        raise not_authenticated()
    if not principal.is_admin:
        raise ApiError(
            status.HTTP_403_FORBIDDEN, "admin_required", "This requires an administrator."
        )
    return principal


def require_admin_csrf(
    request: Request, principal: Principal = Depends(require_admin)
) -> Principal:
    return _check_csrf(request, principal)


def require_job_session(
    request: Request,
    db: Session = Depends(get_db),
    services: AppServices = Depends(get_services),
) -> Principal:
    """Job endpoints and the YouTube import: an account (or Access Code) session first, else a
    guest session. With both cookies the account wins (a sign-in also ends the guest session)."""
    principal = account_principal(request, db, services) or guest_principal(request, db, services)
    if principal is None:
        raise not_authenticated()
    return principal


def require_job_csrf(
    request: Request, principal: Principal = Depends(require_job_session)
) -> Principal:
    return _check_csrf(request, principal)


def require_job_access(
    request: Request,
    db: Session = Depends(get_db),
    services: AppServices = Depends(get_services),
) -> Principal:
    """The job endpoints: with an Authorization header, only the extension's bearer token (the
    cookies are then ignored, so a request never mixes the two); otherwise the cookie sessions of
    `require_job_session`. A guest never has a bearer token."""
    if "authorization" in request.headers:
        principal = extension_principal(request, db, services)
        if principal is None:
            raise not_authenticated()
        return principal
    return require_job_session(request, db, services)


def require_job_access_csrf(
    request: Request, principal: Principal = Depends(require_job_access)
) -> Principal:
    # A bearer token is never attached by the browser on its own (unlike a cookie), so a request
    # carrying it cannot be forged cross-site: it needs no CSRF token.
    return principal if principal.bearer else _check_csrf(request, principal)


def require_extension_session(
    request: Request,
    db: Session = Depends(get_db),
    services: AppServices = Depends(get_services),
) -> Principal:
    """The extension's own endpoints: its bearer token only."""
    principal = extension_principal(request, db, services)
    if principal is None:
        raise not_authenticated()
    return principal


def require_guest_session(
    request: Request,
    db: Session = Depends(get_db),
    services: AppServices = Depends(get_services),
) -> Principal:
    """Guest endpoints: the caller's guest session only."""
    principal = guest_principal(request, db, services)
    if principal is None:
        raise not_authenticated()
    return principal


def require_guest_csrf(
    request: Request, principal: Principal = Depends(require_guest_session)
) -> Principal:
    return _check_csrf(request, principal)


_missing_ip_header_logged = False


def client_key(request: Request) -> str:
    """Client identity for brute-force protection.

    Prefers the configured CLIENT_IP_HEADER, which the edge proxy overwrites. The
    left-most X-Forwarded-For entry is not trustworthy on hosts whose proxy appends to a
    client-supplied header.
    """
    global _missing_ip_header_logged
    header = request.app.state.services.settings.client_ip_header
    if header:
        value = request.headers.get(header, "").split(",")[0].strip()
        if value:
            return value
        if not _missing_ip_header_logged:
            _missing_ip_header_logged = True
            logger.warning(
                "CLIENT_IP_HEADER %r is configured but absent; using peer address", header
            )
    return request.client.host if request.client else "unknown"
