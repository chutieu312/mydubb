from datetime import datetime

from fastapi import APIRouter, Depends, Request, Response, status
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.access.models import AccessSession
from app.access.service import access_code_matches, create_session, revoke_session
from app.auth.principal import Principal
from app.dependencies import (
    SESSION_COOKIE,
    client_key,
    get_db,
    get_services,
    require_csrf,
    require_session,
)
from app.errors import ApiError
from app.services import AppServices

router = APIRouter(prefix="/api/session", tags=["session"])


class LoginRequest(BaseModel):
    access_code: str


class SessionResponse(BaseModel):
    authenticated: bool
    csrf_token: str
    expires_at: datetime


@router.post("", response_model=SessionResponse)
def login(
    body: LoginRequest,
    request: Request,
    response: Response,
    db: Session = Depends(get_db),
    services: AppServices = Depends(get_services),
) -> SessionResponse:
    limiter = services.access_limiter
    client = client_key(request)
    retry_after = limiter.retry_after(client)
    if retry_after is not None:
        raise ApiError(
            status.HTTP_429_TOO_MANY_REQUESTS,
            "too_many_attempts",
            "Too many incorrect Access Code attempts. Please wait before trying again.",
            headers={"Retry-After": str(retry_after)},
            extra={"retry_after_seconds": retry_after},
        )
    settings = services.settings
    # This router is only mounted with AUTH_MODE=access_code, where the code is required.
    assert settings.access_code is not None
    if not access_code_matches(body.access_code, settings.access_code.get_secret_value()):
        limiter.record_failure(client)
        raise ApiError(
            status.HTTP_401_UNAUTHORIZED, "invalid_access_code", "The Access Code is incorrect."
        )

    issued = create_session(db, settings.session_ttl_seconds)
    response.set_cookie(
        SESSION_COOKIE,
        issued.token,
        max_age=settings.session_ttl_seconds,
        httponly=True,
        secure=settings.cookie_secure,
        samesite="strict",
        path="/",
    )
    return SessionResponse(
        authenticated=True, csrf_token=issued.csrf_token, expires_at=issued.expires_at
    )


@router.get("", response_model=SessionResponse)
def current_session(principal: Principal = Depends(require_session)) -> SessionResponse:
    return SessionResponse(
        authenticated=True, csrf_token=principal.csrf_token, expires_at=principal.expires_at
    )


@router.delete("", status_code=status.HTTP_204_NO_CONTENT)
def logout(
    response: Response,
    principal: Principal = Depends(require_csrf),
    db: Session = Depends(get_db),
    services: AppServices = Depends(get_services),
) -> None:
    # The row was loaded through the same request-scoped DB session as `db`.
    session = db.get(AccessSession, principal.session_id)
    if session is not None:
        revoke_session(db, session)
    response.delete_cookie(
        SESSION_COOKIE,
        path="/",
        httponly=True,
        secure=services.settings.cookie_secure,
        samesite="strict",
    )
