"""API errors of the usage limits (docs/API.md, "Usage limits"). Each kind of refusal has its own
code, so a client can tell an account's quota from the shared cap, the server's capacity
(`server_at_capacity`) and a provider failure (a failed job or import)."""

from fastapi import status

from app.errors import ApiError
from app.quotas.service import AccountQuotaExhausted, QuotaKind, UsageCapReached

_ACCOUNT_CODES = {
    QuotaKind.GENERATE: "daily_generate_quota_exhausted",
    QuotaKind.YOUTUBE_IMPORT: "daily_import_quota_exhausted",
}
_CAP_CODES = {
    QuotaKind.GENERATE: "generate_daily_cap_reached",
    QuotaKind.YOUTUBE_IMPORT: "import_daily_cap_reached",
}


def account_quota_error(exc: AccountQuotaExhausted) -> ApiError:
    plan = exc.plan.capitalize()
    if exc.kind is QuotaKind.GENERATE:
        message = (
            f"Your {plan} plan includes {exc.limit} audio jobs a day, and today's are used up. "
            "Jobs you already started keep running and your finished audio stays available. "
            "You can generate again after 00:00 UTC."
        )
    else:
        message = (
            f"Your {plan} plan includes {exc.limit} YouTube imports a day, and today's are used "
            "up. You can still paste a transcript. Imports are available again after 00:00 UTC."
        )
    return ApiError(
        status.HTTP_429_TOO_MANY_REQUESTS,
        _ACCOUNT_CODES[exc.kind],
        message,
        headers={"Retry-After": str(exc.retry_after)},
        extra={
            "plan": exc.plan,
            "limit": exc.limit,
            "resets_at": exc.resets_at.isoformat(),
            "retry_after_seconds": exc.retry_after,
        },
    )


def usage_cap_error(exc: UsageCapReached) -> ApiError:
    if exc.kind is QuotaKind.GENERATE:
        message = (
            "MyDubb has reached today's limit on new audio jobs, shared by all users. Jobs "
            "already started keep running and finished audio stays available. New jobs can "
            "start again after 00:00 UTC."
        )
    else:
        message = (
            "MyDubb has reached today's limit on YouTube imports, shared by all users. You can "
            "still paste a transcript. Imports are available again after 00:00 UTC."
        )
    return ApiError(
        status.HTTP_503_SERVICE_UNAVAILABLE,
        _CAP_CODES[exc.kind],
        message,
        headers={"Retry-After": str(exc.retry_after)},
        extra={"resets_at": exc.resets_at.isoformat(), "retry_after_seconds": exc.retry_after},
    )
