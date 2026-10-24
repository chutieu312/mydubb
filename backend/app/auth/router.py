"""Email/password sign-in with Amazon Cognito (mounted only with AUTH_MODE=cognito).

Contract: docs/AUTH_API.md. Cognito verifies credentials; MyDubb keeps its own opaque session
(`mydubb_auth` cookie, only the hash stored) and never returns a Cognito token to the browser.

Each database step runs in its own short transaction (`session_scope`), and no transaction is
open while a Cognito request is in flight. Passwords and codes are only forwarded to Cognito;
they are never stored or logged.
"""

import logging
import uuid
from collections.abc import Callable
from datetime import datetime
from typing import Literal, NoReturn

from fastapi import APIRouter, Depends, Request, Response, status
from pydantic import BaseModel, Field
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.access.rate_limit import FailedAttemptLimiter
from app.auth.cognito import (
    NEW_PASSWORD_REQUIRED,
    AuthChallengeStep,
    AuthTokens,
    CognitoClient,
    CognitoError,
    CognitoErrorKind,
)
from app.auth.crypto import TokenCipher
from app.auth.principal import Principal
from app.auth.service import (
    MAX_VERIFICATION_SENDS,
    RESET_SETTLE_MARGIN_SECONDS,
    AccountDisabled,
    ChallengeBusy,
    ChallengeInvalid,
    ChallengeKind,
    ClaimedChallenge,
    IssuedChallenge,
    LeaseOutcome,
    PasswordChangedDuringSignIn,
    ResetOutcome,
    begin_password_reset,
    claim_challenge,
    consume_challenge,
    create_challenge,
    database_now,
    establish_user_session,
    finish_password_reset,
    normalize_email,
    release_challenge,
    revoke_user_session,
    sha256_hex,
)
from app.db import session_scope
from app.dependencies import (
    AUTH_COOKIE,
    client_key,
    get_db,
    get_services,
    require_csrf,
    require_session,
)
from app.errors import ApiError
from app.services import AppServices

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/auth", tags=["auth"])

CHALLENGE_COOKIE = "mydubb_auth_challenge"
CHALLENGE_COOKIE_PATH = "/api/auth"
INVALID_CREDENTIALS_MESSAGE = (
    "Incorrect email or password. If you forgot your password, use Forgot password."
)
_EMAIL = r"^\s*[^@\s]+@[^@\s]+\.[^@\s]+\s*$"
_CODE = r"^\d{1,10}$"

# -- request and response bodies --------------------------------------------------------------


class LoginRequest(BaseModel):
    email: str = Field(min_length=3, max_length=320, pattern=_EMAIL)
    password: str = Field(min_length=1, max_length=256)


class NewPasswordRequest(BaseModel):
    challenge_id: str = Field(min_length=1, max_length=200)
    new_password: str = Field(min_length=1, max_length=256)


class ChallengeRequest(BaseModel):
    challenge_id: str = Field(min_length=1, max_length=200)


class VerifyEmailRequest(BaseModel):
    challenge_id: str = Field(min_length=1, max_length=200)
    code: str = Field(pattern=_CODE)


class ForgotPasswordRequest(BaseModel):
    email: str = Field(min_length=3, max_length=320, pattern=_EMAIL)


class ResetPasswordRequest(BaseModel):
    email: str = Field(min_length=3, max_length=320, pattern=_EMAIL)
    code: str = Field(pattern=_CODE)
    new_password: str = Field(min_length=1, max_length=256)


class UserOut(BaseModel):
    id: uuid.UUID
    email: str
    display_name: str | None


class AuthenticatedResponse(BaseModel):
    status: Literal["authenticated"] = "authenticated"
    user: UserOut
    csrf_token: str
    expires_at: datetime


class ChallengeResponse(BaseModel):
    status: Literal["new_password_required", "email_verification_required"]
    challenge_id: str
    challenge_expires_at: datetime


AuthStep = AuthenticatedResponse | ChallengeResponse


class CodeSentResponse(BaseModel):
    status: Literal["code_sent"] = "code_sent"
    destination: str | None
    challenge_expires_at: datetime


class StatusResponse(BaseModel):
    status: str


class MeResponse(BaseModel):
    user: UserOut
    csrf_token: str
    expires_at: datetime


# -- errors -----------------------------------------------------------------------------------


def _unavailable() -> ApiError:
    return ApiError(
        status.HTTP_503_SERVICE_UNAVAILABLE,
        "auth_unavailable",
        "The sign-in service is not available right now. Please try again in a moment.",
    )


def _cognito_throttled() -> ApiError:
    return ApiError(
        status.HTTP_429_TOO_MANY_REQUESTS,
        "auth_rate_limited",
        "The sign-in service is receiving too many requests. Please try again later.",
    )


def _challenge_busy() -> ApiError:
    return ApiError(
        status.HTTP_409_CONFLICT,
        "challenge_busy",
        "This sign-in step is already being processed. Please wait.",
    )


def _challenge_invalid() -> ApiError:
    return ApiError(
        status.HTTP_400_BAD_REQUEST,
        "challenge_invalid",
        "This sign-in step has expired or was already completed. Please sign in again.",
    )


def _code_invalid() -> ApiError:
    return ApiError(
        status.HTTP_400_BAD_REQUEST, "code_invalid", "The code is incorrect or has expired."
    )


def _password_rejected() -> ApiError:
    return ApiError(
        status.HTTP_422_UNPROCESSABLE_CONTENT,
        "password_rejected",
        "The new password does not meet the password requirements.",
    )


def _too_many(retry_after: int | None, message: str) -> ApiError:
    headers = {"Retry-After": str(retry_after)} if retry_after is not None else None
    extra = {"retry_after_seconds": retry_after} if retry_after is not None else None
    return ApiError(
        status.HTTP_429_TOO_MANY_REQUESTS,
        "too_many_attempts",
        message,
        headers=headers,
        extra=extra,
    )


def _cognito_failure(exc: CognitoError) -> NoReturn:
    """The default meaning of a Cognito error that a step does not handle itself."""
    if exc.kind is CognitoErrorKind.RATE_LIMITED:
        raise _cognito_throttled() from None
    raise _unavailable() from None


# -- helpers ----------------------------------------------------------------------------------


def _cognito(services: AppServices) -> CognitoClient:
    assert services.cognito is not None  # the router exists only in Cognito mode
    return services.cognito


def _cipher(services: AppServices) -> TokenCipher:
    assert services.token_cipher is not None
    return services.token_cipher


def _in_transaction[T](services: AppServices, work: Callable[[Session], T]) -> T:
    with session_scope(services.session_factory) as db:
        return work(db)


def _set_challenge_cookie(
    response: Response, services: AppServices, issued: IssuedChallenge, ttl_seconds: int
) -> None:
    response.set_cookie(
        CHALLENGE_COOKIE,
        issued.binding,
        max_age=ttl_seconds,
        httponly=True,
        secure=services.settings.cookie_secure,
        samesite="strict",
        path=CHALLENGE_COOKIE_PATH,
    )


def _clear_challenge_cookie(response: Response, services: AppServices) -> None:
    response.delete_cookie(
        CHALLENGE_COOKIE,
        path=CHALLENGE_COOKIE_PATH,
        httponly=True,
        secure=services.settings.cookie_secure,
        samesite="strict",
    )


def _start_challenge(
    services: AppServices,
    response: Response,
    *,
    kind: ChallengeKind,
    payload: dict[str, str],
    auth_started_at: datetime,
) -> ChallengeResponse:
    settings = services.settings
    ttl = (
        settings.auth_new_password_challenge_ttl_seconds
        if kind is ChallengeKind.NEW_PASSWORD
        else settings.auth_email_verification_challenge_ttl_seconds
    )
    issued = _in_transaction(
        services,
        lambda db: create_challenge(
            db,
            _cipher(services),
            kind=kind,
            payload=payload,
            auth_started_at=auth_started_at,
            ttl_seconds=ttl,
        ),
    )
    _set_challenge_cookie(response, services, issued, ttl)
    return ChallengeResponse(
        status="new_password_required"
        if kind is ChallengeKind.NEW_PASSWORD
        else "email_verification_required",
        challenge_id=issued.challenge_id,
        challenge_expires_at=issued.expires_at,
    )


def _claim(
    services: AppServices, request: Request, challenge_id: str, kind: ChallengeKind
) -> ClaimedChallenge:
    # A lease that runs out only lets another request take a stuck step over; consume/release
    # check the lease token, so correctness does not depend on this length.
    lease = services.settings.cognito_timeout_seconds + 5
    try:
        return _in_transaction(
            services,
            lambda db: claim_challenge(
                db,
                _cipher(services),
                token=challenge_id,
                binding=request.cookies.get(CHALLENGE_COOKIE),
                kind=kind,
                lease_seconds=lease,
            ),
        )
    except ChallengeInvalid:
        raise _challenge_invalid() from None
    except ChallengeBusy:
        raise _challenge_busy() from None


def _consume(services: AppServices, claimed: ClaimedChallenge) -> None:
    """Complete the step, or stop: a request that lost its lease, or whose step expired while
    Cognito was answering, must not go on to the next step or a session."""
    outcome = _in_transaction(services, lambda db: consume_challenge(db, claimed))
    if outcome is LeaseOutcome.LOST:
        logger.info("Sign-in step was taken over by another request; not completed here")
        raise _challenge_busy()
    if outcome is LeaseOutcome.EXPIRED:
        raise _challenge_invalid()


def _close(services: AppServices, claimed: ClaimedChallenge) -> None:
    """End a step that cannot succeed (if this request still holds it)."""
    _in_transaction(services, lambda db: consume_challenge(db, claimed))


def _release(
    services: AppServices,
    claimed: ClaimedChallenge,
    *,
    failed_attempt: bool = False,
    sent: bool = False,
) -> None:
    # A request that lost its lease changes nothing (the new holder keeps it).
    _in_transaction(
        services,
        lambda db: release_challenge(db, claimed, failed_attempt=failed_attempt, sent=sent),
    )


def _finish_sign_in(
    services: AppServices,
    response: Response,
    access_token: str,
    auth_started_at: datetime,
    *,
    after_verification: bool = False,
) -> AuthStep:
    """Cognito accepted the credentials: verify the email, then open the MyDubb session."""
    try:
        cognito_user = _cognito(services).get_user(access_token)
    except CognitoError as exc:
        _cognito_failure(exc)
    if not cognito_user.email_verified:
        if after_verification:
            # Cognito confirmed the code but still reports the email unverified.
            logger.warning("Email still unverified after a successful verification")
            raise _unavailable()
        # The access token is kept (encrypted) only to send and check the verification code.
        return _start_challenge(
            services,
            response,
            kind=ChallengeKind.EMAIL_VERIFICATION,
            payload={"access_token": access_token},
            auth_started_at=auth_started_at,
        )
    settings = services.settings
    try:
        user, issued = _in_transaction(
            services,
            lambda db: establish_user_session(
                db,
                issuer=settings.cognito_issuer,
                cognito_user=cognito_user,
                auth_started_at=auth_started_at,
                ttl_seconds=settings.session_ttl_seconds,
            ),
        )
    except AccountDisabled:
        raise ApiError(
            status.HTTP_403_FORBIDDEN,
            "account_disabled",
            "This account is disabled. Contact the MyDubb administrator.",
        ) from None
    except PasswordChangedDuringSignIn:
        raise ApiError(
            status.HTTP_409_CONFLICT,
            "password_changed",
            "Your password or account access changed while you were signing in. "
            "Please sign in again.",
        ) from None
    response.set_cookie(
        AUTH_COOKIE,
        issued.token,
        max_age=settings.session_ttl_seconds,
        httponly=True,
        secure=settings.cookie_secure,
        samesite="strict",
        path="/",
    )
    _clear_challenge_cookie(response, services)
    return AuthenticatedResponse(
        user=UserOut(id=user.id, email=user.email, display_name=user.display_name),
        csrf_token=issued.csrf_token,
        expires_at=issued.expires_at,
    )


def _after_auth(
    services: AppServices,
    response: Response,
    outcome: AuthTokens | AuthChallengeStep,
    auth_started_at: datetime,
) -> AuthStep:
    if isinstance(outcome, AuthTokens):
        return _finish_sign_in(services, response, outcome.access_token, auth_started_at)
    if outcome.name == NEW_PASSWORD_REQUIRED and outcome.username:
        return _start_challenge(
            services,
            response,
            kind=ChallengeKind.NEW_PASSWORD,
            payload={"session": outcome.session, "username": outcome.username},
            auth_started_at=auth_started_at,
        )
    # MFA and other steps are not configured for MyDubb (see docs/AUTHENTICATION.md).
    logger.warning("Unsupported Cognito sign-in challenge %s", outcome.name[:40])
    raise _unavailable()


def _reset_settle_seconds(services: AppServices) -> float:
    """When a reset request MyDubb sent can no longer be in flight: two Cognito timeouts (each
    phase of the request is bounded by it, plus the response deadline) and a margin."""
    return 2 * services.settings.cognito_timeout_seconds + RESET_SETTLE_MARGIN_SECONDS


def _record_reset(
    services: AppServices, attempt_id: uuid.UUID, email: str, outcome: ResetOutcome
) -> None:
    try:
        revoked = _in_transaction(
            services, lambda db: finish_password_reset(db, attempt_id, email, outcome)
        )
    except Exception as exc:
        # Fail closed: the attempt stays pending and is enforced once it settles.
        logger.error(
            "Password reset outcome %s not recorded (%s); enforced when the attempt settles",
            outcome.value,
            type(exc).__name__,
        )
        return
    if outcome is not ResetOutcome.REJECTED:
        logger.info("Password reset %s; %d session(s) revoked", outcome.value, revoked)


def _check_recovery_limits(
    services: AppServices, request: Request, email: str | None = None
) -> None:
    """Every recovery/verification request counts, whether or not it succeeds."""
    limiters: list[tuple[FailedAttemptLimiter, str]] = []
    assert services.recovery_limiter is not None
    limiters.append((services.recovery_limiter, client_key(request)))
    if email is not None:
        assert services.recovery_email_limiter is not None
        limiters.append((services.recovery_email_limiter, sha256_hex(normalize_email(email))))
    waits = [w for limiter, key in limiters if (w := limiter.retry_after(key)) is not None]
    if waits:
        raise _too_many(max(waits), "Too many requests. Please wait before trying again.")
    for limiter, key in limiters:
        limiter.record_failure(key)


# -- endpoints --------------------------------------------------------------------------------


@router.post("/login", response_model=AuthStep)
def login(
    body: LoginRequest,
    request: Request,
    response: Response,
    services: AppServices = Depends(get_services),
) -> AuthStep:
    limiter = services.access_limiter
    client = client_key(request)
    retry_after = limiter.retry_after(client)
    if retry_after is not None:
        raise _too_many(
            retry_after, "Too many unsuccessful sign-in attempts. Please wait before trying again."
        )
    auth_started_at = _in_transaction(services, database_now)
    try:
        outcome = _cognito(services).initiate_password_auth(body.email.strip(), body.password)
    except CognitoError as exc:
        if exc.kind is CognitoErrorKind.NOT_AUTHORIZED:
            limiter.record_failure(client)
            raise ApiError(
                status.HTTP_401_UNAUTHORIZED, "invalid_credentials", INVALID_CREDENTIALS_MESSAGE
            ) from None
        _cognito_failure(exc)
    return _after_auth(services, response, outcome, auth_started_at)


@router.post("/new-password", response_model=AuthStep)
def new_password(
    body: NewPasswordRequest,
    request: Request,
    response: Response,
    services: AppServices = Depends(get_services),
) -> AuthStep:
    claimed = _claim(services, request, body.challenge_id, ChallengeKind.NEW_PASSWORD)
    try:
        outcome = _cognito(services).respond_new_password(
            claimed.payload["username"], claimed.payload["session"], body.new_password
        )
    except CognitoError as exc:
        if exc.kind is CognitoErrorKind.INVALID_PASSWORD:
            _release(services, claimed, failed_attempt=True)
            raise _password_rejected() from None
        if exc.kind is CognitoErrorKind.NOT_AUTHORIZED:
            # Cognito's sign-in session expired or was already used.
            _close(services, claimed)
            raise _challenge_invalid() from None
        if exc.kind is CognitoErrorKind.INVALID_PARAMETER:
            _close(services, claimed)
            raise ApiError(
                status.HTTP_409_CONFLICT,
                "account_setup_incomplete",
                "This account is not fully set up. Contact the MyDubb administrator.",
            ) from None
        _release(services, claimed)
        _cognito_failure(exc)
    # Cognito has set the new password; if this request lost the step meanwhile, the user signs
    # in with the new password.
    _consume(services, claimed)
    return _after_auth(services, response, outcome, claimed.auth_started_at)


@router.post("/email-verification/send", response_model=CodeSentResponse)
def send_email_verification(
    body: ChallengeRequest,
    request: Request,
    services: AppServices = Depends(get_services),
) -> CodeSentResponse:
    _check_recovery_limits(services, request)
    claimed = _claim(services, request, body.challenge_id, ChallengeKind.EMAIL_VERIFICATION)
    if claimed.sends >= MAX_VERIFICATION_SENDS:
        _release(services, claimed)
        raise _too_many(None, "Too many codes were requested. Please sign in again later.")
    try:
        destination = _cognito(services).send_email_verification_code(
            claimed.payload["access_token"]
        )
    except CognitoError as exc:
        if exc.kind is CognitoErrorKind.NOT_AUTHORIZED:
            # The access token expired or was revoked (e.g. the user was disabled).
            _close(services, claimed)
            raise _challenge_invalid() from None
        _release(services, claimed)
        _cognito_failure(exc)
    _release(services, claimed, sent=True)
    return CodeSentResponse(
        destination=destination[:320] if destination else None,
        challenge_expires_at=claimed.expires_at,
    )


@router.post("/email-verification/confirm", response_model=AuthStep)
def confirm_email_verification(
    body: VerifyEmailRequest,
    request: Request,
    response: Response,
    services: AppServices = Depends(get_services),
) -> AuthStep:
    claimed = _claim(services, request, body.challenge_id, ChallengeKind.EMAIL_VERIFICATION)
    access_token = claimed.payload["access_token"]
    try:
        _cognito(services).verify_email(access_token, body.code)
    except CognitoError as exc:
        if exc.kind is CognitoErrorKind.CODE_INVALID:
            _release(services, claimed, failed_attempt=True)
            raise _code_invalid() from None
        if exc.kind is CognitoErrorKind.NOT_AUTHORIZED:
            _close(services, claimed)
            raise _challenge_invalid() from None
        _release(services, claimed)
        _cognito_failure(exc)
    # Cognito has verified the email; if this request lost the step meanwhile, the next sign-in
    # finds the email verified.
    _consume(services, claimed)
    return _finish_sign_in(
        services, response, access_token, claimed.auth_started_at, after_verification=True
    )


@router.post(
    "/forgot-password", status_code=status.HTTP_202_ACCEPTED, response_model=StatusResponse
)
def forgot_password(
    body: ForgotPasswordRequest,
    request: Request,
    services: AppServices = Depends(get_services),
) -> StatusResponse:
    email = body.email.strip()
    _check_recovery_limits(services, request, email)
    try:
        _cognito(services).forgot_password(email)
    except CognitoError as exc:
        if exc.kind is CognitoErrorKind.UNAVAILABLE:
            raise _unavailable() from None
        if exc.aws_type == "TooManyRequestsException":
            # Pool-wide throttling, the same for every address.
            raise _cognito_throttled() from None
        # Unknown, disabled or unverified account, per-user limits: answered like a success
        # so the response never tells whether the account exists (the type is in the log).
    return StatusResponse(status="accepted")


@router.post("/reset-password", response_model=StatusResponse)
def reset_password(
    body: ResetPasswordRequest,
    request: Request,
    services: AppServices = Depends(get_services),
) -> StatusResponse:
    email = body.email.strip()
    _check_recovery_limits(services, request, email)
    # The attempt is committed before Cognito is asked, so its outcome can never be lost: if it
    # cannot be recorded afterwards, the attempt stays pending and counts as a reset once it has
    # settled (see app/auth/service.py). Without this record nothing is sent to Cognito.
    try:
        attempt_id = _in_transaction(
            services, lambda db: begin_password_reset(db, email, _reset_settle_seconds(services))
        )
    except SQLAlchemyError as exc:
        logger.error("Password reset not started: database unavailable (%s)", type(exc).__name__)
        raise _unavailable() from None
    try:
        _cognito(services).confirm_forgot_password(email, body.code, body.new_password)
    except CognitoError as exc:
        if exc.kind is CognitoErrorKind.UNAVAILABLE:
            # Cognito may or may not have changed the password (no answer, timeout, 5xx): fail
            # closed. Never retried; the user tries the new password or asks for a new code.
            _record_reset(services, attempt_id, email, ResetOutcome.UNKNOWN)
            raise ApiError(
                status.HTTP_503_SERVICE_UNAVAILABLE,
                "auth_unavailable",
                "We could not confirm whether your password was changed. For your safety, this "
                "account is signed out everywhere. In a minute or two, sign in with the new "
                "password; if it does not work, request a new code.",
            ) from None
        _record_reset(services, attempt_id, email, ResetOutcome.REJECTED)
        if exc.kind is CognitoErrorKind.INVALID_PASSWORD:
            raise _password_rejected() from None
        if exc.kind in (
            CognitoErrorKind.CODE_INVALID,
            CognitoErrorKind.NOT_AUTHORIZED,
            CognitoErrorKind.INVALID_PARAMETER,
        ):
            # Wrong, expired or never-requested code, unknown or disabled account: one answer.
            raise _code_invalid() from None
        _cognito_failure(exc)
    # The password is changed. If recording fails, the sessions are still revoked once the
    # attempt settles, so the answer stays a success.
    _record_reset(services, attempt_id, email, ResetOutcome.SUCCEEDED)
    return StatusResponse(status="password_reset")


@router.get("/me", response_model=MeResponse)
def me(principal: Principal = Depends(require_session)) -> MeResponse:
    assert principal.user is not None
    return MeResponse(
        user=UserOut(
            id=principal.user.id,
            email=principal.user.email,
            display_name=principal.user.display_name,
        ),
        csrf_token=principal.csrf_token,
        expires_at=principal.expires_at,
    )


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
def logout(
    response: Response,
    principal: Principal = Depends(require_csrf),
    db: Session = Depends(get_db),
    services: AppServices = Depends(get_services),
) -> None:
    revoke_user_session(db, principal.session_id)
    response.delete_cookie(
        AUTH_COOKIE,
        path="/",
        httponly=True,
        secure=services.settings.cookie_secure,
        samesite="strict",
    )
