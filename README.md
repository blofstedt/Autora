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
| **Browser** | Live CDP screencast, with a marker painted at each click so you can see the agent miss. |
| **Files** | Every edit as a unified diff, the moment it lands. |
| **Transcript** | What the agent said, with reasoning collapsed by default. |

The scrubber works during a live session. Scroll back to step 12 while the agent
is on step 40; "jump to now" returns you to the head.

## Approvals

Reads run freely. Deploys, migrations, history rewrites and installs pause and
ask, showing the exact rendered command. A few things (piping curl into a shell,
`rm -rf /`, force-pushing to main, reading private keys) are refused outright and
cannot be approved — including under `--yes`.

Rules live in `src/autora/policy.py` as readable patterns. Loosen them per
project once you trust it. `--yes` skips confirmations entirely; don't point that
at production credentials.

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
browser screencast, agent loop, transport, web UI, replay, narration.

Interfaces defined, adapters not shipped: speech-to-text and text-to-speech
(`src/autora/voice/engine.py`), desktop control. The voice *logic* — barge-in,
what to say aloud, voice approvals — is implemented and tested against fakes;
plugging in Whisper/Kokoro is a small adapter each.

```bash
python3 tests/run_all.py
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for why it is built this way.
