"""STT adapter: AssemblyAI real-time streaming.

Requires:
    pip install assemblyai sounddevice

Set ASSEMBLYAI_API_KEY in your environment.

Free tier: 100 hours/month. No credit card required to start.
Signup: https://www.assemblyai.com/

AssemblyAI vs Deepgram on this use case:
  * Both deliver streaming partials over WebSocket → same barge-in quality.
  * Deepgram Nova-2 is slightly faster and has better accuracy on accented speech.
  * AssemblyAI's free tier is 100 hrs/month with no spend. If you have a Deepgram
    key, use that. Use this when you want $0.00 and can live with a monthly cap.
"""

from __future__ import annotations

import asyncio
import os
from collections.abc import AsyncIterator

from ..engine import Transcript


class AssemblyAIStt:
    """Real-time STT via AssemblyAI WebSocket streaming.

    Args:
        api_key: Falls back to ASSEMBLYAI_API_KEY env var.
        sample_rate: Must match your microphone. 16000 Hz (default) is standard.
        word_boost: Optional list of words/phrases to boost, e.g. ["autora", "bash"].
    """

    def __init__(
        self,
        api_key: str | None = None,
        sample_rate: int = 16_000,
        word_boost: list[str] | None = None,
    ):
        self._api_key = api_key or os.environ.get("ASSEMBLYAI_API_KEY")
        if not self._api_key:
            raise RuntimeError(
                "No AssemblyAI API key. Set ASSEMBLYAI_API_KEY in your environment."
            )
        self._sample_rate = sample_rate
        self._word_boost = word_boost

    async def listen(self) -> AsyncIterator[Transcript]:  # type: ignore[override]
        import assemblyai as aai  # noqa: PLC0415

        aai.settings.api_key = self._api_key

        loop = asyncio.get_running_loop()
        send: asyncio.Queue[Transcript | Exception] = asyncio.Queue()

        def _on_data(transcript: aai.RealtimeTranscript):
            if not transcript.text:
                return
            is_final = isinstance(transcript, aai.RealtimeFinalTranscript)
            loop.call_soon_threadsafe(
                send.put_nowait,
                Transcript(text=transcript.text.strip(), final=is_final),
            )

        def _on_error(error: aai.RealtimeError):
            loop.call_soon_threadsafe(send.put_nowait, RuntimeError(str(error)))

        kwargs: dict = dict(
            sample_rate=self._sample_rate,
            on_data=_on_data,
            on_error=_on_error,
        )
        if self._word_boost:
            kwargs["word_boost"] = self._word_boost

        transcriber = aai.RealtimeTranscriber(**kwargs)
        transcriber.connect()

        mic = aai.extras.MicrophoneStream(sample_rate=self._sample_rate)

        # Stream microphone in a background thread — the SDK's stream() is blocking
        import threading  # noqa: PLC0415
        stop_event = threading.Event()

        def _stream():
            transcriber.stream(mic)

        t = threading.Thread(target=_stream, daemon=True)
        t.start()

        try:
            while True:
                item = await send.get()
                if isinstance(item, Exception):
                    raise item
                yield item
        finally:
            stop_event.set()
            transcriber.close()
            t.join(timeout=2)
