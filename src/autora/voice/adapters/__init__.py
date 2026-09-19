"""Voice adapters — drop-in implementations of SttProvider and TtsProvider.

Recommended setup with Deepgram (best barge-in, zero local storage):

    from autora.voice.adapters.deepgram_stt import DeepgramStt
    from autora.voice.adapters.kokoro_tts import KokoroTts

    stt = DeepgramStt()    # needs DEEPGRAM_API_KEY in env
    tts = KokoroTts()      # downloads ~300 MB on first run

Fully local setup (Intel N95 or similar):

    from autora.voice.adapters.kokoro_tts import KokoroTts
    from autora.voice.adapters.faster_whisper_stt import FasterWhisperStt

    tts = KokoroTts()          # ~1-2× realtime on CPU
    stt = FasterWhisperStt()   # downloads ~150 MB on first run
"""

from .deepgram_stt import DeepgramStt
from .faster_whisper_stt import FasterWhisperStt
from .kokoro_tts import KokoroTts
from .openai_whisper_stt import OpenAIWhisperStt
from .piper_tts import PiperTts

__all__ = ["DeepgramStt", "FasterWhisperStt", "KokoroTts", "OpenAIWhisperStt", "PiperTts"]
