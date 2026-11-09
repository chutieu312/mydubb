"""Public sign-up: Create account, confirm the emailed code, resend it (docs/SIGNUP.md).

Contract: docs/AUTH_API.md, "Sign-up". Mounted with the Cognito router; while
PUBLIC_SIGNUP_ENABLED=false every endpoint answers `404 signup_disabled` before anything else, and
while a required setting is missing `503 signup_unavailable`: no CAPTCHA check, no Cognito call,
no email.

Order of a Create account request: limits (every request counts) -> Google reCAPTCHA check (fails
closed) -> Cognito `SignUp`. A request refused before `SignUp` creates nothing and sends nothing.

No session is opened here. A confirmed account signs in with the existing sign-in, which opens a
MyDubb session only once Cognito reports `email_verified=true` and creates the `users` row, whose
plan is the database default (Free). Nothing here reads a role, a plan or a user id from the
request.

No account enumeration: Create account answers the same `verification_required` whether the email
is new or already has an account (the existing owner gets no email from this request), Resend
answers `202` whatever the account, and a wrong, unknown or already-used code is one
`code_invalid`. Nothing is retried; a lost answer is reported as such (`*_outcome_unknown`) and
the user continues on the Verify screen or signs in. Passwords, codes and tokens are never logged.
"""

import logging
from typing import Literal

from fastapi import APIRouter, Depends, Request, status
from pydantic import BaseModel, Field

from app.auth.cognito import CognitoError, CognitoErrorKind
from app.auth.recaptcha import CaptchaResult
from app.auth.router import (
    _CODE,
    _EMAIL,
    StatusResponse,
    _check_recovery_limits,
    _cognito,
    _cognito_failure,
    _cognito_throttled,
    _password_rejected,
    _too_many,
    _unavailable,
)
from app.auth.service import normalize_email, sha256_hex
from app.dependencies import client_key, get_services
from app.errors import ApiError
from app.services import AppServices, SignupServices

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/auth/signup", tags=["auth"])


class SignupRequest(BaseModel):
    email: str = Field(min_length=3, max_length=320, pattern=_EMAIL)
    password: str = Field(min_length=1, max_length=256)
    # The g-recaptcha-response token of the Checkbox (single-use, valid two minutes).
    captcha_token: str = Field(min_length=1, max_length=4096)


class SignupResponse(BaseModel):
    status: Literal["verification_required"] = "verification_required"


class ConfirmSignupRequest(BaseModel):
    email: str = Field(min_length=3, max_length=320, pattern=_EMAIL)
    code: str = Field(pattern=_CODE)


class ConfirmSignupResponse(BaseModel):
    status: Literal["verified"] = "verified"


class ResendRequest(BaseModel):
    email: str = Field(min_length=3, max_length=320, pattern=_EMAIL)


def _signup(services: AppServices) -> SignupServices:
    signup = services.signup
    if signup is None:
        raise ApiError(
            status.HTTP_404_NOT_FOUND,
            "signup_disabled",
            "Creating an account is not available. Sign in with your invitation.",
        )
    if not signup.ready:
        raise ApiError(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "signup_unavailable",
            "Creating an account is not available right now. Please try again later.",
        )
    return signup


def _check_signup_limits(signup: SignupServices, request: Request, email: str) -> None:
    """Every Create account request counts, before Google or Cognito is asked, so pressing the
    button again and again never multiplies CAPTCHA checks or emails."""
    limits = (
        (signup.limiter, client_key(request)),
        (signup.email_limiter, sha256_hex(normalize_email(email))),
    )
    waits = [w for limiter, key in limits if (w := limiter.retry_after(key)) is not None]
    if waits:
        raise _too_many(
            max(waits), "Too many attempts to create an account. Please wait and try again."
        )
    for limiter, key in limits:
        limiter.record_failure(key)


def _code_invalid() -> ApiError:
    return ApiError(
        status.HTTP_400_BAD_REQUEST,
        "code_invalid",
        "That code is not right. Check the latest email we sent, or request a new code. If you "
        "already verified your email, sign in.",
    )


@router.post("", response_model=SignupResponse)
def create_account(
    body: SignupRequest,
    request: Request,
    services: AppServices = Depends(get_services),
) -> SignupResponse:
    signup = _signup(services)
    email = body.email.strip()
    _check_signup_limits(signup, request, email)

    assert signup.captcha is not None
    verdict = signup.captcha.verify(body.captcha_token)
    if verdict.result is CaptchaResult.REJECTED:
        logger.info("Sign-up refused: reCAPTCHA token rejected (%s)", verdict.reason)
        raise ApiError(
            status.HTTP_400_BAD_REQUEST,
            "captcha_invalid",
            "The robot check expired or did not pass. Tick the box again, then press Create "
            "account.",
        )
    if verdict.result is not CaptchaResult.VALID:
        raise ApiError(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "captcha_unavailable",
            "We cannot run the robot check right now, so no account was created. Please try "
            "again later. Signing in still works.",
        )

    try:
        _cognito(services).sign_up(email, body.password)
    except CognitoError as exc:
        if exc.kind is CognitoErrorKind.USER_EXISTS:
            # The same answer as a new account: the response never tells whether an email is
            # registered. The owner is not emailed; they sign in or use Forgot password, and
            # someone whose earlier sign-up is still unconfirmed uses Resend code.
            logger.info("Sign-up for an email that already has a user; answered as usual")
            return SignupResponse()
        if exc.aws_type in ("LimitExceededException", "CodeDeliveryFailureException"):
            # Cognito created the user but could not send the code (e.g. its email quota). The
            # Verify screen offers Resend code; this answer is the usual one.
            logger.warning(
                "Sign-up accepted but the code may not have been sent (%s)", exc.aws_type
            )
            return SignupResponse()
        if exc.kind is CognitoErrorKind.INVALID_PASSWORD:
            raise _password_rejected() from None
        if exc.kind is CognitoErrorKind.INVALID_PARAMETER or (
            exc.aws_type == "UserLambdaValidationException"
        ):
            raise ApiError(
                status.HTTP_422_UNPROCESSABLE_CONTENT,
                "signup_rejected",
                "We could not create an account with this email address. Check it and try again.",
            ) from None
        if exc.kind is CognitoErrorKind.NOT_AUTHORIZED:
            # Self-service sign-up off in the user pool, or a wrong client secret: configuration.
            logger.error(
                "Cognito refused SignUp (%s); check the user pool and app client", exc.aws_type
            )
            raise ApiError(
                status.HTTP_503_SERVICE_UNAVAILABLE,
                "signup_unavailable",
                "Creating an account is not available right now. Please try again later.",
            ) from None
        if exc.kind is CognitoErrorKind.UNAVAILABLE:
            # No answer: the account may exist. Never retried; a second attempt is answered like
            # any other (Cognito never creates a second user for one email).
            raise ApiError(
                status.HTTP_503_SERVICE_UNAVAILABLE,
                "signup_outcome_unknown",
                "We could not confirm whether your account was created. If a code arrives by "
                "email, enter it on the next screen; otherwise try again in a few minutes.",
            ) from None
        _cognito_failure(exc)
    return SignupResponse()


@router.post("/confirm", response_model=ConfirmSignupResponse)
def confirm_account(
    body: ConfirmSignupRequest,
    request: Request,
    services: AppServices = Depends(get_services),
) -> ConfirmSignupResponse:
    _signup(services)
    # Wrong codes count like failed sign-ins (the same limiter), per client and overall.
    limiter, client = services.access_limiter, client_key(request)
    retry_after = limiter.retry_after(client)
    if retry_after is not None:
        raise _too_many(retry_after, "Too many wrong codes. Please wait before trying again.")
    try:
        _cognito(services).confirm_sign_up(body.email.strip(), body.code)
    except CognitoError as exc:
        if exc.kind is CognitoErrorKind.CODE_INVALID:
            limiter.record_failure(client)
            if exc.aws_type == "ExpiredCodeException":
                raise ApiError(
                    status.HTTP_400_BAD_REQUEST,
                    "code_expired",
                    "This code has expired. Choose Resend code to get a new one.",
                ) from None
            raise _code_invalid() from None
        if exc.kind in (
            CognitoErrorKind.NOT_AUTHORIZED,  # unknown user, or already confirmed
            CognitoErrorKind.USER_EXISTS,  # the email belongs to another, confirmed user
            CognitoErrorKind.INVALID_PARAMETER,
        ):
            limiter.record_failure(client)
            raise _code_invalid() from None
        if exc.kind is CognitoErrorKind.RATE_LIMITED and exc.aws_type != "TooManyRequestsException":
            raise _too_many(
                None, "Too many attempts for this code. Please wait, then request a new code."
            ) from None
        if exc.kind is CognitoErrorKind.UNAVAILABLE:
            raise ApiError(
                status.HTTP_503_SERVICE_UNAVAILABLE,
                "verification_outcome_unknown",
                "We could not confirm whether your email was verified. Try signing in; if that "
                "does not work, enter the code again or request a new one.",
            ) from None
        _cognito_failure(exc)
    return ConfirmSignupResponse()


@router.post("/resend", status_code=status.HTTP_202_ACCEPTED, response_model=StatusResponse)
def resend_code(
    body: ResendRequest,
    request: Request,
    services: AppServices = Depends(get_services),
) -> StatusResponse:
    _signup(services)
    email = body.email.strip()
    # The same limits as the other emails MyDubb asks Cognito to send (per client, per address).
    _check_recovery_limits(services, request, email)
    try:
        _cognito(services).resend_confirmation_code(email)
    except CognitoError as exc:
        if exc.kind is CognitoErrorKind.UNAVAILABLE:
            raise _unavailable() from None
        if exc.aws_type == "TooManyRequestsException":
            # Pool-wide throttling, the same for every address.
            raise _cognito_throttled() from None
        # Unknown, already confirmed or disabled user, per-user limits: answered like a success
        # so the response never tells whether (or how) an account exists. The type is logged.
    return StatusResponse(status="accepted")
