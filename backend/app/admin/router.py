"""Internal administration API (mounted with AUTH_MODE=cognito). Only `require_admin` guards it:
new endpoints depend on `require_admin`, or `require_admin_csrf` when they change state.
docs/AUTHENTICATION.md, "Administrators".
"""

from typing import Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from app.auth.principal import Principal
from app.dependencies import require_admin

router = APIRouter(prefix="/api/admin", tags=["admin"])


class AdminSessionResponse(BaseModel):
    role: Literal["admin"] = "admin"


@router.get("/session", response_model=AdminSessionResponse)
def session(_: Principal = Depends(require_admin)) -> AdminSessionResponse:
    """Whether the caller is an administrator right now: nothing else about anyone."""
    return AdminSessionResponse()
