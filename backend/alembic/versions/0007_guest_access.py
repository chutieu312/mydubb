"""guest sessions and guest job quota

Expand-only: creates `guest_sessions` and `guest_job_quota`, and adds the nullable column
`jobs.guest_session_id` (with its index and a foreign key). Code from before this revision never
reads any of them, never sees a guest job (it selects jobs by `session_id` or `user_id`, both NULL
for guest jobs) and keeps working against this schema. Existing rows are not touched.

Revision ID: 0007
Revises: 0006
Create Date: 2026-10-27
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = '0007'
down_revision: str | None = '0006'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        'guest_sessions',
        sa.Column('id', sa.Uuid(), nullable=False),
        sa.Column('token_hash', sa.String(length=64), nullable=False),
        sa.Column('csrf_token', sa.String(length=64), nullable=False),
        sa.Column('ip_key', sa.String(length=64), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('expires_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('revoked_at', sa.DateTime(timezone=True), nullable=True),
        sa.PrimaryKeyConstraint('id', name=op.f('pk_guest_sessions')),
        sa.UniqueConstraint('token_hash', name=op.f('uq_guest_sessions_token_hash')),
    )
    op.create_index(op.f('ix_guest_sessions_expires_at'), 'guest_sessions', ['expires_at'], unique=False)
    op.create_index('ix_guest_sessions_ip_key_created_at', 'guest_sessions', ['ip_key', 'created_at'], unique=False)

    op.add_column('jobs', sa.Column('guest_session_id', sa.Uuid(), nullable=True))
    op.create_index(op.f('ix_jobs_guest_session_id'), 'jobs', ['guest_session_id'], unique=False)
    op.create_foreign_key(op.f('fk_jobs_guest_session_id_guest_sessions'), 'jobs', 'guest_sessions', ['guest_session_id'], ['id'], ondelete='SET NULL')

    op.create_table(
        'guest_job_quota',
        sa.Column('job_id', sa.Uuid(), nullable=False),
        sa.Column('guest_session_id', sa.Uuid(), nullable=True),
        sa.Column('ip_key', sa.String(length=64), nullable=False),
        sa.Column('state', sa.String(length=10), nullable=False),
        sa.Column('reserved_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('charged_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('settled_at', sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint("state IN ('reserved','used','released')", name=op.f('ck_guest_job_quota_state_valid')),
        sa.ForeignKeyConstraint(['job_id'], ['jobs.id'], name=op.f('fk_guest_job_quota_job_id_jobs'), ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['guest_session_id'], ['guest_sessions.id'], name=op.f('fk_guest_job_quota_guest_session_id_guest_sessions'), ondelete='SET NULL'),
        sa.PrimaryKeyConstraint('job_id', name=op.f('pk_guest_job_quota')),
    )
    op.create_index(op.f('ix_guest_job_quota_guest_session_id'), 'guest_job_quota', ['guest_session_id'], unique=False)
    op.create_index(op.f('ix_guest_job_quota_state'), 'guest_job_quota', ['state'], unique=False)
    op.create_index('ix_guest_job_quota_ip_key_charged_at', 'guest_job_quota', ['ip_key', 'charged_at'], unique=False)


def downgrade() -> None:
    op.drop_index('ix_guest_job_quota_ip_key_charged_at', table_name='guest_job_quota')
    op.drop_index(op.f('ix_guest_job_quota_state'), table_name='guest_job_quota')
    op.drop_index(op.f('ix_guest_job_quota_guest_session_id'), table_name='guest_job_quota')
    op.drop_table('guest_job_quota')
    op.drop_constraint(op.f('fk_jobs_guest_session_id_guest_sessions'), 'jobs', type_='foreignkey')
    op.drop_index(op.f('ix_jobs_guest_session_id'), table_name='jobs')
    op.drop_column('jobs', 'guest_session_id')
    op.drop_index('ix_guest_sessions_ip_key_created_at', table_name='guest_sessions')
    op.drop_index(op.f('ix_guest_sessions_expires_at'), table_name='guest_sessions')
    op.drop_table('guest_sessions')
