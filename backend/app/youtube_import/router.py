import uuid

from fastapi import APIRouter, Depends, Request, status
from fastapi.concurrency import run_in_threadpool
from sqlalchemy.orm import Session

from app.auth.principal import Principal
from app.dependencies import get_db, get_services, require_job_csrf
from app.errors import ApiError, not_authenticated
from app.guest.access import GuestAccess
from app.guest.imports import (
    GuestImportQuotaExceeded,
    ImportNotRecorded,
    ImportsStopped,
    reserve_import,
)
from app.guest.router import network_unknown
from app.guest.service import GuestSessionGone
from app.services import AppServices
from app.youtube_import.base import ImportFailure
from app.youtube_import.schemas import YouTubeImportRequest, YouTubeImportResponse
from app.youtube_import.service import YouTubeImporter

router = APIRouter(prefix="/api/transcripts", tags=["transcripts"])


@router.post("/youtube", response_model=YouTubeImportResponse)
async def import_youtube_captions(
    body: YouTubeImportRequest,
    request: Request,
    # An account, or a guest session (with its own import quota, docs/GUEST_ACCESS.md).
    principal: Principal = Depends(require_job_csrf),
    db: Session = Depends(get_db),
    services: AppServices = Depends(get_services),
) -> YouTubeImportResponse:
    """Fetch the existing English captions of a video for the form. Creates no job.

    An async handler: the provider's network I/O is awaited (it never blocks the event loop) and
    can be cancelled at the import's deadline; blocking work (the session check, the database,
    the rate limiter, parsing) runs in threads. The session and CSRF dependencies run first.
    """
    importer = services.youtube_import
    if importer is None:
        failure = ImportFailure("youtube_import_disabled")
        raise ApiError(status.HTTP_404_NOT_FOUND, failure.code, failure.message)
    # The session check is done; give the connection back to the pool instead of holding it
    # while the provider answers.
    await run_in_threadpool(db.commit)
    try:
        if principal.guest:
            return await _guest_import(body, request, principal, importer, services)
        track = await importer.import_captions(body.video)
    except ImportFailure as exc:
        raise _failure(exc) from None
    return YouTubeImportResponse.from_track(track, importer.provider.name)


async def _guest_import(
    body: YouTubeImportRequest,
    request: Request,
    principal: Principal,
    importer: YouTubeImporter,
    services: AppServices,
) -> YouTubeImportResponse:
    """A guest import: admitted, reserved in the import quota, run and settled exactly once.

    Refused before the provider is called, writing nothing: an unknown network, a full server
    (`youtube_import_busy`), no import left. The operation itself runs in a task the request
    cannot cancel (guest/imports.py), so a client that goes away does not undo a success.
    """
    guest = services.guest
    runner = services.guest_imports
    assert guest is not None and runner is not None  # a guest principal needs guest access
    guest_session_id = principal.guest_session_id
    assert guest_session_id is not None
    ip_key = guest.network_key(request)
    if ip_key is None:
        raise network_unknown()
    video = body.video
    slot = importer.admit()

    def reserve(db: Session) -> uuid.UUID:
        # Run by the import runner in its own bounded transaction.
        return reserve_import(
            db,
            guest_session_id=guest_session_id,
            ip_key=ip_key,
            policy=guest.policy,
            runner_id=services.instance_id,
        )

    async def work() -> YouTubeImportResponse:
        track = await importer.provider.english_captions(video)
        # The response is built (the transcript written and checked) before it counts as used.
        return YouTubeImportResponse.from_track(track, importer.provider.name)

    try:
        return await runner.run(reserve, work, on_done=slot.release)
    except GuestImportQuotaExceeded as exc:
        raise _quota_error(exc, guest) from None
    except GuestSessionGone:
        raise not_authenticated() from None
    except ImportNotRecorded:
        raise _failure(ImportFailure("youtube_import_not_recorded")) from None
    except ImportsStopped:
        # Application shutdown (not the client): stopped, and its place given back.
        raise _failure(ImportFailure("youtube_import_cancelled")) from None


def _failure(exc: ImportFailure) -> ApiError:
    headers = {"Retry-After": str(exc.retry_after)} if exc.retry_after else None
    return ApiError(exc.status_code, exc.code, exc.message, headers=headers)


def _quota_error(exc: GuestImportQuotaExceeded, guest: GuestAccess) -> ApiError:
    policy = guest.policy
    running = f" ({exc.in_flight} still running)" if exc.in_flight else ""
    if exc.scope == "session":
        return ApiError(
            status.HTTP_429_TOO_MANY_REQUESTS,
            "guest_import_session_quota_exhausted",
            f"This guest session has used all {policy.imports_per_session} of its YouTube "
            f"imports{running}. You can still paste a transcript, or sign in with your "
            "invitation.",
            extra={"limit": policy.imports_per_session},
        )
    hours = policy.ip_window_seconds / 3600
    headers = {"Retry-After": str(exc.retry_after)} if exc.retry_after else None
    extra: dict = {"limit": policy.imports_per_ip, "window_seconds": policy.ip_window_seconds}
    if exc.retry_after:
        extra["retry_after_seconds"] = exc.retry_after
    return ApiError(
        status.HTTP_429_TOO_MANY_REQUESTS,
        "guest_import_ip_quota_exhausted",
        f"Guests on your network have used all {policy.imports_per_ip} YouTube imports allowed "
        f"in {hours:g} hours{running}; everyone on the same network shares this limit. You can "
        "still paste a transcript, or sign in with your invitation.",
        headers=headers,
        extra=extra,
    )
