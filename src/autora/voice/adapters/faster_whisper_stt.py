"""STT adapter: faster-whisper with CPU int8 quantization.

Requires:
    pip install faster-whisper sounddevice numpy

Models download on first use to ~/.cache/huggingface/hub/:
  tiny.en   ~40 MB   ~15× realtime on N95   usable but noticeably error-prone
  base.en   ~150 MB   ~6× realtime on N95   recommended
  small.en  ~490 MB   ~2× realtime on N95   slightly better, same ballpark
"""

from __future__ import annotations

import asyncio
import io
import queue
import threading
import wave
from collections.abc import AsyncIterator
from typing import TYPE_CHECKING

import numpy as np

from ..engine import Transcript

if TYPE_CHECKING:
    pass

# ── audio constants ──────────────────────────────────────────────────────────
_RATE = 16_000          # Whisper is trained at 16 kHz; resampling elsewhere adds latency
_CHUNK = 1_600          # 100 ms chunks — good VAD resolution without callback overhead
_VAD_RMS_THRESHOLD = 0.01    # fraction of full scale; tune for your mic noise floor
_SILENCE_CHUNKS = 8          # 800 ms of silence → end of utterance
_PARTIAL_EVERY_CHUNKS = 15   # partial transcript every 1.5 s of continuous speech


class FasterWhisperStt:
    """CPU-efficient STT using faster-whisper.

    Args:
        model_size: "tiny.en", "base.en" (default), or "small.en".
        device: "cpu" (default) or "cuda" if you have a GPU.
        compute_type: "int8" (default, fastest on CPU) or "float16".
    """

    def __init__(
        self,
        model_size: str = "base.en",
        device: str = "cpu",
        compute_type: str = "int8",
    ):
        self._model_size = model_size
        self._device = device
        self._compute_type = compute_type
        self._model = None   # lazy-load so import cost is paid at listen() time

    def _load(self):
        if self._model is None:
            from faster_whisper import WhisperModel  # noqa: PLC0415
            self._model = WhisperModel(
                self._model_size,
                device=self._device,
                compute_type=self._compute_type,
            )

    def _transcribe(self, pcm: np.ndarray) -> str:
        """Run faster-whisper on a float32 mono array at 16 kHz."""
        # faster-whisper accepts a numpy array directly
        segments, _ = self._model.transcribe(
            pcm,
            language="en",
            vad_filter=True,          # built-in Silero VAD — removes silence tokens
            vad_parameters={"min_silence_duration_ms": 300},
        )
        return " ".join(s.text.strip() for s in segments).strip()

    async def listen(self) -> AsyncIterator[Transcript]:  # type: ignore[override]
        import sounddevice as sd  # noqa: PLC0415

        self._load()

        audio_queue: queue.Queue[np.ndarray | None] = queue.Queue()

        def _callback(indata: np.ndarray, frames: int, time, status):
            # sounddevice delivers float32 already; copy so the buffer is ours
            audio_queue.put(indata[:, 0].copy())

        stream = sd.InputStream(
            samplerate=_RATE,
            channels=1,
            dtype="float32",
            blocksize=_CHUNK,
            callback=_callback,
        )

        loop = asyncio.get_running_loop()
        send, recv = asyncio.Queue(), asyncio.Queue()

        def _reader_thread():
            speech_buf: list[np.ndarray] = []
            silence_count = 0
            chunk_count = 0

            while True:
                chunk = audio_queue.get()
                if chunk is None:
                    break

                rms = float(np.sqrt(np.mean(chunk ** 2)))
                is_speech = rms > _VAD_RMS_THRESHOLD

                if is_speech:
                    silence_count = 0
                    speech_buf.append(chunk)
                    chunk_count += 1

                    # emit a partial every N chunks so the UI shows activity
                    if chunk_count % _PARTIAL_EVERY_CHUNKS == 0 and len(speech_buf) > 5:
                        pcm = np.concatenate(speech_buf)
                        text = self._transcribe(pcm)
                        if text:
                            loop.call_soon_threadsafe(
                                send.put_nowait,
                                Transcript(text=text, final=False),
                            )

                elif speech_buf:
                    silence_count += 1
                    speech_buf.append(chunk)   # include trailing silence for context

                    if silence_count >= _SILENCE_CHUNKS:
                        pcm = np.concatenate(speech_buf)
                        text = self._transcribe(pcm)
                        if text:
                            loop.call_soon_threadsafe(
                                send.put_nowait,
                                Transcript(text=text, final=True),
                            )
                        speech_buf.clear()
                        silence_count = 0
                        chunk_count = 0

        with stream:
            t = threading.Thread(target=_reader_thread, daemon=True)
            t.start()
            try:
                while True:
                    transcript = await send.get()
                    yield transcript
            finally:
                audio_queue.put(None)
                t.join(timeout=2)

    # -- convenience for tests -----------------------------------------------

    async def transcribe_file(self, path: str) -> str:
        """One-shot transcription of a wav/mp3/etc. file. Useful for testing."""
        import soundfile as sf  # noqa: PLC0415
        self._load()
        pcm, sr = sf.read(path, dtype="float32", always_2d=False)
        if sr != _RATE:
            # simple but imprecise — install resampy for quality resampling
            import resampy  # noqa: PLC0415
            pcm = resampy.resample(pcm, sr, _RATE)
        return self._transcribe(pcm)
