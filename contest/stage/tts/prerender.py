#!/usr/bin/env python3
"""Pre-render a script into the cache and write a manifest.

    python3 contest/stage/tts/prerender.py script.json [--manifest out.json] [--voices F] [--cache DIR] [--jobs 2]

script.json: [{"speaker": "host", "text": "...", "id": "intro-1"}, ...]   (id optional; "id" defaults to the index)
manifest:    [{id, speaker, text, audio, file, duration_s, engine, voice, format, words}, ...] in script order.
`audio` is the /audio/<hash>.<ext> path the running service serves from the same cache.
"""

from __future__ import annotations

import argparse
import json
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from engine import Engine, SynthError  # noqa: E402


def prerender(engine: Engine, items: list[dict], jobs: int = 2) -> list[dict]:
    def one(i_item):
        i, item = i_item
        r = engine.synth(item["speaker"], item["text"])
        return {"id": item.get("id", str(i)), "speaker": item["speaker"], "text": item["text"], **r,
                "file": str(engine.cache_dir / Path(r["audio"]).name)}

    with ThreadPoolExecutor(max_workers=max(1, jobs)) as pool:
        return list(pool.map(one, enumerate(items)))


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("script")
    ap.add_argument("--manifest")
    ap.add_argument("--voices")
    ap.add_argument("--cache")
    ap.add_argument("--jobs", type=int, default=2)
    a = ap.parse_args()
    items = json.loads(Path(a.script).read_text("utf-8"))
    engine = Engine(a.voices, a.cache)
    try:
        manifest = prerender(engine, items, a.jobs)
    except SynthError as e:
        print(f"prerender failed: {e}", file=sys.stderr)
        return 1
    out = Path(a.manifest) if a.manifest else Path(a.script).with_suffix(".manifest.json")
    out.write_text(json.dumps(manifest, ensure_ascii=False, indent=1), "utf-8")
    total = sum(m["duration_s"] for m in manifest)
    engines = {}
    for m in manifest:
        engines[m["engine"]] = engines.get(m["engine"], 0) + 1
    print(f"{len(manifest)} items, {total:.1f} s of audio, engines {engines}, manifest {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
