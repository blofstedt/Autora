#!/bin/sh
# What the entrypoint actually asks `autora` to do.
#
# Run for real, with a stub `autora` on PATH that prints its arguments, so this
# tests the shipped script rather than a description of it.
#
# The case that matters: voice must not switch itself on merely because a key
# exists. The adapters drive a local microphone and speaker, this container has
# neither, and inferring voice from a key meant that saving one in the settings
# panel armed a startup path which only failed on the next restart -- surfacing
# as the web UI refusing connections, with nothing to say voice was involved.
set -u

HERE=$(dirname "$0")
ENTRY=$(cd "$HERE/.." && pwd)/docker-entrypoint.sh
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

mkdir -p "$WORK/bin" "$WORK/profile"
cat > "$WORK/bin/autora" <<'STUB'
#!/bin/sh
echo "ARGS: $*"
STUB
chmod +x "$WORK/bin/autora"

fail=0

run() {
    env PATH="$WORK/bin:$PATH" \
        AUTORA_WORKDIR="$WORK" \
        AUTORA_BROWSER_PROFILE="$WORK/profile" \
        AUTORA_HOST=127.0.0.1 AUTORA_PORT=8817 \
        "$@" sh "$ENTRY" 2>/dev/null
}

expect() {
    label=$1; shift
    want=$1; shift
    out=$("$@") || { echo "  FAIL  $label — entrypoint exited $?"; fail=1; return; }
    case "$out" in
        *"$want"*) echo "  ok    $label" ;;
        *) echo "  FAIL  $label — wanted '$want' in: $out"; fail=1 ;;
    esac
}

refute() {
    label=$1; shift
    unwanted=$1; shift
    out=$("$@") || { echo "  FAIL  $label — entrypoint exited $?"; fail=1; return; }
    case "$out" in
        *"$unwanted"*) echo "  FAIL  $label — found '$unwanted' in: $out"; fail=1 ;;
        *) echo "  ok    $label" ;;
    esac
}

echo "always"
expect "serves on the configured port" "--port 8817" run
expect "auto-approves by default" "--yes" run

echo
echo "titles"
# Every session carrying the same title is a session list with no names in it,
# and a title given here also outranks the one a session takes from its first
# message -- so the container must not invent one.
refute "no title is passed by default" "--title" run
expect "AUTORA_TITLE is still honoured when asked for" "--title Nightly" \
    run AUTORA_TITLE=Nightly

echo
echo "tls"
# Voice is unreachable without a secure page, and the secure page is a second
# listener rather than a replacement: the plain port has to keep serving.
expect "https is on by default" "--tls" run
expect "and on its own port" "--tls-port 8818" run
expect "with http still on the configured port" "--port 8817" run
refute "AUTORA_TLS=0 turns it off" "--tls" run AUTORA_TLS=0
expect "a real certificate wins over the generated one" "--tls-cert /c.pem" \
    run AUTORA_TLS_CERT=/c.pem AUTORA_TLS_KEY=/k.pem

echo
echo "voice"
refute "a Deepgram key alone does not enable voice" "--voice" \
    run DEEPGRAM_API_KEY=dg-somekey-123
refute "an Anthropic key does not enable voice" "--voice" \
    run ANTHROPIC_API_KEY=sk-ant-123
expect "AUTORA_VOICE opts in explicitly" "--voice deepgram" \
    run AUTORA_VOICE=deepgram
refute "AUTORA_VOICE=off stays off" "--voice" \
    run AUTORA_VOICE=off DEEPGRAM_API_KEY=dg-somekey-123

echo
if [ "$fail" -eq 0 ]; then
    echo "all entrypoint argument tests passed"
else
    echo "FAILED"
fi
exit "$fail"
