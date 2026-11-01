"""per-job usage records

Expand-only: two new tables (`job_usage`, `job_usage_attempts`) that the previous application
version never reads or writes, so it keeps working against this schema. They have no foreign key
to `jobs` on purpose (usage outlives the job row; see app/usage/models.py). Existing jobs have no
usage rows; the report counts them as "without a usage record".

Revision id `0020` is deliberately outside the 0012-0019 range, which belongs to other work in
flight. Whichever migration branch is merged second must re-point its `down_revision` at the head
that merged first (a database with two heads cannot `upgrade head`); check `alembic heads`.

Downgrade drops both tables, and with them every recorded usage figure.

Revision ID: 0020
Revises: 0011
Create Date: 2026-11-01
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = '0020'
down_revision: str | None = '0011'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        'job_usage',
        sa.Column('job_id', sa.Uuid(), nullable=False),
        sa.Column('started_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('finished_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('client', sa.String(length=16), nullable=False),
        sa.Column('access', sa.String(length=16), nullable=False),
        sa.Column('target_language', sa.String(length=32), nullable=False),
        sa.Column('voice', sa.String(length=20), nullable=False),
        sa.Column('speed_percent', sa.SmallInteger(), nullable=False),
        sa.Column('timing_mode', sa.String(length=5), nullable=False),
        sa.Column('translation_provider', sa.String(length=50), nullable=False),
        sa.Column('speech_provider', sa.String(length=50), nullable=False),
        sa.Column('audio_processor', sa.String(length=50), nullable=False),
        sa.Column('baseline_seconds', sa.Integer(), nullable=False),
        sa.Column('target_audio_seconds', sa.Numeric(precision=12, scale=3), nullable=False),
        sa.Column('final_audio_seconds', sa.Numeric(precision=12, scale=3), nullable=True),
        sa.Column('source_chars', sa.Integer(), nullable=False),
        sa.Column('blocks', sa.Integer(), nullable=True),
        sa.Column('audio_ms', sa.Integer(), nullable=True),
        sa.Column('mp3_bytes', sa.BigInteger(), nullable=True),
        sa.Column('outcome', sa.String(length=10), nullable=True),
        sa.Column('error_code', sa.String(length=50), nullable=True),
        sa.Column('attempts_expected', sa.Integer(), nullable=True),
        sa.Column('write_errors', sa.Integer(), server_default='0', nullable=False),
        sa.Column('method_version', sa.SmallInteger(), server_default='1', nullable=False),
        sa.CheckConstraint("timing_mode IN ('plain','timed')", name=op.f('ck_job_usage_timing_mode_valid')),
        sa.CheckConstraint(
            "outcome IS NULL OR outcome IN ('completed','failed','superseded')",
            name=op.f('ck_job_usage_outcome_valid'),
        ),
        sa.PrimaryKeyConstraint('job_id', name=op.f('pk_job_usage')),
    )
    op.create_index(op.f('ix_job_usage_started_at'), 'job_usage', ['started_at'], unique=False)
    op.create_index(op.f('ix_job_usage_target_language'), 'job_usage', ['target_language'], unique=False)
    op.create_table(
        'job_usage_attempts',
        sa.Column('job_id', sa.Uuid(), nullable=False),
        sa.Column('seq', sa.Integer(), nullable=False),
        sa.Column('service', sa.String(length=10), nullable=False),
        sa.Column('provider_kind', sa.String(length=5), nullable=False),
        sa.Column('operation', sa.String(length=24), nullable=False),
        sa.Column('outcome', sa.String(length=20), nullable=False),
        sa.Column('http_status', sa.SmallInteger(), nullable=True),
        sa.Column('error_code', sa.String(length=50), nullable=True),
        sa.Column('items', sa.Integer(), nullable=False),
        sa.Column('started_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('elapsed_ms', sa.Integer(), nullable=False),
        sa.Column('sent_amount', sa.BigInteger(), nullable=True),
        sa.Column('sent_unit', sa.String(length=48), nullable=True),
        sa.Column('usage_amount', sa.BigInteger(), nullable=True),
        sa.Column('usage_unit', sa.String(length=16), nullable=False),
        sa.Column('usage_basis', sa.String(length=10), nullable=False),
        sa.Column('usage_method', sa.String(length=48), nullable=True),
        sa.CheckConstraint("service IN ('translator','speech')", name=op.f('ck_job_usage_attempts_service_valid')),
        sa.CheckConstraint("provider_kind IN ('azure','mock')", name=op.f('ck_job_usage_attempts_provider_kind_valid')),
        sa.CheckConstraint(
            "outcome IN ('ok','http_error','timeout','network_error','cancelled',"
            "'unusable_response','failed')",
            name=op.f('ck_job_usage_attempts_outcome_valid'),
        ),
        sa.CheckConstraint(
            "usage_basis IN ('actual','estimated','unknown','none')",
            name=op.f('ck_job_usage_attempts_usage_basis_valid'),
        ),
        sa.PrimaryKeyConstraint('job_id', 'seq', name=op.f('pk_job_usage_attempts')),
    )
    op.create_index(op.f('ix_job_usage_attempts_started_at'), 'job_usage_attempts', ['started_at'], unique=False)


def downgrade() -> None:
    op.drop_index(op.f('ix_job_usage_attempts_started_at'), table_name='job_usage_attempts')
    op.drop_table('job_usage_attempts')
    op.drop_index(op.f('ix_job_usage_target_language'), table_name='job_usage')
    op.drop_index(op.f('ix_job_usage_started_at'), table_name='job_usage')
    op.drop_table('job_usage')
