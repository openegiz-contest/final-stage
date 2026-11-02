#!/usr/bin/env python3
"""Voice sample for the owner: one Russian phrase, 6 voices of one engine, plus index.html that plays them.

    python3 contest/stage/tts/sample.py --engine macos|elevenlabs|yandex [--out DIR] [--text "..."]
    python3 contest/stage/tts/sample.py --engine elevenlabs --list-voices     # the account's voices (id, name)

Output: contest/stage/out/voice-sample/<engine>/NN-<voice>.<ext> and index.html. The candidates and the phrase
live in voices.json ("sample"). macOS has one Russian voice (Milena): its six entries are rate/pitch variants.
"""

from __future__ import annotations

import argparse
import html
import json
import re
import shutil
import sys
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from engine import DEFAULT_VOICES  # noqa: E402
from providers import ProviderError, default_providers  # noqa: E402
from providers.common import get_key, ssl_context  # noqa: E402

OUT_ROOT = Path(__file__).resolve().parent.parent / "out" / "voice-sample"

NOTES = {
    "macos": "Движок macOS: в системе один русский голос, Milena. Шесть файлов ниже — это один и тот же голос "
             "с разной скоростью и высотой. Разных тембров здесь нет.",
    "elevenlabs": "ElevenLabs, модель eleven_v4 с audio tags ([thoughtful], [sighs], [skeptical]: на экране их нет), голоса из аккаунта. Нужно шесть: Opus, Sonnet, Fable, "
                  "GPT sol, GPT astra и Ведущий. Твои клоны голоса сюда не включены.",
    "yandex": "Yandex SpeechKit v3. Голоса — кандидаты; часть старых голосов Яндекс может снять.",
}


def slug(s: str) -> str:
    s = re.sub(r"[^\w]+", "-", s.casefold(), flags=re.UNICODE).strip("-")
    return s[:40] or "voice"


def list_elevenlabs_voices() -> int:
    key = get_key("ELEVENLABS_API_KEY")
    if not key:
        print("ELEVENLABS_API_KEY is not set", file=sys.stderr)
        return 2
    req = urllib.request.Request("https://api.elevenlabs.io/v1/voices", headers={"xi-api-key": key})
    with urllib.request.urlopen(req, timeout=20, context=ssl_context()) as r:
        for v in json.loads(r.read()).get("voices", []):
            print(f"{v['voice_id']}\t{v.get('name')}\t{v.get('category')}\t{json.dumps(v.get('labels') or {}, ensure_ascii=False)}")
    return 0


def render_page(engine: str, text: str, rows: list[dict]) -> str:
    items = "\n".join(
        f'<li><div class="n">{r["n"]:02d}</div><div class="b"><strong>{html.escape(r["label"])}</strong>'
        f'<div class="m">{html.escape(r["file"])} · {r["duration_s"]:.1f} с</div>'
        f'<audio controls preload="none" src="{html.escape(r["file"])}"></audio></div></li>'
        if r.get("file") else
        f'<li><div class="n">{r["n"]:02d}</div><div class="b"><strong>{html.escape(r["label"])}</strong>'
        f'<div class="m err">не получилось: {html.escape(r["error"])}</div></div></li>'
        for r in rows)
    return f"""<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><title>Голоса Сцены: {html.escape(engine)}</title>
<style>
body{{font:16px/1.5 system-ui,sans-serif;max-width:46rem;margin:2rem auto;padding:0 1rem;color:#222}}
.phrase{{background:#f3f1ea;padding:.8rem 1rem;border-radius:6px}}
ol{{list-style:none;padding:0}}li{{display:flex;gap:1rem;padding:.7rem 0;border-top:1px solid #ddd}}
.n{{font-weight:700;color:#999;width:2rem}}.m{{color:#777;font-size:.85rem}}.err{{color:#a22}}audio{{width:100%;margin-top:.3rem}}
</style></head><body>
<h1>Голоса Сцены: {html.escape(engine)}</h1>
<p>{html.escape(NOTES.get(engine, ""))}</p>
<p class="phrase">{html.escape(text)}</p>
<ol>
{items}
</ol></body></html>
"""


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--engine", required=True, choices=["macos", "elevenlabs", "yandex"])
    ap.add_argument("--out", help="output dir (default contest/stage/out/voice-sample/<engine>)")
    ap.add_argument("--text")
    ap.add_argument("--voices", help="voices.json")
    ap.add_argument("--timeout", type=float, default=60)
    ap.add_argument("--list-voices", action="store_true")
    a = ap.parse_args()
    if a.list_voices:
        if a.engine != "elevenlabs":
            print("--list-voices works for elevenlabs only", file=sys.stderr)
            return 2
        return list_elevenlabs_voices()
    cfg = json.loads(Path(a.voices or DEFAULT_VOICES).read_text("utf-8"))
    text = a.text or cfg["sample"]["text"]
    cands = cfg["sample"]["candidates"][a.engine]
    defaults = cfg.get("engines", {}).get(a.engine, {})
    provider = default_providers()[a.engine]
    out = Path(a.out) if a.out else OUT_ROOT / a.engine
    shutil.rmtree(out, ignore_errors=True)
    out.mkdir(parents=True)
    rows, failed = [], 0
    for n, c in enumerate(cands, 1):
        settings = {**defaults, **{k: v for k, v in c.items() if k not in ("label", "voice", "note")}}
        if defaults.get("audio_tags") and not a.text:
            settings["tags"] = cfg["sample"].get("tags") or []
        row = {"n": n, "label": c["label"]}
        try:
            r = provider.synth(text, c["voice"], settings, timeout=a.timeout, out_dir=out / ".tmp")
            name = f"{n:02d}-{slug(c['label'].split(':')[0].split(',')[0])}.{r['format']}"
            shutil.move(r["path"], out / name)
            row.update(file=name, duration_s=r["duration_s"])
            print(f"{name}  {r['duration_s']:.1f}s")
        except ProviderError as e:
            failed += 1
            row["error"] = str(e)
            print(f"{n:02d} {c['label']}: FAILED {e}", file=sys.stderr)
        rows.append(row)
    shutil.rmtree(out / ".tmp", ignore_errors=True)
    (out / "index.html").write_text(render_page(a.engine, text, rows), "utf-8")
    print(f"{out / 'index.html'}  ({len(cands) - failed}/{len(cands)} rendered)")
    return 1 if failed == len(cands) else 0


if __name__ == "__main__":
    sys.exit(main())
