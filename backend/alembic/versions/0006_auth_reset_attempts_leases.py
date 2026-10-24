"""password reset attempts and challenge lease tokens

Expand-only: creates `password_reset_attempts` and adds the nullable column
`auth_challenges.lease_token`. Code from before this revision never reads either.

Revision ID: 0006
Revises: 0005
Create Date: 2026-10-24
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = '0006'
down_revision: str | None = '0005'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        'password_reset_attempts',
        sa.Column('id', sa.Uuid(), nullable=False),
        sa.Column('email_hash', sa.String(length=64), nullable=False),
        sa.Column('state', sa.String(length=10), nullable=False),
        sa.Column('started_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('settle_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('resolved_at', sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint("state IN ('pending','succeeded','rejected','unknown')", name=op.f('ck_password_reset_attempts_state_valid')),
        sa.PrimaryKeyConstraint('id', name=op.f('pk_password_reset_attempts')),
    )
    op.create_index(op.f('ix_password_reset_attempts_email_hash'), 'password_reset_attempts', ['email_hash', 'state'], unique=False)
    op.create_index(op.f('ix_password_reset_attempts_settle_at'), 'password_reset_attempts', ['settle_at'], unique=False)
    op.add_column('auth_challenges', sa.Column('lease_token', sa.String(length=64), nullable=True))


def downgrade() -> None:
    op.drop_column('auth_challenges', 'lease_token')
    op.drop_index(op.f('ix_password_reset_attempts_settle_at'), table_name='password_reset_attempts')
    op.drop_index(op.f('ix_password_reset_attempts_email_hash'), table_name='password_reset_attempts')
    op.drop_table('password_reset_attempts')
