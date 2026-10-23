"""AUDIO_PROCESSOR=ffmpeg: configuration, labels and the job flow (fake Azure, real FFmpeg)."""

import glob
import json
import subprocess
import tempfile
import uuid
from collections.abc import Callable, Iterator
from datetime import UTC, datetime, timedelta

import httpx
import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from app.audio import fitter
from app.audio.ffmpeg import AudioToolError, AudioTools
from app.audio.fitter import FfmpegAudioProcessor
from app.audio.mock import MockAudioProcessor
from app.config import ConfigurationError, Settings
from app.main import create_app
from app.services import build_services
from app.storage.result_store import LocalFileResultStore, ResultContent
from tests.audio_helpers import RATE, make_wav
from tests.conftest import create_job, login, wait_for_terminal

SPEECH_KEY = "speech-key-0123456789abcdef-different"
TRANSLATOR_KEY = "translator-key-0123456789abcdef"
REAL_SPEECH = {
    "speech_provider": "azure",
    "azure_speech_key": SPEECH_KEY,
    "azure_speech_region": "westus2",
    "audio_processor": "ffmpeg",
}
ALL_REAL = {
    **REAL_SPEECH,
    "translation_provider": "azure",
    "azure_translator_key": TRANSLATOR_KEY,
    "provider_mode": "azure",
}
EIGHT_SECONDS = {"first_sentence_start": "00:00:00", "last_sentence_start": "00:00:08"}
NATURAL_SECONDS = 5.3  # the fake speech service always answers with this much speech


def vietnamese(request: httpx.Request) -> httpx.Response:
    items = json.loads(request.content)
    return httpx.Response(
        200, json=[{"translations": [{"text": i["Text"], "to": "vi"}]} for i in items]
    )


def natural_speech(request: httpx.Request) -> httpx.Response:
    return httpx.Response(200, content=make_wav(NATURAL_SECONDS))


# --- configuration ------------------------------------------------------------------------------


def test_audio_processing_defaults_to_the_mock_pass_through(make_settings):
    assert make_settings().component_providers["audio"] == "mock"


def test_ffmpeg_audio_is_reported_per_component(make_settings):
    settings = make_settings(**REAL_SPEECH)
    assert settings.component_providers == {
        "translation": "mock",
        "speech": "azure",
        "audio": "ffmpeg",
    }
    assert settings.is_mock_mode is True  # translation is still a mock


def test_ffmpeg_needs_real_speech_audio_to_adjust(make_settings):
    with pytest.raises(ValidationError, match="SPEECH_PROVIDER=azure"):
        make_settings(audio_processor="ffmpeg")


def test_the_audio_failure_scenario_only_applies_to_the_mock_processor(make_settings):
    with pytest.raises(ValidationError, match="MOCK_FAIL_STAGE=audio"):
        make_settings(**REAL_SPEECH, mock_fail_stage="audio")


def test_azure_provider_mode_needs_every_component_to_be_real(make_settings):
    settings = make_settings(**ALL_REAL)
    assert settings.component_providers == {
        "translation": "azure",
        "speech": "azure",
        "audio": "ffmpeg",
    }
    assert settings.is_mock_mode is False
    for missing, expected in (
        ({"translation_provider": "mock"}, "TRANSLATION_PROVIDER=azure"),
        ({"speech_provider": "mock"}, "SPEECH_PROVIDER=azure"),
        ({"audio_processor": "mock"}, "AUDIO_PROCESSOR=ffmpeg"),
    ):
        with pytest.raises(ValidationError, match=expected):
            make_settings(**{**ALL_REAL, **missing})


def test_production_needs_no_mock_opt_in_when_everything_is_real(make_settings):
    production = {"app_env": "production", "access_code": "x" * 32, "cookie_secure": True}
    settings = make_settings(**ALL_REAL, **production)
    assert settings.allow_mock_providers_in_production is False
    # Without the real audio processor it is still a mock configuration.
    with pytest.raises(ValidationError):
        make_settings(**{**ALL_REAL, "audio_processor": "mock"}, **production)
    mixed = {**ALL_REAL, "provider_mode": "mock"}
    with pytest.raises(ValidationError, match="Mock providers"):
        make_settings(**mixed, **production)


def test_startup_fails_without_ffmpeg_instead_of_using_the_mock(make_settings, monkeypatch):
    monkeypatch.setattr("app.services.locate_tools", lambda: None)
    with pytest.raises(ConfigurationError, match="AUDIO_PROCESSOR=ffmpeg"):
        build_services(make_settings(**REAL_SPEECH))


def test_startup_fails_when_ffmpeg_lacks_the_tempo_filter(make_settings, monkeypatch, audio_tools):
    def missing(tools: AudioTools) -> None:
        raise AudioToolError("a required FFmpeg component is missing")

    monkeypatch.setattr("app.services.check_capabilities", missing)
    with pytest.raises(ConfigurationError, match="atempo"):
        build_services(make_settings(**REAL_SPEECH))


def test_the_processor_follows_the_setting(make_settings, db_engine, audio_tools):
    real = build_services(make_settings(**REAL_SPEECH))
    mock = build_services(make_settings())
    try:
        assert isinstance(real.audio, FfmpegAudioProcessor)
        assert isinstance(mock.audio, MockAudioProcessor)
        assert real.pipeline.provider_names()["audio_processor"] == "ffmpeg-audio"
        assert mock.pipeline.provider_names()["audio_processor"] == "mock-audio"
    finally:
        real.engine.dispose()
        mock.engine.dispose()


# --- result store ---------------------------------------------------------------------------------


def test_the_stored_result_keeps_the_duration_report(tmp_path):
    store = LocalFileResultStore(tmp_path / "results")
    job_id = uuid.uuid4()
    audio = tmp_path / "a.mp3"
    audio.write_bytes(b"mp3")
    report = {"target_seconds": 8, "mp3_decoded_samples": 192000}
    expires = datetime.now(UTC) + timedelta(hours=1)
    store.save(job_id, ResultContent("t", False, audio, False, True, report), expires)
    stored = store.get(job_id)
    assert stored is not None
    assert stored.duration_report == report

    other = uuid.uuid4()
    audio.write_bytes(b"mp3")
    store.save(other, ResultContent("t", False, audio, False, False), expires)
    assert store.get(other).duration_report is None


# --- end-to-end job flow --------------------------------------------------------------------------


@pytest.fixture
def audio_client(
    make_settings: Callable[..., Settings], db_engine, audio_tools: AudioTools
) -> Iterator[Callable[..., TestClient]]:
    clients: list[TestClient] = []

    def factory(*, speech_handler=natural_speech, **overrides) -> TestClient:
        settings = make_settings(**{**REAL_SPEECH, **overrides})
        services = build_services(
            settings,
            translation_transport=httpx.MockTransport(vietnamese),
            speech_transport=httpx.MockTransport(speech_handler),
        )
        client = TestClient(create_app(services=services))
        client.__enter__()
        clients.append(client)
        return client

    yield factory
    for client in reversed(clients):
        client.__exit__(None, None, None)


def decoded_sample_count(audio_tools: AudioTools, mp3: bytes, tmp_path) -> int:
    source = tmp_path / "downloaded.mp3"
    source.write_bytes(mp3)
    pcm = tmp_path / "downloaded.s16le"
    subprocess.run(  # noqa: S603
        [audio_tools.ffmpeg, "-v", "error", "-y", "-i", str(source), "-f", "s16le", str(pcm)],
        check=True,
        capture_output=True,
    )
    return pcm.stat().st_size // 2


def test_meta_reports_the_real_audio_processor(audio_client):
    meta = audio_client().get("/api/meta").json()
    assert meta["providers"] == {"translation": "mock", "speech": "azure", "audio": "ffmpeg"}
    assert SPEECH_KEY not in json.dumps(meta)


def test_meta_of_the_full_azure_mode_has_no_mock_component(audio_client):
    meta = audio_client(**ALL_REAL).get("/api/meta").json()
    assert meta["provider_mode"] == "azure"
    assert meta["mock_mode"] is False
    assert meta["providers"] == {"translation": "azure", "speech": "azure", "audio": "ffmpeg"}


def test_meta_names_the_mode_by_what_is_really_running(audio_client):
    """PROVIDER_MODE=mock with every component real (the Render setup) is reported as azure."""
    client = audio_client(
        provider_mode="mock", translation_provider="azure", azure_translator_key=TRANSLATOR_KEY
    )
    meta = client.get("/api/meta").json()
    assert meta["provider_mode"] == "azure"
    assert meta["mock_mode"] is False


def test_the_result_has_exactly_the_target_duration(audio_client, audio_tools, tmp_path):
    client = audio_client()
    csrf = login(client)
    job = wait_for_terminal(client, create_job(client, csrf, **EIGHT_SECONDS).json()["id"], 60)
    assert job["status"] == "completed", job
    assert job["target_duration_seconds"] == 8

    result = client.get(f"/api/jobs/{job['id']}/result").json()
    audio = result["audio"]
    assert audio["duration_adjusted"] is True
    assert audio["provider"] == "azure-speech"
    duration = audio["duration"]
    target_samples = 8 * RATE
    assert duration["target_seconds"] == 8
    assert duration["target_samples"] == target_samples
    assert duration["source_samples"] == round(NATURAL_SECONDS * RATE)
    assert duration["source_seconds"] == NATURAL_SECONDS
    assert duration["processed_samples"] == target_samples
    assert abs(duration["mp3_decoded_samples"] - target_samples) <= 1
    assert abs(duration["mp3_header_samples"] - target_samples) <= 1
    assert duration["mp3_container_seconds"] >= 8.0  # ffprobe's own figure, recorded as is
    assert duration["tempo_factor"] == pytest.approx(NATURAL_SECONDS / 8, rel=0.01)
    notices = " ".join(result["notices"])
    assert "exactly the target duration" in notices
    assert "has not been adjusted" not in notices

    # The file a user downloads decodes to the target length.
    downloaded = client.get(audio["download_url"])
    assert downloaded.status_code == 200
    assert (
        abs(decoded_sample_count(audio_tools, downloaded.content, tmp_path) - target_samples) <= 1
    )


def test_the_job_records_the_real_audio_processor(audio_client, db_engine):
    client = audio_client()
    csrf = login(client)
    job = wait_for_terminal(client, create_job(client, csrf, **EIGHT_SECONDS).json()["id"], 60)
    with db_engine.connect() as conn:
        names = conn.exec_driver_sql(
            "SELECT speech_provider, audio_processor FROM jobs WHERE id = %s", (job["id"],)
        ).one()
    assert tuple(names) == ("azure-speech", "ffmpeg-audio")


def test_the_mock_processor_still_reports_an_unadjusted_result(audio_client):
    client = audio_client(audio_processor="mock")
    csrf = login(client)
    job = wait_for_terminal(client, create_job(client, csrf, **EIGHT_SECONDS).json()["id"], 60)
    assert job["status"] == "completed", job
    audio = client.get(f"/api/jobs/{job['id']}/result").json()["audio"]
    assert audio["duration_adjusted"] is False
    assert audio["duration"] is None


def test_an_audio_failure_fails_the_job_without_a_partial_result(audio_client, monkeypatch):
    def broken(*args, **kwargs):
        raise AudioToolError("failed")

    monkeypatch.setattr(fitter, "encode_mp3", broken)
    client = audio_client()
    csrf = login(client)
    job = wait_for_terminal(client, create_job(client, csrf, **EIGHT_SECONDS).json()["id"], 60)

    assert job["status"] == "failed"
    assert job["error"]["code"] == "audio_processing_failed"
    result = client.get(f"/api/jobs/{job['id']}/result")
    assert result.status_code == 409
    assert client.app.state.services.result_store.get(uuid.UUID(job["id"])) is None
    assert glob.glob(f"{tempfile.gettempdir()}/mydubb-job-{job['id']}-*") == []


def test_work_files_are_removed_after_a_successful_job(audio_client):
    client = audio_client()
    csrf = login(client)
    job = wait_for_terminal(client, create_job(client, csrf, **EIGHT_SECONDS).json()["id"], 60)
    assert job["status"] == "completed"
    assert glob.glob(f"{tempfile.gettempdir()}/mydubb-job-{job['id']}-*") == []


def test_shutdown_stops_the_audio_processor(make_settings, db_engine, audio_tools):
    services = build_services(
        make_settings(**REAL_SPEECH),
        translation_transport=httpx.MockTransport(vietnamese),
        speech_transport=httpx.MockTransport(natural_speech),
    )
    with TestClient(create_app(services=services)):
        assert not services.audio._cancel.is_set()
    assert services.audio._cancel.is_set()
