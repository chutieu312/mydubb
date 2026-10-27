"""Job liveness, startup recovery, shutdown drain and periodic cleanup."""

import asyncio
import logging
import time

from app.access.service import delete_stale_sessions
from app.auth.service import delete_stale_auth_rows, resolve_stale_password_resets
from app.db import session_scope
from app.guest.imports import release_stale_imports
from app.guest.service import GuestPolicy, delete_stale_rows, settle_jobs
from app.jobs.service import fail_interrupted_jobs, fail_stale_jobs, heartbeat_jobs
from app.services import AppServices

logger = logging.getLogger(__name__)


def recover_after_restart(services: AppServices) -> None:
    """Fail jobs abandoned by instances that are gone, then clean up.

    Only jobs with a stale heartbeat are failed, so jobs still running on another live
    instance (e.g. during an overlapping deploy) are not touched.
    """
    fail_stale(services)
    run_cleanup(services)


def fail_stale(services: AppServices) -> None:
    settings = services.settings
    with session_scope(services.session_factory) as db:
        failed = fail_stale_jobs(db, settings.job_stale_after_seconds)
    if failed:
        logger.warning("Marked %d job(s) with a stale heartbeat as interrupted", failed)
    # Guest imports whose instance is gone (or that outlived any import's deadline): their
    # place is given back. The provider is never called again to recover a result.
    with session_scope(services.session_factory) as db:
        released = release_stale_imports(
            db,
            stale_after_seconds=settings.job_stale_after_seconds,
            max_age_seconds=settings.supadata_deadline_seconds + settings.job_stale_after_seconds,
        )
    if released:
        logger.warning("Released %d guest import(s) whose worker stopped", released)


def heartbeat(services: AppServices) -> None:
    """Refresh heartbeats of the jobs this process still has queued or running, and of the
    guest imports it is running.

    The in-memory snapshot can race with a worker finishing: a job that reaches a terminal
    state in between is filtered out by its status, and a job orphaned in between gets at
    most one extra heartbeat, delaying its interruption by one interval.
    """
    owned = services.pipeline.unfinished_job_ids()
    with session_scope(services.session_factory) as db:
        heartbeat_jobs(db, services.instance_id, owned)
    if services.guest_imports is not None:
        # On the import runner's bounded engine, like every import step.
        services.guest_imports.heartbeat(services.instance_id)


async def job_liveness_loop(services: AppServices) -> None:
    """Keep this instance's jobs alive and fail jobs whose instance disappeared."""
    interval = services.settings.job_heartbeat_interval_seconds
    while True:
        await asyncio.sleep(interval)
        try:
            await asyncio.to_thread(heartbeat, services)
            await asyncio.to_thread(fail_stale, services)
        except Exception:
            logger.exception("Job liveness check failed")


async def drain_running_jobs(services: AppServices, deadline: float) -> None:
    """Wait until `deadline` (time.monotonic) for running jobs to finish. The deadline is the
    one shutdown budget shared with guest imports (main.py), never a grace period of its own."""
    running = services.pipeline.running_job_ids()
    if running:
        logger.info("Waiting for %d running job(s) to finish before shutdown", len(running))
    while running and time.monotonic() < deadline:
        await asyncio.sleep(0.2)
        running = services.pipeline.running_job_ids()


def interrupt_unfinished_jobs(services: AppServices) -> None:
    """On shutdown, fail jobs this process accepted but did not finish."""
    job_ids = services.pipeline.unfinished_job_ids()
    if not job_ids:
        return
    with session_scope(services.session_factory) as db:
        failed = fail_interrupted_jobs(db, job_ids)
    logger.warning("Marked %d unfinished job(s) as interrupted at shutdown", failed)


def run_cleanup(services: AppServices) -> None:
    removed = services.result_store.purge_expired()
    with session_scope(services.session_factory) as db:
        sessions = delete_stale_sessions(db)
        # Cognito sessions, finished sign-in steps and old reset events (empty in Access Code
        # mode); cleaned in both modes so nothing lingers after switching back.
        auth_rows = delete_stale_auth_rows(db)
    # Password resets whose outcome was never recorded (database error, crash): enforced as
    # resets (fail closed). Requests already refuse their sessions once they settle; this makes
    # it permanent. Its own transaction, so a failure here never blocks the cleanup above.
    with session_scope(services.session_factory) as db:
        unresolved = resolve_stale_password_resets(db)
    if unresolved:
        logger.warning("Recorded %d unresolved password reset(s) as unknown", unresolved)
    # Guest quota places whose job already ended without settling them (e.g. failed by an
    # instance running code from before guest access), then expired guest data. Also with guest
    # access off, so nothing lingers after turning it off.
    with session_scope(services.session_factory) as db:
        settled = settle_jobs(db)
        guest_rows = delete_stale_rows(db, _guest_retention(services))
    if settled:
        logger.warning("Settled %d guest quota place(s) of jobs that had ended", settled)
    if removed or sessions or auth_rows or guest_rows:
        logger.info(
            "Cleanup removed %d result(s), %d stale session(s), %d auth row(s) and %d guest row(s)",
            removed,
            sessions,
            auth_rows,
            guest_rows,
        )


def _guest_retention(services: AppServices) -> GuestPolicy:
    # The configured windows even with guest access off (they have defaults).
    return GuestPolicy.from_settings(services.settings)


async def cleanup_loop(services: AppServices) -> None:
    interval = services.settings.cleanup_interval_seconds
    while True:
        await asyncio.sleep(interval)
        try:
            # Disk and database work runs in a thread to keep the event loop free.
            await asyncio.to_thread(run_cleanup, services)
        except Exception:
            logger.exception("Periodic cleanup failed")
