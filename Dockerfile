# ── stage 1: build the UI ────────────────────────────────────────────────────
FROM node:20-alpine AS ui-builder
WORKDIR /build
COPY ui/package.json ui/pnpm-lock.yaml* ui/package-lock.json* ./
RUN npm install -g pnpm 2>/dev/null; \
    if [ -f pnpm-lock.yaml ]; then pnpm install --frozen-lockfile; \
    else npm ci; fi
COPY ui/ .
RUN if [ -f pnpm-lock.yaml ]; then pnpm build; else npm run build; fi

# ── stage 2: runtime ─────────────────────────────────────────────────────────
FROM python:3.12-slim

# System deps for Chromium (Playwright's bundled build uses these)
RUN apt-get update && apt-get install -y --no-install-recommends \
        chromium \
        fonts-liberation \
        libnss3 \
        libatk-bridge2.0-0 \
        libgtk-3-0 \
        libgbm1 \
        libasound2 \
    && rm -rf /var/lib/apt/lists/*

# Tell Playwright to use the system Chromium and skip its own download.
# The binary is at /usr/bin/chromium on Debian bookworm; pass it via env so
# BrowserSession picks it up without requiring a flag on every invocation.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    AUTORA_CHROME_PATH=/usr/bin/chromium

WORKDIR /app
COPY pyproject.toml README.md ./
COPY src/ src/
RUN pip install --no-cache-dir -e ".[anthropic,local,browser,voice-deepgram]"

COPY --from=ui-builder /build/dist ui/dist/

COPY docker-entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 8817

# /data  → browser profile + session logs (persistent volume)
# /host  → the host filesystem mounted read-write so the agent can work on it
VOLUME ["/data", "/host"]

ENTRYPOINT ["/entrypoint.sh"]
