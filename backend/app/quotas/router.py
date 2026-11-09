"""The signed-in account's usage limits for today (docs/API.md, "Usage limits"). Read only: the
numbers are a preview, and every admission is decided by the backend on its own."""

from datetime import date, datetime

from fastapi import APIRouter, Depends, Response
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.auth.principal import Principal
from app.dependencies import get_db, require_session
from app.quotas.service import KindUsage, account_usage

router = APIRouter(prefix="/api/account", tags=["account"])


class KindUsageOut(BaseModel):
    # Operations the backend accepted today (UTC); a failed job or import still counts.
    used: int
    # Null when the account is not limited (an administrator).
    limit: int | None
    remaining: int | None

    @classmethod
    def build(cls, usage: KindUsage) -> "KindUsageOut":
        return cls(used=usage.used, limit=usage.limit, remaining=usage.remaining)


class AccountUsageResponse(BaseModel):
    plan: str
    # True for an administrator: no MyDubb usage limit applies (capacity still does).
    exempt: bool
    day: date
    # 00:00 UTC of the next day, when both daily counts start again.
    resets_at: datetime
    generate: KindUsageOut
    youtube_import: KindUsageOut
    # Per job; null when the account is exempt.
    max_words: int | None
    max_output_seconds: int | None


@router.get("/usage", response_model=AccountUsageResponse)
def get_account_usage(
    response: Response,
    principal: Principal = Depends(require_session),
    db: Session = Depends(get_db),
) -> AccountUsageResponse:
    # Mounted with AUTH_MODE=cognito only, where every session belongs to an account.
    usage = account_usage(db, principal)
    response.headers["Cache-Control"] = "no-store"
    return AccountUsageResponse(
        plan=usage.plan,
        exempt=usage.exempt,
        day=usage.day,
        resets_at=usage.resets_at,
        generate=KindUsageOut.build(usage.generate),
        youtube_import=KindUsageOut.build(usage.youtube_import),
        max_words=None if usage.exempt else usage.limits.max_words,
        max_output_seconds=None if usage.exempt else usage.limits.max_output_seconds,
    )
