"""job runner ownership and heartbeat

Expand-only: adds nullable columns, so the previous application version keeps working
against this schema (safe for rollbacks and overlapping deploys).

Revision ID: 0002
Revises: 0001
Create Date: 2026-10-21
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = '0002'
down_revision: str | None = '0001'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column('jobs', sa.Column('runner_id', sa.String(length=64), nullable=True))
    op.add_column('jobs', sa.Column('heartbeat_at', sa.DateTime(timezone=True), nullable=True))


def downgrade() -> None:
    op.drop_column('jobs', 'heartbeat_at')
    op.drop_column('jobs', 'runner_id')
