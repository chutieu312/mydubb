"""Composition root: builds the application's long-lived collaborators from settings."""

import uuid
from dataclasses import dataclass

from sqlalchemy import Engine
from sqlalchemy.orm import Session, sessionmaker

from app.access.rate_limit import FailedAttemptLimiter
from app.audio.mock import MockAudioProcessor
from app.config import MockFailStage, ProviderMode, Settings
from app.db import create_db_engine, create_session_factory
from app.jobs.executor import BoundedThreadJobExecutor, JobExecutor
from app.jobs.pipeline import JobPipeline
from app.speech.mock import MockSpeechProvider
from app.storage.result_store import LocalFileResultStore, ResultStore
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


def build_services(settings: Settings) -> AppServices:
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
        translator=MockTranslationProvider(
            fail=fail is MockFailStage.TRANSLATION,
            unexpected_error=fail is MockFailStage.UNEXPECTED,
            delay=delay,
        ),
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
