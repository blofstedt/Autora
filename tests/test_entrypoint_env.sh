#!/bin/sh
# The entrypoint's /data/autora.env parsing, under the shell the image uses.
#
# This file is edited by hand and by the settings panel, and the script that
# reads it runs under `set -e` as PID 1. A line it cannot handle must be
# skipped, never fatal: a fatal one stops the container before Python starts,
# and the app simply refuses connections with nothing in its own logs to say
# why.
set -u

HERE=$(dirname "$0")
ENTRY="$HERE/../docker-entrypoint.sh"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

fail=0

# The parsing block, lifted from the entrypoint and pointed at a fixture, so
# this tests the shipped code rather than a copy of it.
extract() {
    sed -n '/^if \[ -f \/data\/autora.env \]/,/^fi$/p' "$ENTRY" \
        | sed "s#/data/autora.env#$WORK/autora.env#g"
}

run_case() {
    label=$1
    want_name=$2
    want_value=$3
    {
        echo "#!/bin/sh"
        echo "set -e"
        extract
        echo "echo \"RESULT=\${$want_name:-UNSET}\""
    } > "$WORK/probe.sh"
    chmod +x "$WORK/probe.sh"

    out=$(sh "$WORK/probe.sh" 2>/dev/null) || {
        echo "  FAIL  $label — the script exited $? (this kills the container)"
        fail=1
        return
    }
    got=${out#RESULT=}
    if [ "$got" = "$want_value" ]; then
        echo "  ok    $label"
    else
        echo "  FAIL  $label — got '$got', want '$want_value'"
        fail=1
    fi
}

echo "well-formed"
printf 'DEEPSEEK_API_KEY=sk-abc123\n' > "$WORK/autora.env"
run_case "plain KEY=value" DEEPSEEK_API_KEY "sk-abc123"

printf '# a comment\n\nDEEPSEEK_API_KEY=sk-abc123\n' > "$WORK/autora.env"
run_case "comments and blanks" DEEPSEEK_API_KEY "sk-abc123"

printf 'DEEPSEEK_API_KEY=sk-abc123' > "$WORK/autora.env"
run_case "no trailing newline" DEEPSEEK_API_KEY "sk-abc123"

printf 'ANTHROPIC_API_KEY=sk-ant-has=equals=signs\n' > "$WORK/autora.env"
run_case "value containing '='" ANTHROPIC_API_KEY "sk-ant-has=equals=signs"

echo
echo "what people actually write"
printf 'export DEEPSEEK_API_KEY=sk-abc123\n' > "$WORK/autora.env"
run_case "leading 'export '" DEEPSEEK_API_KEY "sk-abc123"

printf '   DEEPSEEK_API_KEY=sk-abc123\n' > "$WORK/autora.env"
run_case "indented line" DEEPSEEK_API_KEY "sk-abc123"

printf '\texport  DEEPSEEK_API_KEY=sk-abc123\n' > "$WORK/autora.env"
run_case "tab, then export, double space" DEEPSEEK_API_KEY "sk-abc123"

echo
echo "malformed lines are skipped, never fatal"
printf 'DEEPSEEK API KEY=sk-abc\nANTHROPIC_API_KEY=sk-ant-ok\n' > "$WORK/autora.env"
run_case "spaces in the name" ANTHROPIC_API_KEY "sk-ant-ok"

printf '2FA_KEY=x\nANTHROPIC_API_KEY=sk-ant-ok\n' > "$WORK/autora.env"
run_case "name starting with a digit" ANTHROPIC_API_KEY "sk-ant-ok"

printf '=novalue\nANTHROPIC_API_KEY=sk-ant-ok\n' > "$WORK/autora.env"
run_case "empty name" ANTHROPIC_API_KEY "sk-ant-ok"

printf 'just some prose with no equals\nANTHROPIC_API_KEY=sk-ant-ok\n' > "$WORK/autora.env"
run_case "a line that is not a pair" ANTHROPIC_API_KEY "sk-ant-ok"

printf 'BAD-NAME=x\nANTHROPIC_API_KEY=sk-ant-ok\n' > "$WORK/autora.env"
run_case "hyphen in the name" ANTHROPIC_API_KEY "sk-ant-ok"

echo
echo "no file at all"
rm -f "$WORK/autora.env"
run_case "missing file is a no-op" ANTHROPIC_API_KEY "UNSET"

echo
if [ "$fail" -eq 0 ]; then
    echo "all entrypoint env tests passed"
else
    echo "FAILED"
fi
exit "$fail"
