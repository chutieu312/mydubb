"""Migration 0005 against data written before it (Access Code sessions and jobs)."""

import hashlib
import uuid
from datetime import UTC, datetime, timedelta

from alembic import command
from sqlalchemy import inspect, text

from tests.conftest import alembic_config, sign_in

LEGACY_TOKEN = "legacy-session-token"


def _insert_legacy_rows(conn) -> tuple[uuid.UUID, uuid.UUID]:
    now = datetime.now(UTC)
    session_id, job_id = uuid.uuid4(), uuid.uuid4()
    conn.execute(
        text(
            "INSERT INTO access_sessions (id, token_hash, csrf_token, created_at, expires_at) "
            "VALUES (:id, :hash, 'csrf', :now, :exp)"
        ),
        {
            "id": session_id,
            "hash": hashlib.sha256(LEGACY_TOKEN.encode()).hexdigest(),
            "now": now,
            "exp": now + timedelta(hours=1),
        },
    )
    # Columns as the 0004-era code writes them (no user_id).
    conn.execute(
        text(
            "INSERT INTO jobs (id, session_id, status, voice, first_sentence_start_seconds, "
            "last_sentence_start_seconds, target_duration_seconds, transcript_char_count, "
            "translation_provider, speech_provider, audio_processor, error_code, error_message, "
            "created_at, updated_at, completed_at) VALUES (:id, :sid, 'failed', "
            "'AndrewMultilingual', 10, 70, 60, 42, 'mock-translation', 'mock-speech', "
            "'mock-audio', 'interrupted', 'm', :now, :now, :now)"
        ),
        {"id": job_id, "sid": session_id, "now": now},
    )
    return session_id, job_id


def test_0005_is_expand_only_and_gives_no_old_job_to_a_user(
    engine, database_url, make_client, make_cognito_client, fake_cognito
):
    config = alembic_config(database_url)
    command.downgrade(config, "0004")
    try:
        assert "users" not in inspect(engine).get_table_names()
        with engine.begin() as conn:
            _, job_id = _insert_legacy_rows(conn)
    finally:
        command.upgrade(config, "head")

    tables = set(inspect(engine).get_table_names())
    assert {"users", "user_sessions", "auth_challenges", "password_reset_events"} <= tables
    with engine.connect() as conn:
        assert (
            conn.execute(
                text("SELECT user_id FROM jobs WHERE id = :id"), {"id": job_id}
            ).scalar_one()
            is None
        )

    # The Access Code session and its job still work after the migration.
    beta = make_client()
    beta.cookies.set("mydubb_session", LEGACY_TOKEN)
    assert beta.get("/api/session").status_code == 200
    assert beta.get(f"/api/jobs/{job_id}").json()["status"] == "failed"

    # A Cognito user never sees it.
    fake_cognito.add_user("lan@example.com", "correct-horse-1")
    user = make_cognito_client()
    sign_in(user, "lan@example.com", "correct-horse-1")
    assert user.get(f"/api/jobs/{job_id}").status_code == 404


def test_0004_era_inserts_still_work_on_the_new_schema(engine):
    """Code from before 0005 (e.g. during a deploy overlap) keeps inserting jobs."""
    with engine.begin() as conn:
        conn.execute(text("TRUNCATE jobs, access_sessions CASCADE"))
        _, job_id = _insert_legacy_rows(conn)
        assert (
            conn.execute(
                text("SELECT user_id FROM jobs WHERE id = :id"), {"id": job_id}
            ).scalar_one()
            is None
        )
        conn.execute(text("TRUNCATE jobs, access_sessions CASCADE"))
