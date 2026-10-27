"""Guest sessions ("Try as guest"). Contract: docs/API.md, "Guest access".

Always mounted: with guest access off every endpoint answers 404 `guest_access_disabled`, and
/api/meta tells the UI not to offer it. A guest may only start, read and end its own guest
session here, and create, poll and download its own jobs (jobs/router.py).
"""

import uuid
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, Request, Response, status
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.auth.principal import Principal
from app.dependencies import (
    GUEST_COOKIE,
    account_principal,
    get_db,
    get_services,
    guest_principal,
    require_guest_csrf,
    require_guest_session,
)
from app.errors import ApiError
from app.guest.access import GuestAccess
from app.guest.service import (
    GuestSessionsExhausted,
    QuotaStatus,
    quota_status,
    revoke_session,
    start_session,
)
from app.services import AppServices

router = APIRouter(prefix="/api/guest", tags=["guest"])


class GuestOut(BaseModel):
    id: uuid.UUID


class QuotaOut(BaseModel):
    # Completed jobs over the guest session's lifetime; jobs still processing hold a place.
    session_limit: int
    session_used: int
    session_in_progress: int
    session_remaining: int
    # Completed jobs of every guest session from the same client network in the sliding window.
    # The network fields are null when this request's network cannot be told.
    ip_limit: int
    ip_used: int | None
    ip_in_progress: int | None
    ip_remaining: int | None
    ip_window_seconds: int
    # When the network gets a place back, if it has none left now (null otherwise or unknown).
    ip_retry_after_seconds: int | None
    max_words: int

    @classmethod
    def build(cls, status_: QuotaStatus, guest: GuestAccess) -> "QuotaOut":
        return cls(
            session_limit=status_.session_limit,
            session_used=status_.session_used,
            session_in_progress=status_.session_in_progress,
            session_remaining=status_.session_remaining,
            ip_limit=status_.ip_limit,
            ip_used=status_.ip_used,
            ip_in_progress=status_.ip_in_progress,
            ip_remaining=status_.ip_remaining,
            ip_window_seconds=guest.policy.ip_window_seconds,
            ip_retry_after_seconds=status_.ip_retry_after_seconds,
            max_words=guest.policy.max_words,
        )


class GuestSessionResponse(BaseModel):
    status: str = "guest"
    guest: GuestOut
    # Required for POST /api/jobs and DELETE /api/guest/session; kept in memory by the UI.
    csrf_token: str
    expires_at: datetime
    quota: QuotaOut


def guest_access(services: AppServices = Depends(get_services)) -> GuestAccess:
    if services.guest is None:
        raise ApiError(
            status.HTTP_404_NOT_FOUND,
            "guest_access_disabled",
            "Guest access is not available on this server.",
        )
    return services.guest


def network_unknown() -> ApiError:
    # Never a shared fallback identity: that would merge unrelated guests into one quota.
    return ApiError(
        status.HTTP_503_SERVICE_UNAVAILABLE,
        "guest_network_unknown",
        "Guest access is not available right now because the server cannot identify your "
        "network. Please try again later, or sign in with your invitation.",
    )


def _response(
    db: Session, request: Request, principal: Principal, guest: GuestAccess
) -> GuestSessionResponse:
    assert principal.guest_session_id is not None
    status_ = quota_status(
        db,
        guest_session_id=principal.guest_session_id,
        ip_key=guest.network_key(request),
        policy=guest.policy,
    )
    return GuestSessionResponse(
        guest=GuestOut(id=principal.session_id),
        csrf_token=principal.csrf_token,
        expires_at=principal.expires_at,
        quota=QuotaOut.build(status_, guest),
    )


@router.post("/session", response_model=GuestSessionResponse)
def start_guest_session(
    request: Request,
    response: Response,
    guest: GuestAccess = Depends(guest_access),
    db: Session = Depends(get_db),
    services: AppServices = Depends(get_services),
) -> GuestSessionResponse:
    """Start a guest session, or return the browser's current one unchanged (never renewed, so
    asking again never resets its quota). No Azure call, no job."""
    if account_principal(request, db, services) is not None:
        raise ApiError(
            status.HTTP_409_CONFLICT,
            "already_signed_in",
            "You are already signed in. Sign out first to try MyDubb as a guest.",
        )
    current = guest_principal(request, db, services)
    if current is not None:
        return _response(db, request, current, guest)

    ip_key = guest.network_key(request)
    if ip_key is None:
        raise network_unknown()
    try:
        issued = start_session(db, ip_key=ip_key, policy=guest.policy)
    except GuestSessionsExhausted as exc:
        headers = {"Retry-After": str(exc.retry_after)} if exc.retry_after else None
        raise ApiError(
            status.HTTP_429_TOO_MANY_REQUESTS,
            "guest_sessions_exhausted",
            "Too many guest sessions were started recently from your network. Please try again "
            "later, or sign in with your invitation.",
            headers=headers,
            extra={"retry_after_seconds": exc.retry_after} if exc.retry_after else None,
        ) from None
    db.commit()
    max_age = max(1, int((issued.expires_at - datetime.now(UTC)).total_seconds()))
    response.set_cookie(
        GUEST_COOKIE,
        issued.token,
        max_age=max_age,
        httponly=True,
        secure=services.settings.cookie_secure,
        samesite="strict",
        path="/",
    )
    response.status_code = status.HTTP_201_CREATED
    principal = Principal(
        session_id=issued.id,
        csrf_token=issued.csrf_token,
        expires_at=issued.expires_at,
        guest=True,
    )
    return _response(db, request, principal, guest)


@router.get("/session", response_model=GuestSessionResponse)
def get_guest_session(
    request: Request,
    guest: GuestAccess = Depends(guest_access),
    principal: Principal = Depends(require_guest_session),
    db: Session = Depends(get_db),
) -> GuestSessionResponse:
    return _response(db, request, principal, guest)


@router.delete("/session", status_code=status.HTTP_204_NO_CONTENT)
def end_guest_session(
    response: Response,
    guest: GuestAccess = Depends(guest_access),
    principal: Principal = Depends(require_guest_csrf),
    db: Session = Depends(get_db),
    services: AppServices = Depends(get_services),
) -> None:
    """End the guest session. Its jobs are not moved anywhere; they stay unreachable."""
    revoke_session(db, principal.session_id)
    response.delete_cookie(
        GUEST_COOKIE,
        path="/",
        httponly=True,
        secure=services.settings.cookie_secure,
        samesite="strict",
    )
