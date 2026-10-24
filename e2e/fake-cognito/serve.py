"""E2E-only launcher: the real MyDubb backend with an in-memory Amazon Cognito stand-in.

Not part of the application image. docker-compose.e2e.yml mounts this file and
backend/tests/fake_cognito.py (the stand-in the backend's own tests use) into a container that is
built from the repository Dockerfile, so everything except the user pool is the production code:
routers, sessions, CSRF, challenges, PostgreSQL, jobs and the React build. No AWS call is made
and no AWS credential exists.

A second, tiny HTTP server (port 9000, published on 127.0.0.1 only) lets the tests do what an
administrator and an inbox would: create users, read the codes the stand-in "emailed", disable a
user and make the next call to the pool fail.
"""

import os
import sys
import threading

import uvicorn
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

sys.path.insert(0, os.environ.get("FAKE_COGNITO_DIR", "/e2e-fake"))

from fake_cognito import FakeCognito  # noqa: E402

from app.auth.cognito import CognitoError, CognitoErrorKind  # noqa: E402
from app.config import load_settings  # noqa: E402
from app.main import create_app  # noqa: E402
from app.services import build_services  # noqa: E402

fake = FakeCognito()
control = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)


class NewUser(BaseModel):
    email: str
    password: str
    name: str | None = None
    temporary: bool = False
    email_verified: bool = True


class Target(BaseModel):
    email: str


class Failure(BaseModel):
    operation: str
    email: str
    kind: CognitoErrorKind


# Failures are armed per user, so tests running side by side cannot disturb each other.
_armed: dict[tuple[str, str], list[CognitoError]] = {}


def _arm_by_email(method: str, operation: str) -> None:
    original = getattr(fake, method)

    def wrapper(email, *args, **kwargs):
        pending = _armed.get((operation, email.lower()))
        if pending:
            raise pending.pop(0)
        return original(email, *args, **kwargs)

    setattr(fake, method, wrapper)


_arm_by_email("initiate_password_auth", "InitiateAuth")
_arm_by_email("forgot_password", "ForgotPassword")
_arm_by_email("confirm_forgot_password", "ConfirmForgotPassword")


@control.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@control.post("/users", status_code=201)
def create_user(user: NewUser) -> dict[str, str]:
    fake.add_user(
        user.email,
        user.password,
        name=user.name,
        temporary=user.temporary,
        email_verified=user.email_verified,
    )
    return {"status": "created"}


@control.get("/codes/{email}")
def codes(email: str) -> dict[str, str | None]:
    user = fake.users.get(email.lower())
    if user is None:
        raise HTTPException(404, "no such user")
    return {"verification_code": user.verification_code, "reset_code": user.reset_code}


@control.post("/disable")
def disable(target: Target) -> dict[str, str]:
    fake.disable(target.email)
    return {"status": "disabled"}


@control.post("/fail-next")
def fail_next(failure: Failure) -> dict[str, str]:
    """The next InitiateAuth, ForgotPassword or ConfirmForgotPassword for this user fails."""
    if failure.operation not in {"InitiateAuth", "ForgotPassword", "ConfirmForgotPassword"}:
        raise HTTPException(400, "unsupported operation")
    key = (failure.operation, failure.email.lower())
    _armed.setdefault(key, []).append(CognitoError(failure.kind, "E2E"))
    return {"status": "armed"}


def main() -> None:
    server = uvicorn.Server(
        uvicorn.Config(control, host="0.0.0.0", port=9000, log_level="warning")  # noqa: S104
    )
    threading.Thread(target=server.run, daemon=True).start()

    settings = load_settings()
    app = create_app(services=build_services(settings, cognito_client=fake))
    uvicorn.run(app, host="0.0.0.0", port=8000, workers=1, server_header=False)  # noqa: S104


if __name__ == "__main__":
    main()
