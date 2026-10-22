"""initial schema

Revision ID: 0001
Revises: 
Create Date: 2026-10-21 14:02:36.595637
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op


revision: str = '0001'
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table('access_sessions',
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('token_hash', sa.String(length=64), nullable=False),
    sa.Column('csrf_token', sa.String(length=64), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('expires_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('revoked_at', sa.DateTime(timezone=True), nullable=True),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_access_sessions')),
    sa.UniqueConstraint('token_hash', name=op.f('uq_access_sessions_token_hash'))
    )
    op.create_index(op.f('ix_access_sessions_expires_at'), 'access_sessions', ['expires_at'], unique=False)
    op.create_table('jobs',
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('session_id', sa.Uuid(), nullable=True),
    sa.Column('status', sa.String(length=20), nullable=False),
    sa.Column('voice', sa.String(length=20), nullable=False),
    sa.Column('first_sentence_start_seconds', sa.Integer(), nullable=False),
    sa.Column('last_sentence_start_seconds', sa.Integer(), nullable=False),
    sa.Column('target_duration_seconds', sa.Integer(), nullable=False),
    sa.Column('transcript_char_count', sa.Integer(), nullable=False),
    sa.Column('translation_provider', sa.String(length=50), nullable=False),
    sa.Column('speech_provider', sa.String(length=50), nullable=False),
    sa.Column('audio_processor', sa.String(length=50), nullable=False),
    sa.Column('error_code', sa.String(length=50), nullable=True),
    sa.Column('error_message', sa.String(length=500), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('started_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('completed_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('result_expires_at', sa.DateTime(timezone=True), nullable=True),
    sa.CheckConstraint("status IN ('queued','translating','synthesizing','processing','completed','failed')", name=op.f('ck_jobs_status_valid')),
    sa.CheckConstraint('last_sentence_start_seconds > first_sentence_start_seconds', name=op.f('ck_jobs_timestamps_ordered')),
    sa.ForeignKeyConstraint(['session_id'], ['access_sessions.id'], name=op.f('fk_jobs_session_id_access_sessions'), ondelete='SET NULL'),
    sa.PrimaryKeyConstraint('id', name=op.f('pk_jobs'))
    )
    op.create_index(op.f('ix_jobs_session_id'), 'jobs', ['session_id'], unique=False)
    op.create_index(op.f('ix_jobs_status'), 'jobs', ['status'], unique=False)


def downgrade() -> None:
    op.drop_index(op.f('ix_jobs_status'), table_name='jobs')
    op.drop_index(op.f('ix_jobs_session_id'), table_name='jobs')
    op.drop_table('jobs')
    op.drop_index(op.f('ix_access_sessions_expires_at'), table_name='access_sessions')
    op.drop_table('access_sessions')
