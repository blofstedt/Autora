#!/bin/sh
set -e

HOST="${AUTORA_HOST:-0.0.0.0}"
PORT="${AUTORA_PORT:-8817}"
WORKDIR="${AUTORA_WORKDIR:-/host}"
TITLE="${AUTORA_TITLE:-Autora}"
BROWSER_PROFILE="${AUTORA_BROWSER_PROFILE:-/data/browser-profile}"

# Ensure the browser profile directory exists so Playwright can write to it.
mkdir -p "${BROWSER_PROFILE}"

set -- up "${WORKDIR}" \
    --host "${HOST}" \
    --port "${PORT}" \
    --title "${TITLE}" \
    --browser-profile "${BROWSER_PROFILE}"

# Auto-approve: default ON for the Umbrel server use-case (the user is the
# sole operator; approvals are available via the web UI regardless).
if [ "${AUTORA_AUTO_APPROVE:-1}" = "1" ]; then
    set -- "$@" --yes
fi

# Voice: enable Deepgram when the API key is present.
if [ -n "${DEEPGRAM_API_KEY}" ]; then
    set -- "$@" --voice deepgram
fi

exec autora "$@"
