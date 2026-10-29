"""job target language

Expand-only: adds one column with a constant default, so the previous application version
keeps working against this schema (it never writes the column, and new rows from it read as
'vietnamese', which is what that version produces). Rows that exist before the migration also
read as 'vietnamese'. The CHECK only admits the two supported output languages (API values of
`app/languages.py`).

Revision ID: 0009
Revises: 0008
Create Date: 2026-10-29
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = '0009'
down_revision: str | None = '0008'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        'jobs',
        sa.Column(
            'target_language', sa.String(length=32), server_default=sa.text("'vietnamese'"), nullable=False
        ),
    )
    op.create_check_constraint(
        op.f('ck_jobs_target_language_valid'),
        'jobs',
        "target_language IN ('vietnamese', 'mandarin_simplified')",
    )


def downgrade() -> None:
    op.drop_constraint(op.f('ck_jobs_target_language_valid'), 'jobs', type_='check')
    op.drop_column('jobs', 'target_language')
