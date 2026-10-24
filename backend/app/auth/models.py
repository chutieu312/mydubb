import uuid
from datetime import datetime

from sqlalchemy import (
    BigInteger,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Identity,
    Index,
    LargeBinary,
    SmallInteger,
    String,
    UniqueConstraint,
    Uuid,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base


class User(Base):
    """A MyDubb account linked to one Amazon Cognito user.

    The identity is the token issuer plus Cognito's immutable `sub`; the email address and the
    display name are profile data refreshed at every sign-in and never used to identify a user.
    No password or password hash is stored: Cognito owns credentials.
    """

    __tablename__ = "users"
    __table_args__ = (
        UniqueConstraint("cognito_issuer", "cognito_sub", name="uq_users_cognito_identity"),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    cognito_issuer: Mapped[str] = mapped_column(String(200))
    cognito_sub: Mapped[str] = mapped_column(String(128))
    email: Mapped[str] = mapped_column(String(320))
    # Lowercased email, used only to find the accounts a password reset applies to.
    email_normalized: Mapped[str] = mapped_column(String(320), index=True)
    display_name: Mapped[str | None] = mapped_column(String(200))
    # Set by an administrator (scripts/auth_users.py): the user cannot sign in or use sessions.
    disabled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # Sessions whose sign-in started at or before this instant are invalid (password reset).
    sessions_valid_after: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    last_login_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class UserSession(Base):
    """A browser session of a Cognito user (separate from Access Code sessions).

    Only a SHA-256 hash of the cookie token is stored. Older application versions never read
    this table, so a Cognito session can never be accepted as an Access Code session.
    """

    __tablename__ = "user_sessions"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    csrf_token: Mapped[str] = mapped_column(String(64))
    # When the sign-in that created this session started (database clock, before the first
    # Cognito request). A password reset completed after it invalidates the session.
    auth_started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class AuthChallenge(Base):
    """A pending sign-in step (new password or email verification).

    The client holds an opaque `challenge_id` (stored hashed) and a browser-binding cookie
    (stored hashed). The Cognito material needed to finish the step is encrypted with
    AUTH_TOKEN_ENCRYPTION_KEY and erased when the step ends.
    """

    __tablename__ = "auth_challenges"
    __table_args__ = (
        CheckConstraint("kind IN ('new_password','email_verification')", name="kind_valid"),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    binding_hash: Mapped[str] = mapped_column(String(64))
    kind: Mapped[str] = mapped_column(String(20))
    encrypted_payload: Mapped[bytes | None] = mapped_column(LargeBinary)
    auth_started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    attempts: Mapped[int] = mapped_column(SmallInteger, server_default=text("0"), default=0)
    sends: Mapped[int] = mapped_column(SmallInteger, server_default=text("0"), default=0)
    # A request working on the challenge holds it until then (at most one at a time).
    locked_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    consumed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)


class PasswordResetEvent(Base):
    """A completed password reset, kept briefly so that a sign-in that started before it (and
    whose user row may not exist yet) cannot create a session afterwards."""

    __tablename__ = "password_reset_events"
    __table_args__ = (Index(None, "email_hash", "reset_at"),)

    id: Mapped[int] = mapped_column(BigInteger, Identity(always=False), primary_key=True)
    # SHA-256 of the lowercased email (no address stored).
    email_hash: Mapped[str] = mapped_column(String(64))
    reset_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
