"""cognito users and sessions

Expand-only: creates four new tables and adds one nullable column (with its index and a
foreign key) to `jobs`, so the previous application version keeps working against this schema
(it never reads any of them). Cognito sessions live in their own table, so older code can never
accept one as an Access Code session. Existing jobs and Access Code sessions are not touched;
no job is assigned to a user.

Revision ID: 0005
Revises: 0004
Create Date: 2026-10-24
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = '0005'
down_revision: str | None = '0004'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        'users',
        sa.Column('id', sa.Uuid(), nullable=False),
        sa.Column('cognito_issuer', sa.String(length=200), nullable=False),
        sa.Column('cognito_sub', sa.String(length=128), nullable=False),
        sa.Column('email', sa.String(length=320), nullable=False),
        sa.Column('email_normalized', sa.String(length=320), nullable=False),
        sa.Column('display_name', sa.String(length=200), nullable=True),
        sa.Column('disabled_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('sessions_valid_after', sa.DateTime(timezone=True), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('last_login_at', sa.DateTime(timezone=True), nullable=True),
        sa.PrimaryKeyConstraint('id', name=op.f('pk_users')),
        sa.UniqueConstraint('cognito_issuer', 'cognito_sub', name=op.f('uq_users_cognito_identity')),
    )
    op.create_index(op.f('ix_users_email_normalized'), 'users', ['email_normalized'], unique=False)

    op.create_table(
        'user_sessions',
        sa.Column('id', sa.Uuid(), nullable=False),
        sa.Column('user_id', sa.Uuid(), nullable=False),
        sa.Column('token_hash', sa.String(length=64), nullable=False),
        sa.Column('csrf_token', sa.String(length=64), nullable=False),
        sa.Column('auth_started_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('expires_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('revoked_at', sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(['user_id'], ['users.id'], name=op.f('fk_user_sessions_user_id_users'), ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id', name=op.f('pk_user_sessions')),
        sa.UniqueConstraint('token_hash', name=op.f('uq_user_sessions_token_hash')),
    )
    op.create_index(op.f('ix_user_sessions_user_id'), 'user_sessions', ['user_id'], unique=False)
    op.create_index(op.f('ix_user_sessions_expires_at'), 'user_sessions', ['expires_at'], unique=False)

    op.create_table(
        'auth_challenges',
        sa.Column('id', sa.Uuid(), nullable=False),
        sa.Column('token_hash', sa.String(length=64), nullable=False),
        sa.Column('binding_hash', sa.String(length=64), nullable=False),
        sa.Column('kind', sa.String(length=20), nullable=False),
        sa.Column('encrypted_payload', sa.LargeBinary(), nullable=True),
        sa.Column('auth_started_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('attempts', sa.SmallInteger(), server_default=sa.text('0'), nullable=False),
        sa.Column('sends', sa.SmallInteger(), server_default=sa.text('0'), nullable=False),
        sa.Column('locked_until', sa.DateTime(timezone=True), nullable=True),
        sa.Column('consumed_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('expires_at', sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("kind IN ('new_password','email_verification')", name=op.f('ck_auth_challenges_kind_valid')),
        sa.PrimaryKeyConstraint('id', name=op.f('pk_auth_challenges')),
        sa.UniqueConstraint('token_hash', name=op.f('uq_auth_challenges_token_hash')),
    )
    op.create_index(op.f('ix_auth_challenges_expires_at'), 'auth_challenges', ['expires_at'], unique=False)

    op.create_table(
        'password_reset_events',
        sa.Column('id', sa.BigInteger(), sa.Identity(always=False), nullable=False),
        sa.Column('email_hash', sa.String(length=64), nullable=False),
        sa.Column('reset_at', sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint('id', name=op.f('pk_password_reset_events')),
    )
    op.create_index(op.f('ix_password_reset_events_email_hash'), 'password_reset_events', ['email_hash', 'reset_at'], unique=False)

    op.add_column('jobs', sa.Column('user_id', sa.Uuid(), nullable=True))
    op.create_index(op.f('ix_jobs_user_id'), 'jobs', ['user_id'], unique=False)
    op.create_foreign_key(op.f('fk_jobs_user_id_users'), 'jobs', 'users', ['user_id'], ['id'], ondelete='SET NULL')


def downgrade() -> None:
    op.drop_constraint(op.f('fk_jobs_user_id_users'), 'jobs', type_='foreignkey')
    op.drop_index(op.f('ix_jobs_user_id'), table_name='jobs')
    op.drop_column('jobs', 'user_id')
    op.drop_index(op.f('ix_password_reset_events_email_hash'), table_name='password_reset_events')
    op.drop_table('password_reset_events')
    op.drop_index(op.f('ix_auth_challenges_expires_at'), table_name='auth_challenges')
    op.drop_table('auth_challenges')
    op.drop_index(op.f('ix_user_sessions_expires_at'), table_name='user_sessions')
    op.drop_index(op.f('ix_user_sessions_user_id'), table_name='user_sessions')
    op.drop_table('user_sessions')
    op.drop_index(op.f('ix_users_email_normalized'), table_name='users')
    op.drop_table('users')
