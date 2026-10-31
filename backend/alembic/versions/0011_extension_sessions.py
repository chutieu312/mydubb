"""chrome extension sessions

Expand-only. `user_sessions.client` ('web' by default, 'extension' for a token held by the Chrome
extension) and the table of one-time authorization codes the extension exchanges for a token
(docs/EXTENSION_AUTH.md). Existing sessions read as 'web'. The previous application version keeps
working against this schema: it never writes the column (its rows get the default) and never
reads the new table. It does not filter on the column, so it would accept an extension token sent
as the `mydubb_auth` cookie; only the holder of that token, i.e. the same user, could do so.

Downgrade drops the table and the column; extension sessions then become ordinary rows that the
older version could accept as cookies, so they are revoked first.

Revision ID: 0011
Revises: 0010
Create Date: 2026-10-30
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = '0011'
down_revision: str | None = '0010'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        'user_sessions',
        sa.Column('client', sa.String(length=10), server_default=sa.text("'web'"), nullable=False),
    )
    op.create_check_constraint(
        op.f('ck_user_sessions_client_valid'), 'user_sessions', "client IN ('web','extension')"
    )
    op.create_table(
        'extension_auth_codes',
        sa.Column('id', sa.Uuid(), nullable=False),
        sa.Column('code_hash', sa.String(length=64), nullable=False),
        sa.Column('user_id', sa.Uuid(), nullable=False),
        sa.Column('client_id', sa.String(length=32), nullable=False),
        sa.Column('redirect_uri', sa.String(length=100), nullable=False),
        sa.Column('code_challenge', sa.String(length=43), nullable=False),
        sa.Column('auth_started_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('expires_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('consumed_at', sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(
            ['user_id'], ['users.id'], name=op.f('fk_extension_auth_codes_user_id_users'), ondelete='CASCADE'
        ),
        sa.PrimaryKeyConstraint('id', name=op.f('pk_extension_auth_codes')),
        sa.UniqueConstraint('code_hash', name=op.f('uq_extension_auth_codes_code_hash')),
    )
    op.create_index(op.f('ix_extension_auth_codes_user_id'), 'extension_auth_codes', ['user_id'], unique=False)
    op.create_index(op.f('ix_extension_auth_codes_expires_at'), 'extension_auth_codes', ['expires_at'], unique=False)


def downgrade() -> None:
    op.drop_index(op.f('ix_extension_auth_codes_expires_at'), table_name='extension_auth_codes')
    op.drop_index(op.f('ix_extension_auth_codes_user_id'), table_name='extension_auth_codes')
    op.drop_table('extension_auth_codes')
    op.execute(
        "UPDATE user_sessions SET revoked_at = now() WHERE client = 'extension' AND revoked_at IS NULL"
    )
    op.drop_constraint(op.f('ck_user_sessions_client_valid'), 'user_sessions', type_='check')
    op.drop_column('user_sessions', 'client')
