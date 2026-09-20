#!/bin/sh
set -e

# Keys may also be left in the persistent data volume, one KEY=value per line.
#
# The compose file forwards ANTHROPIC_API_KEY and friends from the host, but
# that substitution only happens if the value is present where the project is
# run from -- miss that and the variable silently becomes an empty string, the
# harness finds no key, and the first symptom is a connection error against a
# local model server nobody started. A file inside the volume has no such
# indirection: it is either there or it is not, it survives app updates, and it
# is reachable without going near the compose file.
#
# Parsed rather than sourced: this only ever needs to set variables, and
# sourcing would run whatever else the file happened to contain.
if [ -f /data/autora.env ]; then
    while IFS= read -r line || [ -n "$line" ]; do
        case "$line" in
            ''|'#'*) continue ;;
            *=*) export "$line" ;;
        esac
    done < /data/autora.env
fi

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
