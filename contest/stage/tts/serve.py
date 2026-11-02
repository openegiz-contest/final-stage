#!/usr/bin/env python3
"""The Stage's TTS service (stdlib only, 127.0.0.1).

    python3 contest/stage/tts/serve.py [--port 8790] [--voices voices.json] [--cache DIR] [--cors ORIGIN]

  GET /synth?speaker=<id>&text=<urlencoded>[&tags=auto|none|<JSON [{at, tag}]>]
        -> {audio: "/audio/<hash>.<ext>", duration_s, words: [{start_char, end_char, start_s, end_s}],
            engine, voice, format, cached, fallback_from?}
  GET /audio/<hash>.<ext>      the cached audio (Range supported)
  GET /speakers                speakers and their chains (no secrets)
  GET /health                  {ok, engines: {name: available}}
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from engine import CONTENT_TYPES, Engine, SynthError  # noqa: E402
from providers.common import get_key  # noqa: E402


def make_handler(engine: Engine, cors: str):
    class Handler(BaseHTTPRequestHandler):
        server_version = "stage-tts"

        def log_message(self, *args):
            pass

        def _headers(self, status: int, ctype: str, length: int, extra: dict | None = None):
            self.send_response(status)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(length))
            self.send_header("Access-Control-Allow-Origin", cors)
            self.send_header("Vary", "Origin")
            for k, v in (extra or {}).items():
                self.send_header(k, v)
            self.end_headers()

        def _json(self, status: int, obj) -> None:
            body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
            self._headers(status, "application/json; charset=utf-8", len(body), {"Cache-Control": "no-store"})
            if self.command != "HEAD":
                self.wfile.write(body)

        def do_OPTIONS(self):
            self.send_response(204)
            self.send_header("Access-Control-Allow-Origin", cors)
            self.send_header("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Range")
            self.send_header("Content-Length", "0")
            self.end_headers()

        do_HEAD = lambda self: self.do_GET()  # noqa: E731

        def do_GET(self):
            u = urllib.parse.urlsplit(self.path)
            q = urllib.parse.parse_qs(u.query)
            try:
                if u.path == "/synth":
                    speaker = (q.get("speaker") or [""])[0]
                    text = (q.get("text") or [""])[0]
                    tags = (q.get("tags") or ["auto"])[0]
                    if tags not in ("auto", "none"):
                        try:
                            tags = json.loads(tags)
                        except ValueError:
                            tags = None
                        if not isinstance(tags, list):
                            raise SynthError("tags: auto, none or a JSON list", 400)
                    return self._json(200, engine.synth(speaker, text, tags))
                if u.path.startswith("/audio/"):
                    return self._audio(urllib.parse.unquote(u.path[len("/audio/"):]))
                if u.path == "/speakers":
                    return self._json(200, {s: {"label": engine.config["speakers"][s].get("label"),
                                                "chain": [{"engine": c["engine"], "voice": c["voice"]}
                                                          for c in engine.chain(s)]} for s in engine.speakers()})
                if u.path == "/health":
                    return self._json(200, {"ok": True, "keys": {"elevenlabs": bool(get_key("ELEVENLABS_API_KEY")),
                                                                 "yandex": bool(get_key("YANDEX_API_KEY"))}})
                return self._json(404, {"error": "not found"})
            except SynthError as e:
                return self._json(e.status, {"error": str(e), "tried": e.tried})
            except BrokenPipeError:
                pass
            except Exception as e:  # noqa: BLE001
                return self._json(500, {"error": f"{type(e).__name__}: {e}"})

        def _audio(self, name: str):
            p = engine.audio_path(name)
            if p is None:
                return self._json(404, {"error": "no such audio"})
            size = p.stat().st_size
            ctype = CONTENT_TYPES[p.suffix[1:]]
            start, end, status = 0, size - 1, 200
            m = re.fullmatch(r"bytes=(\d*)-(\d*)", self.headers.get("Range", ""))
            if m and (m.group(1) or m.group(2)):
                if m.group(1):
                    start = int(m.group(1))
                    end = int(m.group(2)) if m.group(2) else size - 1
                else:
                    start = max(size - int(m.group(2)), 0)
                end = min(end, size - 1)
                if start > end:
                    return self._headers(416, ctype, 0, {"Content-Range": f"bytes */{size}"})
                status = 206
            extra = {"Accept-Ranges": "bytes", "Cache-Control": "public, max-age=31536000, immutable"}
            if status == 206:
                extra["Content-Range"] = f"bytes {start}-{end}/{size}"
            self._headers(status, ctype, end - start + 1, extra)
            if self.command == "HEAD":
                return
            with open(p, "rb") as f:
                f.seek(start)
                self.wfile.write(f.read(end - start + 1))

    return Handler


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--port", type=int, default=8790)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--voices", help="voices.json (default: next to this file)")
    ap.add_argument("--cache", help="cache dir (default ~/Library/Caches/openegiz-stage/tts)")
    ap.add_argument("--cors", default="http://127.0.0.1:8780", help="allowed origin")
    a = ap.parse_args()
    engine = Engine(a.voices, a.cache)
    srv = ThreadingHTTPServer((a.host, a.port), make_handler(engine, a.cors))
    srv.daemon_threads = True
    print(f"stage-tts on http://{a.host}:{a.port}  cache {engine.cache_dir}", flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
