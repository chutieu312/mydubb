"""Startup recovery and periodic cleanup."""

import asyncio
import logging

from app.access.service import delete_stale_sessions
from app.db import session_scope
from app.jobs.service import fail_interrupted_jobs
from app.services import AppServices

logger = logging.getLogger(__name__)


def recover_after_restart(services: AppServices) -> None:
    with session_scope(services.session_factory) as db:
        failed = fail_interrupted_jobs(db)
    if failed:
        logger.warning("Marked %d interrupted job(s) as failed after restart", failed)
    run_cleanup(services)


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
    if removed or sessions:
        logger.info("Cleanup removed %d result(s) and %d stale session(s)", removed, sessions)


async def cleanup_loop(services: AppServices) -> None:
    interval = services.settings.cleanup_interval_seconds
    while True:
        await asyncio.sleep(interval)
        try:
            # Disk and database work runs in a thread to keep the event loop free.
            await asyncio.to_thread(run_cleanup, services)
        except Exception:
            logger.exception("Periodic cleanup failed")
