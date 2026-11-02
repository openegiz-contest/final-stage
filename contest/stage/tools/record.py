#!/usr/bin/env python3
"""Record a Final's run into a replay the director can play (stdlib only).

    python3 contest/stage/tools/record.py <run dir> --out run.jsonl [--interval 0.25] [--max-s N] [--note TEXT]
    python3 contest/stage/tools/record.py --url http://127.0.0.1:8765 --out run.jsonl     # what the Stage sees

Polls the run folder (runs/final/<run-id>/, or the engine's live page, which scrubs paths and secrets
the way the Stage reads them) and appends to --out, one JSON object per line:

  {"format":"stage-replay/1","startedAt":"<ISO>","runId":"…","recorded":true}      header
  {"t":0.0,"state":{…}}                                    state.json, when it changed (the first one in full)
  {"t":1.2,"delta":{"set":{…},"append":{…},"unset":[…]}}   later changes as deltas (director/sources/codec.js)
  {"t":2.5,"tid":"p1-r1-message-opus-5.5","prompt":true}   prompt.txt of a turn appeared
  {"t":3.1,"tid":"…","line":"{…}"}                         a new complete line of claude.jsonl|codex.jsonl

t is seconds since the recording started. Within one poll the states come first, then the prompts and lines,
so the director always knows a turn before it reads its log. Stops when state.json says "done" (after one
last pass over the logs), at --max-s, or on Ctrl-C. A recording from a folder holds the raw logs: do not
publish it; record with --url to get the scrubbed text.
"""

import argparse
import json
import re
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path


APPEND_KEYS = ("transcript", "votes", "placements")


def encode_delta(prev: dict, nxt: dict) -> dict | None:
    """The change from prev to nxt, in the format of director/sources/codec.js (the engine only appends)."""
    same = lambda a, b: json.dumps(a, sort_keys=True) == json.dumps(b, sort_keys=True)  # noqa: E731
    sets, append, unset = {}, {}, []
    for key in list(prev) + [k for k in nxt if k not in prev]:
        a, b = prev.get(key), nxt.get(key)
        if key not in nxt:
            unset.append(key)
        elif key in prev and same(a, b):
            continue
        elif key in APPEND_KEYS and isinstance(a, list) and isinstance(b, list) and len(b) > len(a) and same(a, b[: len(a)]):
            append[key] = b[len(a):]
        elif key == "judges" and isinstance(a, list) and isinstance(b, list) and len(a) == len(b):
            for i, (x, y) in enumerate(zip(a, b)):
                if not same(x, y):
                    sets[f"judges.{i}"] = y
        else:
            sets[key] = b
    delta = {k: v for k, v in (("set", sets), ("append", append), ("unset", unset)) if v}
    return delta or None


class FolderReader:
    def __init__(self, root: Path):
        self.root = root

    def text(self, rel: str) -> str | None:
        try:
            return (self.root / rel).read_text(encoding="utf-8", errors="replace")
        except OSError:
            return None

    def size(self, rel: str) -> int | None:
        try:
            return (self.root / rel).stat().st_size
        except OSError:
            return None

    def listdir(self, rel: str) -> list[str]:
        try:
            return sorted(p.name for p in (self.root / rel).iterdir())
        except OSError:
            return []


class HttpReader:
    def __init__(self, base: str):
        self.base = base.rstrip("/")

    def _open(self, rel: str, method: str = "GET"):
        req = urllib.request.Request(f"{self.base}/{rel}", method=method)
        try:
            return urllib.request.urlopen(req, timeout=5)
        except (urllib.error.URLError, TimeoutError, ConnectionError):
            return None

    def text(self, rel: str) -> str | None:
        r = self._open(rel)
        if r is None:
            return None
        with r:
            return r.read().decode("utf-8", errors="replace")

    def size(self, rel: str) -> int | None:
        r = self._open(rel, "HEAD")
        if r is None:
            return None
        with r:
            n = r.headers.get("Content-Length")
            return int(n) if n else None

    def listdir(self, rel: str) -> list[str]:
        html = self.text(rel.rstrip("/") + "/")
        return sorted({m.strip("/") for m in re.findall(r'href="([^"?#]+)"', html or "")} - {"..", ""})


class Recorder:
    def __init__(self, reader, out, *, note: str | None = None, clock=time.monotonic):
        self.reader, self.out, self.clock = reader, out, clock
        self.t0 = clock()
        self.last_state: str | None = None
        self.prev: dict | None = None
        self.done = False
        self.sizes: dict[str, int] = {}
        self.lines: dict[str, int] = {}
        self.prompts: set[str] = set()
        final = self._json("final.json") or {}
        header = {"format": "stage-replay/1", "startedAt": datetime.now(timezone.utc).isoformat(timespec="milliseconds"),
                  "runId": final.get("created_at"), "recorded": True}
        if note:
            header["note"] = note
        self._write(header)

    def _json(self, rel):
        text = self.reader.text(rel)
        try:
            return json.loads(text) if text else None
        except json.JSONDecodeError:
            return None  # caught mid-write

    def _write(self, obj) -> None:
        self.out.write(json.dumps(obj, ensure_ascii=False, separators=(",", ":")) + "\n")
        self.out.flush()

    def _state(self, t: float) -> None:
        text = self.reader.text("state.json")
        if text is None or text == self.last_state:
            return
        try:
            state = json.loads(text)
        except json.JSONDecodeError:
            return
        self.last_state = text
        delta = encode_delta(self.prev, state) if self.prev is not None else None
        if self.prev is None:
            self._write({"t": t, "state": state})
        elif delta:
            self._write({"t": t, "delta": delta})
        self.prev = state
        self.done = state.get("status") == "done"

    def _turns(self, t: float) -> None:
        for tid in self.reader.listdir("turns"):
            base = f"turns/{tid}"
            if tid not in self.prompts and self.reader.size(f"{base}/prompt.txt") is not None:
                self.prompts.add(tid)
                self._write({"t": t, "tid": tid, "prompt": True})
            for name in ("claude.jsonl", "codex.jsonl"):
                rel = f"{base}/{name}"
                size = self.reader.size(rel)
                if size is None or size == self.sizes.get(rel):
                    continue
                self.sizes[rel] = size
                text = self.reader.text(rel) or ""
                complete = text[: text.rfind("\n") + 1]
                lines = [ln for ln in complete.split("\n") if ln]
                for line in lines[self.lines.get(rel, 0):]:
                    self._write({"t": t, "tid": tid, "line": line})
                self.lines[rel] = max(self.lines.get(rel, 0), len(lines))

    def poll(self) -> None:
        t = round(self.clock() - self.t0, 3)
        self._state(t)
        self._turns(t)
        self._state(t)  # a state that landed while the logs were read goes first for the next poll's lines


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("run_dir", nargs="?", help="the run folder")
    ap.add_argument("--url", help="the engine's live page instead of a folder (scrubbed text)")
    ap.add_argument("--out", required=True)
    ap.add_argument("--interval", type=float, default=0.25)
    ap.add_argument("--max-s", type=float, default=0, help="stop after N seconds (0: until the Final is done)")
    ap.add_argument("--note", help="written into the header")
    args = ap.parse_args(argv)
    if bool(args.run_dir) == bool(args.url):
        ap.error("give a run folder or --url")
    reader = HttpReader(args.url) if args.url else FolderReader(Path(args.run_dir))
    with open(args.out, "w", encoding="utf-8") as out:
        rec = Recorder(reader, out, note=args.note)
        try:
            while True:
                rec.poll()
                if rec.done:
                    rec.poll()  # the logs' last lines
                    break
                if args.max_s and rec.clock() - rec.t0 >= args.max_s:
                    break
                time.sleep(args.interval)
        except KeyboardInterrupt:
            pass
    print(f"recorded {args.out}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
