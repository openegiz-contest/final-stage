"""ElevenLabs provider: POST /v1/text-to-speech/{voice_id}/with-timestamps (character-level alignment).

Audio tags (eleven_v3/v4): settings["tags"] = [{"at": char offset, "tag": "thoughtful"}, ...]. The provider
inserts "[tag] " at those offsets only in the text it sends; the words it returns are over the original text,
so the Stage still types the Judge's words verbatim."""

from __future__ import annotations

import base64
import json
import re
import tempfile
import urllib.error
import urllib.request
from pathlib import Path

from .common import ProviderError, ProviderUnavailable, get_key, probe_duration, ssl_context, words_from_chars

DEFAULT_BASE = "https://api.elevenlabs.io"
DEFAULT_MODEL = "eleven_multilingual_v2"
DEFAULT_FORMAT = "mp3_44100_128"
VOICE_SETTINGS = ("stability", "similarity_boost", "style", "use_speaker_boost", "speed")
TAG = re.compile(r"\[[^\[\]\n]{1,40}\] ?")


def with_tags(text: str, tags: list[dict] | None, say: dict[str, str] | None = None) -> tuple[str, list]:
    """(text to speak, for each of its characters where it came from): an int is an index into `text`, None a
    tag character, (a, b) a character of a pronunciation that replaces text[a:b] (settings["say"], whole words,
    case-insensitive)."""
    at_map: dict[int, list[str]] = {}
    for t in tags or []:
        at, tag = t.get("at"), str(t.get("tag") or "").strip()
        if isinstance(at, int) and 0 <= at < len(text) and tag and "[" not in tag and "]" not in tag:
            at_map.setdefault(at, []).append(tag)
    repl: dict[int, tuple[int, str]] = {}
    for word, sound in (say or {}).items():
        if word and sound:
            for m in re.finditer(r"(?<!\w)" + re.escape(word) + r"(?!\w)", text, re.IGNORECASE):
                if not any(m.start() < e and s0 < m.end() for s0, (e, _) in repl.items()):
                    repl[m.start()] = (m.end(), sound)
    spoken: list[str] = []
    index: list = []
    i = 0
    while i < len(text):
        for tag in at_map.get(i, []):
            mark = f"[{tag}] "
            spoken.append(mark)
            index.extend([None] * len(mark))
        if i in repl:
            end, sound = repl[i]
            spoken.append(sound)
            index.extend([(i, end)] * len(sound))
            i = end
            continue
        spoken.append(text[i])
        index.append(i)
        i += 1
    return "".join(spoken), index


def untag_alignment(spoken: str, index: list, al: dict, text: str = "") -> tuple[list[str], list[float], list[float]]:
    """Alignment over the spoken text back onto the original characters (a replaced word gets the time of its
    pronunciation)."""
    chars, starts, ends = al["characters"], al["character_start_times_seconds"], al["character_end_times_seconds"]
    if "".join(chars) == spoken and len(chars) == len(index) == len(starts) == len(ends):
        oc: list[str] = []
        os_: list[float] = []
        oe: list[float] = []
        k = 0
        while k < len(index):
            src = index[k]
            if src is None:
                k += 1
            elif isinstance(src, tuple):
                j = k
                while j < len(index) and index[j] == src:
                    j += 1
                a, b = src
                t0, t1 = min(starts[k:j]), max(ends[k:j])
                for c in text[a:b]:
                    oc.append(c)
                    os_.append(t0)
                    oe.append(t1)
                k = j
            else:
                oc.append(chars[k])
                os_.append(starts[k])
                oe.append(ends[k])
                k += 1
        return oc, os_, oe
    # Normalised alignment (digits spelled out): drop whatever still looks like a tag; words_from_chars
    # then matches words to the original tokens and interpolates what it cannot match.
    joined = "".join(chars)
    drop = set()
    for m in TAG.finditer(joined):
        drop.update(range(m.start(), m.end()))
    keep = [k for k in range(min(len(chars), len(starts), len(ends))) if k not in drop]
    return [chars[k] for k in keep], [starts[k] for k in keep], [ends[k] for k in keep]


def extension(output_format: str) -> str:
    head = output_format.split("_")[0]
    return {"mp3": "mp3", "wav": "wav", "opus": "ogg"}.get(head, head)


def parse_response(text: str, payload: dict) -> tuple[bytes, dict]:
    """(audio bytes, alignment) from a with-timestamps response. `alignment` maps the characters we sent;
    `normalized_alignment` maps the normalised text (digits spelled out) and is the fallback."""
    try:
        audio = base64.b64decode(payload["audio_base64"])
    except (KeyError, ValueError, TypeError) as e:
        raise ProviderError("elevenlabs: response has no audio_base64") from e
    al = payload.get("alignment") or payload.get("normalized_alignment")
    if not al or not al.get("characters"):
        raise ProviderError("elevenlabs: response has no alignment")
    return audio, al


class ElevenLabs:
    name = "elevenlabs"

    def synth(self, text: str, voice: str, settings: dict | None = None, timeout: float | None = None,
              out_dir: str | Path | None = None) -> dict:
        s = dict(settings or {})
        key = get_key("ELEVENLABS_API_KEY")
        if not key:
            raise ProviderUnavailable("ELEVENLABS_API_KEY is not set")
        if not voice:
            raise ProviderUnavailable("no ElevenLabs voice_id configured")
        base = (s.get("base_url") or get_key("ELEVENLABS_BASE_URL") or DEFAULT_BASE).rstrip("/")
        fmt = s.get("output_format") or DEFAULT_FORMAT
        spoken, index = with_tags(text, s.get("tags"), s.get("say"))
        body: dict = {"text": spoken, "model_id": s.get("model_id") or DEFAULT_MODEL}
        vs = {k: s[k] for k in VOICE_SETTINGS if k in s}
        if vs:
            body["voice_settings"] = vs
        for k in ("language_code", "seed", "apply_text_normalization", "previous_text", "next_text"):
            if s.get(k) is not None:
                body[k] = s[k]
        req = urllib.request.Request(
            f"{base}/v1/text-to-speech/{voice}/with-timestamps?output_format={fmt}",
            data=json.dumps(body).encode("utf-8"),
            headers={"xi-api-key": key, "Content-Type": "application/json", "Accept": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=timeout or 30, context=ssl_context()) as resp:
                payload = json.loads(resp.read())
        except urllib.error.HTTPError as e:
            raise ProviderError(f"elevenlabs HTTP {e.code}: {e.read()[:200].decode('utf-8', 'replace')}") from e
        except (urllib.error.URLError, OSError, ValueError) as e:
            raise ProviderError(f"elevenlabs: {e}") from e
        audio, al = parse_response(text, payload)
        out_dir = Path(out_dir or tempfile.mkdtemp(prefix="stage-tts-"))
        out_dir.mkdir(parents=True, exist_ok=True)
        ext = extension(fmt)
        f = tempfile.NamedTemporaryFile(suffix="." + ext, dir=out_dir, delete=False)
        f.write(audio)
        f.close()
        chars, starts, ends = untag_alignment(spoken, index, al, text)
        duration = probe_duration(f.name) or (max(al["character_end_times_seconds"] or [0.0]))
        return {"path": f.name, "format": ext, "duration_s": round(duration, 3),
                "words": words_from_chars(text, chars, starts, ends, duration)}
