"""In-memory stand-in for the Amazon Cognito user pool API (no network, no AWS credentials).

It reproduces the behaviour MyDubb relies on, as documented by AWS for an app client with
`PreventUserExistenceErrors=ENABLED`: unknown users, wrong passwords and disabled users all get
`NotAuthorizedException` at sign-in; `ForgotPassword` answers the same for unknown, disabled and
unverified users (and only sends a code to a verified address); `ConfirmForgotPassword` answers
`CodeMismatchException` for unknown or disabled users. A `NEW_PASSWORD_REQUIRED` session is
single-use, and disabling a user revokes their access tokens.

Tests can inject one-off failures (`fail_next`) and run code inside an operation (`hooks`) to
hold a request at a precise point for race tests.
"""

import itertools
import secrets
import threading
from collections.abc import Callable
from dataclasses import dataclass, field

from app.auth.cognito import (
    NEW_PASSWORD_REQUIRED,
    AuthChallengeStep,
    AuthTokens,
    CognitoError,
    CognitoErrorKind,
    CognitoUser,
)

MIN_PASSWORD_LENGTH = 8


@dataclass
class FakeUser:
    email: str
    password: str
    sub: str
    temporary: bool = False
    email_verified: bool = True
    enabled: bool = True
    name: str | None = None
    verification_code: str | None = None
    reset_code: str | None = None
    # Sign-up: False until ConfirmSignUp (an UNCONFIRMED user cannot sign in).
    confirmed: bool = True
    signup_code: str | None = None
    signup_code_expired: bool = False


@dataclass
class FakeCognito:
    users: dict[str, FakeUser] = field(default_factory=dict)
    calls: list[str] = field(default_factory=list)
    hooks: dict[str, Callable[[], None]] = field(default_factory=dict)
    # Values that every test can check never reach the browser or the database in clear.
    issued_tokens: list[str] = field(default_factory=list)
    issued_sessions: list[str] = field(default_factory=list)
    challenge_override: str | None = None
    # Like a user pool with "Self-service sign-up" disabled (invite-only): SignUp is refused.
    signup_disabled: bool = False
    # Emails the stand-in "sent" for sign-up (one entry per code), for tests that count them.
    signup_emails: list[str] = field(default_factory=list)
    _failures: dict[str, list[CognitoError]] = field(default_factory=dict)
    # Operations whose next answer is lost *after* Cognito applied them (timeout on the way back).
    _lost: dict[str, int] = field(default_factory=dict)
    _tokens: dict[str, str] = field(default_factory=dict)  # access token -> email key
    _sessions: dict[str, str] = field(default_factory=dict)  # sign-in session -> email key
    _lock: threading.Lock = field(default_factory=threading.Lock)
    _counter: itertools.count = field(default_factory=itertools.count)

    # -- test helpers -----------------------------------------------------------------------

    def add_user(self, email: str, password: str, **attributes) -> FakeUser:
        user = FakeUser(
            email=email, password=password, sub=f"sub-{next(self._counter)}", **attributes
        )
        self.users[email.lower()] = user
        return user

    def fail_next(self, operation: str, kind: CognitoErrorKind, aws_type: str = "Injected"):
        self._failures.setdefault(operation, []).append(CognitoError(kind, aws_type))

    def lose_next_answer(self, operation: str) -> None:
        """The next call of `operation` is applied, then answers like a timeout."""
        self._lost[operation] = self._lost.get(operation, 0) + 1

    def _maybe_lose(self, operation: str) -> None:
        with self._lock:
            if self._lost.get(operation):
                self._lost[operation] -= 1
                raise CognitoError(CognitoErrorKind.UNAVAILABLE, "Timeout")

    def expire_signup_code(self, email: str) -> None:
        self.users[email.lower()].signup_code_expired = True

    def _send_signup_code(self, user: FakeUser) -> None:
        user.signup_code = f"{secrets.randbelow(10**6):06d}"
        user.signup_code_expired = False
        self.signup_emails.append(user.email.lower())

    def disable(self, email: str) -> None:
        """Like AdminDisableUser: no sign-in, access tokens revoked."""
        key = email.lower()
        self.users[key].enabled = False
        with self._lock:
            for token in [t for t, owner in self._tokens.items() if owner == key]:
                del self._tokens[token]

    def _enter(self, operation: str) -> None:
        self.calls.append(operation)
        hook = self.hooks.get(operation)
        if hook is not None:
            hook()
        pending = self._failures.get(operation)
        if pending:
            raise pending.pop(0)

    def _issue(self, key: str) -> AuthTokens:
        token = f"fake-access-{secrets.token_hex(16)}"
        with self._lock:
            self._tokens[token] = key
        self.issued_tokens.append(token)
        return AuthTokens(access_token=token)

    def _user_for_token(self, token: str) -> FakeUser:
        with self._lock:
            key = self._tokens.get(token)
        if key is None:
            raise CognitoError(CognitoErrorKind.NOT_AUTHORIZED, "NotAuthorizedException")
        return self.users[key]

    @staticmethod
    def _check_policy(password: str) -> None:
        if len(password) < MIN_PASSWORD_LENGTH:
            raise CognitoError(CognitoErrorKind.INVALID_PASSWORD, "InvalidPasswordException")

    # -- CognitoClient ------------------------------------------------------------------------

    def initiate_password_auth(self, email: str, password: str) -> AuthTokens | AuthChallengeStep:
        user = self.users.get(email.lower())
        if user is None or not user.enabled or not secrets.compare_digest(user.password, password):
            self._enter("InitiateAuth")
            raise CognitoError(CognitoErrorKind.NOT_AUTHORIZED, "NotAuthorizedException")
        self._enter("InitiateAuth")
        if not user.confirmed:
            # Cognito's UserNotConfirmedException (MyDubb maps it to NOT_AUTHORIZED).
            raise CognitoError(CognitoErrorKind.NOT_AUTHORIZED, "UserNotConfirmedException")
        if self.challenge_override is not None:
            return AuthChallengeStep(name=self.challenge_override, session="s", username=user.sub)
        if user.temporary:
            session = f"fake-session-{secrets.token_hex(16)}"
            with self._lock:
                self._sessions[session] = email.lower()
            self.issued_sessions.append(session)
            return AuthChallengeStep(name=NEW_PASSWORD_REQUIRED, session=session, username=user.sub)
        return self._issue(email.lower())

    def respond_new_password(
        self, username: str, session: str, new_password: str
    ) -> AuthTokens | AuthChallengeStep:
        self._enter("RespondToAuthChallenge")
        with self._lock:
            key = self._sessions.get(session)
        if key is None or self.users[key].sub != username:
            raise CognitoError(CognitoErrorKind.NOT_AUTHORIZED, "NotAuthorizedException")
        self._check_policy(new_password)
        with self._lock:
            del self._sessions[session]  # a sign-in session answers one challenge
        user = self.users[key]
        user.password, user.temporary = new_password, False
        return self._issue(key)

    def get_user(self, access_token: str) -> CognitoUser:
        self._enter("GetUser")
        user = self._user_for_token(access_token)
        return CognitoUser(
            sub=user.sub, email=user.email, email_verified=user.email_verified, name=user.name
        )

    def send_email_verification_code(self, access_token: str) -> str | None:
        self._enter("GetUserAttributeVerificationCode")
        user = self._user_for_token(access_token)
        user.verification_code = f"{secrets.randbelow(10**6):06d}"
        return f"{user.email[0]}***@{user.email.split('@')[1][0]}***"

    def verify_email(self, access_token: str, code: str) -> None:
        self._enter("VerifyUserAttribute")
        user = self._user_for_token(access_token)
        if user.verification_code is None or not secrets.compare_digest(
            user.verification_code, code
        ):
            raise CognitoError(CognitoErrorKind.CODE_INVALID, "CodeMismatchException")
        user.email_verified, user.verification_code = True, None

    def forgot_password(self, email: str) -> None:
        self._enter("ForgotPassword")
        user = self.users.get(email.lower())
        if user is not None and user.enabled and user.email_verified:
            user.reset_code = f"{secrets.randbelow(10**6):06d}"
        # Otherwise: a simulated delivery, indistinguishable from a real one.

    def confirm_forgot_password(self, email: str, code: str, new_password: str) -> None:
        self._enter("ConfirmForgotPassword")
        self._check_policy(new_password)
        user = self.users.get(email.lower())
        if (
            user is None
            or not user.enabled
            or user.reset_code is None
            or not secrets.compare_digest(user.reset_code, code)
        ):
            raise CognitoError(CognitoErrorKind.CODE_INVALID, "CodeMismatchException")
        user.password, user.reset_code = new_password, None

    # -- sign-up -------------------------------------------------------------------------------

    def sign_up(self, email: str, password: str) -> None:
        self._enter("SignUp")
        if self.signup_disabled:
            raise CognitoError(CognitoErrorKind.NOT_AUTHORIZED, "NotAuthorizedException")
        self._check_policy(password)
        key = email.lower()
        with self._lock:  # one user per email, also for concurrent requests
            if key in self.users:
                raise CognitoError(CognitoErrorKind.USER_EXISTS, "UsernameExistsException")
            user = FakeUser(
                email=email,
                password=password,
                sub=f"sub-{next(self._counter)}",
                email_verified=False,
                confirmed=False,
            )
            self.users[key] = user
            self._send_signup_code(user)
        self._maybe_lose("SignUp")

    def confirm_sign_up(self, email: str, code: str) -> None:
        self._enter("ConfirmSignUp")
        user = self.users.get(email.lower())
        if user is None:
            raise CognitoError(CognitoErrorKind.CODE_INVALID, "CodeMismatchException")
        if user.confirmed:
            raise CognitoError(CognitoErrorKind.NOT_AUTHORIZED, "NotAuthorizedException")
        if user.signup_code is None or not secrets.compare_digest(user.signup_code, code):
            raise CognitoError(CognitoErrorKind.CODE_INVALID, "CodeMismatchException")
        if user.signup_code_expired:
            raise CognitoError(CognitoErrorKind.CODE_INVALID, "ExpiredCodeException")
        # Confirming with the emailed code marks the email verified (AutoVerifiedAttributes).
        user.confirmed, user.email_verified, user.signup_code = True, True, None
        self._maybe_lose("ConfirmSignUp")

    def resend_confirmation_code(self, email: str) -> None:
        self._enter("ResendConfirmationCode")
        user = self.users.get(email.lower())
        if user is None:
            return  # a simulated delivery, indistinguishable from a real one
        if user.confirmed:
            raise CognitoError(CognitoErrorKind.INVALID_PARAMETER, "InvalidParameterException")
        self._send_signup_code(user)
