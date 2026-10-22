"""LocalFileResultStore: atomic publication, cleanup races, and expiration."""

import shutil
import threading
import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from app.storage.result_store import LocalFileResultStore, ResultContent

WAIT = 5  # seconds; only a safety net so a broken test fails instead of hanging


def content(tmp_path: Path, text: str = "translated") -> ResultContent:
    audio = tmp_path / f"source-{uuid.uuid4()}.mp3"
    audio.write_bytes(b"mp3-bytes")
    return ResultContent(
        translation_text=text,
        translation_is_illustrative=True,
        audio_file=audio,
        audio_is_fixture=True,
        duration_adjusted=False,
    )


def in_one_hour() -> datetime:
    return datetime.now(UTC) + timedelta(hours=1)


class PausingStore(LocalFileResultStore):
    """Pauses inside save() so the test controls exactly when cleanup interleaves."""

    def __init__(self, root: Path, pause_after_write: bool) -> None:
        super().__init__(root)
        self.pause_after_write = pause_after_write
        self.paused = threading.Event()
        self.resume = threading.Event()

    def _write_staging(self, staging, content, expires_at):
        if not self.pause_after_write:
            self._pause()
        super()._write_staging(staging, content, expires_at)
        if self.pause_after_write:
            self._pause()

    def _pause(self) -> None:
        self.paused.set()
        assert self.resume.wait(WAIT), "test never resumed the save"


@pytest.mark.parametrize("pause_after_write", [False, True], ids=["mid-write", "pre-publish"])
def test_cleanup_during_active_save_keeps_it_and_save_succeeds(tmp_path, pause_after_write):
    store = PausingStore(tmp_path / "results", pause_after_write)
    job_id = uuid.uuid4()
    errors: list[BaseException] = []

    def save() -> None:
        try:
            store.save(job_id, content(tmp_path), in_one_hour())
        except BaseException as exc:
            errors.append(exc)

    worker = threading.Thread(target=save)
    worker.start()
    assert store.paused.wait(WAIT)

    staging = tmp_path / "results" / f".staging-{job_id}"
    assert staging.is_dir()
    assert store.purge_expired() == 0
    assert staging.is_dir()
    # Nothing is published until the save completes.
    assert store.get(job_id) is None

    store.resume.set()
    worker.join(WAIT)
    assert not worker.is_alive()
    assert errors == []

    result = store.get(job_id)
    assert result is not None
    assert result.translation_text == "translated"
    assert result.audio_path.read_bytes() == b"mp3-bytes"
    assert not staging.exists()


def test_abandoned_staging_directories_are_cleaned_up(tmp_path):
    root = tmp_path / "results"
    root.mkdir()
    # Simulates a crash mid-save in a previous process: never tracked as active here.
    abandoned = root / f".staging-{uuid.uuid4()}"
    abandoned.mkdir()
    (abandoned / "translation.txt").write_text("partial")
    store = LocalFileResultStore(root)

    assert store.purge_expired() == 1
    assert not abandoned.exists()


def test_completed_save_leaves_no_staging_directory(tmp_path):
    store = LocalFileResultStore(tmp_path / "results")
    store.save(uuid.uuid4(), content(tmp_path), in_one_hour())
    assert [p.name for p in (tmp_path / "results").iterdir() if p.name.startswith(".")] == []


def test_failed_save_removes_its_staging_and_publishes_nothing(tmp_path):
    store = LocalFileResultStore(tmp_path / "results")
    job_id = uuid.uuid4()
    broken = content(tmp_path)
    broken.audio_file.unlink()  # moving the audio will fail

    with pytest.raises(FileNotFoundError):
        store.save(job_id, broken, in_one_hour())
    assert store.get(job_id) is None
    assert list((tmp_path / "results").iterdir()) == []


def test_expired_results_are_not_served_and_are_purged(tmp_path):
    store = LocalFileResultStore(tmp_path / "results")
    expired, fresh = uuid.uuid4(), uuid.uuid4()
    store.save(expired, content(tmp_path), datetime.now(UTC) - timedelta(seconds=1))
    store.save(fresh, content(tmp_path), in_one_hour())

    assert store.get(expired) is None
    assert store.purge_expired() == 0  # get() already removed the expired entry
    assert store.get(fresh) is not None

    store.save(expired, content(tmp_path), datetime.now(UTC) - timedelta(seconds=1))
    assert store.purge_expired() == 1
    assert not (tmp_path / "results" / str(expired)).exists()
    assert store.get(fresh) is not None


def test_unreadable_metadata_is_purged(tmp_path):
    store = LocalFileResultStore(tmp_path / "results")
    job_id = uuid.uuid4()
    store.save(job_id, content(tmp_path), in_one_hour())
    (tmp_path / "results" / str(job_id) / "meta.json").write_text("{not json")

    assert store.get(job_id) is None
    assert store.purge_expired() == 1


def test_result_removed_while_being_read_reports_gone_instead_of_crashing(tmp_path):
    class RemovedAfterMetaRead(LocalFileResultStore):
        @staticmethod
        def _read_meta(directory):
            meta = LocalFileResultStore._read_meta(directory)
            shutil.rmtree(directory)  # cleanup/delete wins the race here
            return meta

    store = RemovedAfterMetaRead(tmp_path / "results")
    job_id = uuid.uuid4()
    LocalFileResultStore.save(store, job_id, content(tmp_path), in_one_hour())

    assert store.get(job_id) is None
