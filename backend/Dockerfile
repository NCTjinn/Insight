# ── Insight Backend Dockerfile ─────────────────────────────────────────────────
# Multi-stage build: keeps the final image lean.
# Cloud Run requires the container to listen on $PORT (default 8080).

# ── Stage 1: dependency install ────────────────────────────────────────────────
FROM python:3.12-slim AS builder

WORKDIR /app

# Install dependencies into an isolated prefix so we can copy only them
COPY requirements.txt .
RUN pip install --no-cache-dir --prefix=/install -r requirements.txt


# ── Stage 2: runtime image ─────────────────────────────────────────────────────
FROM python:3.12-slim

WORKDIR /app

# Copy installed packages from builder
COPY --from=builder /install /usr/local

# Copy application source
COPY main.py .

# Cloud Run injects $PORT at runtime (usually 8080).
# We read it in the CMD below so the container always binds correctly.
ENV PORT=8080

# Non-root user for security
RUN addgroup --system app && adduser --system --ingroup app app
USER app

# Uvicorn: single worker is fine for Cloud Run's per-instance concurrency model.
# Increase --workers if you need CPU-bound parallelism (rare for this workload).
CMD uvicorn main:app --host 0.0.0.0 --port ${PORT} --workers 1 --log-level info
