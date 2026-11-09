"""Stand-in for Google's reCAPTCHA siteverify, as MyDubb sees it (no network, no key).

Used by the backend tests and, mounted like fake_cognito.py, by the browser E2E stack. Tokens
"ok-*" pass once (a second use is `timeout-or-duplicate`, as Google documents), "down-*" cannot be
checked (Google unreachable or over quota), anything else is refused.
"""

import threading

from app.auth.recaptcha import CaptchaResult, CaptchaVerdict


class FakeCaptcha:
    def __init__(self) -> None:
        self.calls: list[str] = []
        self._used: set[str] = set()
        self._lock = threading.Lock()

    def verify(self, token: str) -> CaptchaVerdict:
        with self._lock:
            self.calls.append(token)
            if token.startswith("down-"):
                return CaptchaVerdict(CaptchaResult.UNAVAILABLE, "timeout")
            if token in self._used:
                return CaptchaVerdict(CaptchaResult.REJECTED, "timeout-or-duplicate")
            self._used.add(token)
            if token.startswith("ok-"):
                return CaptchaVerdict(CaptchaResult.VALID, "ok")
            return CaptchaVerdict(CaptchaResult.REJECTED, "invalid-input-response")
