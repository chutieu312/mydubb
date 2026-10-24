"""Encryption of the Cognito material held while a sign-in step is pending.

AES-256-GCM with a random 96-bit nonce per message. The associated data names the challenge
row and its kind, so a ciphertext copied to another row (or another step) does not decrypt.
Rotating AUTH_TOKEN_ENCRYPTION_KEY only invalidates pending sign-in steps (minutes); sessions
are not encrypted with it.
"""

import json
import secrets
from typing import Any

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

_NONCE_BYTES = 12


class DecryptionError(Exception):
    """The ciphertext is damaged, belongs elsewhere, or was made with another key."""


class TokenCipher:
    def __init__(self, key: bytes) -> None:
        self._aead = AESGCM(key)

    def encrypt(self, payload: dict[str, Any], associated_data: bytes) -> bytes:
        nonce = secrets.token_bytes(_NONCE_BYTES)
        plaintext = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        return nonce + self._aead.encrypt(nonce, plaintext, associated_data)

    def decrypt(self, blob: bytes, associated_data: bytes) -> dict[str, Any]:
        if len(blob) <= _NONCE_BYTES:
            raise DecryptionError
        try:
            plaintext = self._aead.decrypt(
                blob[:_NONCE_BYTES], blob[_NONCE_BYTES:], associated_data
            )
        except InvalidTag:
            raise DecryptionError from None
        payload = json.loads(plaintext)
        if not isinstance(payload, dict):
            raise DecryptionError
        return payload
