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
#
# Every line is validated before it is used, and a line that fails is skipped
# rather than fatal. This script runs under `set -e` as PID 1: an `export` that
# rejects its argument takes the whole container down before Python ever starts,
# and the symptom is the app refusing connections with nothing in its own logs.
# A file a person is invited to edit must never be able to do that -- and the
# obvious things to write by hand (`export KEY=...`, an indented line) are
# exactly what a naive parser chokes on.
if [ -f /data/autora.env ]; then
    while IFS= read -r line || [ -n "$line" ]; do
        # Leading whitespace and an optional `export `, in any combination and
        # any order -- people write both, and neither is an error.
        while :; do
            case "$line" in
                " "*|"	"*) line=${line#?} ;;
                "export "*|"export	"*) line=${line#export} ;;
                *) break ;;
            esac
        done

        case "$line" in
            ''|'#'*) continue ;;
            *=*) ;;
            *) continue ;;
        esac

        name=${line%%=*}
        case "$name" in
            ''|[!A-Za-z_]*|*[!A-Za-z0-9_]*)
                echo "warning: /data/autora.env: skipping unusable name '$name'" >&2
                continue
                ;;
        esac

        # Belt and braces: the name is already known good, and even so this
        # must not be the thing that stops the app from starting.
        export "$name=${line#*=}" || true
    done < /data/autora.env
fi

# Everything the harness keeps -- memories, session recordings -- lives under
# AUTORA_HOME, which defaults to ~/.autora. Inside this container that is
# /root/.autora, which is not a volume: it is part of the image layer and is
# discarded every time the container is recreated, which is to say on every
# update. /data is the one directory that survives, so that is where state goes.
export AUTORA_HOME="${AUTORA_HOME:-/data}"
mkdir -p "${AUTORA_HOME}"

HOST="${AUTORA_HOST:-0.0.0.0}"
PORT="${AUTORA_PORT:-8817}"
WORKDIR="${AUTORA_WORKDIR:-/host}"
# Deliberately empty by default. A title given here is the title of *every*
# session the container ever opens, which is how a session list ends up as a
# column of identical names -- and it also outranks the name a session takes
# from its first message, so naming them costs nothing and buys nothing. Set
# AUTORA_TITLE only if you actually want one fixed label.
TITLE="${AUTORA_TITLE:-}"
BROWSER_PROFILE="${AUTORA_BROWSER_PROFILE:-/data/browser-profile}"

# Ensure the browser profile directory exists so Playwright can write to it.
mkdir -p "${BROWSER_PROFILE}"

set -- up "${WORKDIR}" \
    --host "${HOST}" \
    --port "${PORT}" \
    --browser-profile "${BROWSER_PROFILE}"

if [ -n "${TITLE}" ]; then
    set -- "$@" --title "${TITLE}"
fi

# https on a second port, so a phone on the LAN gets a microphone.
#
# Browsers only allow audio capture from a secure context, and an IP address on
# plain http is not one -- which is why dictation and live chat had nowhere to
# appear when the app was opened from another device. A self-signed certificate
# is enough: click through the warning once per device and the origin is
# secure. The certificate lives in /data, so that warning is a one-time cost
# per device rather than one per restart.
#
# Alongside http, never instead of it: 8817 keeps serving exactly what it
# served before, so a reverse proxy in front of it (Umbrel's app_proxy, say)
# is unaffected, and the http page can simply link to the secure one. Publish
# 8818 to reach it. Set AUTORA_TLS=0 to skip it entirely, or point
# AUTORA_TLS_CERT and AUTORA_TLS_KEY at a real certificate if you have one.
if [ -n "${AUTORA_TLS_CERT:-}" ] && [ -n "${AUTORA_TLS_KEY:-}" ]; then
    set -- "$@" --tls-cert "${AUTORA_TLS_CERT}" --tls-key "${AUTORA_TLS_KEY}"
elif [ "${AUTORA_TLS:-1}" = "1" ]; then
    set -- "$@" --tls-port "${AUTORA_TLS_PORT:-8818}"
    set -- "$@" --tls
fi

# Auto-approve: default ON for the Umbrel server use-case (the user is the
# sole operator; approvals are available via the web UI regardless).
if [ "${AUTORA_AUTO_APPROVE:-1}" = "1" ]; then
    set -- "$@" --yes
fi

# Voice: only when asked for, never merely because a key exists.
#
# The adapters drive a local microphone and speaker through sounddevice, and
# this container has neither -- so turning voice on here cannot work, and
# inferring it from a key means saving that key in the settings panel silently
# arms a broken startup path that only fires on the next restart.
#
# Set AUTORA_VOICE=deepgram to opt in deliberately.
if [ -n "${AUTORA_VOICE:-}" ] && [ "${AUTORA_VOICE}" != "off" ]; then
    set -- "$@" --voice "${AUTORA_VOICE}"
fi

exec autora "$@"
