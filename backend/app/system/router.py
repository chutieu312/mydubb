from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse

from app.config import AuthMode
from app.db import check_database
from app.dependencies import get_services
from app.languages import DEFAULT_TARGET_LANGUAGE, TargetLanguage
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


def _guest_access(services: AppServices) -> dict:
    if services.guest is None:
        return {"enabled": False}
    policy = services.guest.policy
    return {
        "enabled": True,
        "jobs_per_session": policy.jobs_per_session,
        "jobs_per_ip": policy.jobs_per_ip,
        "ip_window_seconds": policy.ip_window_seconds,
        "max_words": policy.max_words,
        "max_output_seconds": policy.max_output_seconds,
        "session_ttl_seconds": policy.session_ttl_seconds,
        # YouTube imports (offered to guests when `youtube_import.enabled`); not jobs.
        "imports_per_session": policy.imports_per_session,
        "imports_per_ip": policy.imports_per_ip,
    }


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
        # Output languages a job can choose (`target_language`), the first being the default. The
        # service codes are informative only: requests send the `id`, never a locale.
        "target_languages": [
            {
                "id": language.value,
                "label": language.label,
                "noun": language.noun,
                "translator_language": language.translator_code,
                "speech_locale": language.speech_locale,
            }
            for language in TargetLanguage
        ],
        "default_target_language": DEFAULT_TARGET_LANGUAGE.value,
        "timestamp_format": "HH:MM:SS",
        # Whether the form offers "YouTube URL" next to pasting, and which provider serves it.
        "youtube_import": {
            "enabled": services.youtube_import is not None,
            "provider": (
                services.youtube_import.provider.name if services.youtube_import else None
            ),
        },
        # "Try as guest": whether the sign-in screen offers it, and the limits a guest sees.
        "guest_access": _guest_access(services),
        "result_ttl_seconds": settings.result_ttl_seconds,
        # Which login UI to show. Accounts are created by an administrator: no sign-up.
        "auth": {
            "mode": settings.auth_mode.value,
            "self_registration": False,
            "password_reset": settings.auth_mode is AuthMode.COGNITO,
        },
    }
