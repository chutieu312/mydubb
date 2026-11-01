"""Usage retention and the migration: cleanup touches only usage; the schema is expand-only."""

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


def test_the_migration_is_expand_only_and_reversible(engine, database_url):
    config = alembic_config(database_url)
    with engine.begin() as conn:
        conn.execute(text("TRUNCATE jobs, job_usage, job_usage_attempts, access_sessions CASCADE"))
    command.downgrade(config, "0011")
    try:
        tables = set(inspect(engine).get_table_names())
        assert not {"job_usage", "job_usage_attempts"} & tables
        assert {"jobs", "user_sessions", "extension_auth_codes"} <= tables  # product data intact
    finally:
        command.upgrade(config, "head")
    inspector = inspect(engine)
    assert {"job_usage", "job_usage_attempts"} <= set(inspector.get_table_names())
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
