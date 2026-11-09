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
    Guest ("Try as guest"): `guest` is True, `session_id` is the `guest_sessions` row and owns
    jobs; `user` is None. A guest is resolved only by the job endpoints and the guest endpoints
    (dependencies.py), never by `require_session`.
    Chrome extension: `bearer` is True, `session_id` is a `user_sessions` row issued to the
    extension and the `user` owns jobs. Resolved only by the job endpoints and the extension's own
    endpoints, from the Authorization header (never from a cookie).

    `is_admin` is read from the user row by each request, and only for a website session: a guest,
    an extension token or an Access Code session is never an administrator.

    `plan` and `quota_exempt` (app/quotas) are read from the same user row by each request, for a
    website session and for an extension token alike: an administrator's jobs are exempt from the
    usage limits from either client, while only `is_admin` opens the administration endpoints.
    Never taken from the request. Without a user (guest, Access Code) they keep their defaults.
    """

    session_id: uuid.UUID
    csrf_token: str
    expires_at: datetime
    user: UserProfile | None = None
    guest: bool = False
    bearer: bool = False
    is_admin: bool = False
    plan: str = "free"
    quota_exempt: bool = False

    @property
    def user_id(self) -> uuid.UUID | None:
        return self.user.id if self.user is not None else None

    @property
    def guest_session_id(self) -> uuid.UUID | None:
        return self.session_id if self.guest else None
