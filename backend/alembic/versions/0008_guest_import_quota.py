"""guest YouTube import quota

Expand-only: creates `guest_import_quota` (one row per guest caption import, with its quota state
and the liveness of the instance running it). Code from before this revision never reads it and
keeps working against this schema. Existing tables and rows are not touched.

Revision ID: 0008
Revises: 0007
Create Date: 2026-10-27
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = '0008'
down_revision: str | None = '0007'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        'guest_import_quota',
        sa.Column('id', sa.Uuid(), nullable=False),
        sa.Column('guest_session_id', sa.Uuid(), nullable=True),
        sa.Column('ip_key', sa.String(length=64), nullable=False),
        sa.Column('state', sa.String(length=10), nullable=False),
        sa.Column('runner_id', sa.String(length=64), nullable=False),
        sa.Column('heartbeat_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('reserved_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('charged_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('settled_at', sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint("state IN ('reserved','used','released')", name=op.f('ck_guest_import_quota_state_valid')),
        sa.ForeignKeyConstraint(['guest_session_id'], ['guest_sessions.id'], name=op.f('fk_guest_import_quota_guest_session_id_guest_sessions'), ondelete='SET NULL'),
        sa.PrimaryKeyConstraint('id', name=op.f('pk_guest_import_quota')),
    )
    op.create_index(op.f('ix_guest_import_quota_guest_session_id'), 'guest_import_quota', ['guest_session_id'], unique=False)
    op.create_index(op.f('ix_guest_import_quota_state'), 'guest_import_quota', ['state'], unique=False)
    op.create_index('ix_guest_import_quota_ip_key_charged_at', 'guest_import_quota', ['ip_key', 'charged_at'], unique=False)


def downgrade() -> None:
    op.drop_index('ix_guest_import_quota_ip_key_charged_at', table_name='guest_import_quota')
    op.drop_index(op.f('ix_guest_import_quota_state'), table_name='guest_import_quota')
    op.drop_index(op.f('ix_guest_import_quota_guest_session_id'), table_name='guest_import_quota')
    op.drop_table('guest_import_quota')
