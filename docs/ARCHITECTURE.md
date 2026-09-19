# Architecture, and why it differs from the Gemini blueprint

## The premise

The complaint that started this was: *"Hermes is cool, but technical, and I hate
how you can't SEE what it's doing in real time."*

That sentence is a transparency requirement, not a latency requirement. The
Gemini blueprint spends nearly all of its complexity budget on shaving
milliseconds off voice round-trips, and gives the seeing part one line:

> Send the terminal output (via WebSockets) back to your Tauri overlay.

So the priorities here are inverted. The observability layer is the product; the
agent loop is a consumer of it; voice is a client of it. Everything below follows
from that.

---

## The central decision: one event log

Every observable act funnels through `Session.emit`. No `print`, no direct
socket write, no side channel. The event is persisted **before** it is published.

That ordering is load-bearing. Because nothing is broadcast that isn't already
on disk, a client can always reconnect with "I last saw seq N" and be brought
back to exactness. Which in turn means:

- **Live and replay are one code path.** The UI's `derive(events, cursor)` is a
  pure fold over an event prefix. Scrubbing to step 12 reproduces step 12
  exactly, because there is no second renderer to drift.
- **Recording is free.** It is not a feature; it is what already happened.
- **Backpressure becomes safe.** The bus is allowed to be lossy under load
  precisely because the log is not (see below).
- **Debugging is `tail -f`.** JSONL, not SQLite, because the log is the primary
  artifact and should be readable by a human at 3am with `grep`.

Frames are the exception to "everything in the log": a 10-minute browser session
is thousands of JPEGs. Those go to a content-addressed blob store and the event
carries a 64-char hash. Content addressing dedupes identical frames for free,
which matters more than it sounds — an agent waiting on a page emits dozens of
byte-identical frames. In the end-to-end test, 30 captured frames deduped to 5
stored blobs.

## Backpressure, which the blueprint has none of

`self.audio_buffer.extend(...)` with no bound, and a websocket send per frame, is
fine on localhost and falls over the moment anything is slow. The naive fixes
are both wrong: unbounded queues grow until the process dies, and drop-oldest
silently loses tool results, which makes the record a lie.

Autora's policy is per-kind, because the kinds differ semantically:

- **Frames are coalesced** — one slot per stream, newest wins. A slow viewer
  sees a lower frame rate, which is the correct degradation for video, and never
  falls behind.
- **Everything else is lossless.** If a subscriber can't keep up, it is
  disconnected with a resumable seq rather than fed a corrupted stream. It
  reconnects and replays from the log.

## One agent loop, not two

The blueprint runs Open Interpreter for shell and Browser Use for the web. That
is two agent loops, two conversation histories, two tool vocabularies, no shared
timeline. The first task that spans both — *"find why the deploy broke, then
check the staging site"* — has no coherent transcript and nothing to replay.

Here, every capability is a tool in one registry driven by one loop emitting to
one log. The composition problem disappears, and a new tool is narrated, logged,
gated and replayed without touching any of those systems.

## The permission gate exists before the fun part

A voice agent with shell access and production credentials needs a gate on day
one. Speech recognition misfires; "push to staging" and "push to stage" differ
by a phoneme. The blueprint pipes model output straight into
`{"tool":"bash","command":"supabase db push"}` and executes it.

Three decisions — ALLOW (record it), ASK (suspend, show the exact command, wait
for a human), DENY (refuse and explain, so the model routes around instead of
retrying). Ordering matters: DENY rules are evaluated first so a later ALLOW
can't shadow a hard stop, and `--yes` bypasses ASK but never DENY.

Two things this shook out that are worth knowing:

- **Prefix-anchored allowlists leak.** `cat README.md` is read-only;
  `cat README.md && ./malware` matches the same prefix. The allow rule requires
  the command to contain no `; & | > \` $()` — a chained command is not a
  read-only command.
- **Redaction belongs at the boundary.** Tool args are scrubbed before they
  reach the log, not after. The log is the thing you share when showing off a
  recording; it must not carry the token that was on the command line. The
  browser tool detects password fields from the DOM rather than trusting the
  model to flag them — a leaked password in a shareable recording is not
  recoverable.

## Barge-in is a cancellation problem, not an audio problem

The first implementation polled a cancel flag between tool yields. A tool
blocked in `process.wait()` yields nothing to poll between, so interrupting
`sleep 30` took 30 seconds. Polling cannot preempt a blocking await.

The fix races the work against the cancel event and actively cancels the task,
which propagates `CancelledError` into the tool and lets it kill its child
process group on the way out. Measured: **1ms** from `interrupt()` to turn end,
with no orphaned processes.

(A related bug worth recording: the TTS worker caught `CancelledError` to handle
barge-in and never re-raised, making the worker itself impossible to shut down.
Catching cancellation requires deciding whose cancellation it was.)

## Why voice quality is not a TTS problem

Kokoro at 82M is perfectly pleasant. Agent voice is unbearable for other
reasons, roughly in this order:

1. **It reads code, paths, JSON and hashes aloud.** Nothing breaks the spell
   faster than "slash home slash user slash dot config slash app dot t s x".
2. **It can't be interrupted**, so correcting it means waiting it out.
3. **It goes silent for the 90 seconds a tool runs**, and thinking is
   indistinguishable from crashed.
4. **It waits for the full response before speaking**, adding latency no vocoder
   wins back.

`voice/narration.py` fixes 1, 3 and 4; the loop's cancellation fixes 2. Swapping
the TTS model is the *last* thing to try.

One concrete detail: the blueprint flushes TTS on any `.` or `,`, which splits
`3.5` and `e.g.` mid-token and produces stuttering. The chunker emits at genuine
sentence boundaries, with an abbreviation and decimal guard, falling back to soft
boundaries only once a split would be less noticeable than the wait.

Voice approvals fail safe: anything ambiguous is a no, and negatives are checked
before affirmatives, so "yes — no, wait" denies.

## On "iterative buffer prefilling"

The blueprint's centerpiece: re-transcribe a growing audio buffer while the user
speaks, and fire throwaway 1-token requests to warm the model's KV cache. It's a
clever idea that doesn't survive the details.

- SenseVoice is **non-autoregressive** — it transcribes the whole clip at once
  and *revises earlier words* as it gets more context. Prefix caching needs a
  byte-identical prefix. Revise token three and the GPU pass you just spent is
  discarded.
- The cacheable prefix is the **system prompt and tool schemas**, which sit
  *before* the user text. With a screenshot attached, image tokens sit in front
  too. The user's half-sentence is the least cacheable part of the prompt.
- Every speculative prefill **occupies the GPU the real request needs** and
  evicts blocks from the cache it's trying to warm.

The version that pays off is caching the static prefix — identical on every turn,
never invalidated by a re-transcribe, one flag on the request. That is what the
Anthropic adapter does with `cache_control`. Measure time-to-first-token before
building anything more elaborate; on a warm local model the bottleneck is
usually TTS, not the LLM.

## On the model choice

`Qwen 3.8 27B (Q4_K_M)` served by vLLM, in the blueprint, is not a thing that
exists. Qwen3 ships 30B-A3B / 32B / 235B-A22B; `Q4_K_M` is a llama.cpp GGUF
quantization that vLLM does not load (it wants AWQ/GPTQ/FP8). You'd be blocked
before the first token.

More usefully: model choice is the thing you'll change most often, and it's
entangled with tool-call dialects, streaming shapes and vision payloads. So it's
an interface, and the harness holds no vendor types. Two adapters ship —
Anthropic, and any OpenAI-compatible endpoint (vLLM, Ollama, llama.cpp, LM
Studio), so a local Qwen is a config change.

The honest caveat: local 27–32B models are markedly worse at *multi-step* tool
calling than frontier hosted ones — not at producing one well-formed call, but at
**recovering** when a selector misses or a build fails, which is most of what an
agent session actually is. Consider routing by task: local for transcription and
classification, hosted for the planning loop.

## Web UI, not a Tauri overlay

For v1: zero install, reachable from a phone, and the same surface as replay.
Tauri makes sense later for an always-on desktop overlay, but it's a distribution
choice, not an architecture one — it would consume the same websocket.

## Choices I'd revisit

- **Sequential tool execution.** Parallel calls would be faster, but watching two
  things happen at once is much harder to follow, and legibility is the point.
- **Fold-from-zero in the UI.** O(n) per scrub keeps it honest with no
  incremental cache to get subtly wrong. Fine to tens of thousands of events;
  past that, memoize on checkpoints.
- **Desktop control** is specified but unimplemented. The right shape is a
  containerized desktop (Xvfb + WebRTC, neko-style) so the UI can embed a live
  desktop you can also *take over* — human takeover being the thing Hermes most
  conspicuously lacks.
- **The policy default is ASK**, which will annoy you. That is the correct
  starting point; loosen per project once you trust it.
