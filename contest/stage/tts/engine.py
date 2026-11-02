"""The synthesis engine: speakers -> fallback chain -> providers, with a content-addressed cache.

Used by serve.py, prerender.py and the tests. Thread-safe: at most `concurrency` synth jobs run at once,
identical requests in flight share one job, a failing engine cools down so a dead network costs one timeout,
not one per message.
"""

from __future__ import annotations

import hashlib
import json
import re
import os
import shutil
import tempfile
import threading
import time
from pathlib import Path

from providers import ProviderError, ProviderUnavailable, default_providers

HERE = Path(__file__).resolve().parent
DEFAULT_VOICES = HERE / "voices.json"
DEFAULT_CACHE = Path(os.environ.get("OPENEGIZ_STAGE_TTS_CACHE") or Path.home() / "Library" / "Caches" / "openegiz-stage" / "tts")
MAX_TEXT = 6000
CONTENT_TYPES = {"mp3": "audio/mpeg", "wav": "audio/wav", "ogg": "audio/ogg", "m4a": "audio/mp4"}


class SynthError(Exception):
    """Every engine of the chain failed, or the request is invalid."""

    def __init__(self, message: str, status: int = 502, tried: list | None = None):
        super().__init__(message)
        self.status = status
        self.tried = tried or []


def cache_key(engine: str, voice: str, settings: dict, text: str) -> str:
    # the pronunciation dictionary counts only with the entries this text uses: a new entry does not
    # invalidate every line already synthesised
    if isinstance(settings.get("say"), dict):
        used = {w: v for w, v in settings["say"].items() if w and re.search(r"(?<!\w)" + re.escape(w) + r"(?!\w)", text, re.IGNORECASE)}
        settings = {**settings, "say": used}
    blob = json.dumps([engine, voice, settings, text], sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()


class Engine:
    def __init__(self, voices_path: str | Path | None = None, cache_dir: str | Path | None = None,
                 providers: dict | None = None, config: dict | None = None):
        self.config = config if config is not None else json.loads(Path(voices_path or DEFAULT_VOICES).read_text("utf-8"))
        self.cache_dir = Path(cache_dir or DEFAULT_CACHE)
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self.providers = providers if providers is not None else default_providers()
        g = self.config.get("settings", {})
        self.timeout_s = float(g.get("timeout_s", 8))
        self.cooldown_s = float(g.get("cooldown_s", 30))
        self.sem = threading.Semaphore(int(g.get("concurrency", 2)))
        self._cool: dict[str, float] = {}
        self._locks: dict[str, threading.Lock] = {}
        self._mu = threading.Lock()

    # ------------------------------------------------------------------------------------------ config
    def speakers(self) -> list[str]:
        return list(self.config["speakers"])

    def chain(self, speaker: str) -> list[dict]:
        """[{engine, voice, settings, timeout_s}] for a speaker; engine-level defaults merged under the entry."""
        sp = self.config["speakers"].get(speaker)
        if sp is None:
            raise SynthError(f"unknown speaker: {speaker}", 400)
        out = []
        for e in sp["chain"]:
            defaults = dict(self.config.get("engines", {}).get(e["engine"], {}))
            settings = {**defaults, **{k: v for k, v in e.items() if k not in ("engine", "voice", "timeout_s", "note")}}
            timeout = e.get("timeout_s") or defaults.get("timeout_s") or \
                (45.0 if e["engine"] == "macos" else self.timeout_s)
            settings.pop("timeout_s", None)
            out.append({"engine": e["engine"], "voice": e.get("voice", ""), "settings": settings,
                        "timeout_s": float(timeout)})
        return out

    # -------------------------------------------------------------------------------------------- cache
    def _meta_path(self, key: str) -> Path:
        return self.cache_dir / f"{key}.json"

    def _lookup(self, key: str) -> dict | None:
        try:
            meta = json.loads(self._meta_path(key).read_text("utf-8"))
        except (OSError, ValueError):
            return None
        if not (self.cache_dir / f"{key}.{meta['format']}").exists():
            return None
        return meta

    def audio_path(self, name: str) -> Path | None:
        """Cache file for an /audio/<name> request, or None when the name is not a cache file."""
        stem, _, ext = name.partition(".")
        if len(stem) != 64 or any(c not in "0123456789abcdef" for c in stem) or ext not in CONTENT_TYPES:
            return None
        p = self.cache_dir / name
        return p if p.is_file() else None

    def _store(self, key: str, engine: str, voice: str, result: dict, settings_tags: list | None = None) -> dict:
        ext = result["format"]
        dest = self.cache_dir / f"{key}.{ext}"
        shutil.move(result["path"], dest)
        meta = {"engine": engine, "voice": voice, "format": ext, "duration_s": result["duration_s"],
                "words": result["words"], "stats": result.get("stats"), "created": time.time(),
                "tags": settings_tags}
        tmp = self.cache_dir / f".{key}.json.tmp"
        tmp.write_text(json.dumps(meta, ensure_ascii=False), "utf-8")
        os.replace(tmp, self._meta_path(key))
        return meta

    def _response(self, key: str, meta: dict, cached: bool, tried: list) -> dict:
        r = {"audio": f"/audio/{key}.{meta['format']}", "duration_s": meta["duration_s"], "words": meta["words"],
             "engine": meta["engine"], "voice": meta["voice"], "format": meta["format"], "cached": cached,
             "tags": meta.get("tags") or []}
        if tried:
            r["fallback_from"] = tried
        return r

    # ----------------------------------------------------------------------------------------- synthesis
    def _run(self, provider, text: str, step: dict) -> dict:
        """Run one provider call with a hard timeout (the thread is abandoned if the provider ignores it)."""
        box: dict = {}
        tmp = Path(tempfile.mkdtemp(prefix="stage-tts-", dir=self.cache_dir))

        def work():
            try:
                box["result"] = provider.synth(text, step["voice"], step["settings"],
                                               timeout=step["timeout_s"], out_dir=tmp)
            except BaseException as e:  # noqa: BLE001 - reported to the chain
                box["error"] = e

        t = threading.Thread(target=work, daemon=True)
        t.start()
        t.join(step["timeout_s"] + 2)
        if t.is_alive():
            raise ProviderError(f"timed out after {step['timeout_s']:g}s")
        if "error" in box:
            shutil.rmtree(tmp, ignore_errors=True)
            e = box["error"]
            if isinstance(e, ProviderError):
                raise e
            raise ProviderError(f"{type(e).__name__}: {e}") from e
        box["result"]["_tmp"] = str(tmp)
        return box["result"]

    def tags_for(self, speaker: str, text: str, tags: list | str | None) -> list[dict]:
        """Audio tags for engines that take them: an explicit list, "none", or "auto" (the tagger, when
        settings.auto_tags is on). The tagger never fails: no tags is a valid answer."""
        if isinstance(tags, list):
            return tags
        if tags == "none" or not self.config.get("settings", {}).get("auto_tags"):
            return []
        try:
            from tagger import auto_tags
        except ImportError:
            return []
        return auto_tags(speaker, text, timeout=float(self.config["settings"].get("tag_timeout_s", 12)))

    def synth(self, speaker: str, text: str, tags: list | str | None = "auto") -> dict:
        if not text or not text.strip():
            raise SynthError("empty text", 400)
        if len(text) > MAX_TEXT:
            raise SynthError(f"text too long ({len(text)} > {MAX_TEXT} characters)", 400)
        chain = self.chain(speaker)
        if any(step["settings"].get("audio_tags") for step in chain):
            resolved = self.tags_for(speaker, text, tags)
            for step in chain:
                if step["settings"].get("audio_tags") and resolved:
                    step["settings"] = {**step["settings"], "tags": resolved}
        tried: list[dict] = []
        for i, step in enumerate(chain):
            eng = step["engine"]
            provider = self.providers.get(eng)
            if provider is None:
                tried.append({"engine": eng, "error": "unknown engine"})
                continue
            key = cache_key(eng, step["voice"], step["settings"], text)
            meta = self._lookup(key)
            if meta:
                return self._response(key, meta, True, tried)
            last = i == len(chain) - 1
            if not last and self._cool.get(eng, 0) > time.monotonic():
                tried.append({"engine": eng, "error": "cooling down after a failure"})
                continue
            with self._mu:
                lock = self._locks.setdefault(key, threading.Lock())
            with lock:  # identical requests wait for the one in flight
                meta = self._lookup(key)
                if meta:
                    return self._response(key, meta, True, tried)
                try:
                    with self.sem:
                        result = self._run(provider, text, step)
                    meta = self._store(key, eng, step["voice"], result, step["settings"].get("tags") or [])
                    shutil.rmtree(result.get("_tmp", ""), ignore_errors=True)
                    self._cool.pop(eng, None)
                    return self._response(key, meta, False, tried)
                except ProviderUnavailable as e:
                    tried.append({"engine": eng, "error": str(e)})
                except ProviderError as e:
                    tried.append({"engine": eng, "error": str(e)})
                    if self.cooldown_s > 0:
                        self._cool[eng] = time.monotonic() + self.cooldown_s
            with self._mu:
                self._locks.pop(key, None)
        raise SynthError("all engines failed: " + "; ".join(f"{t['engine']}: {t['error']}" for t in tried),
                         502, tried)
