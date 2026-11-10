"""Server-side check of a Google reCAPTCHA v2 Checkbox token (sign-up only).

Google's contract (developers.google.com/recaptcha/docs/verify): POST `secret` and `response` to
https://www.google.com/recaptcha/api/siteverify; the answer has `success`, `challenge_ts`,
`hostname` and optional `error-codes`. "Each reCAPTCHA user response token is valid for two
minutes, and can only be verified once": an expired or reused token comes back as
`timeout-or-duplicate`, so expiry and replay are decided by Google. A v2 Checkbox token has no
`action` or `score` (those are v3), so there is nothing else to compare and no threshold to set.

This module fails closed: only `success: true` with an allowed `hostname` passes. Every other
answer, an error code, a timeout, a network error, an HTTP error, an over-quota answer or anything
that does not match the contract refuses the sign-up. Nothing is retried (a token is single-use).
The token, the secret and the raw answer are never logged; logs carry Google's error codes only.
The user's IP address is not sent (`remoteip` is optional).
"""

import json
import logging
import time
from collections.abc import Callable
from dataclasses import dataclass
from enum import StrEnum
from typing import Protocol

import httpx
from pydantic import SecretStr

logger = logging.getLogger(__name__)

SITEVERIFY_URL = "https://www.google.com/recaptcha/api/siteverify"
_MAX_RESPONSE_BYTES = 16 * 1024
# The user's token: an expired, reused or forged one. They tick the box again.
_TOKEN_ERRORS = {"timeout-or-duplicate", "invalid-input-response", "missing-input-response"}


class CaptchaResult(StrEnum):
    VALID = "valid"
    # The token is not good (expired, reused, forged, solved on another site): ask for a new one.
    REJECTED = "rejected"
    # Google could not be asked or did not give a usable answer (timeout, outage, quota, our own
    # key misconfigured): sign-up is refused for now.
    UNAVAILABLE = "unavailable"


@dataclass(frozen=True)
class CaptchaVerdict:
    result: CaptchaResult
    # Safe to log: Google's error codes or a short label of ours, never the token.
    reason: str


class CaptchaVerifier(Protocol):
    def verify(self, token: str) -> CaptchaVerdict: ...


class RecaptchaVerifier:
    def __init__(
        self,
        *,
        secret: SecretStr,
        allowed_hostnames: list[str],
        timeout_seconds: float,
        transport: httpx.BaseTransport | None = None,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._secret = secret
        self._hostnames = frozenset(name.lower() for name in allowed_hostnames)
        self._timeout = timeout_seconds
        self._clock = clock
        self._http = httpx.Client(
            timeout=httpx.Timeout(timeout_seconds), follow_redirects=False, transport=transport
        )

    def close(self) -> None:
        self._http.close()

    def verify(self, token: str) -> CaptchaVerdict:
        deadline = self._clock() + self._timeout
        try:
            with self._http.stream(
                "POST",
                SITEVERIFY_URL,
                data={"secret": self._secret.get_secret_value(), "response": token},
            ) as response:
                raw = b""
                for chunk in response.iter_bytes():
                    raw += chunk
                    if len(raw) > _MAX_RESPONSE_BYTES or self._clock() > deadline:
                        return self._unavailable("unusable answer")
                if self._clock() > deadline:
                    return self._unavailable("deadline")
        except httpx.TimeoutException:
            return self._unavailable("timeout")
        except httpx.HTTPError as exc:
            return self._unavailable(type(exc).__name__)
        if response.status_code != 200:
            return self._unavailable(f"HTTP {response.status_code}")
        try:
            body = json.loads(raw)
        except ValueError:
            return self._unavailable("not JSON")
        return self.judge(body)

    def judge(self, body: object) -> CaptchaVerdict:
        """Google's answer -> a verdict (separate so the rules can be read and tested alone)."""
        if not isinstance(body, dict) or not isinstance(body.get("success"), bool):
            return self._unavailable("unexpected answer")
        codes = body.get("error-codes")
        error_codes = (
            [code for code in codes if isinstance(code, str)] if isinstance(codes, list) else []
        )
        if body["success"] is not True:
            if error_codes and all(code in _TOKEN_ERRORS for code in error_codes):
                return CaptchaVerdict(CaptchaResult.REJECTED, ",".join(error_codes)[:200])
            if not error_codes:
                return CaptchaVerdict(CaptchaResult.REJECTED, "not solved")
            # Our secret or request is wrong (missing/invalid secret, bad request) or an unknown
            # code: not the user's fault, and not something a new token fixes.
            return self._unavailable(",".join(error_codes)[:200])
        hostname = body.get("hostname")
        if not isinstance(hostname, str) or hostname.lower() not in self._hostnames:
            # Solved on a page that is not ours (or the answer has no hostname).
            logger.warning("reCAPTCHA token solved on a host name that is not allowed")
            return CaptchaVerdict(CaptchaResult.REJECTED, "hostname not allowed")
        return CaptchaVerdict(CaptchaResult.VALID, "ok")

    @staticmethod
    def _unavailable(reason: str) -> CaptchaVerdict:
        logger.warning("reCAPTCHA verification unavailable: %s", reason)
        return CaptchaVerdict(CaptchaResult.UNAVAILABLE, reason)
