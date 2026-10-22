"""Job liveness: heartbeats cover only jobs this process still owns, so jobs whose worker
is gone (e.g. its failure could not be recorded while the database was down) become stale
and are interrupted once the database is back.

Deterministic: workers run inline, a toggleable session factory simulates the database
outage, and the passage of time is simulated by moving `heartbeat_at` into the past.
"""

import contextlib
import uuid
from collections.abc import Callable
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import text
from sqlalchemy.exc import OperationalError

from app import maintenance
from app.audio.mock import MockAudioProcessor
from app.db import session_scope
from app.jobs import pipeline as pipeline_module
from app.jobs import service
from app.jobs.models import JobStatus
from app.jobs.pipeline import JobInput, JobPipeline
from app.processing_errors import ProcessingError
from app.speech.mock import MockSpeechProvider
from app.speech.voices import Voice
from app.translation.mock import MockTranslationProvider


class FlakySessionFactory:
    """Wraps a session factory; while `down` is set, opening a session fails."""

    def __init__(self, factory) -> None:
        self._factory = factory
        self.down = False

    def __call__(self):
        if self.down:
            raise OperationalError("SELECT 1", {}, Exception("database unavailable"))
        return self._factory()


class InlineSlot:
    """Runs the job synchronously in the calling thread."""

    def start(self, work: Callable[[], None]) -> None:
        work()

    def cancel(self) -> None:
        pass


class DeferredSlot:
    """Accepts the job but keeps it queued until `run()` is called."""

    def __init__(self) -> None:
        self.work: Callable[[], None] | None = None

    def start(self, work: Callable[[], None]) -> None:
        self.work = work

    def cancel(self) -> None:
        pass


class BrokenSlot:
    def start(self, work: Callable[[], None]) -> None:
        raise RuntimeError("cannot schedule new futures after shutdown")

    def cancel(self) -> None:
        pass


class TranslatorFailingDuringOutage:
    """Fails the stage and takes the database down, so the failure cannot be recorded."""

    name = "mock-translation"

    def __init__(self, factory: FlakySessionFactory) -> None:
        self._factory = factory

    def translate(self, text: str):
        self._factory.down = True
        raise ProcessingError("translation_failed", "Translation failed.")


def make_pipeline(services, factory, translator=None) -> JobPipeline:
    return JobPipeline(
        session_factory=factory,
        translator=translator or MockTranslationProvider(),
        speech=MockSpeechProvider(),
        audio=MockAudioProcessor(),
        result_store=services.result_store,
        result_ttl_seconds=services.settings.result_ttl_seconds,
    )


def new_job(services, runner_id: str | None = None) -> JobInput:
    """Create a queued job row the way the API does (owned by `runner_id`)."""
    with session_scope(services.session_factory) as db:
        session_id = uuid.uuid4()
        db.execute(
            text(
                "INSERT INTO access_sessions (id, token_hash, csrf_token, created_at, expires_at)"
                " VALUES (:id, :hash, 'csrf', now(), now() + interval '1 day')"
            ),
            {"id": session_id, "hash": uuid.uuid4().hex},
        )
        job = service.create_job(
            db,
            session_id=session_id,
            voice="HoaiMy",
            first_sentence_start_seconds=10,
            last_sentence_start_seconds=370,
            transcript_char_count=20,
            translation_provider="mock-translation",
            speech_provider="mock-speech",
            audio_processor="mock-audio",
            runner_id=runner_id or services.instance_id,
        )
    return JobInput(job.id, "A transcript.", Voice.HOAI_MY, 360)


def row(db_engine, job_id) -> tuple:
    with db_engine.connect() as conn:
        return tuple(
            conn.execute(
                text("SELECT status, error_code, heartbeat_at FROM jobs WHERE id = :id"),
                {"id": job_id},
            ).one()
        )


def age(db_engine, job_ids, seconds: float) -> None:
    """Simulate time passing: the last heartbeat happened `seconds` ago."""
    past = datetime.now(UTC) - timedelta(seconds=seconds)
    with db_engine.begin() as conn:
        conn.execute(
            text("UPDATE jobs SET heartbeat_at = :t, updated_at = :t WHERE id = ANY(:ids)"),
            {"t": past, "ids": list(job_ids)},
        )


def liveness_tick(services) -> None:
    """One iteration of the liveness loop."""
    maintenance.heartbeat(services)
    maintenance.fail_stale(services)


@pytest.fixture
def services(make_client):
    return make_client().app.state.services


def test_job_orphaned_during_db_outage_is_interrupted_after_recovery(services, db_engine):
    factory = FlakySessionFactory(services.session_factory)
    pipeline = make_pipeline(services, factory, TranslatorFailingDuringOutage(factory))
    services.pipeline = pipeline  # the liveness loop asks this pipeline what it owns
    orphan = new_job(services)

    pipeline.start(InlineSlot(), orphan)  # fails; recording "failed" hits the outage

    factory.down = False  # database is back
    assert row(db_engine, orphan.job_id)[0] == "translating"  # failure was never recorded
    assert pipeline.unfinished_job_ids() == set()  # and no worker owns it any more

    stale = services.settings.job_stale_after_seconds
    age(db_engine, [orphan.job_id], stale + 30)
    liveness_tick(services)

    status, error_code, _ = row(db_engine, orphan.job_id)
    assert (status, error_code) == ("failed", "interrupted")


def test_owned_queued_and_running_jobs_keep_their_heartbeat(services, db_engine):
    pipeline = make_pipeline(services, services.session_factory)
    services.pipeline = pipeline
    queued = new_job(services)
    running = new_job(services)
    pipeline.start(DeferredSlot(), queued)  # accepted, waiting for a worker
    with pipeline._lock:  # a worker is executing it right now
        pipeline._accepted.add(running.job_id)
        pipeline._running.add(running.job_id)
    with session_scope(services.session_factory) as db:
        service.transition(db, running.job_id, JobStatus.QUEUED, JobStatus.TRANSLATING)

    stale = services.settings.job_stale_after_seconds
    age(db_engine, [queued.job_id, running.job_id], stale + 30)
    liveness_tick(services)

    for job, status in ((queued, "queued"), (running, "translating")):
        current_status, error_code, heartbeat_at = row(db_engine, job.job_id)
        assert (current_status, error_code) == (status, None)
        assert heartbeat_at > datetime.now(UTC) - timedelta(seconds=10)


def test_jobs_of_another_live_instance_are_not_failed(services, db_engine):
    other = new_job(services, runner_id="another-instance")
    age(db_engine, [other.job_id], 5)  # its instance heartbeated 5 s ago

    liveness_tick(services)

    assert row(db_engine, other.job_id)[:2] == ("queued", None)


def test_terminal_jobs_are_never_changed_by_liveness(services, db_engine):
    pipeline = make_pipeline(services, services.session_factory)
    services.pipeline = pipeline
    completed = new_job(services)
    failed = new_job(services)
    with session_scope(services.session_factory) as db:
        for job in (completed, failed):
            service.transition(db, job.job_id, JobStatus.QUEUED, JobStatus.PROCESSING)
        service.transition(db, completed.job_id, JobStatus.PROCESSING, JobStatus.COMPLETED)
        service.mark_failed(db, failed.job_id, "speech_failed", "Speech synthesis failed.")
    # Race: the in-memory snapshot still lists them although their workers finished.
    with pipeline._lock:
        pipeline._accepted.update({completed.job_id, failed.job_id})
    stale = services.settings.job_stale_after_seconds
    age(db_engine, [completed.job_id, failed.job_id], stale + 30)
    before = {job.job_id: row(db_engine, job.job_id) for job in (completed, failed)}

    liveness_tick(services)

    for job in (completed, failed):
        assert row(db_engine, job.job_id) == before[job.job_id]
    assert before[completed.job_id][:2] == ("completed", None)
    assert before[failed.job_id][:2] == ("failed", "speech_failed")


def test_work_dir_creation_failure_does_not_leave_the_job_tracked(services, db_engine, monkeypatch):
    pipeline = make_pipeline(services, services.session_factory)
    services.pipeline = pipeline
    job = new_job(services)

    def no_space(*args, **kwargs):
        raise OSError(28, "No space left on device")

    monkeypatch.setattr(pipeline_module.tempfile, "mkdtemp", no_space)
    with contextlib.suppress(OSError):  # the old code let this escape the worker
        pipeline.start(InlineSlot(), job)

    assert pipeline.unfinished_job_ids() == set()
    assert pipeline.running_job_ids() == set()
    assert row(db_engine, job.job_id)[:2] == ("failed", "internal_error")


def test_scheduling_failure_does_not_leave_the_job_tracked(services):
    pipeline = make_pipeline(services, services.session_factory)
    job = new_job(services)

    with pytest.raises(RuntimeError):
        pipeline.start(BrokenSlot(), job)

    assert pipeline.unfinished_job_ids() == set()
