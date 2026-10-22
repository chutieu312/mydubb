"""Application configuration loaded from environment variables.

All settings come from the environment (optionally a local `.env` file in development).
Invalid or unsafe combinations fail at startup instead of silently degrading.
"""

import tempfile
from enum import StrEnum
from pathlib import Path

from pydantic import Field, SecretStr, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class AppEnv(StrEnum):
    DEVELOPMENT = "development"
    TEST = "test"
    PRODUCTION = "production"


class ProviderMode(StrEnum):
    MOCK = "mock"
    AZURE = "azure"


class MockFailStage(StrEnum):
    NONE = "none"
    TRANSLATION = "translation"
    SPEECH = "speech"
    AUDIO = "audio"
    # Raises an unexpected (non-provider) exception to exercise internal-error masking.
    UNEXPECTED = "unexpected"


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
    mock_fail_stage: MockFailStage = MockFailStage.NONE
    # Artificial delay per mock stage so processing stages are observable in the UI.
    mock_stage_delay_seconds: float = Field(default=0.0, ge=0, le=30)

    session_ttl_seconds: int = Field(default=12 * 3600, ge=60)
    cookie_secure: bool = True
    # Extra origins allowed on state-changing requests (e.g. the Vite dev server).
    trusted_origins: list[str] = Field(default_factory=list)

    access_max_failures_per_client: int = Field(default=5, ge=1)
    access_max_failures_global: int = Field(default=50, ge=1)
    access_failure_window_seconds: int = Field(default=900, ge=1)

    job_max_concurrency: int = Field(default=2, ge=1)
    job_max_queued: int = Field(default=8, ge=0)

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
                "PROVIDER_MODE=azure is not implemented in Milestone 1; use PROVIDER_MODE=mock"
            )
        if self.app_env is AppEnv.PRODUCTION:
            if not self.cookie_secure:
                raise ValueError("COOKIE_SECURE must be true when APP_ENV=production")
            if self.provider_mode is ProviderMode.MOCK:
                raise ValueError("Mock providers are not allowed when APP_ENV=production")
            if self.mock_fail_stage is not MockFailStage.NONE:
                raise ValueError("MOCK_FAIL_STAGE is not allowed when APP_ENV=production")
            if len(self.access_code.get_secret_value()) < 16:
                raise ValueError("ACCESS_CODE must be at least 16 characters in production")
        return self

    @property
    def sqlalchemy_url(self) -> str:
        return to_sqlalchemy_url(self.database_url.get_secret_value())

    @property
    def is_mock_mode(self) -> bool:
        return self.provider_mode is ProviderMode.MOCK
