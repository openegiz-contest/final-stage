#!/usr/bin/env python3
"""The Stage's local server (stdlib only, GET and HEAD only).

    python3 contest/stage/server.py [--port 8780] [--live http://127.0.0.1:8765 [--fallback-run DIR] | --run DIR] [--pub DIR] [--program DIR]

  /                  contest/stage/
  /vendor/three/     contest/site/assets/3d/three/ (three r181, the site's copy)
  /vendor/mine/      contest/site/assets/3d/ (mine.js: trucks, terrain)
  /run/<path>        the Final's run folder: proxied to the engine's live.py (--live, scrubbed there),
                     or served from a finished run folder (--run, replays and tests)
  /pub/<path>        the Final Materials of the run (--pub, alias --materials): `<run>/materials/`, so that
                     /pub/<path> is a Judge's tool path 1:1 ("publication/solutions/team-003/screenshots/…",
                     "teams/team-003/source/src/…"). Without a run it may be a Qualifying publication.
  /program/<path>    the programme of the broadcast: program.json, its audio and images (--program,
                     built by tools/build.py; show.html reads /program/program.json)
  /cli/versions.json {"claude": "Claude Code 2.1.308", "codex": "codex-cli 0.160.1"}: `--version` of the
                     Judges' CLIs on this machine, as the engine reports them in state.json judges[].cli
                     (judge/final/runner.py versions()), for the Judges' tags before the engine starts
                     (cli/versions.json in the repo is `{}`: what other static servers give, no 404)

The Stage only reads: nothing here writes, and every path is confined to its root. Byte ranges are
served (206), so a Finalist's Stand video seeks (show.html).
"""

import argparse
import json
import os
import posixpath
import re
import shutil
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
FALLBACK_FILES = ("state.json", "final.json")
SITE_3D = HERE.parent / "site" / "assets" / "3d"


class _Slice:
    """A file object that reads at most n bytes from where it stands (a byte range's body)."""

    def __init__(self, f, n: int):
        self.f, self.left = f, n

    def read(self, size: int = -1) -> bytes:
        if self.left <= 0:
            return b""
        b = self.f.read(self.left if size < 0 else min(size, self.left))
        self.left -= len(b)
        return b

    def close(self) -> None:
        self.f.close()


_versions: tuple[float, bytes] | None = None


def cli_versions() -> bytes:
    """The Judges' CLI versions as the engine words them (judge/final/runner.py), cached for a minute."""
    global _versions
    if _versions and time.monotonic() - _versions[0] < 60:
        return _versions[1]
    out = {}
    for agent in ("claude", "codex"):
        path, v = shutil.which(agent), None
        if path:
            try:
                r = subprocess.run([path, "--version"], capture_output=True, text=True, timeout=20)
                v = r.stdout.strip().splitlines()[0] if r.returncode == 0 and r.stdout.strip() else None
            except (OSError, subprocess.TimeoutExpired):
                v = None
        if v and agent == "claude" and v.endswith("(Claude Code)"):
            v = "Claude Code " + v.removesuffix("(Claude Code)").strip()
        out[agent] = v
    _versions = (time.monotonic(), json.dumps(out).encode())
    return _versions[1]


class Handler(SimpleHTTPRequestHandler):
    roots: dict[str, Path] = {}
    live: str | None = None
    fallback: Path | None = None  # the run folder: state.json and final.json when live.py has stopped
    extensions_map = SimpleHTTPRequestHandler.extensions_map | {
        ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json",
        ".jsonl": "application/x-ndjson", ".txt": "text/plain; charset=utf-8", ".md": "text/plain; charset=utf-8", ".glb": "model/gltf-binary"}

    def log_message(self, *args):
        pass

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def _split(self) -> tuple[str, str]:
        path = posixpath.normpath(urllib.parse.unquote(urllib.parse.urlsplit(self.path).path))
        for prefix in ("/vendor/three", "/vendor/mine", "/run", "/pub", "/program"):
            if path == prefix or path.startswith(prefix + "/"):
                return prefix, path[len(prefix):].lstrip("/")
        return "/", path.lstrip("/")

    def translate_path(self, path):
        prefix, rest = self._split()
        root = self.roots.get(prefix)
        if root is None:
            return str(HERE / "\0missing")
        p = (root / rest).resolve()
        return str(p) if p == root or root in p.parents else str(HERE / "\0missing")

    def _proxy(self, rest: str, head: bool) -> None:
        query = urllib.parse.urlsplit(self.path).query
        url = f"{self.live}/{urllib.parse.quote(rest)}" + (f"?{query}" if query else "")
        try:
            with urllib.request.urlopen(urllib.request.Request(url, method="HEAD" if head else "GET"), timeout=5) as r:
                body = r.read()
                self.send_response(r.status)
                self.send_header("Content-Type", r.headers.get("Content-Type", "application/octet-stream"))
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                if not head:
                    self.wfile.write(body)
        except urllib.error.HTTPError as e:
            self.send_error(e.code)
        except (urllib.error.URLError, TimeoutError, ConnectionError):
            # live.py holds after `done` unless started with --no-hold (never on air); this is the backup so the
            # final state still reaches the Stage. Only the run's
            # state files, never raw turn logs: those are scrubbed by live.py alone.
            if self.fallback and rest in FALLBACK_FILES and (self.fallback / rest).is_file():
                body = (self.fallback / rest).read_bytes()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                if not head:
                    self.wfile.write(body)
                return
            self.send_error(502, "the engine's live page does not answer")

    def _versions(self, head: bool) -> None:
        body = cli_versions()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if not head:
            self.wfile.write(body)

    def do_GET(self):
        prefix, rest = self._split()
        if prefix == "/" and rest == "cli/versions.json":
            return self._versions(head=False)
        if prefix == "/run" and self.live:
            return self._proxy(rest, head=False)
        return super().do_GET()

    def do_HEAD(self):
        prefix, rest = self._split()
        if prefix == "/" and rest == "cli/versions.json":
            return self._versions(head=True)
        if prefix == "/run" and self.live:
            return self._proxy(rest, head=True)
        return super().do_HEAD()

    def send_head(self):
        rng = (self.headers.get("Range") or "").strip()
        path = self.translate_path(self.path)
        m = re.fullmatch(r"bytes=(\d*)-(\d*)", rng)
        if not m or not (m[1] or m[2]) or not os.path.isfile(path):
            return super().send_head()
        size = os.path.getsize(path)
        start, end = (int(m[1]), min(int(m[2]) if m[2] else size - 1, size - 1)) if m[1] else (max(0, size - int(m[2])), size - 1)
        if start > end:
            self.send_response(416)
            self.send_header("Content-Range", f"bytes */{size}")
            self.end_headers()
            return None
        f = open(path, "rb")
        f.seek(start)
        self.send_response(206)
        self.send_header("Content-Type", self.guess_type(path))
        self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.send_header("Content-Length", str(end - start + 1))
        self.send_header("Accept-Ranges", "bytes")
        self.end_headers()
        return _Slice(f, end - start + 1)

    def list_directory(self, path):
        self.send_error(404)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--port", type=int, default=8780)
    src = ap.add_mutually_exclusive_group()
    src.add_argument("--live", default="http://127.0.0.1:8765", help="the engine's live.py (default)")
    src.add_argument("--run", help="a run folder on disk instead of the live engine")
    ap.add_argument("--pub", "--materials", dest="pub", help="the Final Materials folder (<run>/materials), served as /pub/; "
                    "before a run, a Qualifying publication folder")
    ap.add_argument("--fallback-run", help="with --live: the run folder (runs/final/<id>) whose state.json and final.json "
                    "are served when live.py has stopped (a backup: on air live.py holds after done)")
    ap.add_argument("--program", help="the programme folder (program.json, audio, images) for show.html")
    args = ap.parse_args(argv)
    Handler.roots = {"/": HERE, "/vendor/three": SITE_3D / "three", "/vendor/mine": SITE_3D}
    if args.run:
        Handler.roots["/run"] = Path(args.run).resolve()
        Handler.live = None
    else:
        Handler.live = args.live.rstrip("/")
        Handler.fallback = Path(args.fallback_run).resolve() if args.fallback_run else None
    if args.pub:
        Handler.roots["/pub"] = Path(args.pub).resolve()
    if args.program:
        Handler.roots["/program"] = Path(args.program).resolve()
    server = ThreadingHTTPServer(("127.0.0.1", args.port), partial(Handler, directory=str(HERE)))
    print(f"Stage on http://127.0.0.1:{args.port}/  run: {args.run or Handler.live}  pub: {args.pub or '-'}  program: {args.program or '-'}")
    server.serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
