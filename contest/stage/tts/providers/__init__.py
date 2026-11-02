"""TTS providers. One interface:

    provider.synth(text, voice, settings=None, timeout=None, out_dir=None)
        -> {"path": audio file, "format": "wav"|"mp3"|..., "duration_s": float,
            "words": [{start_char, end_char, start_s, end_s}]}   (see common.py for the word contract)

Raises ProviderUnavailable (nothing to try: no key, voice missing) or ProviderError (tried and failed).
"""

from .common import ProviderError, ProviderUnavailable
from .elevenlabs import ElevenLabs
from .macos import MacOS
from .yandex import Yandex


def default_providers() -> dict:
    return {"elevenlabs": ElevenLabs(), "yandex": Yandex(), "macos": MacOS()}
