"""Usage retention and the migration: cleanup touches only usage; the schema is expand-only."""

import uuid
from datetime import UTC, datetime, timedelta

import pytest
from alembic import command
from alembic.script import ScriptDirectory
from pydantic import ValidationError
from sqlalchemy import Engine, inspect, text
from sqlalchemy.orm import sessionmaker

from app import maintenance
from app.db import session_scope
from tests.conftest import alembic_config
from tests.test_job_liveness import new_job
from tests.test_usage_report import add_job


def count(engine: Engine, table: str) -> int:
    with engine.connect() as conn:
        return conn.execute(text(f"SELECT count(*) FROM {table}")).scalar_one()  # noqa: S608


def test_cleanup_deletes_only_usage_older_than_the_retention(make_client, db_engine):
    client = make_client(usage_retention_days=30)
    services = client.app.state.services
    now = datetime.now(UTC)
    old = add_job(db_engine, started=now - timedelta(days=31))
    edge = add_job(db_engine, started=now - timedelta(days=29))
    recent = add_job(db_engine, started=now - timedelta(hours=1))
    # Product data that must survive: a job row (even one whose usage is old), and sessions.
    job = new_job(services)
    add_job(db_engine, started=now - timedelta(days=400), job_id=job.job_id)
    jobs_before = count(db_engine, "jobs")
    sessions_before = count(db_engine, "access_sessions")

    maintenance.run_cleanup(services)

    with db_engine.connect() as conn:
        kept = {r[0] for r in conn.execute(text("SELECT job_id FROM job_usage"))}
        kept_attempts = {r[0] for r in conn.execute(text("SELECT job_id FROM job_usage_attempts"))}
    assert kept == {edge, recent} == kept_attempts
    assert old not in kept and job.job_id not in kept
    assert count(db_engine, "jobs") == jobs_before  # the cleanup never deletes a job
    assert count(db_engine, "access_sessions") == sessions_before


def test_a_failing_usage_purge_does_not_stop_the_rest_of_the_cleanup(
    make_client, db_engine, monkeypatch
):
    client = make_client()
    services = client.app.state.services

    def broken(*args, **kwargs):
        raise RuntimeError("boom")

    monkeypatch.setattr(maintenance, "delete_usage_older_than", broken)
    maintenance.run_cleanup(services)  # no exception


def test_deleting_a_job_row_does_not_delete_its_usage(db_engine, make_client):
    services = make_client().app.state.services
    job = new_job(services)
    add_job(db_engine, job_id=job.job_id)
    with session_scope(sessionmaker(bind=db_engine)) as db:
        db.execute(text("DELETE FROM jobs WHERE id = :id"), {"id": job.job_id})
    assert count(db_engine, "job_usage") == 1 and count(db_engine, "job_usage_attempts") == 2


def test_the_retention_setting_has_a_documented_range(make_settings):
    assert make_settings().usage_retention_days == 180
    assert make_settings().usage_recording_enabled is True
    for value in (0, 6, 3651):
        with pytest.raises(ValidationError):
            make_settings(usage_retention_days=value)


# --- migration ------------------------------------------------------------------------------------


def test_there_is_a_single_alembic_head(database_url):
    heads = ScriptDirectory.from_config(alembic_config(database_url)).get_heads()
    assert len(heads) == 1, f"several heads {heads}: re-point down_revision of the later migration"


def test_the_migration_is_expand_only_reversible_and_leaves_the_admin_roles_alone(
    engine, database_url
):
    config = alembic_config(database_url)
    user = uuid.uuid4()
    with engine.begin() as conn:
        conn.execute(text("TRUNCATE jobs, job_usage, job_usage_attempts, users CASCADE"))
        conn.execute(
            text(
                "INSERT INTO users (id, cognito_issuer, cognito_sub, email, email_normalized, "
                "role, created_at, updated_at) VALUES (:id, 'issuer', 'sub-1', 'a@example.com', "
                "'a@example.com', 'admin', now(), now())"
            ),
            {"id": user},
        )
        conn.execute(
            text(
                "INSERT INTO user_role_events (user_id, old_role, new_role, changed_by, changed_at)"
                " VALUES (:id, 'user', 'admin', 'test', now())"
            ),
            {"id": user},
        )
        conn.execute(
            text(
                "INSERT INTO job_usage (job_id, started_at, client, access, target_language, "
                "voice, speed_percent, timing_mode, translation_provider, speech_provider, "
                "audio_processor, baseline_seconds, target_audio_seconds, source_chars) "
                "VALUES (:id, now(), 'web', 'invitation', 'vietnamese', 'AndrewMultilingual', "
                "100, 'plain', 'a', 'b', 'c', 60, 60, 10)"
            ),
            {"id": uuid.uuid4()},
        )
    command.downgrade(config, "0012_user_roles")  # only the usage tables go (and their rows)
    try:
        tables = set(inspect(engine).get_table_names())
        assert not {"job_usage", "job_usage_attempts"} & tables
        assert {"jobs", "users", "user_role_events", "extension_auth_codes"} <= tables
        with engine.connect() as conn:
            role = conn.execute(text("SELECT role FROM users WHERE id = :id"), {"id": user})
            assert role.scalar_one() == "admin"
            events = conn.execute(text("SELECT count(*) FROM user_role_events")).scalar_one()
            assert events == 1
    finally:
        command.upgrade(config, "head")
    inspector = inspect(engine)
    assert {"job_usage", "job_usage_attempts"} <= set(inspector.get_table_names())
    with engine.connect() as conn:  # the account and the admin grant survived both directions
        assert conn.execute(text("SELECT role FROM users")).scalar_one() == "admin"
        assert conn.execute(text("SELECT count(*) FROM job_usage")).scalar_one() == 0
    # No foreign key anywhere: usage is independent of the jobs table.
    assert inspector.get_foreign_keys("job_usage") == []
    assert inspector.get_foreign_keys("job_usage_attempts") == []
    indexed = {tuple(i["column_names"]) for i in inspector.get_indexes("job_usage")}
    assert ("started_at",) in indexed and ("target_language",) in indexed
    assert ("started_at",) in {
        tuple(i["column_names"]) for i in inspector.get_indexes("job_usage_attempts")
    }
    assert inspector.get_pk_constraint("job_usage_attempts")["constrained_columns"] == [
        "job_id",
        "seq",
    ]


def test_models_and_migrations_describe_the_same_usage_tables(engine, database_url):
    """Alembic's own autogenerate comparison finds no difference for the usage tables."""
    from alembic.autogenerate import compare_metadata
    from alembic.migration import MigrationContext

    from app.db import Base

    with engine.connect() as conn:
        context = MigrationContext.configure(
            conn, opts={"compare_type": True, "compare_server_default": False}
        )
        diffs = compare_metadata(context, Base.metadata)
    usage = [d for d in diffs if "job_usage" in repr(d)]
    assert usage == []
