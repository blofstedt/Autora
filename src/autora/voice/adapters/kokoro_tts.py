"""TTS adapter: Kokoro 82M via ONNX runtime.

Requires:
    pip install kokoro-onnx sounddevice numpy

The ONNX build runs ~1-2× realtime on an Intel N95 without a GPU. Our
ClauseChunker streams text clause by clause, so the next clause synthesizes
while the current one plays, keeping the pipeline smooth even at 1× realtime.

Models download on first use to ~/.kokoro/:
  kokoro-v0_19.onnx  ~87 MB
  voices.bin         ~10 MB

Voices (English):
  af        — female, neutral American       (default)
  af_bella  — female, warm
  af_sarah  — female, bright
  am_adam   — male, neutral American
  am_michael — male, deeper
  bf_emma   — female, British
  bm_george — male, British
"""

from __future__ import annotations

import asyncio
import threading
from pathlib import Path

import numpy as np


class KokoroTts:
    """Kokoro-82M TTS via ONNX.

    Args:
        voice: Kokoro voice ID.  See module docstring for the full list.
        speed: Speech rate multiplier.  0.8–1.2 is a good range.
        sample_rate: Output sample rate.  24000 Hz is Kokoro's native rate.
    """

    def __init__(
        self,
        voice: str = "af",
        speed: float = 1.0,
        sample_rate: int = 24_000,
    ):
        self._voice = voice
        self._speed = speed
        self._sample_rate = sample_rate
        self._kokoro = None   # lazy-load

    def _load(self):
        if self._kokoro is None:
            from kokoro_onnx import Kokoro  # noqa: PLC0415
            # kokoro-onnx downloads to ~/.kokoro on first call
            self._kokoro = Kokoro("kokoro-v0_19.onnx", "voices.bin")

    async def speak(self, text: str) -> None:
        """Synthesize *text* and play it; returns when audio finishes or is cancelled."""
        if not text.strip():
            return

        self._load()

        # Synthesis is CPU-bound — run in a thread so we don't block the event loop.
        loop = asyncio.get_running_loop()
        samples, sr = await loop.run_in_executor(
            None,
            self._synthesize,
            text,
        )

        await _play(samples, sr)

    def _synthesize(self, text: str):
        import asyncio as _asyncio  # noqa: PLC0415
        # run_in_executor can't call async functions; kokoro.create() is async,
        # so we spin a tiny event loop for it.
        async def _inner():
            return await self._kokoro.create(
                text,
                voice=self._voice,
                speed=self._speed,
                lang="en-us",
            )
        return _asyncio.run(_inner())


# ── Piper TTS adapter ────────────────────────────────────────────────────────
# (Imported from piper_tts.py; kept here for cross-reference.)


# ── shared audio playback helper ─────────────────────────────────────────────

async def _play(samples: np.ndarray, sample_rate: int) -> None:
    """Play a float32 mono array through the default output device.

    Runs in a thread so cancellation (barge-in) immediately stops playback.
    sounddevice.play() is itself blocking; wrapping it in a Task lets
    asyncio.CancelledError interrupt it cleanly.
    """
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
        sd.stop()      # immediate hardware stop
        t.join(timeout=0.1)
        raise
