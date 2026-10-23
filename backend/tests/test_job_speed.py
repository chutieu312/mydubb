"""Audio speed through the API (mock providers): validation, persistence, old data."""

import uuid

import pytest
from sqlalchemy import text

from app.storage.result_store import ResultContent
from tests.conftest import VALID_JOB, create_job, login, wait_for_terminal

SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2]


def field_errors(response) -> dict[str, str]:
    assert response.status_code == 422, response.text
    body = response.json()["error"]
    assert body["code"] == "validation_error"
    return {f["field"]: f["message"] for f in body["fields"]}


def job_speed_percent(db_engine, job_id) -> int:
    with db_engine.connect() as conn:
        return conn.execute(
            text("SELECT audio_speed_percent FROM jobs WHERE id = :id"), {"id": job_id}
        ).scalar_one()


def post_without_speed(client, csrf):
    body = {k: v for k, v in VALID_JOB.items() if k != "voice"}
    return client.post("/api/jobs", json=body, headers={"X-CSRF-Token": csrf})


def test_a_request_without_speed_is_one_x(client, db_engine):
    csrf = login(client)
    response = post_without_speed(client, csrf)
    assert response.status_code == 202
    body = response.json()
    assert body["speed"] == 1
    assert body["target_duration_seconds"] == 360
    assert body["baseline_duration_seconds"] == 360
    assert body["output_duration_seconds"] == 360
    assert job_speed_percent(db_engine, body["id"]) == 100


@pytest.mark.parametrize("speed", SPEEDS)
def test_each_supported_speed_is_stored_and_reported(client, db_engine, speed):
    csrf = login(client)
    created = create_job(client, csrf, speed=speed)
    assert created.status_code == 202
    job_id = created.json()["id"]
    assert created.json()["speed"] == speed
    assert job_speed_percent(db_engine, job_id) == round(speed * 100)

    final = wait_for_terminal(client, job_id)
    assert final["status"] == "completed"
    # The baseline keeps its meaning (last - first, 360 s); the output length is computed by
    # the server from it, never taken from the request.
    assert final["speed"] == speed
    assert final["target_duration_seconds"] == 360
    assert final["baseline_duration_seconds"] == 360
    assert final["output_duration_seconds"] == pytest.approx(360 / speed)


def test_baseline_twenty_seconds_gives_the_documented_outputs(client):
    csrf = login(client)
    expected = {0.5: 40, 0.75: 80 / 3, 1: 20, 1.25: 16, 1.5: 40 / 3, 1.75: 80 / 7, 2: 10}
    for speed, output in expected.items():
        body = create_job(
            client,
            csrf,
            first_sentence_start="00:00:05",
            last_sentence_start="00:00:25",
            speed=speed,
        ).json()
        assert body["baseline_duration_seconds"] == 20
        assert body["output_duration_seconds"] == pytest.approx(output, abs=1e-12)


@pytest.mark.parametrize(
    "speed",
    [None, True, False, "1", "1.5", "2x", "", 0, -1, 0.25, 1.1, 1.2500001, 2.5, 3, 100, [1], {}],
)
def test_other_speeds_are_rejected(client, db_engine, speed):
    csrf = login(client)
    assert "speed" in field_errors(create_job(client, csrf, speed=speed))
    with db_engine.connect() as conn:
        assert conn.execute(text("SELECT count(*) FROM jobs")).scalar_one() == 0


def test_an_output_duration_sent_by_the_client_is_never_trusted(client):
    csrf = login(client)
    response = create_job(client, csrf, speed=2, output_duration_seconds=1)
    assert response.status_code == 202
    assert response.json()["output_duration_seconds"] == 180


def test_the_result_repeats_the_submitted_speed(client):
    csrf = login(client)
    job_id = create_job(client, csrf, speed=1.5).json()["id"]
    assert wait_for_terminal(client, job_id)["status"] == "completed"
    result = client.get(f"/api/jobs/{job_id}/result").json()
    assert result["speed"] == 1.5
    assert result["baseline_duration_seconds"] == 360
    assert result["output_duration_seconds"] == 240
    # The mock audio is a fixture that is not adjusted: say so instead of implying 1.5x audio.
    assert result["audio"]["duration"] is None
    notices = " ".join(result["notices"])
    assert "Audio speed 1.5x was selected" in notices
    assert "does not adjust duration" in notices


def test_one_x_adds_no_speed_notice(client):
    csrf = login(client)
    job_id = create_job(client, csrf, speed=1).json()["id"]
    assert wait_for_terminal(client, job_id)["status"] == "completed"
    notices = " ".join(client.get(f"/api/jobs/{job_id}/result").json()["notices"])
    assert "Audio speed" not in notices


def test_jobs_keep_their_own_speed(client):
    """A later job with another speed never changes what an earlier job says it used."""
    csrf = login(client)
    first = create_job(client, csrf, speed=0.5).json()["id"]
    assert wait_for_terminal(client, first)["status"] == "completed"
    second = create_job(client, csrf, speed=2).json()["id"]
    assert wait_for_terminal(client, second)["status"] == "completed"

    assert client.get(f"/api/jobs/{first}").json()["speed"] == 0.5
    assert client.get(f"/api/jobs/{first}/result").json()["speed"] == 0.5
    assert client.get(f"/api/jobs/{second}").json()["speed"] == 2
    assert client.get(f"/api/jobs/{second}/result").json()["speed"] == 2


def test_a_job_row_written_before_the_option_existed_reads_as_one_x(client, db_engine):
    """The column default makes rows from older code (which never writes it) 1x."""
    csrf = login(client)
    job_id = create_job(client, csrf).json()["id"]
    assert wait_for_terminal(client, job_id)["status"] == "completed"
    with db_engine.begin() as conn:
        # What the previous release did: an INSERT without the new column.
        old_id = conn.execute(
            text(
                "INSERT INTO jobs (id, session_id, status, voice, first_sentence_start_seconds,"
                " last_sentence_start_seconds, target_duration_seconds, transcript_char_count,"
                " translation_provider, speech_provider, audio_processor, created_at, updated_at)"
                " SELECT gen_random_uuid(), session_id, 'completed', 'HoaiMy', 10, 370, 360, 5,"
                " 'mock-translation', 'mock-speech', 'mock-audio', now(), now()"
                " FROM jobs WHERE id = :id RETURNING id"
            ),
            {"id": job_id},
        ).scalar_one()
    body = client.get(f"/api/jobs/{old_id}").json()
    assert body["speed"] == 1
    assert body["baseline_duration_seconds"] == 360
    assert body["output_duration_seconds"] == 360


def test_the_database_refuses_an_unsupported_speed(client, db_engine):
    csrf = login(client)
    job_id = create_job(client, csrf).json()["id"]
    with pytest.raises(Exception, match="audio_speed_valid"), db_engine.begin() as conn:
        conn.execute(
            text("UPDATE jobs SET audio_speed_percent = 130 WHERE id = :id"), {"id": job_id}
        )


def test_a_stored_result_without_speed_in_its_report_reads_as_one_x(client):
    """A result written by the previous release (report has no speed/baseline) stays readable."""
    csrf = login(client)
    job_id = create_job(client, csrf).json()["id"]
    assert wait_for_terminal(client, job_id)["status"] == "completed"
    store = client.app.state.services.result_store
    stored = store.get(uuid.UUID(job_id))
    legacy_report = {
        "sample_rate": 24000,
        "target_seconds": 360,
        "target_samples": 8_640_000,
        "source_seconds": 370.0,
        "source_samples": 8_880_000,
        "processed_seconds": 360.0,
        "processed_samples": 8_640_000,
        "mp3_decoded_seconds": 360.0,
        "mp3_decoded_samples": 8_640_000,
        "mp3_header_seconds": 360.0,
        "mp3_header_samples": 8_640_000,
        "mp3_container_seconds": 360.048,
        "tempo_factor": 1.0278,
        "padded_samples": 4,
        "trimmed_samples": 0,
        "tempo_passes": 1,
    }
    audio = stored.audio_path.parent / "copy.mp3"
    audio.write_bytes(stored.audio_path.read_bytes())
    store.save(
        uuid.UUID(job_id),
        ResultContent(
            translation_text=stored.translation_text,
            translation_is_illustrative=False,
            audio_file=audio,
            audio_is_fixture=False,
            duration_adjusted=True,
            duration_report=legacy_report,
        ),
        stored.expires_at,
    )
    duration = client.get(f"/api/jobs/{job_id}/result").json()["audio"]["duration"]
    assert duration["speed"] == 1
    assert duration["baseline_seconds"] == 360
    assert duration["target_seconds"] == 360
    assert duration["target_samples"] == 8_640_000
