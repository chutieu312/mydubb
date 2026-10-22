"""Composition root: builds the application's long-lived collaborators from settings."""

import logging
import uuid
from dataclasses import dataclass

import httpx
from sqlalchemy import Engine
from sqlalchemy.orm import Session, sessionmaker

from app.access.rate_limit import FailedAttemptLimiter
from app.audio.mock import MockAudioProcessor
from app.config import MockFailStage, ProviderMode, Settings, TranslationProviderChoice
from app.db import create_db_engine, create_session_factory
from app.jobs.executor import BoundedThreadJobExecutor, JobExecutor
from app.jobs.pipeline import JobPipeline
from app.speech.mock import MockSpeechProvider
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


def build_services(
    settings: Settings, *, translation_transport: httpx.BaseTransport | None = None
) -> AppServices:
    """`translation_transport` replaces the network for Azure Translator (tests only)."""
    engine = create_db_engine(settings.sqlalchemy_url, settings.db_connect_timeout_seconds)
    session_factory = create_session_factory(engine)
    result_store = LocalFileResultStore(settings.result_storage_dir)

    if settings.provider_mode is not ProviderMode.MOCK:
        # Settings validation already rejects this; never silently fall back to mocks.
        raise RuntimeError(f"Unsupported provider mode: {settings.provider_mode}")
    fail = settings.mock_fail_stage
    delay = settings.mock_stage_delay_seconds
    pipeline = JobPipeline(
        session_factory=session_factory,
        translator=build_translator(settings, translation_transport),
        speech=MockSpeechProvider(fail=fail is MockFailStage.SPEECH, delay=delay),
        audio=MockAudioProcessor(fail=fail is MockFailStage.AUDIO, delay=delay),
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
    )
