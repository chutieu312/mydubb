"""Public sign-up (app/auth/signup.py, docs/SIGNUP.md): Create account -> confirm the emailed
code -> sign in -> a Free account under Story A's quotas.

Fake Cognito (tests/fake_cognito.py), a fake reCAPTCHA verifier, mock pipeline, fake Supadata
transport and a disposable PostgreSQL: nothing reaches Google, AWS or a provider.
"""

import itertools
import logging
from collections.abc import Callable, Iterator
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import Engine, text

from app.auth.cognito import CognitoErrorKind
from app.config import Settings
from app.main import content_security_policy, create_app
from app.quotas.service import PLAN_LIMITS
from app.services import build_services
from tests.conftest import COGNITO_SETTINGS, VALID_JOB
from tests.fake_cognito import FakeCognito
from tests.fake_recaptcha import FakeCaptcha
from tests.test_extension_auth import EXT_ID, _authorize, _bearer, _code_from, _exchange, _verifier
from tests.test_free_quotas import error_code, generate, import_, run_concurrently, usage
from tests.test_youtube_import_api import SUPADATA, supadata_ok

EMAIL = "new.user@example.com"
PASSWORD = "a-fine-password-1"
INVITED = "invited@example.com"
INVITED_PASSWORD = "invited-password-1"
SITE_KEY = "6Lc_test_site_key_000000000000000000000"
SIGNUP: dict[str, Any] = {
    **COGNITO_SETTINGS,
    **SUPADATA,
    "extension_ids": [EXT_ID],
    "cognito_client_secret": "test-client-secret",
    "public_signup_enabled": True,
    "recaptcha_site_key": SITE_KEY,
    "recaptcha_secret_key": "6Lc_test_secret_key_00000000000000000000",
    "recaptcha_allowed_hostnames": "mydubb.test",
    "job_max_concurrency": 4,
    "job_max_queued": 200,
}
# The request body of a job whose transcript has this many words.
WORDS = " ".join(["word"] * 1001)


_tokens = itertools.count()


def token() -> str:
    return f"ok-{next(_tokens)}"


@pytest.fixture
def captcha() -> FakeCaptcha:
    return FakeCaptcha()


@pytest.fixture
def make_app(
    make_settings: Callable[..., Settings],
    fake_cognito: FakeCognito,
    captcha: FakeCaptcha,
    db_engine: Engine,
) -> Iterator[Callable[..., TestClient]]:
    fake_cognito.add_user(INVITED, INVITED_PASSWORD, name="Invited")
    clients: list[TestClient] = []

    def factory(**overrides: Any) -> TestClient:
        settings = make_settings(**{**SIGNUP, **overrides})
        services = build_services(
            settings,
            youtube_import_transport=httpx.MockTransport(supadata_ok),
            cognito_client=fake_cognito,
            captcha_verifier=captcha,
        )
        client = TestClient(create_app(services=services))
        client.__enter__()
        clients.append(client)
        return client

    yield factory
    for client in reversed(clients):
        client.__exit__(None, None, None)


def signup(client: TestClient, email: str = EMAIL, password: str = PASSWORD, **extra: Any):
    body = {"email": email, "password": password, "captcha_token": token(), **extra}
    return client.post("/api/auth/signup", json=body)


def confirm(client: TestClient, code: str, email: str = EMAIL):
    return client.post("/api/auth/signup/confirm", json={"email": email, "code": code})


def resend(client: TestClient, email: str = EMAIL):
    return client.post("/api/auth/signup/resend", json={"email": email})


def login(client: TestClient, email: str = EMAIL, password: str = PASSWORD):
    return client.post("/api/auth/login", json={"email": email, "password": password})


def code_of(fake: FakeCognito, email: str = EMAIL) -> str:
    code = fake.users[email.lower()].signup_code
    assert code is not None
    return code


def user_rows(db_engine: Engine) -> list[tuple[str, str, str]]:
    with db_engine.connect() as conn:
        return [
            tuple(row)
            for row in conn.execute(text("SELECT email_normalized, role, plan FROM users"))
        ]


def register(client: TestClient, fake: FakeCognito, email: str = EMAIL) -> str:
    """Create account, confirm, sign in; returns the CSRF token of the new session."""
    assert signup(client, email).status_code == 200
    assert confirm(client, code_of(fake, email), email).json() == {"status": "verified"}
    response = login(client, email)
    assert response.status_code == 200 and response.json()["status"] == "authenticated"
    return response.json()["csrf_token"]


# -- the whole flow -----------------------------------------------------------------------------


def test_create_verify_sign_in_and_use_the_studio_as_free(make_app, fake_cognito, db_engine):
    client = make_app()
    response = signup(client)
    assert response.status_code == 200
    assert response.json() == {"status": "verification_required"}
    assert fake_cognito.users[EMAIL].confirmed is False

    # Before verification there is no way in: no session, no user row.
    early = login(client)
    assert early.status_code == 401 and error_code(early) == "invalid_credentials"
    assert client.get("/api/auth/me").status_code == 401
    assert user_rows(db_engine) == []

    assert confirm(client, code_of(fake_cognito)).json() == {"status": "verified"}
    signed_in = login(client)
    assert signed_in.status_code == 200 and signed_in.json()["status"] == "authenticated"
    csrf = signed_in.json()["csrf_token"]
    assert client.get("/api/auth/me").json()["user"]["email"] == EMAIL
    assert (EMAIL, "user", "free") in user_rows(db_engine)

    # Story A's quotas, unchanged: the same numbers, the same refusals.
    fresh = usage(client)
    free = PLAN_LIMITS["free"]
    assert (fresh["plan"], fresh["exempt"]) == ("free", False)
    assert fresh["generate"] == {"used": 0, "limit": free.generates_per_day, "remaining": 20}
    assert fresh["youtube_import"] == {"used": 0, "limit": 5, "remaining": 5}
    assert (fresh["max_words"], fresh["max_output_seconds"]) == (1000, 600)
    assert error_code(generate(client, csrf, transcript=WORDS)) == "plan_word_limit_exceeded"
    for _ in range(20):
        assert generate(client, csrf).status_code == 202
    assert error_code(generate(client, csrf)) == "daily_generate_quota_exhausted"
    for _ in range(5):
        assert import_(client, csrf).status_code == 200
    assert error_code(import_(client, csrf)) == "daily_import_quota_exhausted"


def test_the_client_cannot_choose_a_role_or_a_plan(make_app, fake_cognito, db_engine):
    client = make_app()
    response = signup(client, role="admin", plan="pro", is_admin=True, user_id="x")
    assert response.status_code == 200
    assert confirm(client, code_of(fake_cognito)).status_code == 200
    csrf = login(client).json()["csrf_token"]
    assert (EMAIL, "user", "free") in user_rows(db_engine)
    assert client.get("/api/admin/session").status_code == 403
    assert usage(client)["exempt"] is False
    assert generate(client, csrf).status_code == 202


def connect_extension(web: TestClient, ext: TestClient, csrf: str) -> dict[str, str]:
    """Connect extension (docs/EXTENSION_AUTH.md) from the website session; the bearer headers."""
    verifier = _verifier()
    code, _ = _code_from(_authorize(web, csrf, verifier))
    response = _exchange(ext, code, verifier)
    assert response.status_code == 200, response.text
    return _bearer(response.json()["access_token"])


def test_an_extension_token_of_a_new_account_is_free_and_never_admin(make_app, fake_cognito):
    web, ext = make_app(), make_app()
    bearer = connect_extension(web, ext, register(web, fake_cognito))
    assert ext.get("/api/admin/session", headers=bearer).status_code == 401
    assert ext.post("/api/jobs", json=VALID_JOB, headers=bearer).status_code == 202
    # One Free quota for web and extension (Story A): the web session sees the extension's job.
    assert usage(web)["generate"]["used"] == 1


# -- the feature gate ---------------------------------------------------------------------------


def test_off_by_default_nothing_is_called(make_cognito_client, fake_cognito):
    client = make_cognito_client()
    for path, body in (
        ("/api/auth/signup", {"email": EMAIL, "password": PASSWORD, "captcha_token": "ok-1"}),
        ("/api/auth/signup/confirm", {"email": EMAIL, "code": "123456"}),
        ("/api/auth/signup/resend", {"email": EMAIL}),
    ):
        response = client.post(path, json=body)
        assert response.status_code == 404, path
        assert error_code(response) == "signup_disabled"
    assert fake_cognito.calls == []
    meta = client.get("/api/meta").json()
    assert meta["auth"]["self_registration"] is False
    assert meta["signup"] == {"enabled": False}
    csp = client.get("/api/health").headers["content-security-policy"]
    assert "google" not in csp
    # Byte for byte the policy the site had before sign-up existed.
    assert csp == (
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; "
        "media-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; "
        "form-action 'self'; frame-ancestors 'none'"
    )


def test_access_code_mode_has_no_sign_up(client):
    assert client.post("/api/auth/signup", json={}).status_code == 404
    assert client.get("/api/meta").json()["signup"] == {"enabled": False}


@pytest.mark.parametrize(
    ("override", "missing"),
    [
        ({"cognito_client_secret": None}, "COGNITO_CLIENT_SECRET"),
        ({"recaptcha_site_key": None}, "RECAPTCHA_SITE_KEY"),
        ({"recaptcha_secret_key": None}, "RECAPTCHA_SECRET_KEY"),
        ({"recaptcha_secret_key": "has spaces in it which is wrong"}, "RECAPTCHA_SECRET_KEY"),
        ({"recaptcha_allowed_hostnames": None}, "RECAPTCHA_ALLOWED_HOSTNAMES"),
        ({"recaptcha_allowed_hostnames": "https://mydubb.com/"}, "RECAPTCHA_ALLOWED_HOSTNAMES"),
    ],
)
def test_missing_configuration_refuses_sign_up_but_sign_in_works(
    make_app, fake_cognito, captcha, caplog, override, missing
):
    with caplog.at_level(logging.ERROR):
        client = make_app(**override)
    assert missing in caplog.text
    for path, body in (
        ("/api/auth/signup", {"email": EMAIL, "password": PASSWORD, "captcha_token": "ok-x"}),
        ("/api/auth/signup/confirm", {"email": EMAIL, "code": "123456"}),
        ("/api/auth/signup/resend", {"email": EMAIL}),
    ):
        response = client.post(path, json=body)
        assert response.status_code == 503 and error_code(response) == "signup_unavailable"
    assert captcha.calls == [] and "SignUp" not in fake_cognito.calls
    meta = client.get("/api/meta").json()
    assert meta["auth"]["self_registration"] is False and meta["signup"] == {"enabled": False}
    assert "google" not in client.get("/api/health").headers["content-security-policy"]
    assert login(client, INVITED, INVITED_PASSWORD).json()["status"] == "authenticated"


def test_production_needs_the_client_ip_header(make_settings):
    settings = make_settings(
        **{**SIGNUP, "app_env": "production", "cookie_secure": True},
        allow_mock_providers_in_production=True,
    )
    assert settings.signup_problems() == ["CLIENT_IP_HEADER"]
    settings = make_settings(
        **{**SIGNUP, "app_env": "production", "cookie_secure": True},
        allow_mock_providers_in_production=True,
        client_ip_header="cf-connecting-ip",
    )
    assert settings.signup_problems() == []


def test_meta_and_csp_when_on(make_app):
    client = make_app()
    meta = client.get("/api/meta").json()
    assert meta["auth"] == {"mode": "cognito", "self_registration": True, "password_reset": True}
    assert meta["signup"] == {
        "enabled": True,
        "recaptcha_site_key": SITE_KEY,
        "free_plan": {
            "generates_per_day": 20,
            "youtube_imports_per_day": 5,
            "max_words": 1000,
            "max_output_seconds": 600,
        },
    }
    csp = client.get("/api/health").headers["content-security-policy"]
    assert csp == content_security_policy(recaptcha=True)
    assert (
        "script-src 'self' https://www.google.com/recaptcha/ https://www.gstatic.com/recaptcha/"
        in csp
    )
    assert (
        "frame-src https://www.google.com/recaptcha/ https://recaptcha.google.com/recaptcha/" in csp
    )
    assert "frame-ancestors 'none'" in csp and "style-src 'self';" in csp


# -- reCAPTCHA ----------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("captcha_token", "status", "code"),
    [
        ("forged", 400, "captcha_invalid"),
        ("down-1", 503, "captcha_unavailable"),
    ],
)
def test_a_failed_check_never_reaches_cognito(
    make_app, fake_cognito, captcha, captcha_token, status, code
):
    client = make_app()
    response = client.post(
        "/api/auth/signup",
        json={"email": EMAIL, "password": PASSWORD, "captcha_token": captcha_token},
    )
    assert response.status_code == status and error_code(response) == code
    assert "SignUp" not in fake_cognito.calls and EMAIL not in fake_cognito.users


def test_a_token_works_once(make_app, fake_cognito):
    client = make_app()
    first = client.post(
        "/api/auth/signup", json={"email": EMAIL, "password": PASSWORD, "captcha_token": "ok-r"}
    )
    assert first.status_code == 200
    replay = client.post(
        "/api/auth/signup",
        json={"email": "other@example.com", "password": PASSWORD, "captcha_token": "ok-r"},
    )
    assert replay.status_code == 400 and error_code(replay) == "captcha_invalid"
    assert fake_cognito.calls.count("SignUp") == 1


def test_a_missing_token_is_a_validation_error(make_app, captcha):
    client = make_app()
    response = client.post("/api/auth/signup", json={"email": EMAIL, "password": PASSWORD})
    assert response.status_code == 422
    assert captcha.calls == []


# -- enumeration --------------------------------------------------------------------------------


def test_an_existing_email_gets_the_same_answer_and_no_email(make_app, fake_cognito):
    client = make_app()
    new = signup(client)
    existing = signup(client, INVITED, "another-password-9")
    assert (existing.status_code, existing.json()) == (new.status_code, new.json())
    assert fake_cognito.signup_emails == [EMAIL]
    # The account is untouched: its password still works.
    assert login(client, INVITED, INVITED_PASSWORD).json()["status"] == "authenticated"


def test_resend_answers_the_same_for_every_address(make_app, fake_cognito):
    client = make_app()
    signup(client)
    answers = {
        (r.status_code, r.text)
        for r in (resend(client), resend(client, INVITED), resend(client, "nobody@example.com"))
    }
    assert answers == {(202, '{"status":"accepted"}')}
    assert fake_cognito.signup_emails == [EMAIL, EMAIL]


def test_codes_give_one_answer_for_unknown_and_confirmed_accounts(make_app, fake_cognito):
    client = make_app()
    unknown = confirm(client, "123456", "nobody@example.com")
    confirmed = confirm(client, "123456", INVITED)
    assert unknown.status_code == confirmed.status_code == 400
    assert error_code(unknown) == error_code(confirmed) == "code_invalid"
    assert unknown.json() == confirmed.json()


# -- codes, resend and limits -------------------------------------------------------------------


def test_wrong_expired_and_resent_codes(make_app, fake_cognito):
    client = make_app()
    signup(client)
    first = code_of(fake_cognito)
    wrong = confirm(client, "000000" if first != "000000" else "111111")
    assert wrong.status_code == 400 and error_code(wrong) == "code_invalid"

    fake_cognito.expire_signup_code(EMAIL)
    expired = confirm(client, first)
    assert expired.status_code == 400 and error_code(expired) == "code_expired"

    assert resend(client).status_code == 202
    second = code_of(fake_cognito)
    assert confirm(client, second).json() == {"status": "verified"}
    again = confirm(client, second)
    assert again.status_code == 400 and error_code(again) == "code_invalid"
    assert login(client).json()["status"] == "authenticated"


def test_wrong_codes_are_limited_like_failed_sign_ins(make_app, fake_cognito):
    client = make_app(access_max_failures_per_client=3)
    signup(client)
    for _ in range(3):
        assert confirm(client, "999999").status_code == 400
    refused = confirm(client, code_of(fake_cognito))
    assert refused.status_code == 429 and error_code(refused) == "too_many_attempts"
    assert int(refused.headers["Retry-After"]) > 0
    assert fake_cognito.calls.count("ConfirmSignUp") == 3


def test_create_account_is_limited_before_google_is_asked(make_app, captcha):
    client = make_app(signup_max_per_client=2)
    assert signup(client, "a@example.com").status_code == 200
    assert signup(client, "b@example.com").status_code == 200
    refused = signup(client, "c@example.com")
    assert refused.status_code == 429 and error_code(refused) == "too_many_attempts"
    assert int(refused.headers["Retry-After"]) > 0
    assert len(captcha.calls) == 2


def test_create_account_is_limited_per_email(make_app, captcha, fake_cognito):
    client = make_app(signup_max_per_email=2)
    assert signup(client).status_code == 200
    assert signup(client, EMAIL.upper()).status_code == 200  # the same address
    refused = signup(client, f" {EMAIL} ")
    assert refused.status_code == 429
    assert len(captcha.calls) == 2 and fake_cognito.signup_emails == [EMAIL]


def test_resend_uses_the_recovery_limits(make_app, fake_cognito):
    client = make_app(auth_recovery_max_per_email=2)
    signup(client)
    assert resend(client).status_code == 202
    assert resend(client).status_code == 202
    refused = resend(client)
    assert refused.status_code == 429 and error_code(refused) == "too_many_attempts"
    assert fake_cognito.calls.count("ResendConfirmationCode") == 2


def test_cognito_refusals_and_outages(make_app, fake_cognito):
    client = make_app()
    weak = signup(client, password="short")
    assert weak.status_code == 422 and error_code(weak) == "password_rejected"

    fake_cognito.signup_disabled = True  # the user pool is still invite-only
    off = signup(client)
    assert off.status_code == 503 and error_code(off) == "signup_unavailable"
    fake_cognito.signup_disabled = False

    fake_cognito.fail_next("SignUp", CognitoErrorKind.RATE_LIMITED, "TooManyRequestsException")
    throttled = signup(client)
    assert throttled.status_code == 429 and error_code(throttled) == "auth_rate_limited"

    fake_cognito.fail_next("ResendConfirmationCode", CognitoErrorKind.UNAVAILABLE, "Timeout")
    down = resend(client)
    assert down.status_code == 503 and error_code(down) == "auth_unavailable"
    # Nothing was retried.
    assert fake_cognito.calls.count("ResendConfirmationCode") == 1


# -- lost answers, duplicates, concurrency ------------------------------------------------------


def test_a_lost_sign_up_answer_is_never_retried_and_the_user_can_go_on(make_app, fake_cognito):
    client = make_app()
    fake_cognito.lose_next_answer("SignUp")
    lost = signup(client)
    assert lost.status_code == 503 and error_code(lost) == "signup_outcome_unknown"
    assert fake_cognito.calls.count("SignUp") == 1
    # The account exists and the code was sent: the Verify screen works...
    code = code_of(fake_cognito)
    # ...and pressing Create account again (a new token) is answered as usual: no second user.
    again = signup(client)
    assert again.status_code == 200 and again.json() == {"status": "verification_required"}
    assert [u.email for u in fake_cognito.users.values()].count(EMAIL) == 1
    assert confirm(client, code).json() == {"status": "verified"}
    assert login(client).json()["status"] == "authenticated"


def test_a_lost_confirmation_answer_leaves_a_way_in(make_app, fake_cognito, db_engine):
    client = make_app()
    signup(client)
    fake_cognito.lose_next_answer("ConfirmSignUp")
    lost = confirm(client, code_of(fake_cognito))
    assert lost.status_code == 503 and error_code(lost) == "verification_outcome_unknown"
    # Cognito did confirm: signing in works and is the next step the message names.
    assert login(client).json()["status"] == "authenticated"


def test_concurrent_sign_ups_for_one_email_create_one_account(make_app, fake_cognito):
    client = make_app(signup_max_per_email=50, signup_max_per_client=50)
    results = run_concurrently(8, lambda i: signup(client))
    assert all(isinstance(r, httpx.Response) and r.status_code == 200 for r in results)
    assert sum(1 for u in fake_cognito.users.values() if u.email == EMAIL) == 1
    assert fake_cognito.signup_emails == [EMAIL]


def test_two_server_instances_share_the_user_pool(make_app, fake_cognito):
    first, second = make_app(), make_app()
    assert signup(first).status_code == 200
    assert confirm(second, code_of(fake_cognito)).json() == {"status": "verified"}
    assert login(first).json()["status"] == "authenticated"


# -- verified email is required before any session ----------------------------------------------


def test_an_unverified_email_never_gets_a_session(make_app, fake_cognito, db_engine):
    """However the Cognito user came to exist (sign-up not confirmed, or an account whose email
    is not verified), MyDubb opens no session until Cognito says the email is verified."""
    client = make_app()
    signup(client)
    assert login(client).status_code == 401
    fake_cognito.add_user("unverified@example.com", PASSWORD, email_verified=False)
    step = login(client, "unverified@example.com").json()
    assert step["status"] == "email_verification_required"
    assert client.get("/api/auth/me").status_code == 401
    assert all(row[0] != "unverified@example.com" for row in user_rows(db_engine))
    assert all(row[0] != EMAIL for row in user_rows(db_engine))


# -- the rest keeps working ---------------------------------------------------------------------


def test_sign_in_reset_and_extension_still_work_when_on(make_app, fake_cognito):
    web, ext = make_app(), make_app()
    signed_in = login(web, INVITED, INVITED_PASSWORD).json()
    assert signed_in["status"] == "authenticated"
    assert connect_extension(web, ext, signed_in["csrf_token"])
    assert web.post("/api/auth/forgot-password", json={"email": INVITED}).status_code == 202


def test_cross_origin_sign_up_is_refused(make_app, fake_cognito, captcha):
    client = make_app()
    response = client.post(
        "/api/auth/signup",
        json={"email": EMAIL, "password": PASSWORD, "captcha_token": token()},
        headers={"Origin": "https://evil.example"},
    )
    assert response.status_code == 403
    assert captcha.calls == [] and "SignUp" not in fake_cognito.calls


def test_logs_carry_no_password_code_token_or_email(make_app, fake_cognito, caplog):
    client = make_app()
    with caplog.at_level(logging.DEBUG):
        signup(client)
        signup(client, INVITED)
        code = code_of(fake_cognito)
        confirm(client, "999998")
        confirm(client, code)
        resend(client, "nobody@example.com")
        client.post(
            "/api/auth/signup",
            json={"email": EMAIL, "password": PASSWORD, "captcha_token": "forged-secret-token"},
        )
    for secret in (PASSWORD, code, "forged-secret-token", EMAIL, INVITED, "nobody@example.com"):
        assert secret not in caplog.text
