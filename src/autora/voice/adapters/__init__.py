"""Voice adapters — drop-in implementations of SttProvider and TtsProvider.

Recommended setup for an Intel N95 (or any modern x86 without a GPU):

    from autora.voice.adapters.kokoro_tts import KokoroTts
    from autora.voice.adapters.faster_whisper_stt import FasterWhisperStt

    tts = KokoroTts()          # downloads ~300 MB on first run
    stt = FasterWhisperStt()   # downloads ~150 MB on first run

If Kokoro feels slow on your machine, swap in PiperTts — it is 5-10× faster
at the cost of a bit of naturalness.

For a cloud fallback with zero local storage:

    from autora.voice.adapters.openai_whisper_stt import OpenAIWhisperStt
    stt = OpenAIWhisperStt()   # needs OPENAI_API_KEY in env
"""

from .faster_whisper_stt import FasterWhisperStt
from .kokoro_tts import KokoroTts
from .openai_whisper_stt import OpenAIWhisperStt
from .piper_tts import PiperTts

__all__ = ["FasterWhisperStt", "KokoroTts", "OpenAIWhisperStt", "PiperTts"]
