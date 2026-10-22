"""The dubbing pipeline: translate -> synthesize -> process audio -> store result.

Runs in a worker thread (see executor.py), never on the event loop. Each status change is
a short committed transaction so pollers see progress. The transcript is held in memory
only for the duration of the run.
"""

import logging
import shutil
import tempfile
import threading
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path

from sqlalchemy.orm import Session, sessionmaker

from app.audio.base import AudioProcessor
from app.db import session_scope
from app.jobs import service
from app.jobs.executor import JobSlot
from app.jobs.models import JobStatus
from app.processing_errors import ProcessingError
from app.speech.base import SpeechProvider
from app.speech.voices import Voice
from app.storage.result_store import ResultContent, ResultStore
from app.translation.base import TranslationProvider

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class JobInput:
    job_id: uuid.UUID
    transcript: str  # cleaned English text; never persisted
    voice: Voice
    target_duration_seconds: int


class _Superseded(Exception):
    """The job left the expected state (e.g. failed by recovery); stop quietly."""


class JobPipeline:
    def __init__(
        self,
        *,
        session_factory: sessionmaker[Session],
        translator: TranslationProvider,
        speech: SpeechProvider,
        audio: AudioProcessor,
        result_store: ResultStore,
        result_ttl_seconds: int,
    ) -> None:
        self._session_factory = session_factory
        self._translator = translator
        self._speech = speech
        self._audio = audio
        self._result_store = result_store
        self._result_ttl = timedelta(seconds=result_ttl_seconds)
        self._lock = threading.Lock()
        self._accepted: set[uuid.UUID] = set()

    def provider_names(self) -> dict[str, str]:
        return {
            "translation_provider": self._translator.name,
            "speech_provider": self._speech.name,
            "audio_processor": self._audio.name,
        }

    def start(self, slot: JobSlot, job: JobInput) -> None:
        """Run the job on a reserved executor slot and track it until it finishes."""
        with self._lock:
            self._accepted.add(job.job_id)
        slot.start(lambda: self.run(job))

    def unfinished_job_ids(self) -> set[uuid.UUID]:
        """Jobs accepted by this process that have not finished running (queued or running)."""
        with self._lock:
            return set(self._accepted)

    def run(self, job: JobInput) -> None:
        work_dir = Path(tempfile.mkdtemp(prefix=f"mydubb-job-{job.job_id}-"))
        try:
            self._run_stages(job, work_dir)
        except _Superseded:
            logger.info("Job %s no longer active; stopping", job.job_id)
        except ProcessingError as exc:
            logger.warning("Job %s failed: %s", job.job_id, exc.code)
            self._fail(job.job_id, exc.code, exc.user_message)
        except Exception:
            # Details go to server logs only (never transcript content); users get a safe message.
            logger.exception("Job %s failed unexpectedly", job.job_id)
            self._fail(job.job_id, "internal_error", "Processing failed due to an internal error.")
        finally:
            shutil.rmtree(work_dir, ignore_errors=True)
            with self._lock:
                self._accepted.discard(job.job_id)

    def _run_stages(self, job: JobInput, work_dir: Path) -> None:
        now = datetime.now(UTC)
        self._advance(job.job_id, JobStatus.QUEUED, JobStatus.TRANSLATING, started_at=now)
        translation = self._translator.translate(job.transcript)

        self._advance(job.job_id, JobStatus.TRANSLATING, JobStatus.SYNTHESIZING)
        speech = self._speech.synthesize(translation.text, job.voice, work_dir)

        self._advance(job.job_id, JobStatus.SYNTHESIZING, JobStatus.PROCESSING)
        processed = self._audio.fit_to_duration(speech.path, job.target_duration_seconds, work_dir)

        completed_at = datetime.now(UTC)
        expires_at = completed_at + self._result_ttl
        self._result_store.save(
            job.job_id,
            ResultContent(
                translation_text=translation.text,
                translation_is_illustrative=translation.is_illustrative,
                audio_file=processed.path,
                audio_is_fixture=speech.is_fixture,
                duration_adjusted=processed.duration_adjusted,
            ),
            expires_at,
        )
        with session_scope(self._session_factory) as db:
            completed = service.transition(
                db,
                job.job_id,
                JobStatus.PROCESSING,
                JobStatus.COMPLETED,
                completed_at=completed_at,
                result_expires_at=expires_at,
            )
        if not completed:
            self._result_store.delete(job.job_id)
            raise _Superseded

    def _advance(self, job_id: uuid.UUID, expected: JobStatus, new: JobStatus, **fields) -> None:
        with session_scope(self._session_factory) as db:
            if not service.transition(db, job_id, expected, new, **fields):
                raise _Superseded

    def _fail(self, job_id: uuid.UUID, code: str, message: str) -> None:
        try:
            with session_scope(self._session_factory) as db:
                service.mark_failed(db, job_id, code, message)
        except Exception:
            # The job stays active in the DB; startup recovery will mark it failed.
            logger.exception("Could not record failure for job %s", job_id)
