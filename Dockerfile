# ── stage 1: build ───────────────────────────────────────────────────────────
# The app is a Vite bundle and an esbuild'd Express server. Both come out of
# `npm run build` into dist/, so one build stage produces everything the
# runtime needs and none of the toolchain that produced it.
FROM node:22-alpine AS builder
WORKDIR /build

# Dependencies first, from the lockfile alone: this layer is then reused on
# every build that did not change what we depend on, which is most of them.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.server.json vite.config.ts index.html ./
COPY public/ public/
COPY src/ src/
COPY server.ts ./
COPY server/ server/

# Typecheck both halves before building either. A container that builds and
# then fails at runtime on something the compiler already knew is a wasted
# round trip through the registry and an update on somebody's box.
RUN npm run lint && npm run build

# The runtime needs express, ws and the Gemini SDK -- not vite, esbuild or
# typescript. Pruning here rather than reinstalling in the next stage keeps it
# to one npm run and one lockfile.
RUN npm prune --omit=dev

# ── stage 2: runtime ─────────────────────────────────────────────────────────
FROM node:22-alpine
WORKDIR /app

ENV NODE_ENV=production \
    # Umbrel's compose file publishes 8817 and app_proxy points at it.
    AUTORA_PORT=8817 \
    AUTORA_HOST=0.0.0.0 \
    # The one directory that survives an update, so the keys pasted into
    # Settings and the spend ledger behind the billing card outlive it.
    AUTORA_HOME=/data

COPY --from=builder /build/node_modules node_modules/
COPY --from=builder /build/dist dist/
# The server reads its own version out of this to stamp the page and answer
# /api/origin, so it is a runtime file rather than a build artefact.
COPY package.json ./

EXPOSE 8817

# /data → settings, keys and the spend ledger (persistent volume)
# /host → the host filesystem, mounted read-write so the agent can work on it
VOLUME ["/data"]

CMD ["node", "dist/server.cjs"]
