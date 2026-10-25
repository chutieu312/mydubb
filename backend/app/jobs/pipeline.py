"""The dubbing pipeline: translate -> synthesize -> process audio -> store result.

Plain mode translates the cleaned transcript, synthesizes it and fits the whole audio to the
target. Timed mode (`JobInput.timed`) translates one line per block, synthesizes one clip per block
(speech/blocks.py) and places each in its frame of the timeline (audio/timeline.py); the stages and
statuses are the same, and a failure in any block fails the job (no partial audio, no plain
fallback).

Runs in a worker thread (see executor.py), never on the event loop. Each status change is
a short committed transaction so pollers see progress. The transcript is held in memory
only for the duration of the run.

After a real translation, the English it kept is detected (`pronunciation/detector.py`) so
speech reads it with `en-US`, and once the job is completed its glossary candidates are
counted in their own transaction (`glossary_candidates/store.py`). That bookkeeping is
auxiliary: if it fails, the completed job and its result are kept and only a log line (no
term, text or database message) says so.
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

from app.audio.base import AudioProcessor, ProcessedAudio
from app.audio.speed import AudioSpeed, DurationTarget
from app.db import session_scope
from app.glossary_candidates.store import record_job_candidates
from app.jobs import service
from app.jobs.executor import JobSlot
from app.jobs.models import JobStatus
from app.processing_errors import ProcessingError
from app.pronunciation.detector import Detection, detect_english
from app.speech.base import SpeechProvider
from app.speech.voices import Voice
from app.storage.result_store import ResultContent, ResultStore
from app.transcript.timed import TimedTranscript
from app.translation.base import TranslationProvider, TranslationResult
from app.translation.glossary import Glossary, default_glossary

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class JobInput:
    job_id: uuid.UUID
    transcript: str  # cleaned English text (timed mode: the blocks, one per line); never persisted
    voice: Voice
    baseline_seconds: int  # last - first sentence start, as the user selected it
    speed: AudioSpeed
    # Timed mode: captions and blocks, in memory only; None in plain mode.
    timed: TimedTranscript | None = None


def timing_summary(
    timed: TimedTranscript, selected_baseline: int, requests: int, processed: ProcessedAudio
) -> dict:
    """What the result reports about timed mode (no transcript text)."""
    summary = {
        "mode": "timed",
        "captions": len(timed.captions),
        "blocks": len(timed.blocks),
        "source_first_seconds": timed.source_first,
        "source_last_seconds": timed.source_last,
        "source_baseline_seconds": timed.source_baseline,
        "selected_baseline_seconds": selected_baseline,
        "estimated_block_starts": [b.estimated_start for b in timed.blocks],
        "speech_requests": requests,
        "timeline": None,
    }
    if processed.timeline is not None:
        summary["timeline"] = processed.timeline.as_dict()
    return summary


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
        glossary: Glossary | None = None,
    ) -> None:
        self._session_factory = session_factory
        self._glossary = glossary if glossary is not None else default_glossary()
        self._translator = translator
        self._speech = speech
        self._audio = audio
        self._result_store = result_store
        self._result_ttl = timedelta(seconds=result_ttl_seconds)
        self._lock = threading.Lock()
        self._accepted: set[uuid.UUID] = set()  # queued or running in this process
        self._running: set[uuid.UUID] = set()

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
        try:
            slot.start(lambda: self.run(job))
        except Exception:
            # Not scheduled (e.g. executor shut down): stop tracking so it is not kept alive.
            with self._lock:
                self._accepted.discard(job.job_id)
            raise

    def unfinished_job_ids(self) -> set[uuid.UUID]:
        """Jobs accepted by this process that have not finished running (queued or running)."""
        with self._lock:
            return set(self._accepted)

    def running_job_ids(self) -> set[uuid.UUID]:
        """Jobs currently executing in a worker thread of this process."""
        with self._lock:
            return set(self._running)

    def run(self, job: JobInput) -> None:
        with self._lock:
            self._running.add(job.job_id)
        work_dir: Path | None = None
        try:
            work_dir = Path(tempfile.mkdtemp(prefix=f"mydubb-job-{job.job_id}-"))
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
            try:
                if work_dir is not None:
                    shutil.rmtree(work_dir, ignore_errors=True)
            finally:
                # Always stop tracking: a job left active in the database without a worker
                # then stops receiving heartbeats and is interrupted by the liveness check.
                with self._lock:
                    self._accepted.discard(job.job_id)
                    self._running.discard(job.job_id)

    def _run_stages(self, job: JobInput, work_dir: Path) -> None:
        now = datetime.now(UTC)
        self._advance(job.job_id, JobStatus.QUEUED, JobStatus.TRANSLATING, started_at=now)
        if job.timed is None:
            translation = self._translator.translate(job.transcript)
        else:
            translation = self._translator.translate_lines([b.text for b in job.timed.blocks])

        detection = self._detect(job, translation)
        terms = detection.speech_terms if detection is not None else None

        self._advance(job.job_id, JobStatus.TRANSLATING, JobStatus.SYNTHESIZING)
        if job.timed is None:
            speech = self._speech.synthesize(translation.text, job.voice, work_dir, terms=terms)
            self._advance(job.job_id, JobStatus.SYNTHESIZING, JobStatus.PROCESSING)
            target = DurationTarget(job.baseline_seconds, job.speed)
            processed = self._audio.fit_to_duration(speech, target, work_dir)
            timing = None
        else:
            # Timed mode: one clip per block, each placed in its frame of the timeline. Any
            # failure fails the job; there is no fallback to the plain flow.
            blocks = self._speech.synthesize_blocks(translation.lines, job.voice, work_dir, terms)
            self._advance(job.job_id, JobStatus.SYNTHESIZING, JobStatus.PROCESSING)
            plan = job.timed.plan(job.baseline_seconds, job.speed)
            processed = self._audio.fit_timeline(blocks, plan, work_dir)
            speech = blocks
            timing = timing_summary(job.timed, job.baseline_seconds, blocks.requests, processed)

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
                duration_report=(
                    processed.duration_report.as_dict() if processed.duration_report else None
                ),
                timing=timing,
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
        if detection is not None and detection.candidates:
            self._record_candidates(job.job_id, detection)

    def _detect(self, job: JobInput, translation: TranslationResult) -> Detection | None:
        """English kept by a real translation; None for mock text (it is the source itself)."""
        if translation.is_illustrative:
            return None
        try:
            detection = detect_english(job.transcript, translation.text, self._glossary)
        except Exception as exc:
            # Pronunciation hints are an improvement, not a requirement: speech then uses
            # the glossary alone, as before. The log names the error type only.
            logger.error(
                "Job %s: English detection failed (%s); speech uses the glossary only",
                job.job_id,
                type(exc).__name__,
            )
            return None
        counts = detection.counts()
        logger.info(
            "Job %s pronunciation: glossary=%d term=%d untranslated=%d code=%d "
            "candidates=%d ambiguous_tokens=%d unmatched_tokens=%d",
            job.job_id,
            counts["glossary"],
            counts["term"],
            counts["untranslated"],
            counts["code"],
            counts["candidates"],
            counts["ambiguous_tokens"],
            counts["unmatched_tokens"],
        )
        return detection

    def _record_candidates(self, job_id: uuid.UUID, detection: Detection) -> None:
        """Count the job's glossary candidates; never affects the completed job."""
        try:
            with session_scope(self._session_factory) as db:
                recorded = record_job_candidates(db, job_id, detection.candidates)
        except Exception as exc:
            # Rolled back as a whole (separate transaction from the job's own updates). The
            # exception text may quote SQL parameters, i.e. terms, so only its type is logged.
            logger.warning(
                "Job %s: glossary candidates were not recorded (%s); the result is unaffected",
                job_id,
                type(exc).__name__,
            )
            return
        if recorded:
            logger.info(
                "Job %s: %d glossary candidate(s) counted%s",
                job_id,
                len(detection.candidates),
                f" ({detection.dropped_candidates} over the per-job limit not counted)"
                if detection.dropped_candidates
                else "",
            )
        else:
            logger.info("Job %s: glossary candidates were already counted", job_id)

    def _advance(self, job_id: uuid.UUID, expected: JobStatus, new: JobStatus, **fields) -> None:
        with session_scope(self._session_factory) as db:
            if not service.transition(db, job_id, expected, new, **fields):
                raise _Superseded

    def _fail(self, job_id: uuid.UUID, code: str, message: str) -> None:
        try:
            with session_scope(self._session_factory) as db:
                service.mark_failed(db, job_id, code, message)
        except Exception:
            # The job stays active in the DB. This process stops heartbeating it once the
            # worker ends, so the liveness check marks it interrupted when it goes stale.
            logger.exception("Could not record failure for job %s", job_id)
