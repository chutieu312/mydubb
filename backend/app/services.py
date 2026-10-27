"""Composition root: builds the application's long-lived collaborators from settings."""

import logging
import uuid
from dataclasses import dataclass

import httpx
from sqlalchemy import Engine
from sqlalchemy.orm import Session, sessionmaker

from app.access.rate_limit import FailedAttemptLimiter
from app.audio.base import AudioProcessor
from app.audio.ffmpeg import AudioToolError, check_capabilities, locate_tools
from app.audio.fitter import FfmpegAudioProcessor
from app.audio.mock import MockAudioProcessor
from app.auth.cognito import CognitoClient, HttpCognitoClient
from app.auth.crypto import TokenCipher
from app.config import (
    AudioProcessorChoice,
    AuthMode,
    ConfigurationError,
    MockFailStage,
    Settings,
    SpeechProviderChoice,
    TranslationProviderChoice,
    YouTubeImportChoice,
    decode_encryption_key,
)
from app.db import create_db_engine, create_session_factory
from app.guest.access import GuestAccess
from app.jobs.executor import BoundedThreadJobExecutor, JobExecutor
from app.jobs.pipeline import JobPipeline
from app.speech.azure import AzureSpeechProvider
from app.speech.base import SpeechProvider
from app.speech.mock import MockSpeechProvider
from app.speech.rate_limit import RequestRateLimiter
from app.storage.result_store import LocalFileResultStore, ResultStore
from app.translation.azure import AzureTranslationProvider
from app.translation.base import TranslationProvider
from app.translation.glossary import default_glossary
from app.translation.mock import MockTranslationProvider
from app.youtube_import.base import CaptionProvider
from app.youtube_import.mock import MockCaptionProvider
from app.youtube_import.service import YouTubeImporter
from app.youtube_import.supadata import SupadataCaptionProvider


@dataclass
class AppServices:
    settings: Settings
    # Unique per process start; recorded as `jobs.runner_id` for jobs this process runs.
    instance_id: str
    engine: Engine
    session_factory: sessionmaker[Session]
    # Failed sign-ins (Access Code, or Cognito email/password).
    access_limiter: FailedAttemptLimiter
    result_store: ResultStore
    executor: JobExecutor
    pipeline: JobPipeline
    # Stops FFmpeg processes of running jobs at shutdown.
    audio: AudioProcessor
    # Request-rate limiter shared by all jobs when speech uses Azure; closed at shutdown.
    speech_limiter: RequestRateLimiter | None = None
    # AUTH_MODE=cognito only: the user pool client, the cipher for pending sign-in steps, and the
    # limiter for password recovery and verification-code requests (every request counts).
    cognito: CognitoClient | None = None
    token_cipher: TokenCipher | None = None
    recovery_limiter: FailedAttemptLimiter | None = None
    # Same, keyed by the (hashed) email address of forgot/reset-password requests.
    recovery_email_limiter: FailedAttemptLimiter | None = None
    # YouTube caption import; None while YOUTUBE_IMPORT_PROVIDER=off. Closed at shutdown.
    youtube_import: YouTubeImporter | None = None
    # "Try as guest" policy and IP-hash key; None while GUEST_ACCESS_ENABLED=false.
    guest: GuestAccess | None = None


def build_translator(
    settings: Settings, transport: httpx.BaseTransport | None = None
) -> TranslationProvider:
    if settings.translation_provider is TranslationProviderChoice.AZURE:
        # Settings validation guarantees the key; never fall back to the mock translator.
        assert settings.azure_translator_key is not None
        # The HTTP client library logs every request URL at INFO; keep it out of the logs.
        logging.getLogger("httpx").setLevel(logging.WARNING)
        return AzureTranslationProvider(
            key=settings.azure_translator_key,
            region=settings.azure_translator_region,
            endpoint=settings.azure_translator_endpoint,
            glossary=default_glossary(),
            timeout_seconds=settings.azure_translator_timeout_seconds,
            max_request_chars=settings.azure_translator_max_request_chars,
            transport=transport,
        )
    fail = settings.mock_fail_stage
    return MockTranslationProvider(
        fail=fail is MockFailStage.TRANSLATION,
        unexpected_error=fail is MockFailStage.UNEXPECTED,
        delay=settings.mock_stage_delay_seconds,
    )


def build_speech(
    settings: Settings,
    limiter: RequestRateLimiter | None,
    transport: httpx.BaseTransport | None = None,
) -> SpeechProvider:
    if settings.speech_provider is SpeechProviderChoice.AZURE:
        # Settings validation guarantees the key and region; never fall back to the mock.
        assert settings.azure_speech_key is not None and settings.azure_speech_region is not None
        assert limiter is not None
        tools = locate_tools()
        if tools is None:
            raise ConfigurationError(
                "Invalid configuration: SPEECH_PROVIDER=azure needs the ffmpeg and ffprobe "
                "programs on PATH to build the MP3 (they are part of the Docker image)"
            )
        logging.getLogger("httpx").setLevel(logging.WARNING)
        return AzureSpeechProvider(
            key=settings.azure_speech_key,
            region=settings.azure_speech_region,
            glossary=default_glossary(),
            tools=tools,
            limiter=limiter,
            timeout_seconds=settings.azure_speech_timeout_seconds,
            max_chunk_chars=settings.azure_speech_max_chunk_chars,
            transport=transport,
        )
    return MockSpeechProvider(
        fail=settings.mock_fail_stage is MockFailStage.SPEECH,
        delay=settings.mock_stage_delay_seconds,
    )


def build_audio(settings: Settings) -> AudioProcessor:
    if settings.audio_processor is AudioProcessorChoice.FFMPEG:
        # Never fall back to the pass-through mock: the audio would silently miss the target.
        tools = locate_tools()
        if tools is None:
            raise ConfigurationError(
                "Invalid configuration: AUDIO_PROCESSOR=ffmpeg needs the ffmpeg and ffprobe "
                "programs on PATH (they are part of the Docker image)"
            )
        try:
            check_capabilities(tools)
        except AudioToolError:
            raise ConfigurationError(
                "Invalid configuration: AUDIO_PROCESSOR=ffmpeg needs an FFmpeg with the "
                "atempo filter and the libmp3lame encoder"
            ) from None
        return FfmpegAudioProcessor(tools)
    return MockAudioProcessor(
        fail=settings.mock_fail_stage is MockFailStage.AUDIO,
        delay=settings.mock_stage_delay_seconds,
    )


def build_youtube_import(
    settings: Settings, transport: httpx.AsyncBaseTransport | None = None
) -> YouTubeImporter | None:
    provider: CaptionProvider
    if settings.youtube_import_provider is YouTubeImportChoice.SUPADATA:
        # Settings validation guarantees the key; there is no fallback to another provider.
        assert settings.supadata_api_key is not None
        provider = SupadataCaptionProvider(
            key=settings.supadata_api_key,
            # One limiter for every import of the process, status polls included.
            limiter=RequestRateLimiter(
                settings.supadata_max_requests_per_window,
                settings.supadata_rate_window_seconds,
            ),
            timeout_seconds=settings.supadata_timeout_seconds,
            deadline_seconds=settings.supadata_deadline_seconds,
            poll_interval_seconds=settings.supadata_poll_interval_seconds,
            transport=transport,
        )
    elif settings.youtube_import_provider is YouTubeImportChoice.MOCK:
        provider = MockCaptionProvider(delay=settings.mock_stage_delay_seconds)
    else:
        return None
    return YouTubeImporter(provider, max_concurrent=settings.youtube_import_max_concurrent)


def build_auth(
    settings: Settings, cognito_client: CognitoClient | None
) -> tuple[
    CognitoClient | None,
    TokenCipher | None,
    FailedAttemptLimiter | None,
    FailedAttemptLimiter | None,
]:
    if settings.auth_mode is not AuthMode.COGNITO:
        return None, None, None, None
    # Settings validation guarantees these; never fall back to the Access Code.
    assert settings.cognito_region is not None and settings.cognito_client_id is not None
    assert settings.auth_token_encryption_key is not None
    key = decode_encryption_key(settings.auth_token_encryption_key.get_secret_value())
    assert key is not None
    if cognito_client is None:
        # The HTTP client library logs every request URL at INFO; keep it out of the logs.
        logging.getLogger("httpx").setLevel(logging.WARNING)
        cognito_client = HttpCognitoClient(
            region=settings.cognito_region,
            client_id=settings.cognito_client_id,
            client_secret=settings.cognito_client_secret,
            timeout_seconds=settings.cognito_timeout_seconds,
        )
    limiter = FailedAttemptLimiter(
        max_per_client=settings.auth_recovery_max_per_client,
        max_global=settings.auth_recovery_max_global,
        window_seconds=settings.auth_recovery_window_seconds,
    )
    email_limiter = FailedAttemptLimiter(
        max_per_client=settings.auth_recovery_max_per_email,
        # The overall limit is enforced by `limiter`; this one only counts per address.
        max_global=2**31,
        window_seconds=settings.auth_recovery_window_seconds,
    )
    return cognito_client, TokenCipher(key), limiter, email_limiter


def build_services(
    settings: Settings,
    *,
    translation_transport: httpx.BaseTransport | None = None,
    speech_transport: httpx.BaseTransport | None = None,
    youtube_import_transport: httpx.AsyncBaseTransport | None = None,
    cognito_client: CognitoClient | None = None,
) -> AppServices:
    """The transports replace the network for Azure Translator / Azure Speech / Supadata, and
    `cognito_client` replaces Amazon Cognito (tests only)."""
    engine = create_db_engine(settings.sqlalchemy_url, settings.db_connect_timeout_seconds)
    session_factory = create_session_factory(engine)
    result_store = LocalFileResultStore(settings.result_storage_dir)

    speech_limiter = (
        RequestRateLimiter(
            settings.azure_speech_max_requests_per_window,
            settings.azure_speech_rate_window_seconds,
        )
        if settings.speech_provider is SpeechProviderChoice.AZURE
        else None
    )
    audio = build_audio(settings)
    cognito, token_cipher, recovery_limiter, recovery_email_limiter = build_auth(
        settings, cognito_client
    )
    pipeline = JobPipeline(
        session_factory=session_factory,
        translator=build_translator(settings, translation_transport),
        speech=build_speech(settings, speech_limiter, speech_transport),
        audio=audio,
        result_store=result_store,
        result_ttl_seconds=settings.result_ttl_seconds,
        glossary=default_glossary(),
    )

    return AppServices(
        settings=settings,
        instance_id=uuid.uuid4().hex,
        engine=engine,
        session_factory=session_factory,
        access_limiter=FailedAttemptLimiter(
            max_per_client=settings.access_max_failures_per_client,
            max_global=settings.access_max_failures_global,
            window_seconds=settings.access_failure_window_seconds,
        ),
        result_store=result_store,
        executor=BoundedThreadJobExecutor(
            max_concurrency=settings.job_max_concurrency,
            max_queued=settings.job_max_queued,
        ),
        pipeline=pipeline,
        audio=audio,
        speech_limiter=speech_limiter,
        cognito=cognito,
        token_cipher=token_cipher,
        recovery_limiter=recovery_limiter,
        recovery_email_limiter=recovery_email_limiter,
        youtube_import=build_youtube_import(settings, youtube_import_transport),
        guest=GuestAccess.from_settings(settings),
    )
