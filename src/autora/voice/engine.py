"""Voice I/O: protocols, and the loop that makes speech interruptible.

No model is shipped here. STT and TTS are interfaces, because the right choice
depends on hardware you have and I do not, and because this is the layer people
most want to swap. Adapters are a dozen lines each; the value is in the loop.

On Gemini's "iterative buffer prefilling" -- re-transcribing a growing audio
buffer to warm the model's KV cache while you are still talking. It is a clever
idea that does not survive contact with the details:

  * SenseVoice is non-autoregressive and transcribes the whole clip at once, so
    a later pass can and does revise *earlier* words once it has more context.
    Prefix caching requires a byte-identical prefix. Revise token three and the
    cache you spent a GPU pass building is discarded.
  * The cached prefix has to include the system prompt and tool definitions,
    which sit *before* the user text. With a screenshot attached, image tokens
    sit in front too. The user's half-sentence is the least cacheable part of
    the prompt.
  * Every speculative prefill occupies the same GPU the real request needs, and
    evicts blocks from the very cache it is trying to warm.

The version that does pay off is caching the static prefix -- system prompt plus
tool schemas -- which is identical on every turn of a session, is never
invalidated by a re-transcribe, and is one flag on the request. That is what the
Anthropic adapter does. Measure your actual time-to-first-token before building
anything more elaborate: on a warm local model it is usually the TTS that is
the bottleneck, not the LLM.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import AsyncIterator, Awaitable, Callable, Protocol, runtime_checkable

from ..events import Kind
from .narration import ClauseChunker, interpret_decision, narrate_approval, narrate_tool


@dataclass
class Transcript:
    text: str
    final: bool
    confidence: float = 1.0
    #: SenseVoice-style tags, when the model provides them. Nice to have; do not
    #: build behavior on them, since accuracy on real speech is uneven.
    emotion: str | None = None


@runtime_checkable
class SttProvider(Protocol):
    async def listen(self) -> AsyncIterator[Transcript]:
        """Yield partial transcripts, then a final one per utterance."""
        ...


@runtime_checkable
class TtsProvider(Protocol):
    async def speak(self, text: str) -> None:
        """Synthesize and play. Must return promptly when cancelled."""
        ...


class VoiceLoop:
    """Couples speech in and out to the agent, with barge-in.

    The rule that matters: the moment the human starts speaking, stop talking.
    Not at the end of the current sentence -- immediately. Everything else about
    a voice agent can be mediocre and it will still feel good if interruption is
    instant, and nothing else can compensate if it is not.
    """

    def __init__(self, session, agent, stt: SttProvider, tts: TtsProvider):
        self.session = session
        self.agent = agent
        self.stt = stt
        self.tts = tts
        self._speaking: asyncio.Task | None = None
        self._queue: asyncio.Queue[str] = asyncio.Queue()
        self._pending_approval: str | None = None
        #: Set by stop_speaking() so the worker can tell a cancelled *utterance*
        #: (barge-in: keep serving the queue) from a cancelled *worker*
        #: (shutdown: stop). Without this the worker swallows its own
        #: cancellation and becomes impossible to shut down.
        self._barge_in = False

    # -- speaking --------------------------------------------------------

    async def say(self, text: str) -> None:
        """Queue a line to be spoken."""
        if text.strip():
            await self._queue.put(text)

    async def _speech_worker(self) -> None:
        while True:
            line = await self._queue.get()
            self._speaking = asyncio.create_task(self.tts.speak(line))
            self.session.emit(Kind.TTS_SPEAKING, {"text": line}, actor="agent")
            try:
                await self._speaking
            except asyncio.CancelledError:
                self.session.emit(Kind.TTS_INTERRUPTED, {"text": line}, actor="user")
                if not self._barge_in:
                    # The worker itself is being shut down -- propagate, or this
                    # loop never exits.
                    raise
                self._barge_in = False
            finally:
                self._speaking = None

    def stop_speaking(self) -> None:
        """Cut off mid-word and drop anything queued behind it."""
        if self._speaking is not None and not self._speaking.done():
            self._barge_in = True
            self._speaking.cancel()
        while not self._queue.empty():
            try:
                self._queue.get_nowait()
            except asyncio.QueueEmpty:
                break

    # -- listening -------------------------------------------------------

    async def run(self) -> None:
        worker = asyncio.create_task(self._speech_worker())
        try:
            async for transcript in self.stt.listen():
                if not transcript.final:
                    # The human has started talking. Yield the floor before we
                    # even know what they said -- waiting for a final transcript
                    # means talking over them for another second.
                    if transcript.text.strip():
                        self.stop_speaking()
                        self.agent.interrupt()
                        self.session.emit(Kind.STT_PARTIAL, {"text": transcript.text},
                                          actor="user")
                    continue

                self.session.emit(Kind.STT_FINAL, {
                    "text": transcript.text, "emotion": transcript.emotion,
                }, actor="user")
                await self._handle(transcript.text)
        finally:
            worker.cancel()

    async def _handle(self, text: str) -> None:
        # An outstanding approval takes priority: "yes" means the deploy, not a
        # new instruction.
        if self._pending_approval is not None:
            decision = interpret_decision(text)
            if decision is None:
                await self.say("Sorry, was that a yes or a no?")
                return
            self.agent.gate.resolve(self._pending_approval, decision, "voice")
            self._pending_approval = None
            await self.say("Okay." if decision else "Leaving it alone.")
            return

        await self.speak_turn(text)

    async def speak_turn(self, text: str) -> None:
        """Run a turn, narrating it as it streams."""
        chunker = ClauseChunker()
        subscriber = self.session.bus.subscribe(_NarrationSubscriber(self, chunker))
        try:
            await self.agent.run_turn(text)
        finally:
            self.session.bus.unsubscribe(subscriber)
            for clause in chunker.flush():
                await self.say(clause)

    def on_approval(self, request_id: str, reason: str) -> None:
        self._pending_approval = request_id
        asyncio.create_task(self.say(narrate_approval(reason)))


class _NarrationSubscriber:
    """Turns the event stream into speech.

    Subscribing to the same event bus the UI uses, rather than tapping the model
    stream directly, means voice cannot drift from what is on screen -- and any
    tool added later is narrated without touching this file.
    """

    def __init__(self, loop: VoiceLoop, chunker: ClauseChunker):
        self.loop = loop
        self.chunker = chunker
        self.overflowed = False
        self.last_seq = -1

    def offer(self, event) -> None:
        if event.kind == Kind.AGENT_TEXT:
            for clause in self.chunker.feed(event.payload.get("text", "")):
                asyncio.create_task(self.loop.say(clause))
        elif event.kind == Kind.TOOL_CALL:
            # Flush buffered prose first so narration stays in order with the
            # action it describes.
            for clause in self.chunker.flush():
                asyncio.create_task(self.loop.say(clause))
            asyncio.create_task(self.loop.say(
                narrate_tool(event.payload.get("name", ""), event.payload.get("args", {}))))
        elif event.kind == Kind.POLICY_REQUEST:
            self.loop.on_approval(event.payload.get("request_id", ""),
                                  event.payload.get("reason", ""))
        # Thinking deltas are deliberately never spoken.

    def close(self) -> None:
        pass
