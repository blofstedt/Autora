# Autora

An agentic harness you can **watch**.

The agent's browser, terminal, desktop and file edits stream into the
conversation in real time — each command, page and edit shown at the point it
happened, and still there to scroll back to afterwards. Every session records
itself, and reading one back is reading the thread. It runs in yolo mode:
nothing waits for approval in chat, and every command is shown as it runs.

Built on one idea: **the event log is the product.** Everything the agent does
emits a typed event to an append-only log. The live view is a subscriber to that
log. A recording is that log read back. There is no separate recording pipeline
to bolt on, and no way for the live view and the recording to disagree — they
are the same code path.

```
  agent ──emit──> event log (jsonl + blobs) ──┬──> websocket ──> live UI
                       │                      └──> replay ─────> same UI
                       └── asciinema export, grep, tail -f
```

## Quickstart

```bash
git clone https://github.com/blofstedt/Autora && cd Autora
npm install

export GEMINI_API_KEY=...        # optional -- keys can also be added in Settings
npm run dev
```

Open <http://localhost:3000>. Type a task. Watch it work.

For production, `npm run build` then `npm start`. The container is the same
two steps: `docker build -t autora . && docker run -p 8817:8817 -v autora-data:/data autora`.

### Connecting a model

Replies come from whichever provider you connect, called from the server -- the
key never reaches the browser. Open Settings (the gear, top right), pick a
vendor, paste a key, and choose a model from the list:

| Provider | Get a key | Notes |
| --- | --- | --- |
| OpenAI | <https://platform.openai.com/api-keys> | GPT-5, GPT-4.1, GPT-4o, o3/o4-mini |
| Google Gemini | <https://aistudio.google.com/apikey> | Free tier covers Flash |
| Anthropic Claude | <https://console.anthropic.com/settings/keys> | Sonnet, Haiku, Opus |
| DeepSeek | <https://platform.deepseek.com/api_keys> | Cheapest of the hosted options |
| OpenRouter | <https://openrouter.ai/keys> | One key, hundreds of models; list and prices fetched live |
| Local server | — | Anything speaking the OpenAI API: vLLM, Ollama, llama.cpp |

Each provider keeps its own key, model and endpoint, so switching between them
costs nothing. **Which provider answers** picks one, or leave it on *Automatic*
and the first connected provider is used, in the order shown in the panel.

Every model in the picker is quoted with its price per million tokens, and
those are the same numbers the [billing card](#billing) counts with. **Check
key** asks the vendor whether the key works before you rely on it, and fills
the model list from the same call; **Refresh models** re-asks later, which is
how the OpenRouter catalogue stays current.

Keys pasted into the panel are saved on the server in `.autora/settings.json`,
created readable only by the account Autora runs as. Keys set in the
environment (`GEMINI_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`,
`DEEPSEEK_API_KEY`, `OPENROUTER_API_KEY`) are still honoured and are never
written to that file -- they are the fallback when the app has no key of its
own, and the panel says which of the two is in force.

Without any key the console still runs -- every panel, the event stream,
memory, approvals and the schedule all work -- but nothing answers, and the
thread says which key is missing rather than improvising a reply.

**[docs/GEMINI.md](docs/GEMINI.md)** covers the Gemini specifics: choosing a
model, the thinking budget, and what each error in the thread means.

### Tools

A model decides; tools are what it decides *with*. **Settings -> Tools** lists
the four groups, says whether each can actually be used right now, and sets how
tightly each is held:

| Group | What it is | Asks first, by default |
| --- | --- | --- |
| Terminal | A real shell on the machine Autora runs on, via `bash -lc`. Output streams into the thread as it arrives. | Every command |
| Web browser | The Chromium the agent drives: open, read, click, fill, scroll, screenshot. | Anything that changes the page |
| Computer control | Somebody's actual desktop, over [the relay](#controlling-a-desktop). | Anything but looking |
| Memory | The workspace graph, which outlives the session. | Never |

The same list generates three things that used to be written down separately:
the tool schemas the model receives, the sentence the agent is told about what
it can do, and this panel. They cannot disagree, which is the point -- an agent
that has been told it has a terminal it does not have will narrate command
output rather than admit it, and one told nothing will deny having a shell it
is holding.

A group can be **off** (you turned it off, and the agent is told so) or
**unusable** (on, but the thing it needs is absent -- no Chromium on the
server, no relay dialled in). Those are different sentences, and the agent
gets the one that is true, because "I cannot browse" and "Chromium is not
installed on the server" send you to two very different places.

Nothing is gated: every call runs straight away (yolo mode) and is shown in the
thread as it happens. Stop kills the whole process group, so `sleep 300` inside a
command dies with the command rather than outliving it.

The terminal is a shell, not a terminal emulator: there is no TTY, so `vim`,
`top` and anything that pages will hang rather than work. Use non-interactive
flags. `sudo` works wherever the account Autora runs as can use it -- in the
Umbrel container that is usually root, where it is unnecessary rather than
unavailable.

### Billing

Settings carries a billing card: this month, today, and all time, with a
thirty-day chart and a breakdown by provider and model down to individual
turns. It is counted locally -- every turn records the tokens the vendor
reported and prices them from the table the model picker quoted -- so it is an
accurate running estimate, not an invoice. It cannot see usage from outside
this app, nor a vendor's own discounts, cache credits or minimums, and a turn
whose vendor reported no token count is marked as estimated rather than
silently averaged in.

An optional monthly budget draws a meter and warns as it fills. It does not
block: a console that stops answering mid-sentence because of a number typed
weeks ago is a worse surprise than the bill it was meant to prevent.

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

**On a tailnet, this is one command and it is the best answer there is.**
Tailscale issues a real certificate, so there is no warning to click through,
no port number to remember, and whatever was guarding the plain port — Umbrel's
login, say — still guards it. On the machine running Autora:

```bash
tailscale serve --bg 8817          # https://<machine>.<tailnet>.ts.net -> :8817
tailscale serve status             # confirm, and see the URL to open
tailscale serve --https=443 off    # undo
```

Open the `https://` URL it prints — no port on the end — and the microphone,
the install prompt and everything else appear. It needs MagicDNS and HTTPS
Certificates enabled for the tailnet, both in the admin console under **DNS**;
`tailscale serve` will tell you if they are off. With a proxy in front you can
also drop `--host 0.0.0.0` and go back to the default `127.0.0.1` bind, so
nothing has to listen on the tailnet interface at all.

Anything else that terminates TLS works the same way: Caddy or nginx with a
certificate from `tailscale cert`, or whatever reverse proxy you already run.

**With nothing in front of it**, `--tls` is the fallback. Autora puts an https
listener on the next port up with a certificate it generates and keeps:

```bash
autora up ~/code/my-project --tls        # http on 8817, https on 8818
```

Nothing moves — the plain port serves what it always did, and the http page
offers a link across.

That certificate is signed by a small authority Autora generates and keeps, and
the authority is offered for download at `/autora-ca.crt` (Settings → **Trust
this server** has it, with the steps for Android and iPhone). Install it on a
device and the warning stops, the microphone works, and the page installs to
the home screen as a real app — three complaints that are one fact underneath:
nothing on that device had vouched for the certificate. Leaves are issued per
hostname during the handshake, from the name the browser asks for, so reaching
the box by tailnet name, `.local` or bare IP all match.

Install it only on devices you own: an authority you trust can vouch for any
site to that device, and this one is worth exactly what the server holding its
key is. Skipping it costs nothing but the warning — clicking through still
opens the microphone, it just will not install to a home screen.

The listener itself has whatever authentication Autora has, which is none. That
is fine on a network you control and a poor thing to expose anywhere else,
which is why it is off by default in the Umbrel app (`AUTORA_TLS=1` to turn it
on) and why a real certificate in front is better still.

Until then the microphone and `Live` are still in the composer, greyed, and
tapping either says what is in the way and offers the secure page if one is
running — rather than vanishing and leaving you to conclude voice was never
built.

| Flag | Env | |
| --- | --- | --- |
| `--tls` | `AUTORA_TLS=1` | Also serve https, with a generated certificate |
| `--tls-port` | `AUTORA_TLS_PORT` | Where (default: `--port` + 1) |
| `--tls-cert` / `--tls-key` | `AUTORA_TLS_CERT` / `AUTORA_TLS_KEY` | Use a real certificate instead |

The Umbrel app publishes 8818 for this and ships with `AUTORA_TLS: "0"`. Put a
proxy in front if you can; set it to `1` if you cannot.

### Controlling a desktop

Autora can drive a real computer's screen — click, type, scroll — through a
small relay that runs on that computer. The relay connects *out* to Autora, so
nothing has to be opened up on the machine with the screen, and it is a single
file with no Autora imports, so that machine does not need Autora installed.

Get it from the server you want it to reach, which fills the address in for
you:

```bash
# on the machine you want the agent to control
curl -O http://YOUR-SERVER:8817/relay.py      # Windows: curl.exe -O ...
pip install websockets mss pyautogui pillow   # Windows: py -m pip install ...
python relay.py                               # Windows: py relay.py
```

**Settings → Desktop relay** in the UI has those same three commands with your
server's own address already in them, says whether a relay is connected, and
lists what to check when one will not connect.

Where Autora *is* installed on that machine, `autora relay 192.168.1.5:8817`
does the same thing. Any form of the address works — `host:port`,
`http://host:port`, `ws://host` — and https with Autora's own certificate needs
`--insecure` or the certificate installed there.

Two things catch people out. `autora up` binds to `127.0.0.1` unless told
otherwise, so start it with `--host 0.0.0.0` if the relay is on another
machine. And `python -m autora.relay` only works where Autora is installed —
on a PC that has never had it, that command reports `No module named autora`,
which is the download above missing rather than anything being broken.

Frames reach the conversation only while a session is using the desktop; a
connected but idle relay is not an hour of screenshots in your transcript. The
live preview in Settings tells you it is alive in the meantime.

macOS needs Accessibility permission for the terminal you run it from (System
Settings → Privacy & Security → Accessibility) — capture works without it,
clicking and typing do not. Linux needs an X display, so install XWayland under
Wayland. Windows needs nothing special.

### Other commands

```bash
autora sessions                    # list recordings
autora replay 20260919-141233-ab12 # print one to the terminal
curl localhost:8817/api/sessions/<id>/cast > session.cast && asciinema play session.cast
```

## What you see

One column: the conversation, with the work inside it.

| In the thread | Shows |
|---|---|
| **A command** | The shell call where the agent ran it, its own output under it, colours and progress bars intact, with the exit code and how long it took. |
| **A page** | The page itself, live, while it is open: you watch the pointer travel and the clicks land. Once it has moved on, every frame of that stretch stays with the card, with a marker painted where each click went — drag its strip to move through them. The *agent* reads the page as text, not pixels — see below. |
| **A desktop** | The same, for the machine the relay is running on. |
| **An image** | Drawn in the conversation, at a size you can read and one tap from full screen — a screenshot it was asked for, a chart it made, or a picture it wrote into a sentence. |
| **An edit** | The unified diff, the moment it lands. |
| **Everything else** | One line each — a lookup, a read, a memory write — openable for the detail. |

Nothing is hidden behind a tab, and nothing scrolls away: the terminal from
three questions ago is still three questions up, next to the question that
caused it. Reviewing a session is scrolling back through it, which is also how
you review the session someone else ran — there is no separate recording mode
to enter, because the transcript *is* the recording.

The interface is dark, keyboard-friendly, and has no third-party dependencies at
runtime — fonts are vendored (Inter and JetBrains Mono, variable, Latin subset,
77KB total), so it works offline and on an airgapped box, and opening a session
does not tell a CDN about it.

It is one app at every size. On a phone it is a single column with the
conversation and a tab for scheduled tasks. On a desktop the session list comes
out into a rail on the left, the reading column widens, and screenshots and
diffs get room to be read at a useful size rather than shrunk into a pane.

| Key | |
|---|---|
| `/` | focus the composer |
| `k` | the knowledge web |
| `v` | live voice chat |
| `esc` | close whatever is open |

The tab itself carries state: the favicon and title go violet while the agent
works, amber when it is waiting on your approval. An approval that lands while
the tab is in the background also chimes once.

## How the agent sees a page

Not by screenshot. `read` returns every interactive element on the page with
the role and name a screen reader would announce it by, numbered:

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

Name an address in a message and a real Chromium opens it. A bare domain needs
a verb in front of it — `open example.com`, not every passing mention of
`npm.io` — because launching a browser should be something you can point at
afterwards and say why it happened.

### Watching it work

Reading a page as text is what makes an agent good at browsing. Not being able
to see what it did is what makes it impossible to trust. So the two are
separate channels out of the same page, and you get both:

- **The model gets text.** The numbered outline above, and the page's readable
  prose. No pixels.
- **You get video.** Chrome's own screencast, frame by frame over the session
  socket, at six frames a second by default.

The pointer is real. Before a click, it travels to the target and a ring plays
where it lands — drawn into the page inside a shadow root so the page cannot
restyle it and it never appears in what the agent reads — and then the click is
dispatched as an ordinary mouse event at those coordinates. The agent is not
miming for the camera; it is clicking there, and the camera is pointed at it.

The feed is deliberately not part of the record. Frames go out over the socket
and are never written to the event log: a browsing session would otherwise be a
video file in the transcript, replayed in full to every tab that reconnects.
What the log keeps is keyframes — one after each navigation and each action —
which is what the card shows once the page has moved on. The card says
**watching** while frames are arriving and **back to live** once you have
scrolled back through them.

Nothing is encoded while nobody is looking: the stream stops when the last tab
closes and a fresh tab is handed one frame immediately, because a page sitting
still emits none of its own.

| | |
|---|---|
| `open <url>` | Go there. |
| `click(ref)` | Click the numbered element, visibly. |
| `fill([{ref, text}], submit)` | A whole form in one round trip. |
| `scroll(dy)` · `back()` · `read()` | The rest of it. |
| `shot()` | A picture of the page, into the conversation. |

The same calls are on `POST /api/sessions/:id/browser`, so a person can drive
the page too — which is what turns the card from a recording into something you
can take over.

### Pointing at things

Hit **Select** in the browser pane and click an element in the live video.
Describing an element in prose and hoping the agent finds the same one is the
slow way to ask for a change; pointing at it is not.

A pick resolves what you actually meant — click the label inside a button and
you get the button — and comes back with the element's snapshot ref, a stable
selector, and only the styles *that element* sets, not the whole inherited
cascade. Where the framework left a trail (React's dev fiber, a `data-source`
attribute) it resolves to the file and line that rendered it; where it did not,
it says so rather than guessing at a file. The pick is an event like any other,
so it lands in the thread: the agent sees that you pointed and at what.

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

Autora always runs in **yolo mode**: no tool call pauses for approval in chat.
Every call runs straight away and is shown in the thread as it happens; Stop
kills whatever is running. There is no per-group setting for this -- older
settings files that asked for approval are read as "never".

If you want a gate back for your own deployment, it belongs in `needsApproval`
in [`server/tools.ts`](server/tools.ts); the approval card and its plumbing are
still in place and light up as soon as that returns true.

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
emitted as an event, so it is in the thread and in the recording: you can see
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
| `GEMINI_API_KEY` | Google Gemini key — or add one in Settings instead |
| `OPENAI_API_KEY` | OpenAI key |
| `ANTHROPIC_API_KEY` | Anthropic Claude key |
| `DEEPSEEK_API_KEY` | DeepSeek key |
| `OPENROUTER_API_KEY` | OpenRouter key |
| `GEMINI_MODEL` | Starting model for Gemini (default `gemini-flash-latest`, the rolling free-Flash alias); a model chosen in Settings wins |
| `GEMINI_THINKING_BUDGET` | Thinking tokens (default `0` for a responsive console; `-1` lets the model decide) |
| `AUTORA_STATE_DIR` | Where settings, keys and the spend ledger are written (default: `$AUTORA_HOME/settings`, else `.autora/` beside the app) |
| `AUTORA_PORT` / `AUTORA_HOST` | Where to listen (default `3000` on `0.0.0.0`; the container uses `8817`) |
| `AUTORA_LLM_BASE_URL` | Local OpenAI-compatible endpoint |
| `AUTORA_BROWSER_PATH` | The Chromium to drive (default: the usual system paths; `/usr/bin/chromium-browser` in the container) |
| `AUTORA_CONTEXT_TOKENS` | The context window the prompt is kept inside (default `100000`; set it to your model's window for small local models) |
| `AUTORA_COMPACT_AT` | Fraction of that window at which older turns are folded into working memory in the background (default `0.75`) |
| `AUTORA_PROTECTED_TURNS` | Most recent messages that are never summarised (default `6`) |
| `AUTORA_MAX_TOOL_TOKENS` | Tool output longer than this is kept in the session vault, with its start and end left in the prompt (default `3000`) |
| `AUTORA_COMPACTION_MODEL` | A cheaper model of the same provider to write the working memory with (default: the chat model) |
| `AUTORA_MAX_OUTPUT_TOKENS` | Output tokens the model may write per step of a task (default: 8192) |
| `TYPESAFE_API_KEY` | A key for the hosted Jev API, used by Jev Mode instead of the chat model. `JEV_API_KEY`, `JEV_TOKEN`, `JEV_KEY` and `TYPESAFE_TOKEN` work too, as environment variables or saved in Settings → Secrets (also settable in Settings → Jev Mode) |
| `AUTORA_BROWSER_HEADED` | `1` shows a real browser window instead of running headless |
| `AUTORA_BROWSER_FPS` / `AUTORA_BROWSER_QUALITY` / `AUTORA_BROWSER_STREAM_WIDTH` | How much live video to send (default `6` fps, quality `50`, scaled to `960` wide) |
| `AUTORA_HOME` | State directory (default `~/.autora`; `/data` in the container) — the one place that survives an update |

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
