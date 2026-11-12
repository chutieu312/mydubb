"""guest sessions in the Chrome extension ("Try as guest" in the extension)

Expand-only.

- `extension_auth_codes.guest_session_id`: a one-time code may now be approved by a guest session
  of the website instead of an account (docs/EXTENSION_AUTH.md, "Guests"); `user_id` becomes
  nullable, and a CHECK keeps exactly one of the two set. Existing codes all have a user.
- `guest_extension_tokens`: the extension's bearer tokens of a guest session. Only the SHA-256 of a
  token is stored; the guest session (its jobs and quotas) stays in `guest_sessions`.

The previous application version keeps working against this schema: it never reads the new table,
and it never writes a guest code. If it ever exchanged one (a code approved by a newer instance
during an overlapping deploy), its account lookup of the NULL user finds nobody and it answers
`invalid_grant`, the same as for any refused code: no token is issued.

Downgrade removes the guest codes and tokens first (guest extension connections end), then the
table, the CHECK and the column, and makes `user_id` required again.

Revision ID: 0022_extension_guest
Revises: 0021_free_quotas
Create Date: 2026-11-11
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0022_extension_guest"
down_revision: str | None = "0021_free_quotas"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.alter_column("extension_auth_codes", "user_id", existing_type=sa.Uuid(), nullable=True)
    op.add_column("extension_auth_codes", sa.Column("guest_session_id", sa.Uuid(), nullable=True))
    op.create_foreign_key(
        op.f("fk_extension_auth_codes_guest_session_id_guest_sessions"),
        "extension_auth_codes",
        "guest_sessions",
        ["guest_session_id"],
        ["id"],
        ondelete="CASCADE",
    )
    op.create_index(
        op.f("ix_extension_auth_codes_guest_session_id"),
        "extension_auth_codes",
        ["guest_session_id"],
        unique=False,
    )
    op.create_check_constraint(
        op.f("ck_extension_auth_codes_one_owner"),
        "extension_auth_codes",
        "(user_id IS NULL) <> (guest_session_id IS NULL)",
    )
    op.create_table(
        "guest_extension_tokens",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("guest_session_id", sa.Uuid(), nullable=False),
        sa.Column("token_hash", sa.String(length=64), nullable=False),
        sa.Column("client_id", sa.String(length=32), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(
            ["guest_session_id"],
            ["guest_sessions.id"],
            name=op.f("fk_guest_extension_tokens_guest_session_id_guest_sessions"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_guest_extension_tokens")),
        sa.UniqueConstraint("token_hash", name=op.f("uq_guest_extension_tokens_token_hash")),
    )
    op.create_index(
        op.f("ix_guest_extension_tokens_guest_session_id"),
        "guest_extension_tokens",
        ["guest_session_id"],
        unique=False,
    )
    op.create_index(
        op.f("ix_guest_extension_tokens_expires_at"),
        "guest_extension_tokens",
        ["expires_at"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index(op.f("ix_guest_extension_tokens_expires_at"), table_name="guest_extension_tokens")
    op.drop_index(
        op.f("ix_guest_extension_tokens_guest_session_id"), table_name="guest_extension_tokens"
    )
    op.drop_table("guest_extension_tokens")
    op.execute("DELETE FROM extension_auth_codes WHERE guest_session_id IS NOT NULL")
    op.drop_constraint(
        op.f("ck_extension_auth_codes_one_owner"), "extension_auth_codes", type_="check"
    )
    op.drop_index(
        op.f("ix_extension_auth_codes_guest_session_id"), table_name="extension_auth_codes"
    )
    op.drop_constraint(
        op.f("fk_extension_auth_codes_guest_session_id_guest_sessions"),
        "extension_auth_codes",
        type_="foreignkey",
    )
    op.drop_column("extension_auth_codes", "guest_session_id")
    op.alter_column("extension_auth_codes", "user_id", existing_type=sa.Uuid(), nullable=False)
