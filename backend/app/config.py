"""Application configuration loaded from environment variables.

All settings come from the environment (optionally a local `.env` file in development).
Invalid or unsafe combinations fail at startup instead of silently degrading.
"""

import re
import tempfile
from enum import StrEnum
from pathlib import Path
from urllib.parse import urlsplit

from pydantic import Field, SecretStr, ValidationError, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class AppEnv(StrEnum):
    DEVELOPMENT = "development"
    TEST = "test"
    PRODUCTION = "production"


class ProviderMode(StrEnum):
    MOCK = "mock"
    AZURE = "azure"


class TranslationProviderChoice(StrEnum):
    MOCK = "mock"
    AZURE = "azure"


DEFAULT_AZURE_TRANSLATOR_ENDPOINT = "https://api.cognitive.microsofttranslator.com"
# Azure Translator limit per request is 50,000 characters (service-limits documentation).
AZURE_TRANSLATOR_MAX_REQUEST_CHARS = 50_000


class MockFailStage(StrEnum):
    NONE = "none"
    TRANSLATION = "translation"
    SPEECH = "speech"
    AUDIO = "audio"
    # Raises an unexpected (non-provider) exception to exercise internal-error masking.
    UNEXPECTED = "unexpected"


_HEADER_VALUE = re.compile(r"[!-~]+")
_REGION = re.compile(r"[A-Za-z0-9-]{1,64}")
_SUPPORTED_DB_SCHEMES = ("postgresql+psycopg://", "postgresql://", "postgres://")


def to_sqlalchemy_url(url: str) -> str:
    """Normalize a PostgreSQL URL (e.g. from Neon) to the psycopg 3 SQLAlchemy driver."""
    if not url.startswith(_SUPPORTED_DB_SCHEMES):
        raise ValueError("DATABASE_URL must be a PostgreSQL URL (postgresql://...)")
    for scheme in ("postgresql://", "postgres://"):
        if url.startswith(scheme):
            return "postgresql+psycopg://" + url[len(scheme) :]
    return url


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    app_env: AppEnv
    database_url: SecretStr
    # Allows for serverless Postgres cold starts (e.g. Neon) without hanging indefinitely.
    db_connect_timeout_seconds: int = Field(default=10, ge=2, le=60)
    access_code: SecretStr

    provider_mode: ProviderMode
    # Explicit opt-in to run mock providers with APP_ENV=production (online mock beta).
    # Every other production security rule still applies.
    allow_mock_providers_in_production: bool = False
    # Translation can use Azure while speech and audio processing are still mock
    # (Milestone 3 in progress). PROVIDER_MODE=mock keeps meaning "mock everything" unless this
    # overrides the translation stage.
    translation_provider: TranslationProviderChoice = TranslationProviderChoice.MOCK
    mock_fail_stage: MockFailStage = MockFailStage.NONE
    # Artificial delay per mock stage so processing stages are observable in the UI.
    mock_stage_delay_seconds: float = Field(default=0.0, ge=0, le=30)

    # Azure Translator (only validated and used when TRANSLATION_PROVIDER=azure). The key is
    # a secret: it lives in the environment only and is never logged or sent to the browser.
    azure_translator_key: SecretStr | None = None
    # Region of the resource, sent as Ocp-Apim-Subscription-Region. Required for regional
    # resources; optional for a "global" resource.
    azure_translator_region: str | None = None
    azure_translator_endpoint: str = DEFAULT_AZURE_TRANSLATOR_ENDPOINT
    # Total time allowed for one HTTP request to the service (Microsoft: max latency 15 s).
    azure_translator_timeout_seconds: float = Field(default=30, ge=5, le=120)
    # Largest request, markup included. Lower than the service limit: Microsoft recommends
    # shorter requests, and a failed chunk fails the whole job.
    azure_translator_max_request_chars: int = Field(
        default=10_000, ge=500, le=AZURE_TRANSLATOR_MAX_REQUEST_CHARS
    )

    session_ttl_seconds: int = Field(default=12 * 3600, ge=60)
    cookie_secure: bool = True
    # Header set (overwritten) by the edge proxy with the real client IP, e.g.
    # "cf-connecting-ip". Used for Access Code brute-force protection. When unset or absent,
    # the connection peer (after uvicorn proxy-header handling) is used.
    client_ip_header: str | None = None
    # Extra origins allowed on state-changing requests (e.g. the Vite dev server).
    trusted_origins: list[str] = Field(default_factory=list)

    access_max_failures_per_client: int = Field(default=5, ge=1)
    access_max_failures_global: int = Field(default=50, ge=1)
    access_failure_window_seconds: int = Field(default=900, ge=1)

    job_max_concurrency: int = Field(default=2, ge=1)
    job_max_queued: int = Field(default=8, ge=0)
    # Each instance refreshes `heartbeat_at` on the active jobs it runs. Active jobs whose
    # heartbeat is older than `job_stale_after_seconds` are failed as interrupted, which is
    # safe while an old and a new instance overlap during a deploy.
    job_heartbeat_interval_seconds: int = Field(default=15, ge=1)
    job_stale_after_seconds: int = Field(default=90, ge=3)
    # On shutdown, wait up to this long for running jobs to finish before interrupting them.
    # Keep it below the host's shutdown delay (Render: maxShutdownDelaySeconds).
    job_shutdown_grace_seconds: float = Field(default=20, ge=0, le=280)

    result_ttl_seconds: int = Field(default=3600, ge=60)
    result_storage_dir: Path = Path(tempfile.gettempdir()) / "mydubb-results"
    cleanup_interval_seconds: int = Field(default=300, ge=5)

    # Resource guard for request bodies (protects a small single instance's memory).
    max_request_body_bytes: int = Field(default=10 * 1024 * 1024, ge=1024)

    frontend_dist_dir: Path | None = None
    log_level: str = "INFO"

    @field_validator("database_url")
    @classmethod
    def _require_postgresql(cls, value: SecretStr) -> SecretStr:
        url = value.get_secret_value()
        if not url.startswith(_SUPPORTED_DB_SCHEMES):
            # Never fall back to SQLite or another engine.
            raise ValueError("DATABASE_URL must be a PostgreSQL URL (postgresql://...)")
        return value

    @field_validator("access_code")
    @classmethod
    def _access_code_strength(cls, value: SecretStr) -> SecretStr:
        if len(value.get_secret_value()) < 8:
            raise ValueError("ACCESS_CODE must be at least 8 characters")
        return value

    @model_validator(mode="after")
    def _check_environment_rules(self) -> "Settings":
        if self.provider_mode is ProviderMode.AZURE:
            raise ValueError(
                "PROVIDER_MODE=azure is not implemented yet (Azure Speech and FFmpeg are "
                "pending); use PROVIDER_MODE=mock, optionally with TRANSLATION_PROVIDER=azure"
            )
        if self.translation_provider is TranslationProviderChoice.AZURE:
            self._check_azure_translator()
            if self.mock_fail_stage in (MockFailStage.TRANSLATION, MockFailStage.UNEXPECTED):
                raise ValueError(
                    "MOCK_FAIL_STAGE=translation/unexpected only applies to the mock "
                    "translation provider; unset it or use TRANSLATION_PROVIDER=mock"
                )
        if self.job_stale_after_seconds < 3 * self.job_heartbeat_interval_seconds:
            raise ValueError(
                "JOB_STALE_AFTER_SECONDS must be at least 3x JOB_HEARTBEAT_INTERVAL_SECONDS"
            )
        if self.app_env is AppEnv.PRODUCTION:
            if not self.cookie_secure:
                raise ValueError("COOKIE_SECURE must be true when APP_ENV=production")
            if self.provider_mode is ProviderMode.MOCK and not (
                self.allow_mock_providers_in_production
            ):
                raise ValueError(
                    "Mock providers are not allowed when APP_ENV=production unless "
                    "ALLOW_MOCK_PROVIDERS_IN_PRODUCTION=true"
                )
            if self.mock_fail_stage is not MockFailStage.NONE:
                raise ValueError("MOCK_FAIL_STAGE is not allowed when APP_ENV=production")
            if len(self.access_code.get_secret_value()) < 16:
                raise ValueError("ACCESS_CODE must be at least 16 characters in production")
        return self

    def _check_azure_translator(self) -> None:
        key = self.azure_translator_key.get_secret_value() if self.azure_translator_key else ""
        if not key:
            raise ValueError("AZURE_TRANSLATOR_KEY is required when TRANSLATION_PROVIDER=azure")
        if not _HEADER_VALUE.fullmatch(key):
            raise ValueError("AZURE_TRANSLATOR_KEY must be printable ASCII without spaces")
        if self.azure_translator_region is not None and not _REGION.fullmatch(
            self.azure_translator_region
        ):
            raise ValueError("AZURE_TRANSLATOR_REGION must be a region name such as westus2")
        parts = urlsplit(self.azure_translator_endpoint)
        if (
            parts.scheme != "https"
            or not parts.hostname
            or parts.username
            or parts.password
            or parts.query
            or parts.fragment
            or parts.path not in ("", "/")
        ):
            raise ValueError(
                "AZURE_TRANSLATOR_ENDPOINT must be an https URL with only a host, "
                "e.g. https://api.cognitive.microsofttranslator.com"
            )

    @property
    def sqlalchemy_url(self) -> str:
        return to_sqlalchemy_url(self.database_url.get_secret_value())

    @property
    def is_mock_mode(self) -> bool:
        """True while any component (speech, audio processing) is still a mock."""
        return self.provider_mode is ProviderMode.MOCK

    @property
    def component_providers(self) -> dict[str, str]:
        """Which implementation serves each pipeline stage (reported by /api/meta)."""
        return {
            "translation": self.translation_provider.value,
            # Azure Speech and FFmpeg arrive in later Milestone 3 pull requests.
            "speech": "mock",
            "audio": "mock",
        }


class ConfigurationError(RuntimeError):
    """Invalid configuration. The message never contains configured values."""


def load_settings() -> Settings:
    """Load settings from the environment, failing with a message safe for logs.

    Pydantic's default error text includes the rejected input (which may be a database
    password or the Access Code), so only field names and messages are reported.
    """
    try:
        return Settings()  # type: ignore[call-arg]
    except ValidationError as exc:
        problems = []
        for error in exc.errors(include_input=False, include_url=False, include_context=False):
            field = ".".join(str(part) for part in error["loc"]).upper() or "SETTINGS"
            message = str(error["msg"]).removeprefix("Value error, ")
            problems.append(f"{field}: {message}")
        raise ConfigurationError("Invalid configuration: " + "; ".join(problems)) from None
