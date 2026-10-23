"""glossary candidates

Expand-only: creates a new table and adds one nullable column to `jobs`, so the previous
application version keeps working against this schema (it never reads either). The table has
no foreign key to `jobs` or `access_sessions`: deleting jobs, sessions or results never
removes candidates.

Revision ID: 0004
Revises: 0003
Create Date: 2026-10-23
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = '0004'
down_revision: str | None = '0003'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        'glossary_candidates',
        sa.Column('id', sa.BigInteger(), sa.Identity(always=False), nullable=False),
        sa.Column('term_key', sa.String(length=100), nullable=False),
        sa.Column('display_term', sa.String(length=100), nullable=False),
        sa.Column('spellings', sa.ARRAY(sa.Text()), server_default=sa.text("'{}'::text[]"), nullable=False),
        sa.Column('kind', sa.String(length=20), nullable=False),
        sa.Column('job_count', sa.Integer(), server_default=sa.text('0'), nullable=False),
        sa.Column('first_seen_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('last_seen_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('status', sa.String(length=10), server_default=sa.text("'pending'"), nullable=False),
        sa.Column('canonical_term', sa.String(length=100), nullable=True),
        sa.Column('case_policy', sa.String(length=12), nullable=True),
        sa.Column('reviewed_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('reviewed_by', sa.String(length=64), nullable=True),
        sa.Column('review_note', sa.String(length=200), nullable=True),
        sa.Column('promoted_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('promoted_commit', sa.String(length=40), nullable=True),
        sa.CheckConstraint("status IN ('pending','approved','rejected','promoted')", name=op.f('ck_glossary_candidates_status_valid')),
        sa.CheckConstraint("kind IN ('word','phrase','proper_name','acronym')", name=op.f('ck_glossary_candidates_kind_valid')),
        sa.CheckConstraint("case_policy IS NULL OR case_policy IN ('insensitive','exact')", name=op.f('ck_glossary_candidates_case_policy_valid')),
        sa.CheckConstraint('job_count >= 0', name=op.f('ck_glossary_candidates_job_count_valid')),
        sa.CheckConstraint("status NOT IN ('approved','promoted') OR (canonical_term IS NOT NULL AND case_policy IS NOT NULL)", name=op.f('ck_glossary_candidates_approved_has_canonical')),
        sa.CheckConstraint("status <> 'promoted' OR promoted_commit IS NOT NULL", name=op.f('ck_glossary_candidates_promoted_has_commit')),
        sa.PrimaryKeyConstraint('id', name=op.f('pk_glossary_candidates')),
        sa.UniqueConstraint('term_key', name=op.f('uq_glossary_candidates_term_key')),
    )
    op.create_index(op.f('ix_glossary_candidates_last_seen_at'), 'glossary_candidates', ['last_seen_at'], unique=False)
    op.create_index(op.f('ix_glossary_candidates_status'), 'glossary_candidates', ['status'], unique=False)
    op.add_column('jobs', sa.Column('glossary_candidates_recorded_at', sa.DateTime(timezone=True), nullable=True))


def downgrade() -> None:
    op.drop_column('jobs', 'glossary_candidates_recorded_at')
    op.drop_index(op.f('ix_glossary_candidates_status'), table_name='glossary_candidates')
    op.drop_index(op.f('ix_glossary_candidates_last_seen_at'), table_name='glossary_candidates')
    op.drop_table('glossary_candidates')
