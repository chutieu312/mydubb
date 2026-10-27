from dataclasses import dataclass

from fastapi import Request

from app.config import Settings, decode_encryption_key
from app.guest.client_ip import client_network, network_key
from app.guest.service import GuestPolicy


@dataclass(frozen=True)
class GuestAccess:
    """Guest access as configured (present only with GUEST_ACCESS_ENABLED=true)."""

    policy: GuestPolicy
    ip_hash_key: bytes
    client_ip_header: str | None

    @classmethod
    def from_settings(cls, settings: Settings) -> "GuestAccess | None":
        if not settings.guest_access_enabled:
            return None
        # Settings validation guarantees a valid key.
        assert settings.guest_ip_hash_key is not None
        key = decode_encryption_key(settings.guest_ip_hash_key.get_secret_value())
        assert key is not None
        return cls(
            policy=GuestPolicy.from_settings(settings),
            ip_hash_key=key,
            client_ip_header=settings.client_ip_header,
        )

    def network_key(self, request: Request) -> str | None:
        """The keyed hash of the caller's network, or None when the network cannot be told."""
        network = client_network(request, self.client_ip_header)
        return network_key(network, self.ip_hash_key) if network is not None else None
