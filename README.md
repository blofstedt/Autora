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

### Reaching it from a phone

`autora up` speaks plain HTTP, which is fine over `localhost` and fine for
reading the thread from another device. Two things need more than that:

| Wants a secure page | Why |
| --- | --- |
| Install to the home screen | Browsers only install a PWA from an https origin |
| Dictation and live voice chat | Microphone capture is gated on a secure context |

A private network is not enough — `http://box.tailnet.ts.net:8817` is an
insecure origin as far as the browser is concerned, and no amount of site
settings changes that.

The shortest way to a microphone is `--tls`, which puts an https listener on
the next port up with a certificate Autora generates and keeps:

```bash
autora up ~/code/my-project --tls        # http on 8817, https on 8818
```

Nothing moves: the plain port serves exactly what it served before, so
bookmarks, reverse proxies and the relay are unaffected, and the http page
offers a link across to the secure one. The certificate is self-signed, so the
first visit from each device shows a warning — proceed past it once and the
origin is secure, which is all the browser was waiting for. You still do not
get the install-to-home-screen prompt, which wants a certificate someone else
trusts.

For that, and on a tailnet, the shortest path to a real certificate is
Tailscale's own proxy:

```bash
tailscale serve --bg 8817          # https://<machine>.<tailnet>.ts.net -> :8817
tailscale serve status             # confirm, and see the URL to open
tailscale serve --https=443 off    # undo
```

That needs MagicDNS and HTTPS Certificates enabled for the tailnet (admin
console, Settings → Features). With a proxy in front you can also drop
`--host 0.0.0.0` and go back to the default `127.0.0.1` bind: nothing has to
listen on the tailnet interface itself. Open the `https://` URL it prints — no port —
and both the install prompt and the microphone appear. Anything else that
terminates TLS in front of the port works the same way: Caddy or nginx with a
certificate from `tailscale cert`, or whatever your reverse proxy already uses.

Until then the microphone and `Live` are still in the composer, greyed, and
tapping either says what is in the way and offers the secure page if one is
running — rather than vanishing and leaving you to conclude voice was never
built.

| Flag | Env | |
| --- | --- | --- |
| `--tls` | `AUTORA_TLS=1` | Also serve https, with a generated certificate |
| `--tls-port` | `AUTORA_TLS_PORT` | Where (default: `--port` + 1) |
| `--tls-cert` / `--tls-key` | `AUTORA_TLS_CERT` / `AUTORA_TLS_KEY` | Use a real certificate instead |

In the Docker image this is on by default and the https listener is on 8818;
publish it (`-p 8818:8818`) to reach it. The Umbrel app ships with
`AUTORA_TLS: "0"` instead, because that port is published straight past
Umbrel's login — set it to `1` when you want the microphone on a phone.

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

### Pointing at things

Hit **Select** in the browser pane and click an element in the live video.
Describing an element in prose and hoping the agent finds the same one is the
slow way to ask for a change; pointing at it is not.

A pick resolves what you actually meant — click the label inside a button and
you get the button — and comes back with the element's snapshot ref, a stable
selector, and only the styles *that element* sets, not the whole inherited
cascade. Where the framework left a trail (React's dev fiber, a `data-source`
attribute) it resolves to the file and line that rendered it; where it did not,
it says so rather than guessing at a file. The pick lands on the timeline, so
the agent sees that you pointed and at what.

### 3D and canvas

A `<canvas>` has no DOM to read, so the pick asks the engine instead. A scene
graph is the accessibility tree of a 3D app — named objects in a hierarchy — and
where the engine is reachable (three.js, Babylon) a click becomes a raycast and
comes back as `player_torso (Mesh)` rather than a pixel.

```
3D engine: three
Hit: player_torso (Mesh) at [-1.91, 0, 0.6], material MeshBasicMaterial

Scene graph:
  world  Scene
    player_torso  Mesh
    enemy_drone  Mesh
    props  Group
      crate_01  Mesh
```

Most apps keep their scene private, so the universal fallback is a tight crop of
the click rather than a whole frame — ~136 tokens against ~1,365, and
unambiguous about what is being asked about. If you want objects nameable,
expose the scene as `window.scene`.

### Guiding someone

`highlight` spotlights a region of the page: a dimmed backdrop, a slowly
breathing ring, a label. It is painted into the page inside a shadow root, so it
survives into the screencast and the recording, cannot be restyled by the page,
and never leaks its own text into what the agent reads back.

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

## Memory

The agent keeps what it learns in `~/.autora/memory.db` — one SQLite file, no
service, openable with any SQLite client. Four kinds of record: **preferences**
(how you want things done), **procedures** (a how-to that worked — a skill, once
you stop capitalising it), **facts**, and **episodes** (a notable outcome worth
recalling).

Two rules keep it from rotting:

**Everything has provenance.** A record points back at the session and event
that produced it. A memory system without that becomes a junk drawer — claims
accumulate and a wrong one is indistinguishable from a right one. Being able to
ask "why do you think that?" and delete the answer is what makes the rest
trustworthy.

**Nothing is confirmed on first sight.** Records written automatically land
`provisional`, and are promoted only when a later session independently writes
the same thing. Nothing is learned at all from a run that failed or was
interrupted — a procedure learned from a broken run teaches the break.

Retrieval is budgeted rather than dumped. A handful of pinned records are always
present; the rest is searched per prompt (SQLite FTS5, BM25-ranked) and capped
hard. Everything else stays one `memory(action="search")` away. In practice a
store of 42 records puts about 130 tokens in front of the model. The block is
emitted as an event, so it is on the timeline and in the recording: you can see
exactly what the agent was primed with before it answered.

Lexical search rather than embeddings is a deliberate choice, not a shortcut —
for one person's memory the recall problem is small, and a BM25 hit you can
explain beats a cosine distance you cannot. Embeddings are a later optimisation
if recall proves insufficient.

### The knowledge web

Press `k`. Everything the agent knows, as a graph: colour by kind, size by how
often it has been recalled, a ring for pinned, faded for provisional. Click a
node for its content, its tags, and the session it came from. Pin it to load it
every time, retire it, or delete it for good.

The point is not the picture. Memory you cannot see is memory you cannot
correct — an agent that has quietly decided something wrong about you will keep
acting on it forever unless there is somewhere to go and say no.

## Configuration

| Variable | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` | Hosted provider |
| `AUTORA_LLM_BASE_URL` | Local OpenAI-compatible endpoint |
| `AUTORA_CHROME_PATH` | Use an existing Chromium instead of Playwright's pinned build |
| `AUTORA_HOME` | State directory (default `~/.autora`) — sessions and `memory.db` |

## Where sessions live

```
~/.autora/sessions/<id>/
  events.jsonl     # the whole session, greppable, tailable
  blobs/           # content-addressed frames (deduped)
  meta.json
```

`tail -f ~/.autora/sessions/<id>/events.jsonl` is a supported debugging path, not
an accident.

## Releasing to the Umbrel store

Umbrel decides whether an update exists by comparing one string: `version` in
`blofstedt-autora/umbrel-app.yml`. Not the image digest, not the commit. A
change can be merged, built and pushed to the registry, and every installed
copy will still report itself up to date — removing and re-adding the community
store re-fetches the same manifest and reaches the same conclusion.

So a change that reaches the container ships with a higher `version` and
rewritten `releaseNotes`, which Umbrel shows on the update. CI enforces this on
every pull request; a change with no user-facing effect opts out with
`[no release]` in the pull request title or body.

```bash
python3 .github/scripts/check_release.py --base origin/main   # the same check, locally
```

## Status

Working and tested: event store, bus backpressure, policy gate, PTY, file tools,
browser screencast, agent loop, transport, web UI, replay, narration, context
composition and compaction, accessibility-tree page reading, visual element
picking (DOM and 3D), guidance overlays, memory with provenance, the knowledge
web.

Interfaces defined, adapters not shipped: speech-to-text and text-to-speech
(`src/autora/voice/engine.py`), desktop control. The voice *logic* — barge-in,
what to say aloud, voice approvals — is implemented and tested against fakes;
plugging in Whisper/Kokoro is a small adapter each.

```bash
python3 tests/run_all.py
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for why it is built this way.
