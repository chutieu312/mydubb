"""FastAPI application factory.

In production one process serves both the API (/api/*) and the React build (same origin).
"""

import asyncio
import contextlib
import logging
import time
from collections.abc import AsyncIterator
from pathlib import Path
from urllib.parse import urlsplit

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from app.access.router import router as access_router
from app.auth.router import router as auth_router
from app.config import AppEnv, AuthMode, Settings, load_settings
from app.errors import error_response, install_error_handlers
from app.guest.router import router as guest_router
from app.jobs.router import router as jobs_router
from app.maintenance import (
    cleanup_loop,
    drain_running_jobs,
    interrupt_unfinished_jobs,
    job_liveness_loop,
    recover_after_restart,
)
from app.services import AppServices, build_services
from app.system.router import router as system_router
from app.youtube_import.router import router as youtube_import_router

logger = logging.getLogger(__name__)

_UNSAFE_METHODS = {"POST", "PUT", "PATCH", "DELETE"}

_SECURITY_HEADERS = [
    (b"x-content-type-options", b"nosniff"),
    (b"x-frame-options", b"DENY"),
    (b"referrer-policy", b"same-origin"),
    (
        b"content-security-policy",
        b"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; "
        b"media-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; "
        b"form-action 'self'; frame-ancestors 'none'",
    ),
]


class RequestGuardMiddleware:
    """Security headers, same-origin enforcement for state-changing API calls, and a
    request-body size guard. Implemented as pure ASGI to avoid buffering bodies."""

    def __init__(
        self, app: ASGIApp, *, trusted_origins: list[str], max_body_bytes: int, hsts: bool
    ):
        self.app = app
        self.trusted_origins = {o.rstrip("/") for o in trusted_origins}
        self.max_body_bytes = max_body_bytes
        self.hsts = hsts

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        path: str = scope["path"]
        is_api = path.startswith("/api/") or path == "/api"
        is_docs = path == "/api/docs"
        headers = {k.decode("latin-1"): v.decode("latin-1") for k, v in scope["headers"]}

        async def send_with_headers(message: Message) -> None:
            if message["type"] == "http.response.start":
                # Swagger UI (development only) relies on inline scripts and a CDN.
                extra = [
                    header
                    for header in _SECURITY_HEADERS
                    if not (is_docs and header[0] == b"content-security-policy")
                ]
                if self.hsts:
                    # Production is served over HTTPS only (TLS terminates at the host proxy).
                    extra.append((b"strict-transport-security", b"max-age=31536000"))
                existing = {k.lower() for k, _ in message.get("headers", [])}
                if is_api and b"cache-control" not in existing:
                    extra.append((b"cache-control", b"no-store"))
                message["headers"] = list(message.get("headers", [])) + extra
            await send(message)

        if is_api and scope["method"] in _UNSAFE_METHODS:
            rejection = self._check_unsafe_request(headers)
            if rejection is not None:
                await rejection(scope, receive, send_with_headers)
                return

        await self.app(scope, receive, send_with_headers)

    def _check_unsafe_request(self, headers: dict[str, str]):
        origin = headers.get("origin")
        if origin is not None and not self._origin_allowed(origin, headers.get("host", "")):
            return error_response(403, "origin_rejected", "Cross-origin request rejected.")
        length = headers.get("content-length")
        if length is None:
            if "chunked" in headers.get("transfer-encoding", "").lower():
                return error_response(
                    411, "length_required", "Requests must include a Content-Length header."
                )
        elif not length.isdigit() or int(length) > self.max_body_bytes:
            limit_mb = self.max_body_bytes / (1024 * 1024)
            return error_response(
                413,
                "request_too_large",
                f"The request body exceeds this server's {limit_mb:g} MB processing limit.",
            )
        return None

    def _origin_allowed(self, origin: str, host: str) -> bool:
        if origin.rstrip("/") in self.trusted_origins:
            return True
        return bool(host) and urlsplit(origin).netloc == host


def _install_frontend(app: FastAPI, dist_dir: Path) -> None:
    dist = dist_dir.resolve()
    index = dist / "index.html"
    if not index.is_file():
        logger.warning("Frontend build not found at %s; serving API only", dist)
        return

    @app.get("/{path:path}", include_in_schema=False)
    async def spa(path: str) -> FileResponse:
        if path == "api" or path.startswith("api/"):
            raise HTTPException(status_code=404, detail="Not found.")
        candidate = (dist / path).resolve()
        if path and candidate.is_file() and candidate.is_relative_to(dist):
            # Vite emits content-hashed file names under /assets.
            cache = (
                "public, max-age=31536000, immutable" if path.startswith("assets/") else "no-cache"
            )
            return FileResponse(candidate, headers={"Cache-Control": cache})
        return FileResponse(index, headers={"Cache-Control": "no-cache"})


def create_app(settings: Settings | None = None, services: AppServices | None = None) -> FastAPI:
    if services is None:
        services = build_services(settings or load_settings())
    settings = services.settings
    logging.basicConfig(level=settings.log_level.upper())

    if settings.app_env is AppEnv.PRODUCTION and settings.is_mock_mode:
        mocked = [stage for stage, impl in settings.component_providers.items() if impl == "mock"]
        logger.warning(
            "Running in production with MOCK providers for %s "
            "(ALLOW_MOCK_PROVIDERS_IN_PRODUCTION=true)",
            ", ".join(mocked),
        )
    if settings.auth_mode is AuthMode.COGNITO and settings.access_code is not None:
        logger.warning("ACCESS_CODE is set but ignored because AUTH_MODE=cognito")

    @contextlib.asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        await asyncio.to_thread(recover_after_restart, services)
        cleanup_task = asyncio.create_task(cleanup_loop(services))
        liveness_task = asyncio.create_task(job_liveness_loop(services))
        try:
            yield
        finally:
            cleanup_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await cleanup_task
            # One shutdown budget (JOB_SHUTDOWN_GRACE_SECONDS) for running jobs and guest imports,
            # waited for together (heartbeats continue meanwhile); then whatever is left is
            # stopped: jobs interrupted, guest imports cancelled and given back.
            deadline = time.monotonic() + services.settings.job_shutdown_grace_seconds
            services.executor.shutdown()
            if services.youtube_import is not None:
                # Imports waiting for the provider or a request slot stop instead of outliving us.
                services.youtube_import.close()
            draining = [drain_running_jobs(services, deadline)]
            if services.guest_imports is not None:
                draining.append(services.guest_imports.wait_until(deadline))
            await asyncio.gather(*draining)
            if services.speech_limiter is not None:
                # Jobs still waiting for a speech request slot stop instead of outliving us.
                services.speech_limiter.close()
            # Running FFmpeg processes are killed instead of outliving the server.
            services.audio.close()
            imports_quiescent = True
            if services.guest_imports is not None:
                # Imports still running (e.g. a stalled provider read) are cancelled, start no
                # database work any more and are given back in one bounded statement (or by the
                # next instance's recovery); at most twice the runner's stop bound.
                outcome = await services.guest_imports.stop()
                imports_quiescent = outcome.quiescent
            liveness_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await liveness_task
            try:
                await asyncio.to_thread(interrupt_unfinished_jobs, services)
            except Exception:
                logger.exception("Could not mark unfinished jobs at shutdown")
            close = getattr(services.cognito, "close", None)
            if close is not None:
                close()
            services.engine.dispose()
            if services.guest_import_engine is not None:
                if imports_quiescent:
                    services.guest_import_engine.dispose()
                else:
                    # Never claim the database is free while an import step may still run; the
                    # process exit closes those connections.
                    logger.warning("Guest import database engine left open at shutdown")

    app = FastAPI(
        title="MyDubb API",
        version="0.1.0",
        lifespan=lifespan,
        docs_url="/api/docs" if settings.app_env != "production" else None,
        redoc_url=None,
        openapi_url="/api/openapi.json" if settings.app_env != "production" else None,
    )
    app.state.services = services
    app.add_middleware(
        RequestGuardMiddleware,
        trusted_origins=settings.trusted_origins,
        max_body_bytes=settings.max_request_body_bytes,
        hsts=settings.app_env is AppEnv.PRODUCTION,
    )
    install_error_handlers(app)
    app.include_router(system_router)
    # The two login modes are exclusive: only the active mode's endpoints exist.
    if settings.auth_mode is AuthMode.COGNITO:
        app.include_router(auth_router)
    else:
        app.include_router(access_router)
    app.include_router(jobs_router)
    # Always mounted: with guest access off it answers 404 guest_access_disabled.
    app.include_router(guest_router)
    # Always mounted: with the import off it answers 404 youtube_import_disabled after the
    # session and CSRF checks, and /api/meta tells the UI not to offer it.
    app.include_router(youtube_import_router)
    if settings.frontend_dist_dir is not None:
        _install_frontend(app, settings.frontend_dist_dir)
    return app
