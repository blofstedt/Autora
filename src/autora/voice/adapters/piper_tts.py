"""TTS adapter: Piper — fastest CPU TTS, 5-10× realtime on any modern CPU.

Requires:
    pip install piper-tts sounddevice numpy

Voice models download from Hugging Face on first use.  They are stored in
~/.local/share/piper-tts/ by default.

Recommended voices (English):
  en_US-lessac-medium     female, clear, 65 MB   (default)
  en_US-ryan-medium       male,   clear, 63 MB
  en_GB-alan-medium       male,   British, 60 MB
  en_US-amy-medium        female, warm, 63 MB

Full list: https://huggingface.co/rhasspy/piper-voices

Piper is the right choice if Kokoro feels too slow on your hardware. The
voice is a little less natural but you will never hear glitches or
under-runs, which matters more during a running tool narration.
"""

from __future__ import annotations

import asyncio
import io
import threading
import wave
from pathlib import Path

import numpy as np


class PiperTts:
    """Piper TTS adapter.

    Args:
        voice: Piper voice name.  See module docstring.
        data_dir: Where to store downloaded models.  Defaults to the piper-tts
            package's default (~/.local/share/piper-tts/).
        length_scale: Speed control.  1.0 = normal, 1.2 = slower, 0.85 = faster.
    """

    def __init__(
        self,
        voice: str = "en_US-lessac-medium",
        data_dir: str | Path | None = None,
        length_scale: float = 1.0,
    ):
        self._voice_name = voice
        self._data_dir = Path(data_dir) if data_dir else None
        self._length_scale = length_scale
        self._voice = None   # lazy-load

    def _load(self):
        if self._voice is None:
            from piper.voice import PiperVoice  # noqa: PLC0415
            from piper.download import ensure_voice_exists, find_voice, get_voices  # noqa: PLC0415

            data_dir = self._data_dir or (
                Path.home() / ".local" / "share" / "piper-tts"
            )
            data_dir.mkdir(parents=True, exist_ok=True)

            voices_info = get_voices(str(data_dir), update_voices=False)
            try:
                model_path, config_path = find_voice(self._voice_name, [str(data_dir)])
            except ValueError:
                # Not downloaded yet
                ensure_voice_exists(self._voice_name, [str(data_dir)], str(data_dir), voices_info)
                model_path, config_path = find_voice(self._voice_name, [str(data_dir)])

            self._voice = PiperVoice.load(model_path, config_path=config_path, use_cuda=False)

    async def speak(self, text: str) -> None:
        if not text.strip():
            return

        self._load()

        loop = asyncio.get_running_loop()
        pcm_bytes, sample_rate = await loop.run_in_executor(None, self._synthesize, text)

        # Convert WAV bytes (piper always returns WAV) to float32 numpy array
        with io.BytesIO(pcm_bytes) as buf:
            with wave.open(buf) as wf:
                raw = wf.readframes(wf.getnframes())
                sr = wf.getframerate()

        samples = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0

        from .kokoro_tts import _play  # shared playback helper
        await _play(samples, sr)

    def _synthesize(self, text: str) -> tuple[bytes, int]:
        """Returns (wav_bytes, sample_rate) — runs in a thread pool."""
        buf = io.BytesIO()
        with wave.open(buf, "wb") as wf:
            self._voice.synthesize(
                text,
                wf,
                length_scale=self._length_scale,
            )
        return buf.getvalue(), self._voice.config.sample_rate
