"""Job liveness, startup recovery, shutdown drain and periodic cleanup."""

import asyncio
import logging
import time

from app.access.service import delete_stale_sessions
from app.auth.service import delete_stale_auth_rows
from app.db import session_scope
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
    with session_scope(services.session_factory) as db:
        failed = fail_stale_jobs(db, services.settings.job_stale_after_seconds)
    if failed:
        logger.warning("Marked %d job(s) with a stale heartbeat as interrupted", failed)


def heartbeat(services: AppServices) -> None:
    """Refresh heartbeats of the jobs this process still has queued or running.

    The in-memory snapshot can race with a worker finishing: a job that reaches a terminal
    state in between is filtered out by its status, and a job orphaned in between gets at
    most one extra heartbeat, delaying its interruption by one interval.
    """
    owned = services.pipeline.unfinished_job_ids()
    with session_scope(services.session_factory) as db:
        heartbeat_jobs(db, services.instance_id, owned)


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


async def drain_running_jobs(services: AppServices) -> None:
    """Wait up to the configured grace period for running jobs to finish."""
    deadline = time.monotonic() + services.settings.job_shutdown_grace_seconds
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
    if removed or sessions or auth_rows:
        logger.info(
            "Cleanup removed %d result(s), %d stale session(s) and %d auth row(s)",
            removed,
            sessions,
            auth_rows,
        )


async def cleanup_loop(services: AppServices) -> None:
    interval = services.settings.cleanup_interval_seconds
    while True:
        await asyncio.sleep(interval)
        try:
            # Disk and database work runs in a thread to keep the event loop free.
            await asyncio.to_thread(run_cleanup, services)
        except Exception:
            logger.exception("Periodic cleanup failed")
