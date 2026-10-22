# syntax=docker/dockerfile:1

# ---- Frontend build -------------------------------------------------------
FROM node:22-alpine AS frontend
WORKDIR /build
COPY frontend/package.json frontend/package-lock.json frontend/.npmrc ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

# ---- Runtime: FastAPI serves the API and the React build on one origin ----
FROM python:3.12-slim AS runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never \
    UV_PROJECT_ENVIRONMENT=/opt/venv

WORKDIR /app
COPY backend/pyproject.toml backend/uv.lock backend/.python-version ./
# uv is only needed at build time; it is mounted, not copied into the image.
RUN --mount=from=ghcr.io/astral-sh/uv:0.11.30,source=/uv,target=/bin/uv \
    uv sync --frozen --no-dev --no-install-project

COPY backend/alembic.ini ./
COPY backend/alembic ./alembic
COPY backend/app ./app
COPY --from=frontend /build/dist ./frontend_dist
COPY --chmod=0755 docker/entrypoint.sh /usr/local/bin/entrypoint.sh

RUN useradd --create-home --uid 10001 mydubb \
    && mkdir -p /tmp/mydubb-results \
    && chown mydubb:mydubb /tmp/mydubb-results
USER mydubb

ENV PATH=/opt/venv/bin:$PATH \
    FRONTEND_DIST_DIR=/app/frontend_dist \
    RESULT_STORAGE_DIR=/tmp/mydubb-results \
    PORT=8000

EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD python -c "import os, urllib.request; urllib.request.urlopen('http://127.0.0.1:' + os.environ.get('PORT', '8000') + '/api/health', timeout=4)"

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
