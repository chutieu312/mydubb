"""Application configuration loaded from environment variables.

All settings come from the environment (optionally a local `.env` file in development).
Invalid or unsafe combinations fail at startup instead of silently degrading.
"""

import base64
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


class SpeechProviderChoice(StrEnum):
    MOCK = "mock"
    AZURE = "azure"


class AudioProcessorChoice(StrEnum):
    MOCK = "mock"
    FFMPEG = "ffmpeg"


class YouTubeImportChoice(StrEnum):
    # Importing the existing English captions of a YouTube video into the form. Off by default:
    # pasting a transcript works the same with or without it.
    OFF = "off"
    SUPADATA = "supadata"
    # Fixed captions for development and the browser E2E suite; never reaches the network.
    MOCK = "mock"


class AuthMode(StrEnum):
    # The Private Beta Access Code (default) or Amazon Cognito email/password accounts. The two are
    # exclusive: each mode serves only its own login endpoints and accepts only its own sessions.
    ACCESS_CODE = "access_code"
    COGNITO = "cognito"


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
# Speech region identifiers (e.g. westus2) become part of the host name, so they stay strict.
_SPEECH_REGION = re.compile(r"[a-z0-9]{2,30}")
_SUPPORTED_DB_SCHEMES = ("postgresql+psycopg://", "postgresql://", "postgres://")
# AWS region names (e.g. us-west-2) become part of the Cognito host name, so they stay strict.
_AWS_REGION = re.compile(r"[a-z]{2}(-[a-z]+)+-\d")
# Patterns from the Cognito API reference (UserPoolId, ClientId).
_USER_POOL_ID = re.compile(r"([a-z]{2}(?:-[a-z]+)+-\d)_[0-9a-zA-Z]+")
_CLIENT_ID = re.compile(r"[\w+]{1,128}")


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

    auth_mode: AuthMode = AuthMode.ACCESS_CODE
    # Required with AUTH_MODE=access_code; ignored with AUTH_MODE=cognito.
    access_code: SecretStr | None = None

    # Amazon Cognito user pool (only validated and used when AUTH_MODE=cognito). The backend
    # calls the public user pool API operations only, so it needs no AWS credentials.
    cognito_region: str | None = None
    cognito_user_pool_id: str | None = None
    cognito_client_id: str | None = None
    # Secret of a confidential app client; requests then carry a SECRET_HASH.
    cognito_client_secret: SecretStr | None = None
    # Total time allowed for one request to Cognito. Nothing is retried.
    cognito_timeout_seconds: float = Field(default=10, ge=2, le=30)
    # 32-byte key (URL-safe base64) that encrypts the Cognito session/access token kept in the
    # database while a sign-in step (new password, email verification) is pending.
    auth_token_encryption_key: SecretStr | None = None
    # Lifetime of a pending sign-in step. The new-password step uses Cognito's own sign-in
    # session, so keep it at or below the app client's "authentication flow session duration"
    # (3 minutes by default). Email verification uses the access token (60 minutes by default).
    auth_new_password_challenge_ttl_seconds: int = Field(default=180, ge=60, le=900)
    auth_email_verification_challenge_ttl_seconds: int = Field(default=900, ge=60, le=3600)
    # Password recovery and verification-code requests per sliding window (every request
    # counts, failed or not): per client, per email address and overall.
    auth_recovery_max_per_client: int = Field(default=5, ge=1)
    auth_recovery_max_per_email: int = Field(default=3, ge=1)
    auth_recovery_max_global: int = Field(default=50, ge=1)
    auth_recovery_window_seconds: int = Field(default=900, ge=1)

    provider_mode: ProviderMode
    # Explicit opt-in to run mock providers with APP_ENV=production (online mock beta).
    # Every other production security rule still applies.
    allow_mock_providers_in_production: bool = False
    # Translation can use Azure while speech and audio processing are still mock
    # (Milestone 3 in progress). PROVIDER_MODE=mock keeps meaning "mock everything" unless this
    # overrides the translation stage.
    translation_provider: TranslationProviderChoice = TranslationProviderChoice.MOCK
    # Same for speech: SPEECH_PROVIDER=azure generates real Vietnamese speech.
    speech_provider: SpeechProviderChoice = SpeechProviderChoice.MOCK
    # AUDIO_PROCESSOR=ffmpeg adjusts the duration of the real speech with FFmpeg; the mock
    # passes the audio through unchanged. It needs the lossless audio of SPEECH_PROVIDER=azure.
    audio_processor: AudioProcessorChoice = AudioProcessorChoice.MOCK
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

    # Azure Speech text to speech over REST (only validated and used when SPEECH_PROVIDER=azure).
    # It has its own resource and key: the Translator key is never reused. Both stay in the
    # backend environment.
    azure_speech_key: SecretStr | None = None
    # Region of the Speech resource (e.g. westus2); it selects the regional TTS endpoint.
    azure_speech_region: str | None = None
    # Total time allowed for one synthesis request.
    azure_speech_timeout_seconds: float = Field(default=60, ge=10, le=300)
    # Largest text per request. A request is cut off by the service at 10 minutes of audio
    # without an error, so chunks stay far below that (2,000 characters is a few minutes).
    azure_speech_max_chunk_chars: int = Field(default=2000, ge=200, le=4000)
    # Request rate shared by all jobs of this process. Defaults are the Free (F0) limit
    # (20 transactions per 60 seconds, not adjustable); raise them only for a Standard (S0)
    # resource whose quota is higher.
    azure_speech_max_requests_per_window: int = Field(default=20, ge=1, le=1000)
    azure_speech_rate_window_seconds: float = Field(default=60, ge=1, le=600)

    # YouTube caption import (only validated and used when YOUTUBE_IMPORT_PROVIDER=supadata). The
    # key stays in the backend environment; the browser never talks to Supadata.
    youtube_import_provider: YouTubeImportChoice = YouTubeImportChoice.OFF
    supadata_api_key: SecretStr | None = None
    # Time allowed for one HTTP request to Supadata, and for a whole import including the status
    # polls of an asynchronous job. The browser waits for the import, so both stay bounded.
    supadata_timeout_seconds: float = Field(default=30, ge=5, le=120)
    supadata_deadline_seconds: float = Field(default=90, ge=10, le=300)
    # Pause between two status polls of an asynchronous job (Supadata recommends 1 second).
    supadata_poll_interval_seconds: float = Field(default=1, ge=0.5, le=30)
    # Request rate shared by every import of this process, status polls included. Defaults are
    # the Free plan's 1 request per second; raise them only for a plan with a higher limit.
    supadata_max_requests_per_window: int = Field(default=1, ge=1, le=100)
    supadata_rate_window_seconds: float = Field(default=1, ge=1, le=60)
    # Imports running at the same time; one more is refused (503) instead of queued.
    youtube_import_max_concurrent: int = Field(default=2, ge=1, le=20)

    session_ttl_seconds: int = Field(default=12 * 3600, ge=60)
    cookie_secure: bool = True
    # Header set (overwritten) by the edge proxy with the real client IP, e.g.
    # "cf-connecting-ip". Used for Access Code brute-force protection. When unset or absent,
    # the connection peer (after uvicorn proxy-header handling) is used.
    client_ip_header: str | None = None
    # Extra origins allowed on state-changing requests (e.g. the Vite dev server).
    trusted_origins: list[str] = Field(default_factory=list)

    # "Try as guest" (needs AUTH_MODE=cognito): people without an invitation use the Studio with
    # a guest session and quotas (docs/GUEST_ACCESS.md). Off by default.
    guest_access_enabled: bool = False
    # 32 random bytes (URL-safe base64) keying the hash that identifies a client network for the
    # guest quotas, so no raw IP address is stored. Its own key: never AUTH_TOKEN_ENCRYPTION_KEY.
    guest_ip_hash_key: SecretStr | None = None
    # Absolute lifetime of a guest session (and its cookie); never extended. At most the IP
    # window, so a session's used jobs are never forgotten while it is still valid.
    guest_session_ttl_seconds: int = Field(default=24 * 3600, ge=600, le=7 * 24 * 3600)
    # Completed jobs allowed per guest session, and per client network in a sliding window.
    guest_jobs_per_session: int = Field(default=5, ge=1, le=1000)
    guest_jobs_per_ip: int = Field(default=20, ge=1, le=10_000)
    guest_ip_window_seconds: int = Field(default=24 * 3600, ge=600, le=30 * 24 * 3600)
    # Words of a guest job: the text sent for translation, timestamps and markup not counted.
    guest_max_words: int = Field(default=1000, ge=10, le=100_000)
    # Guest sessions that may be started per client network and overall in a sliding window, so
    # starting sessions cannot grow the database without bound.
    guest_sessions_per_ip: int = Field(default=10, ge=1, le=10_000)
    guest_sessions_global: int = Field(default=300, ge=1, le=1_000_000)
    guest_session_rate_window_seconds: int = Field(default=3600, ge=60, le=24 * 3600)

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
    def _access_code_strength(cls, value: SecretStr | None) -> SecretStr | None:
        if value is not None and len(value.get_secret_value()) < 8:
            raise ValueError("ACCESS_CODE must be at least 8 characters")
        return value

    @model_validator(mode="after")
    def _check_environment_rules(self) -> "Settings":
        if self.auth_mode is AuthMode.ACCESS_CODE:
            if self.access_code is None:
                raise ValueError("ACCESS_CODE is required when AUTH_MODE=access_code")
            code = self.access_code.get_secret_value()
            if self.app_env is AppEnv.PRODUCTION and len(code) < 16:
                raise ValueError("ACCESS_CODE must be at least 16 characters in production")
        else:
            self._check_cognito()
        if self.provider_mode is ProviderMode.AZURE:
            # Everything real, or it does not start: no component silently stays a mock.
            missing = [
                f"{name}={wanted}"
                for name, actual, wanted in (
                    ("TRANSLATION_PROVIDER", self.translation_provider.value, "azure"),
                    ("SPEECH_PROVIDER", self.speech_provider.value, "azure"),
                    ("AUDIO_PROCESSOR", self.audio_processor.value, "ffmpeg"),
                )
                if actual != wanted
            ]
            if missing:
                raise ValueError(
                    "PROVIDER_MODE=azure needs every component to be real; also set "
                    + ", ".join(missing)
                )
        if self.translation_provider is TranslationProviderChoice.AZURE:
            self._check_azure_translator()
            if self.mock_fail_stage in (MockFailStage.TRANSLATION, MockFailStage.UNEXPECTED):
                raise ValueError(
                    "MOCK_FAIL_STAGE=translation/unexpected only applies to the mock "
                    "translation provider; unset it or use TRANSLATION_PROVIDER=mock"
                )
        if self.speech_provider is SpeechProviderChoice.AZURE:
            self._check_azure_speech()
            if self.mock_fail_stage is MockFailStage.SPEECH:
                raise ValueError(
                    "MOCK_FAIL_STAGE=speech only applies to the mock speech provider; "
                    "unset it or use SPEECH_PROVIDER=mock"
                )
        if self.audio_processor is AudioProcessorChoice.FFMPEG:
            if self.speech_provider is not SpeechProviderChoice.AZURE:
                raise ValueError(
                    "AUDIO_PROCESSOR=ffmpeg needs SPEECH_PROVIDER=azure: it adjusts the "
                    "duration of real speech audio, not of the mock speech fixture"
                )
            if self.mock_fail_stage is MockFailStage.AUDIO:
                raise ValueError(
                    "MOCK_FAIL_STAGE=audio only applies to the mock audio processor; "
                    "unset it or use AUDIO_PROCESSOR=mock"
                )
        if self.youtube_import_provider is YouTubeImportChoice.SUPADATA:
            key = self.supadata_api_key.get_secret_value() if self.supadata_api_key else ""
            if not key:
                raise ValueError(
                    "SUPADATA_API_KEY is required when YOUTUBE_IMPORT_PROVIDER=supadata"
                )
            if not _HEADER_VALUE.fullmatch(key):
                raise ValueError("SUPADATA_API_KEY must be printable ASCII without spaces")
        if (
            self.youtube_import_provider is YouTubeImportChoice.MOCK
            and self.app_env is AppEnv.PRODUCTION
        ):
            raise ValueError(
                "YOUTUBE_IMPORT_PROVIDER=mock is not allowed when APP_ENV=production (it "
                "returns fixed captions, not the video's); use supadata or off"
            )
        if self.guest_access_enabled:
            self._check_guest_access()
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
        return self

    def _check_cognito(self) -> None:
        region = self.cognito_region or ""
        if not _AWS_REGION.fullmatch(region):
            raise ValueError(
                "COGNITO_REGION is required when AUTH_MODE=cognito and must be a region name "
                "such as us-west-2"
            )
        pool = _USER_POOL_ID.fullmatch(self.cognito_user_pool_id or "")
        if pool is None:
            raise ValueError(
                "COGNITO_USER_POOL_ID is required when AUTH_MODE=cognito and must look like "
                "us-west-2_AbC123"
            )
        if pool.group(1) != region:
            raise ValueError("COGNITO_USER_POOL_ID must belong to COGNITO_REGION")
        if not _CLIENT_ID.fullmatch(self.cognito_client_id or ""):
            raise ValueError(
                "COGNITO_CLIENT_ID is required when AUTH_MODE=cognito (the app client ID)"
            )
        if self.cognito_client_secret is not None and not _HEADER_VALUE.fullmatch(
            self.cognito_client_secret.get_secret_value()
        ):
            raise ValueError("COGNITO_CLIENT_SECRET must be printable ASCII without spaces")
        key = self.auth_token_encryption_key
        if key is None or decode_encryption_key(key.get_secret_value()) is None:
            raise ValueError(
                "AUTH_TOKEN_ENCRYPTION_KEY is required when AUTH_MODE=cognito and must be "
                "32 random bytes in URL-safe base64 (44 characters)"
            )

    def _check_guest_access(self) -> None:
        if self.auth_mode is not AuthMode.COGNITO:
            raise ValueError("GUEST_ACCESS_ENABLED=true needs AUTH_MODE=cognito")
        key = self.guest_ip_hash_key
        if key is None or decode_encryption_key(key.get_secret_value()) is None:
            raise ValueError(
                "GUEST_IP_HASH_KEY is required when GUEST_ACCESS_ENABLED=true and must be 32 "
                "random bytes in URL-safe base64 (44 characters)"
            )
        auth_key = self.auth_token_encryption_key
        if auth_key is not None and decode_encryption_key(
            key.get_secret_value()
        ) == decode_encryption_key(auth_key.get_secret_value()):
            raise ValueError("GUEST_IP_HASH_KEY must differ from AUTH_TOKEN_ENCRYPTION_KEY")
        if self.guest_session_ttl_seconds > self.guest_ip_window_seconds:
            raise ValueError("GUEST_SESSION_TTL_SECONDS must not exceed GUEST_IP_WINDOW_SECONDS")
        if self.app_env is AppEnv.PRODUCTION and not self.client_ip_header:
            # Behind the host's proxy the peer address is the proxy, or comes from a
            # client-supplied X-Forwarded-For: neither can identify a guest's network.
            raise ValueError(
                "GUEST_ACCESS_ENABLED=true needs CLIENT_IP_HEADER (the header the edge proxy "
                "overwrites with the client IP) when APP_ENV=production"
            )

    @property
    def cognito_issuer(self) -> str:
        """Issuer of the user pool's tokens; with `sub` it identifies a user."""
        return (
            f"https://cognito-idp.{self.cognito_region}.amazonaws.com/{self.cognito_user_pool_id}"
        )

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

    def _check_azure_speech(self) -> None:
        key = self.azure_speech_key.get_secret_value() if self.azure_speech_key else ""
        if not key:
            raise ValueError("AZURE_SPEECH_KEY is required when SPEECH_PROVIDER=azure")
        if not _HEADER_VALUE.fullmatch(key):
            raise ValueError("AZURE_SPEECH_KEY must be printable ASCII without spaces")
        if not self.azure_speech_region or not _SPEECH_REGION.fullmatch(self.azure_speech_region):
            raise ValueError(
                "AZURE_SPEECH_REGION is required when SPEECH_PROVIDER=azure and must be a "
                "region name such as westus2"
            )

    @property
    def sqlalchemy_url(self) -> str:
        return to_sqlalchemy_url(self.database_url.get_secret_value())

    @property
    def is_mock_mode(self) -> bool:
        """True while any pipeline component is a mock."""
        return "mock" in self.component_providers.values()

    @property
    def effective_provider_mode(self) -> ProviderMode:
        """What is really running: `azure` only when every component is real."""
        return ProviderMode.MOCK if self.is_mock_mode else ProviderMode.AZURE

    @property
    def component_providers(self) -> dict[str, str]:
        """Which implementation serves each pipeline stage (reported by /api/meta)."""
        return {
            "translation": self.translation_provider.value,
            "speech": self.speech_provider.value,
            "audio": self.audio_processor.value,
        }


def decode_encryption_key(value: str) -> bytes | None:
    """The 32-byte key encoded in AUTH_TOKEN_ENCRYPTION_KEY, or None if it is not one."""
    try:
        key = base64.urlsafe_b64decode(value.encode("ascii"))
    except (ValueError, UnicodeEncodeError):
        return None
    return key if len(key) == 32 else None


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
