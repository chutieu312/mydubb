"""Which client network a guest request comes from, for the guest quotas.

Stricter than `client_key` (brute-force protection), which falls back to the peer address: a
wrong guess here either merges unrelated guests into one quota or lets one guest escape it, so a
request whose network cannot be told is refused instead.

* With CLIENT_IP_HEADER (production: `cf-connecting-ip`, which the edge overwrites with the
  address that connected to it), exactly one occurrence holding exactly one IP address is
  accepted. A missing header, a repeated header, a list or anything that is not an address gives
  None. X-Forwarded-For is never read: behind Render's proxy its left-most entry is whatever the
  client sent.
* Without it (local development, tests), the connection peer is used, also only if it is an IP
  address.

Addresses are grouped into networks: an IPv4 address is its own network; IPv6 is grouped by its
/64 prefix, because one subscriber usually holds a whole /64 and could otherwise take a new
address for every request. An IPv4-mapped IPv6 address counts as the IPv4 address.

The quota tables only ever see `network_key`: an HMAC-SHA256 of the network under
GUEST_IP_HASH_KEY, so the database holds no raw address and a key-less reader cannot test
guesses against it. Nothing here logs an address.
"""

import hashlib
import hmac
import ipaddress

from fastapi import Request

IPV6_PREFIX = 64


def network_of(value: str) -> str | None:
    """The canonical network of one IP address text, or None if it is not exactly one address."""
    text = value.strip()
    if not text or "," in text or any(c.isspace() for c in text):
        return None
    if text.startswith("[") and text.endswith("]"):
        text = text[1:-1]
    try:
        address = ipaddress.ip_address(text)
    except ValueError:
        return None
    if isinstance(address, ipaddress.IPv6Address):
        if address.scope_id is not None:
            # A link-local zone ("%eth0") never reaches us from the internet; refuse it.
            return None
        if address.ipv4_mapped is not None:
            return f"ipv4:{address.ipv4_mapped}"
        network = ipaddress.IPv6Network((address, IPV6_PREFIX), strict=False)
        return f"ipv6:{network.network_address}/{IPV6_PREFIX}"
    return f"ipv4:{address}"


def client_network(request: Request, header: str | None) -> str | None:
    """The caller's network (see the module docstring), or None when it cannot be told."""
    if header:
        values = request.headers.getlist(header)
        if len(values) != 1:
            return None
        return network_of(values[0])
    peer = request.client.host if request.client else ""
    return network_of(peer)


def network_key(network: str, key: bytes) -> str:
    """The keyed hash stored for a network (64 hex characters)."""
    return hmac.new(key, network.encode("ascii"), hashlib.sha256).hexdigest()
