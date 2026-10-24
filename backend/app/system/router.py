from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse

from app.config import AuthMode
from app.db import check_database
from app.dependencies import get_services
from app.services import AppServices
from app.speech.voices import Voice

router = APIRouter(prefix="/api", tags=["system"])


@router.get("/health")
def health() -> dict[str, str]:
    """Liveness: the process is up. Does not touch dependencies."""
    return {"status": "ok"}


@router.get("/ready")
def ready(services: AppServices = Depends(get_services)) -> JSONResponse:
    """Readiness: the database is reachable. Never returns connection details."""
    if check_database(services.engine):
        return JSONResponse({"status": "ready", "checks": {"database": "ok"}})
    return JSONResponse(
        {"status": "not_ready", "checks": {"database": "unavailable"}}, status_code=503
    )


@router.get("/meta")
def meta(services: AppServices = Depends(get_services)) -> dict:
    """Public, non-sensitive configuration the UI needs before login."""
    settings = services.settings
    return {
        "provider_mode": settings.effective_provider_mode.value,
        "mock_mode": settings.is_mock_mode,
        # Implementation behind each pipeline stage, so the UI labels every component.
        "providers": settings.component_providers,
        "voices": [
            {
                "id": v.value,
                "label": v.label,
                "provider_voice": v.azure_voice_name,
                "description": v.description,
            }
            for v in Voice
        ],
        "timestamp_format": "HH:MM:SS",
        "result_ttl_seconds": settings.result_ttl_seconds,
        # Which login UI to show. Accounts are created by an administrator: no sign-up.
        "auth": {
            "mode": settings.auth_mode.value,
            "self_registration": False,
            "password_reset": settings.auth_mode is AuthMode.COGNITO,
        },
    }
