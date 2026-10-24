import uuid
from dataclasses import dataclass
from datetime import datetime


@dataclass(frozen=True)
class UserProfile:
    id: uuid.UUID
    email: str
    display_name: str | None


@dataclass(frozen=True)
class Principal:
    """Who is calling, resolved from the session cookie of the active AUTH_MODE.

    Access Code mode: `session_id` is the `access_sessions` row and owns jobs; `user` is None.
    Cognito mode: `session_id` is the `user_sessions` row and the `user` owns jobs.
    """

    session_id: uuid.UUID
    csrf_token: str
    expires_at: datetime
    user: UserProfile | None = None

    @property
    def user_id(self) -> uuid.UUID | None:
        return self.user.id if self.user is not None else None
