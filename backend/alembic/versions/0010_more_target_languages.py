"""six more job target languages

Replaces the CHECK of migration 0009 so it admits the eight output languages of
`app/languages.py` (Vietnamese, Mandarin and, new, Hindi, Spanish, Arabic, French, Russian,
Japanese). Only the constraint changes: no column, no default and no row is touched, and every
row that satisfied the old CHECK satisfies the new one. The previous application version keeps
working against this schema (it writes only 'vietnamese' and 'mandarin_simplified'), but it cannot
read a job stored in one of the new languages.

Downgrade restores the two-language CHECK and refuses, without changing anything, while a job in a
new language exists: those rows are kept, never rewritten into another language.

Revision ID: 0010
Revises: 0009
Create Date: 2026-10-29
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = '0010'
down_revision: str | None = '0009'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_NAME = 'ck_jobs_target_language_valid'
_PREVIOUS = ('vietnamese', 'mandarin_simplified')
_CURRENT = (*_PREVIOUS, 'hindi', 'spanish', 'arabic', 'french', 'russian', 'japanese')


def _check(values: tuple[str, ...]) -> str:
    return 'target_language IN (' + ', '.join(f"'{value}'" for value in values) + ')'


def upgrade() -> None:
    op.drop_constraint(op.f(_NAME), 'jobs', type_='check')
    op.create_check_constraint(op.f(_NAME), 'jobs', _check(_CURRENT))


def downgrade() -> None:
    newer = op.get_bind().execute(
        sa.text(f'SELECT count(*) FROM jobs WHERE NOT ({_check(_PREVIOUS)})')
    ).scalar_one()
    if newer:
        raise RuntimeError(
            f'{newer} job(s) use a target language that revision 0009 does not know; '
            'downgrade refused so that they are kept unchanged'
        )
    op.drop_constraint(op.f(_NAME), 'jobs', type_='check')
    op.create_check_constraint(op.f(_NAME), 'jobs', _check(_PREVIOUS))
