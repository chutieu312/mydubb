"""Reference prices for converting recorded usage into money (data: `data/reference_prices.json`).

Usage rows never hold a price, so a report can be recomputed when a price changes. The prices are
pay-as-you-go list prices of the paid tier: the services currently run on the Free tier, so the
result is "what this usage would cost at list price", not what was invoiced. All arithmetic is
`Decimal`; nothing is rounded before the final display.
"""

import json
from dataclasses import dataclass
from datetime import date
from decimal import Decimal
from functools import lru_cache
from pathlib import Path

PRICES_FILE = Path(__file__).resolve().parent / "data" / "reference_prices.json"
_PER_UNIT = Decimal(1_000_000)


@dataclass(frozen=True)
class ReferencePrice:
    service: str  # "translator" | "speech"
    sku: str
    meter: str
    region: str
    unit: str
    price: Decimal  # per 1,000,000 characters
    currency: str
    effective_from: date
    checked_on: date
    source: str

    def cost(self, characters: int) -> Decimal:
        """Exact (not rounded) cost of `characters` characters."""
        return Decimal(characters) * self.price / _PER_UNIT


@dataclass(frozen=True)
class FreeAllowance:
    service: str
    sku: str
    amount: int
    unit: str
    checked_on: date
    source: str


@dataclass(frozen=True)
class PriceBook:
    currency: str
    prices: tuple[ReferencePrice, ...]
    allowances: tuple[FreeAllowance, ...]

    def price_for(self, service: str, on: date) -> ReferencePrice | None:
        """The price in force on `on`: the latest entry that started on or before it. A date
        earlier than every entry has no price (None), never the oldest one."""
        candidates = [p for p in self.prices if p.service == service and p.effective_from <= on]
        return max(candidates, key=lambda p: p.effective_from, default=None)


@lru_cache(maxsize=1)
def default_price_book() -> PriceBook:
    return load_price_book(PRICES_FILE)


def load_price_book(path: Path) -> PriceBook:
    data = json.loads(path.read_text(encoding="utf-8"))
    if data.get("schema") != 1:
        raise ValueError("unsupported price file schema")
    currency = data["currency"]
    prices = tuple(
        ReferencePrice(
            service=item["service"],
            sku=item["sku"],
            meter=item["meter"],
            region=item["region"],
            unit=item["unit"],
            price=Decimal(item["price"]),
            currency=currency,
            effective_from=date.fromisoformat(item["effective_from"]),
            checked_on=date.fromisoformat(item["checked_on"]),
            source=item["source"],
        )
        for item in data["prices"]
    )
    if any(p.unit != "1M characters" or p.price < 0 for p in prices):
        raise ValueError("prices must be non-negative and per 1M characters")
    allowances = tuple(
        FreeAllowance(
            service=item["service"],
            sku=item["sku"],
            amount=int(item["amount"]),
            unit=item["unit"],
            checked_on=date.fromisoformat(item["checked_on"]),
            source=item["source"],
        )
        for item in data.get("free_allowances", [])
    )
    return PriceBook(currency=currency, prices=prices, allowances=allowances)
