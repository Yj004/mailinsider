# MailInsider API — Cloud Run
# Build from repo root:
#   docker build -f services/api/Dockerfile -t mailinsider-api .

FROM python:3.12-slim AS base

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PORT=8080

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace

COPY services/api/requirements.txt services/api/requirements.txt
RUN pip install --upgrade pip \
    && pip install -r services/api/requirements.txt

COPY services/api/app services/api/app

WORKDIR /workspace/services/api

# Non-root user for Cloud Run
RUN useradd --create-home --uid 1001 appuser \
    && chown -R appuser:appuser /workspace
USER appuser

EXPOSE 8080

# Cloud Run injects PORT; default 8080 for local docker runs.
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8080} --proxy-headers --forwarded-allow-ips='*'"]
