"""user roles

Expand-only. `users.role` ('user' by default, 'admin' only through scripts/auth_users.py) and the
table `user_role_events`, the trail of role changes. Every existing account reads as 'user'; no
account becomes an administrator here. The previous application version keeps working against this
schema: it never writes the column (its new users get the default, and its sign-in upsert does not
touch the role) and never reads the new table.

Downgrade drops the table and the column, so the grants and their trail are lost: after upgrading
again the administrators have to be granted again.

The revision id is deliberately not a bare number: stories running in parallel may pick the next
number too, and two files with one id make Alembic silently keep only one of them.

Revision ID: 0012_user_roles
Revises: 0011
Create Date: 2026-11-01
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = '0012_user_roles'
down_revision: str | None = '0011'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        'users',
        sa.Column('role', sa.String(length=10), server_default=sa.text("'user'"), nullable=False),
    )
    op.create_check_constraint(op.f('ck_users_role_valid'), 'users', "role IN ('user','admin')")
    op.create_table(
        'user_role_events',
        sa.Column('id', sa.BigInteger(), sa.Identity(always=False), nullable=False),
        sa.Column('user_id', sa.Uuid(), nullable=False),
        sa.Column('old_role', sa.String(length=10), nullable=False),
        sa.Column('new_role', sa.String(length=10), nullable=False),
        sa.Column('changed_by', sa.String(length=200), nullable=False),
        sa.Column('changed_at', sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint(
            "old_role IN ('user','admin') AND new_role IN ('user','admin') AND old_role <> new_role",
            name=op.f('ck_user_role_events_role_change_valid'),
        ),
        sa.PrimaryKeyConstraint('id', name=op.f('pk_user_role_events')),
    )
    op.create_index(op.f('ix_user_role_events_user_id'), 'user_role_events', ['user_id'], unique=False)


def downgrade() -> None:
    op.drop_index(op.f('ix_user_role_events_user_id'), table_name='user_role_events')
    op.drop_table('user_role_events')
    op.drop_constraint(op.f('ck_users_role_valid'), 'users', type_='check')
    op.drop_column('users', 'role')
