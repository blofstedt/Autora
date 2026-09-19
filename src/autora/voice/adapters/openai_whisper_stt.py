"""STT adapter: OpenAI Whisper API — zero local storage, $0.006/min.

Requires:
    pip install openai sounddevice numpy

Set OPENAI_API_KEY in your environment.

This adapter is the right choice when:
  * You don't have enough disk or RAM for a local Whisper model.
  * You want the highest accuracy without any setup.
  * You're on a very slow machine where even faster-whisper tiny.en is too slow.

The cost is negligible for personal use: 60 min/day × 30 days = $10.80/month.
AssemblyAI's free tier (100 hrs/month) also works -- swap the transcribe()
call for their API and the rest of this file stays identical.
"""

from __future__ import annotations

import asyncio
import io
import os
import queue
import threading
import wave
from collections.abc import AsyncIterator

import numpy as np

from ..engine import Transcript

_RATE = 16_000
_CHUNK = 1_600          # 100 ms
_VAD_RMS_THRESHOLD = 0.01
_SILENCE_CHUNKS = 8     # 800 ms silence → send utterance
_MAX_DURATION_S = 30    # Whisper API limit; split long utterances


class OpenAIWhisperStt:
    """STT via the OpenAI Whisper transcription endpoint.

    Buffers microphone audio, detects utterance boundaries with a simple
    energy-based VAD, then sends each utterance to the API as a WAV file.
    Final transcripts only -- no partials (the API is not streaming).

    Args:
        model: "whisper-1" is the only transcription model as of 2024.
        language: ISO 639-1 code, e.g. "en".  None = auto-detect.
        api_key: Falls back to OPENAI_API_KEY env var.
    """

    def __init__(
        self,
        model: str = "whisper-1",
        language: str | None = "en",
        api_key: str | None = None,
    ):
        self._model = model
        self._language = language
        self._api_key = api_key or os.environ.get("OPENAI_API_KEY")
        self._client = None

    def _load(self):
        if self._client is None:
            from openai import AsyncOpenAI  # noqa: PLC0415
            self._client = AsyncOpenAI(api_key=self._api_key)

    async def _api_transcribe(self, pcm: np.ndarray) -> str:
        wav_bytes = _pcm_to_wav(pcm)
        kwargs = {"model": self._model, "file": ("audio.wav", wav_bytes, "audio/wav")}
        if self._language:
            kwargs["language"] = self._language
        result = await self._client.audio.transcriptions.create(**kwargs)
        return result.text.strip()

    async def listen(self) -> AsyncIterator[Transcript]:  # type: ignore[override]
        import sounddevice as sd  # noqa: PLC0415

        self._load()

        audio_queue: queue.Queue[np.ndarray | None] = queue.Queue()

        def _callback(indata, frames, time, status):
            audio_queue.put(indata[:, 0].copy())

        stream = sd.InputStream(
            samplerate=_RATE,
            channels=1,
            dtype="float32",
            blocksize=_CHUNK,
            callback=_callback,
        )

        loop = asyncio.get_running_loop()
        send: asyncio.Queue[np.ndarray] = asyncio.Queue()

        def _vad_thread():
            speech_buf: list[np.ndarray] = []
            silence_count = 0

            while True:
                chunk = audio_queue.get()
                if chunk is None:
                    break

                rms = float(np.sqrt(np.mean(chunk ** 2)))
                is_speech = rms > _VAD_RMS_THRESHOLD

                if is_speech:
                    silence_count = 0
                    speech_buf.append(chunk)
                    # safety: split at max duration so we never exceed the API limit
                    if len(speech_buf) * _CHUNK / _RATE >= _MAX_DURATION_S:
                        loop.call_soon_threadsafe(
                            send.put_nowait, np.concatenate(speech_buf)
                        )
                        speech_buf.clear()
                elif speech_buf:
                    silence_count += 1
                    speech_buf.append(chunk)
                    if silence_count >= _SILENCE_CHUNKS:
                        loop.call_soon_threadsafe(
                            send.put_nowait, np.concatenate(speech_buf)
                        )
                        speech_buf.clear()
                        silence_count = 0

        with stream:
            t = threading.Thread(target=_vad_thread, daemon=True)
            t.start()
            try:
                while True:
                    pcm = await send.get()
                    text = await self._api_transcribe(pcm)
                    if text:
                        yield Transcript(text=text, final=True)
            finally:
                audio_queue.put(None)
                t.join(timeout=2)


def _pcm_to_wav(samples: np.ndarray, rate: int = _RATE) -> bytes:
    """Convert float32 mono array to 16-bit WAV bytes."""
    buf = io.BytesIO()
    pcm16 = (samples * 32767).clip(-32768, 32767).astype(np.int16)
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)  # 16-bit
        wf.setframerate(rate)
        wf.writeframes(pcm16.tobytes())
    return buf.getvalue()
