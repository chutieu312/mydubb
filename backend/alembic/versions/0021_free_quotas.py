"""account plans and daily usage counters (Free quotas)

Expand-only.

- `users.plan` ('free' by default): the account's plan, which sets its quotas
  (docs/API.md, "Usage limits"). Every existing account reads as 'free', whether it was invited or
  not; an administrator's exemption comes from `users.role`, never from the plan. No API writes the
  column: a new account (sign-in upsert, and later self-registration) gets the server default.
- `usage_counters`: one row per (subject, kind, UTC day) with the number of operations the backend
  accepted that day. Subjects are an account (`user:<id>`) and the shared non-administrator cap
  (`global`). Enforcement reads only this table, never the usage report tables.

The previous application version keeps working against this schema: it never reads the table, and
its user upsert does not name `plan`, so new rows get the default.

Downgrade drops the table and the column: the day's counts are lost (quotas start again from zero
once upgraded) and so is every plan (all 'free' today, so nothing else is lost).

Revision ID: 0021_free_quotas
Revises: 0020
Create Date: 2026-11-08
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = '0021_free_quotas'
down_revision: str | None = '0020'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        'users',
        sa.Column('plan', sa.String(length=10), server_default=sa.text("'free'"), nullable=False),
    )
    op.create_check_constraint(op.f('ck_users_plan_valid'), 'users', "plan IN ('free')")
    op.create_table(
        'usage_counters',
        sa.Column('subject', sa.String(length=64), nullable=False),
        sa.Column('kind', sa.String(length=16), nullable=False),
        sa.Column('day', sa.Date(), nullable=False),
        sa.Column('count', sa.Integer(), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint(
            "kind IN ('generate','youtube_import')", name=op.f('ck_usage_counters_kind_valid')
        ),
        sa.CheckConstraint('count >= 0', name=op.f('ck_usage_counters_count_valid')),
        sa.PrimaryKeyConstraint('subject', 'kind', 'day', name=op.f('pk_usage_counters')),
    )
    op.create_index(op.f('ix_usage_counters_day'), 'usage_counters', ['day'], unique=False)


def downgrade() -> None:
    op.drop_index(op.f('ix_usage_counters_day'), table_name='usage_counters')
    op.drop_table('usage_counters')
    op.drop_constraint(op.f('ck_users_plan_valid'), 'users', type_='check')
    op.drop_column('users', 'plan')
