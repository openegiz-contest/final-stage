"""Yandex SpeechKit v3 provider: REST utteranceSynthesis, word timings from `wordTimings`.

Kazakhstan account: v3 only, endpoint tts.api.ml.yandexcloud.kz (override with YANDEX_BASE_URL or the engine
setting base_url; the global endpoint is https://tts.api.cloud.yandex.net). The response is a stream of JSON
objects (each possibly wrapped as {"result": {...}}) with base64 audio chunks and wordTimings (word, startMs,
lengthMs; startMs counts from the start of the whole stream).
"""

from __future__ import annotations

import base64
import json
import tempfile
import urllib.error
import urllib.request
from pathlib import Path

from .common import ProviderError, ProviderUnavailable, get_key, probe_duration, ssl_context, words_from_items

DEFAULT_BASE = "https://tts.api.ml.yandexcloud.kz"


def parse_stream(raw: bytes | str) -> tuple[bytes, list[tuple[str, float, float]]]:
    """Concatenate audio chunks and collect word timings from a (possibly multi-object) response body."""
    s = raw.decode("utf-8") if isinstance(raw, (bytes, bytearray)) else raw
    dec = json.JSONDecoder()
    i, n = 0, len(s)
    audio = bytearray()
    items: list[tuple[str, float, float]] = []
    seen = False
    while True:
        while i < n and s[i] in " \r\n\t,[]":
            i += 1
        if i >= n:
            break
        try:
            obj, i = dec.raw_decode(s, i)
        except ValueError as e:
            raise ProviderError(f"yandex: unreadable response: {e}") from e
        seen = True
        if "error" in obj and "result" not in obj and "audioChunk" not in obj:
            raise ProviderError(f"yandex: {json.dumps(obj['error'], ensure_ascii=False)[:200]}")
        obj = obj.get("result", obj)
        chunk = obj.get("audioChunk") or obj.get("audio_chunk")
        if chunk and chunk.get("data"):
            audio += base64.b64decode(chunk["data"])
        for w in obj.get("wordTimings") or obj.get("word_timings") or []:
            a = int(w.get("startMs", w.get("start_ms", 0))) / 1000
            b = a + int(w.get("lengthMs", w.get("length_ms", 0))) / 1000
            items.append((w.get("word", ""), a, b))
    if not seen or not audio:
        raise ProviderError("yandex: response has no audio")
    return bytes(audio), items


class Yandex:
    name = "yandex"

    def synth(self, text: str, voice: str, settings: dict | None = None, timeout: float | None = None,
              out_dir: str | Path | None = None) -> dict:
        s = dict(settings or {})
        key = get_key("YANDEX_API_KEY")
        if not key:
            raise ProviderUnavailable("YANDEX_API_KEY is not set")
        folder = get_key("YANDEX_FOLDER_ID")
        base = (s.get("base_url") or get_key("YANDEX_BASE_URL") or DEFAULT_BASE).rstrip("/")
        hints = [{"voice": voice or "filipp"}]
        if s.get("role"):
            hints.append({"role": s["role"]})
        if s.get("speed") is not None:
            hints.append({"speed": float(s["speed"])})
        if s.get("pitch_shift") is not None:
            hints.append({"pitchShift": float(s["pitch_shift"])})
        if s.get("volume") is not None:
            hints.append({"volume": float(s["volume"])})
        body = {"text": text, "hints": hints,
                "outputAudioSpec": {"containerAudio": {"containerAudioType": "MP3"}},
                "loudnessNormalizationType": "LUFS",
                "unsafeMode": bool(s.get("unsafe_mode", True))}  # text over 250 chars is split by the service
        headers = {"Authorization": f"Api-Key {key}", "Content-Type": "application/json"}
        if folder:
            headers["x-folder-id"] = folder
        req = urllib.request.Request(f"{base}/tts/v3/utteranceSynthesis",
                                     data=json.dumps(body).encode("utf-8"), headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=timeout or 30, context=ssl_context()) as resp:
                raw = resp.read()
        except urllib.error.HTTPError as e:
            raise ProviderError(f"yandex HTTP {e.code}: {e.read()[:200].decode('utf-8', 'replace')}") from e
        except (urllib.error.URLError, OSError) as e:
            raise ProviderError(f"yandex: {e}") from e
        audio, items = parse_stream(raw)
        out_dir = Path(out_dir or tempfile.mkdtemp(prefix="stage-tts-"))
        out_dir.mkdir(parents=True, exist_ok=True)
        f = tempfile.NamedTemporaryFile(suffix=".mp3", dir=out_dir, delete=False)
        f.write(audio)
        f.close()
        duration = probe_duration(f.name) or (max((b for _, _, b in items), default=0.0))
        return {"path": f.name, "format": "mp3", "duration_s": round(duration, 3),
                "words": words_from_items(text, items, duration)}
