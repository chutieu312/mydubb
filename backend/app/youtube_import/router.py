from fastapi import APIRouter, Depends, status
from sqlalchemy.orm import Session

from app.auth.principal import Principal
from app.dependencies import get_db, get_services, require_csrf
from app.errors import ApiError
from app.services import AppServices
from app.youtube_import.base import ImportFailure
from app.youtube_import.schemas import YouTubeImportRequest, YouTubeImportResponse

router = APIRouter(prefix="/api/transcripts", tags=["transcripts"])


@router.post("/youtube", response_model=YouTubeImportResponse)
def import_youtube_captions(
    body: YouTubeImportRequest,
    principal: Principal = Depends(require_csrf),
    db: Session = Depends(get_db),
    services: AppServices = Depends(get_services),
) -> YouTubeImportResponse:
    """Fetch the existing English captions of a video for the form. Creates no job.

    A sync handler: it runs in the server's thread pool, so waiting for the provider (and for
    the status polls of an asynchronous provider job) does not block the event loop.
    """
    importer = services.youtube_import
    if importer is None:
        failure = ImportFailure("youtube_import_disabled")
        raise ApiError(status.HTTP_404_NOT_FOUND, failure.code, failure.message)
    # The session check is done; give the connection back to the pool instead of holding it
    # while the provider answers.
    db.commit()
    try:
        track = importer.import_captions(body.video)
    except ImportFailure as exc:
        headers = {"Retry-After": str(exc.retry_after)} if exc.retry_after else None
        raise ApiError(exc.status_code, exc.code, exc.message, headers=headers) from None
    return YouTubeImportResponse.from_track(track, importer.provider.name)
