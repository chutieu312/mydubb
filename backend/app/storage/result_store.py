"""Temporary storage for job results (translated text + final MP3).

Results live on the instance's local disk and expire after a TTL. They are never
written to PostgreSQL. On hosts with ephemeral disks (e.g. Render Free) results are
also lost on restart/redeploy; readers then receive an explicit "result expired" response.
"""

import json
import logging
import shutil
import threading
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Protocol

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class ResultContent:
    translation_text: str
    translation_is_illustrative: bool
    audio_file: Path  # source file; moved into the store on save
    audio_is_fixture: bool
    duration_adjusted: bool
    # Measured durations of the final audio (see DurationReport.as_dict); None if not adjusted.
    duration_report: dict | None = None


@dataclass(frozen=True)
class StoredResult:
    translation_text: str
    translation_is_illustrative: bool
    audio_path: Path
    audio_is_fixture: bool
    duration_adjusted: bool
    expires_at: datetime
    duration_report: dict | None = None


class ResultStore(Protocol):
    def save(self, job_id: uuid.UUID, content: ResultContent, expires_at: datetime) -> None: ...

    def get(self, job_id: uuid.UUID) -> StoredResult | None:
        """Return the result, or None if it never existed, expired or was cleaned up."""
        ...

    def delete(self, job_id: uuid.UUID) -> None: ...

    def purge_expired(self) -> int: ...


_META = "meta.json"
_TEXT = "translation.txt"
_AUDIO = "audio.mp3"


_STAGING_PREFIX = ".staging-"


class LocalFileResultStore:
    """Results under `root/<job_id>/`, published atomically from `root/.staging-<job_id>/`.

    Readers only ever see a directory created by a rename of a fully written staging
    directory, so a partially written result is never observable.

    Active saves are tracked in memory, under a lock shared with cleanup, so cleanup
    never deletes the staging directory of a save in progress. This matches the
    documented single-process model; staging directories left by a crashed or previous
    process are not tracked and are removed by the next cleanup.
    """

    def __init__(self, root: Path) -> None:
        self._root = root
        self._root.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._active_saves: set[str] = set()

    def save(self, job_id: uuid.UUID, content: ResultContent, expires_at: datetime) -> None:
        key = str(job_id)
        final_dir = self._root / key
        staging = self._root / f"{_STAGING_PREFIX}{key}"
        with self._lock:
            if key in self._active_saves:
                raise RuntimeError(f"Result for job {key} is already being saved")
            self._active_saves.add(key)
        try:
            shutil.rmtree(staging, ignore_errors=True)
            staging.mkdir()
            try:
                self._write_staging(staging, content, expires_at)
                shutil.rmtree(final_dir, ignore_errors=True)
                staging.rename(final_dir)
            except Exception:
                shutil.rmtree(staging, ignore_errors=True)
                raise
        finally:
            with self._lock:
                self._active_saves.discard(key)

    def _write_staging(self, staging: Path, content: ResultContent, expires_at: datetime) -> None:
        (staging / _TEXT).write_text(content.translation_text, encoding="utf-8")
        shutil.move(content.audio_file, staging / _AUDIO)
        meta = {
            "translation_is_illustrative": content.translation_is_illustrative,
            "audio_is_fixture": content.audio_is_fixture,
            "duration_adjusted": content.duration_adjusted,
            "duration_report": content.duration_report,
            "expires_at": expires_at.isoformat(),
        }
        # Metadata is written last; a directory without it is never treated as a result.
        (staging / _META).write_text(json.dumps(meta), encoding="utf-8")

    def get(self, job_id: uuid.UUID) -> StoredResult | None:
        directory = self._root / str(job_id)
        meta = self._read_meta(directory)
        if meta is None:
            return None
        expires_at = meta["expires_at"]
        if expires_at <= datetime.now(UTC):
            shutil.rmtree(directory, ignore_errors=True)
            return None
        try:
            translation_text = (directory / _TEXT).read_text(encoding="utf-8")
        except FileNotFoundError:
            # Removed concurrently by cleanup or delete: report it as gone, not as an error.
            return None
        return StoredResult(
            translation_text=translation_text,
            translation_is_illustrative=bool(meta["translation_is_illustrative"]),
            audio_path=directory / _AUDIO,
            audio_is_fixture=bool(meta["audio_is_fixture"]),
            duration_adjusted=bool(meta["duration_adjusted"]),
            expires_at=expires_at,
            duration_report=meta.get("duration_report"),
        )

    def delete(self, job_id: uuid.UUID) -> None:
        shutil.rmtree(self._root / str(job_id), ignore_errors=True)

    def purge_expired(self) -> int:
        """Delete expired, unreadable and abandoned entries. Returns the number removed."""
        now = datetime.now(UTC)
        removed = 0
        for entry in self._root.iterdir():
            if not entry.is_dir():
                continue
            if entry.name.startswith(_STAGING_PREFIX):
                key = entry.name.removeprefix(_STAGING_PREFIX)
                # Hold the lock while deciding and deleting so a save cannot start
                # writing into this directory in between.
                with self._lock:
                    if key in self._active_saves:
                        continue
                    shutil.rmtree(entry, ignore_errors=True)
                removed += 1
                continue
            meta = self._read_meta(entry)
            if meta is None or meta["expires_at"] <= now:
                shutil.rmtree(entry, ignore_errors=True)
                removed += 1
        return removed

    @staticmethod
    def _read_meta(directory: Path) -> dict | None:
        """Parsed metadata (with `expires_at` as datetime), or None if missing/unreadable."""
        try:
            meta = json.loads((directory / _META).read_text(encoding="utf-8"))
            meta["expires_at"] = datetime.fromisoformat(meta["expires_at"])
        except (FileNotFoundError, NotADirectoryError):
            return None
        except (OSError, ValueError, KeyError, TypeError):
            logger.warning("Unreadable result metadata in %s", directory.name)
            return None
        if not (directory / _AUDIO).is_file() or not (directory / _TEXT).is_file():
            return None
        return meta
