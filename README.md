# Autora

An agentic harness you can **watch**.

The agent's browser, terminal, and file edits stream to a web UI in real time.
Every session records itself, and you replay it by scrubbing the same UI you
watched it in. Actions that matter pause for your approval, showing you the
exact command before it runs.

Built on one idea: **the event log is the product.** Everything the agent does
emits a typed event to an append-only log. The live view is a subscriber to that
log. A recording is that log read back. There is no separate recording pipeline
to bolt on, and no way for the live view and the replay to disagree — they are
the same code path.

```
  agent ──emit──> event log (jsonl + blobs) ──┬──> websocket ──> live UI
                       │                      └──> replay ─────> same UI
                       └── asciinema export, grep, tail -f
```

## Quickstart

```bash
git clone https://github.com/blofstedt/Autora && cd Autora
pip install -e ".[all]"          # or: uv pip install -e ".[all]"
playwright install chromium      # skip if you already have one; see AUTORA_CHROME_PATH

cd ui && pnpm install && pnpm build && cd ..

export ANTHROPIC_API_KEY=sk-...  # or run fully local, below
autora up ~/code/my-project
```

Open the URL it prints. Type a task. Watch it work.

### Running fully local

```bash
# any OpenAI-compatible server: vLLM, Ollama, llama.cpp, LM Studio
autora up ~/code/my-project --provider local \
  --base-url http://localhost:8000/v1 --model qwen3-coder
```

### Other commands

```bash
autora sessions                    # list recordings
autora replay 20260919-141233-ab12 # print one to the terminal
curl localhost:8817/api/sessions/<id>/cast > session.cast && asciinema play session.cast
```

## What you see

| Pane | Shows |
|---|---|
| **Timeline** | Every event, click to seek. It is a scrub bar over the session, not a log viewer. |
| **Terminal** | A real PTY through xterm.js — colors, progress bars, the lot. |
| **Browser** | Live CDP screencast, with a marker painted at each click so you can see the agent miss. The *agent* reads the page as an accessibility snapshot, not pixels — see below. |
| **Files** | Every edit as a unified diff, the moment it lands. |
| **Transcript** | What the agent said, with reasoning collapsed by default. |

The interface is dark, keyboard-friendly, and has no third-party dependencies at
runtime — fonts are vendored (Inter and JetBrains Mono, variable, Latin subset,
77KB total), so it works offline and on an airgapped box, and opening a session
does not tell a CDN about it.

The scrubber works during a live session. Scroll back to step 12 while the agent
is on step 40; "jump to now" returns you to the head.

Press play and it replays at the pace it happened — real gaps between events,
clamped so a 40-second `npm install` does not become 40 seconds of dead air.
Errors, approvals, prompts and edits are painted onto the track as tick marks,
so the shape of a session is readable before you scrub into it.

| Key | |
|---|---|
| `space` | play / pause |
| `←` `→` | step one event |
| `⇧←` `⇧→` | jump to the previous/next notable event |
| `home` `end` | start of session / jump to now |
| `/` | focus the composer |

The tab itself carries state: the favicon and title go violet while the agent
works, amber when it is waiting on your approval. An approval that lands while
the tab is in the background also chimes once.

## How the agent sees a page

Not by screenshot. `read` returns the accessibility tree — every interactive
element with the role and name a screen reader would announce, numbered:

```
[0] textbox "Email address" value="ada@example.com"
[1] textbox "Password" password empty
[4] checkbox "Remember me" checked
[7] button "Sign in"
[9] link "Terms of service" -> /tos
```

Actions take those numbers: `click(ref=7)`, and `fill` takes a list, so a whole
form is one round trip instead of one per field. Every action returns a freshly
numbered page, so acting rarely needs a `read` first — and refs cannot go stale
without saying so, because a ref that quietly pointed somewhere else is how an
agent ends up clicking the wrong button.

The accessibility tree rather than the DOM, because the DOM is wrapper soup: a
button is six nested divs, and `innerText` cannot see a form field at all. The
a11y layer is what the platform already computes for perceiving an interface
without looking at it. That sign-in page above is ~110 tokens. A 1280×800
screenshot of it is ~1,300, and you cannot click it.

Screenshots remain, as the fallback they should be: for questions about how a
page *looks* — a chart, a canvas, a broken layout. The human still gets the full
video feed either way; the screencast is a separate channel from what the model
reads.

## Approvals

Reads run freely. Deploys, migrations, history rewrites and installs pause and
ask, showing the exact rendered command. A few things (piping curl into a shell,
`rm -rf /`, force-pushing to main, reading private keys) are refused outright and
cannot be approved — including under `--yes`.

Rules live in `src/autora/policy.py` as readable patterns. Loosen them per
project once you trust it. `--yes` skips confirmations entirely; don't point that
at production credentials.

## Context

The model's context is a projection of the event log, the same way the UI is —
`compose(events)` in `src/autora/context.py` folds the log into messages, so
there is no second history to drift out of sync, and "what was in context at
step 12" has an answer.

That projection is where the cost lives. Two things it does:

**Caches the conversation prefix.** The system prompt and tools were already
cached; the history was not, so a forty-step turn re-sent an ever-growing
conversation as fresh input on every step. A breakpoint on the tail means each
turn is paid for once instead of once per remaining iteration.

**Trims old tool output.** A 4000-line test run matters while the agent is
acting on it and not ten steps later, so old results are demoted to a preview
plus a pointer. The full text stays in the blob store — `recall(ref=…)` reads it
back, and `recall(ref=…, search="…")` greps it. Lossy in context, lossless on
disk.

Compaction is batched and sticky rather than continuous, because rewriting
history invalidates the cached prefix from the rewrite point on. Nothing is
trimmed until the window crosses `trigger_tokens`; between compactions the
context is strictly append-only.

On a 30-step turn with 3KB of output per step, measured with
`estimate_tokens`:

| | final request | turn total |
|---|---:|---:|
| Before | 18,633 | 288,880 |
| After | 6,052 | 136,460 |

Applying Anthropic's published cache multipliers to those counts puts the turn
at roughly `0.8×` the cost of a single uncached send of its final request, down
from `15.5×` — most of it from the breakpoint, not the trimming. Real billing
depends on actual cache hits; check `usage.cached` in the UI. Tuning lives in
`ContextPolicy`.

## Configuration

| Variable | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` | Hosted provider |
| `AUTORA_LLM_BASE_URL` | Local OpenAI-compatible endpoint |
| `AUTORA_CHROME_PATH` | Use an existing Chromium instead of Playwright's pinned build |
| `AUTORA_HOME` | State directory (default `~/.autora`) |

## Where sessions live

```
~/.autora/sessions/<id>/
  events.jsonl     # the whole session, greppable, tailable
  blobs/           # content-addressed frames (deduped)
  meta.json
```

`tail -f ~/.autora/sessions/<id>/events.jsonl` is a supported debugging path, not
an accident.

## Status

Working and tested: event store, bus backpressure, policy gate, PTY, file tools,
browser screencast, agent loop, transport, web UI, replay, narration, context
composition and compaction.

Interfaces defined, adapters not shipped: speech-to-text and text-to-speech
(`src/autora/voice/engine.py`), desktop control. The voice *logic* — barge-in,
what to say aloud, voice approvals — is implemented and tested against fakes;
plugging in Whisper/Kokoro is a small adapter each.

```bash
python3 tests/run_all.py
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for why it is built this way.
