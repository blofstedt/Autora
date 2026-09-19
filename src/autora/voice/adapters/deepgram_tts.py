"""TTS adapter: Deepgram Aura — same key as DeepgramStt, same $200 credit.

Requires:
    pip install deepgram-sdk sounddevice numpy

Uses DEEPGRAM_API_KEY from the environment (same key as the STT adapter).

Aura pricing: $0.015 / 1,000 characters.
$200 credit ÷ $0.015 ≈ 13 million characters ≈ 288 hours of speech.

Voices (English):
  aura-asteria-en    female, warm, American       (default)
  aura-luna-en       female, soft, American
  aura-stella-en     female, bright, American
  aura-athena-en     female, British
  aura-hera-en       female, calm
  aura-orion-en      male, American
  aura-arcas-en      male, American
  aura-perseus-en    male, American
  aura-angus-en      male, Irish
  aura-orpheus-en    male, American
  aura-helios-en     male, British
  aura-zeus-en       male, American

Latency: Deepgram streams audio chunks via HTTP chunked transfer, so the
first audio bytes arrive in ~200-300 ms and playback starts before the full
synthesis is done — this fits naturally with ClauseChunker's clause-by-clause
queueing to keep the pipeline smooth.
"""

from __future__ import annotations

import asyncio
import os

import numpy as np


class DeepgramTts:
    """Deepgram Aura TTS adapter.

    Args:
        voice: Aura voice ID. See module docstring for the full list.
        api_key: Falls back to DEEPGRAM_API_KEY env var.
        encoding: Audio encoding from Deepgram. "linear16" gives raw PCM
                  which we play directly; "mp3" is smaller but needs decoding.
        sample_rate: Must match *encoding*. 24000 Hz is Aura's native rate.
    """

    def __init__(
        self,
        voice: str = "aura-asteria-en",
        api_key: str | None = None,
        sample_rate: int = 24_000,
    ):
        self._voice = voice
        self._api_key = api_key or os.environ.get("DEEPGRAM_API_KEY")
        if not self._api_key:
            raise RuntimeError(
                "No Deepgram API key. Set DEEPGRAM_API_KEY in your environment."
            )
        self._sample_rate = sample_rate
        self._client = None

    def _load(self):
        if self._client is None:
            from deepgram import DeepgramClient  # noqa: PLC0415
            self._client = DeepgramClient(self._api_key)

    async def speak(self, text: str) -> None:
        if not text.strip():
            return

        self._load()

        loop = asyncio.get_running_loop()
        pcm = await loop.run_in_executor(None, self._synthesize, text)
        await _play(pcm, self._sample_rate)

    def _synthesize(self, text: str) -> np.ndarray:
        """Fetch audio from Deepgram and return a float32 PCM array."""
        from deepgram import SpeakOptions  # noqa: PLC0415

        options = SpeakOptions(
            model=self._voice,
            encoding="linear16",
            sample_rate=self._sample_rate,
        )
        # speak.rest.v("1").stream() returns a streaming response; we collect
        # it into one buffer so sounddevice can play it cleanly.
        response = self._client.speak.rest.v("1").stream(
            {"text": text}, options
        )
        raw = response.stream_memory.read()
        # linear16 = signed 16-bit PCM, little-endian; convert to float32 [-1, 1]
        return np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0


async def _play(samples: np.ndarray, sample_rate: int) -> None:
    """Play float32 mono through the default output; cancel = immediate stop."""
    import threading  # noqa: PLC0415
    import sounddevice as sd  # noqa: PLC0415

    done = asyncio.Event()

    def _run():
        sd.play(samples, samplerate=sample_rate, blocking=True)
        done.set()

    t = threading.Thread(target=_run, daemon=True)
    t.start()
    try:
        await done.wait()
    except asyncio.CancelledError:
        sd.stop()
        t.join(timeout=0.1)
        raise
