"""FastAPI dependencies shared by routers: services, DB session, session auth, CSRF."""

import hmac
import logging
from collections.abc import Iterator

from fastapi import Depends, Request, status
from sqlalchemy.orm import Session

from app.access.service import find_active_session
from app.auth.principal import Principal, UserProfile
from app.auth.service import find_active_user_session
from app.config import AuthMode
from app.errors import ApiError, not_authenticated
from app.services import AppServices

logger = logging.getLogger(__name__)

SESSION_COOKIE = "mydubb_session"
# Cognito-mode session cookie. A different name from the Access Code cookie, and a different
# table: neither mode can ever accept the other's session.
AUTH_COOKIE = "mydubb_auth"
CSRF_HEADER = "X-CSRF-Token"


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


def require_session(
    request: Request,
    db: Session = Depends(get_db),
    services: AppServices = Depends(get_services),
) -> Principal:
    if services.settings.auth_mode is AuthMode.COGNITO:
        token = request.cookies.get(AUTH_COOKIE)
        found = find_active_user_session(db, token) if token else None
        if found is None:
            # Expired, revoked, logged out, unknown, or the user is disabled in MyDubb.
            raise not_authenticated()
        session, user = found
        return Principal(
            session_id=session.id,
            csrf_token=session.csrf_token,
            expires_at=session.expires_at,
            user=UserProfile(id=user.id, email=user.email, display_name=user.display_name),
        )
    token = request.cookies.get(SESSION_COOKIE)
    if not token:
        raise not_authenticated()
    record = find_active_session(db, token)
    if record is None:
        # Expired, revoked (logged out) or unknown sessions are all rejected the same way.
        raise not_authenticated()
    return Principal(
        session_id=record.id, csrf_token=record.csrf_token, expires_at=record.expires_at
    )


def require_csrf(request: Request, principal: Principal = Depends(require_session)) -> Principal:
    """Synchronizer-token CSRF check for state-changing requests made with a session."""
    submitted = request.headers.get(CSRF_HEADER, "")
    if not submitted or not hmac.compare_digest(submitted, principal.csrf_token):
        raise ApiError(status.HTTP_403_FORBIDDEN, "csrf_failed", "CSRF validation failed.")
    return principal


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
