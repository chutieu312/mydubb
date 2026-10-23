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
from app.config import (
    AudioProcessorChoice,
    ConfigurationError,
    MockFailStage,
    Settings,
    SpeechProviderChoice,
    TranslationProviderChoice,
)
from app.db import create_db_engine, create_session_factory
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


@dataclass
class AppServices:
    settings: Settings
    # Unique per process start; recorded as `jobs.runner_id` for jobs this process runs.
    instance_id: str
    engine: Engine
    session_factory: sessionmaker[Session]
    access_limiter: FailedAttemptLimiter
    result_store: ResultStore
    executor: JobExecutor
    pipeline: JobPipeline
    # Stops FFmpeg processes of running jobs at shutdown.
    audio: AudioProcessor
    # Request-rate limiter shared by all jobs when speech uses Azure; closed at shutdown.
    speech_limiter: RequestRateLimiter | None = None


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


def build_services(
    settings: Settings,
    *,
    translation_transport: httpx.BaseTransport | None = None,
    speech_transport: httpx.BaseTransport | None = None,
) -> AppServices:
    """The transports replace the network for Azure Translator / Azure Speech (tests only)."""
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
    pipeline = JobPipeline(
        session_factory=session_factory,
        translator=build_translator(settings, translation_transport),
        speech=build_speech(settings, speech_limiter, speech_transport),
        audio=audio,
        result_store=result_store,
        result_ttl_seconds=settings.result_ttl_seconds,
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
    )
