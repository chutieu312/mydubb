"""FastAPI dependencies shared by routers: services, DB session, session auth, CSRF."""

import hmac
from collections.abc import Iterator

from fastapi import Depends, Request, status
from sqlalchemy.orm import Session

from app.access.models import AccessSession
from app.access.service import find_active_session
from app.errors import ApiError, not_authenticated
from app.services import AppServices

SESSION_COOKIE = "mydubb_session"
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


def require_session(request: Request, db: Session = Depends(get_db)) -> AccessSession:
    token = request.cookies.get(SESSION_COOKIE)
    if not token:
        raise not_authenticated()
    record = find_active_session(db, token)
    if record is None:
        # Expired, revoked (logged out) or unknown sessions are all rejected the same way.
        raise not_authenticated()
    return record


def require_csrf(
    request: Request, session: AccessSession = Depends(require_session)
) -> AccessSession:
    """Synchronizer-token CSRF check for state-changing requests made with a session."""
    submitted = request.headers.get(CSRF_HEADER, "")
    if not submitted or not hmac.compare_digest(submitted, session.csrf_token):
        raise ApiError(status.HTTP_403_FORBIDDEN, "csrf_failed", "CSRF validation failed.")
    return session


def client_key(request: Request) -> str:
    # With uvicorn --proxy-headers and a trusted proxy, client.host is the real client IP.
    return request.client.host if request.client else "unknown"
