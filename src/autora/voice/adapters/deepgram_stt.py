"""STT adapter: Deepgram Nova-2 streaming via WebSocket.

Requires:
    pip install deepgram-sdk sounddevice numpy

Set DEEPGRAM_API_KEY in your environment (never in code).

Why Deepgram over local Whisper:
  * True streaming — partial transcripts arrive word by word, not after silence.
    Barge-in fires the instant you start talking, not 800ms later.
  * Nova-2 accuracy beats faster-whisper base.en on conversational speech.
  * $0.0059/min means $200 credit ≈ 560 hours. Effectively unlimited.
  * Zero local disk (no 150 MB model download) and zero CPU load on the host.

The one downside: requires an internet connection. For fully offline use,
FasterWhisperStt is the right fallback.
"""

from __future__ import annotations

import asyncio
import os
import queue
import threading
from collections.abc import AsyncIterator

import numpy as np

from ..engine import Transcript

_RATE = 16_000
_CHUNK = 3_200   # 200 ms — Deepgram's recommended minimum frame size


class DeepgramStt:
    """Real-time STT via Deepgram Nova-2 WebSocket streaming.

    Partials arrive word by word; finals arrive on end-of-speech detection.
    The VoiceLoop calls stop_speaking() + agent.interrupt() on the first
    partial, so barge-in is immediate even before the sentence is finished.

    Args:
        api_key: Falls back to DEEPGRAM_API_KEY env var.
        model: Deepgram model name. "nova-2" is the best balance of speed
               and accuracy. "nova-2-conversational" is tuned for chat.
        language: BCP-47 code.  "en-US" (default) or None for auto-detect.
        interim_results: Emit partials (default True). Set False if you only
                         want final transcripts and don't need barge-in.
        endpointing: Milliseconds of silence before Deepgram sends a final.
                     300 ms (default) is a good tradeoff for conversation.
    """

    def __init__(
        self,
        api_key: str | None = None,
        model: str = "nova-2",
        language: str = "en-US",
        interim_results: bool = True,
        endpointing: int = 300,
    ):
        self._api_key = api_key or os.environ.get("DEEPGRAM_API_KEY")
        if not self._api_key:
            raise RuntimeError(
                "No Deepgram API key. Set DEEPGRAM_API_KEY in your environment."
            )
        self._model = model
        self._language = language
        self._interim_results = interim_results
        self._endpointing = endpointing

    async def listen(self) -> AsyncIterator[Transcript]:  # type: ignore[override]
        from deepgram import (  # noqa: PLC0415
            DeepgramClient,
            LiveOptions,
            LiveTranscriptionEvents,
            Microphone,
        )

        client = DeepgramClient(self._api_key)
        connection = client.listen.asyncwebsocket.v("1")

        send: asyncio.Queue[Transcript] = asyncio.Queue()
        loop = asyncio.get_running_loop()

        async def _on_message(self_inner, result, **kwargs):
            alt = result.channel.alternatives[0]
            text = alt.transcript.strip()
            if not text:
                return
            is_final = result.is_final
            # speech_final means Deepgram's endpointing decided this utterance
            # is done. is_final=True but speech_final=False means the transcript
            # for this word window is stable but the utterance continues.
            speech_final = getattr(result, "speech_final", False)
            loop.call_soon_threadsafe(
                send.put_nowait,
                Transcript(
                    text=text,
                    final=speech_final,
                    confidence=alt.confidence if hasattr(alt, "confidence") else 1.0,
                ),
            )

        async def _on_error(self_inner, error, **kwargs):
            loop.call_soon_threadsafe(
                send.put_nowait,
                _SentinelError(str(error)),
            )

        connection.on(LiveTranscriptionEvents.Transcript, _on_message)
        connection.on(LiveTranscriptionEvents.Error, _on_error)

        options = LiveOptions(
            model=self._model,
            language=self._language,
            smart_format=True,        # punctuation, numbers, dates
            interim_results=self._interim_results,
            utterance_end_ms=str(self._endpointing),
            vad_events=True,          # SpeechStarted event for earliest barge-in
            endpointing=str(self._endpointing),
            encoding="linear16",
            sample_rate=_RATE,
            channels=1,
        )

        await connection.start(options)

        mic = Microphone(connection.send, rate=_RATE, chunk=_CHUNK)
        mic.start()

        try:
            while True:
                item = await send.get()
                if isinstance(item, _SentinelError):
                    raise RuntimeError(f"Deepgram error: {item.msg}")
                yield item
        finally:
            mic.finish()
            await connection.finish()


class _SentinelError:
    def __init__(self, msg: str):
        self.msg = msg
