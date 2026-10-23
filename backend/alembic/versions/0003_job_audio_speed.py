"""job audio speed

Expand-only: adds one column with a constant default, so the previous application version
keeps working against this schema (it never writes the column, and new rows from it read as
100, i.e. 1x, which is what that version produces). Rows that exist before the migration also
read as 100. The CHECK only admits the seven supported speeds (percent).

Revision ID: 0003
Revises: 0002
Create Date: 2026-10-23
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = '0003'
down_revision: str | None = '0002'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        'jobs',
        sa.Column('audio_speed_percent', sa.SmallInteger(), server_default=sa.text('100'), nullable=False),
    )
    op.create_check_constraint(
        op.f('ck_jobs_audio_speed_valid'),
        'jobs',
        'audio_speed_percent IN (50, 75, 100, 125, 150, 175, 200)',
    )


def downgrade() -> None:
    op.drop_constraint(op.f('ck_jobs_audio_speed_valid'), 'jobs', type_='check')
    op.drop_column('jobs', 'audio_speed_percent')
