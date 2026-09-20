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
