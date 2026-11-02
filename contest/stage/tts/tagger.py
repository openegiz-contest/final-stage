"""Audio tags for the Stage voice: where to put `[thoughtful]`, `[sighs]` and the like for ElevenLabs eleven_v4.

The text on screen stays verbatim, so tags are never written into it. auto_tags() returns positions only:
  [{"at": <char offset of a sentence start in text>, "tag": "<tag>"}, ...] sorted by `at`.
The TTS provider inserts "[tag] " at those offsets in the copy of the text it sends to the engine.

The text is split into sentences here and numbered; a small model (the local Claude Code CLI) sees the numbered
sentences and answers `[{"s": <index>, "tag": "<tag>"}]`. It never returns text, so it cannot change a word.
Whitelist, one tag per sentence and a cap of ceil(n/2) tags are enforced here, not trusted to the model.
Never raises: any failure (CLI missing, timeout, non-zero exit, bad JSON) returns [] and is not cached.

Manual check:  python3 tagger.py --speaker fable-5.1 "Текст реплики. Ещё одна фраза."
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Callable

MODEL = "claude-haiku-5-5"

TAGS = (
    "thoughtful", "calm", "warmly", "curious", "serious", "confident", "excited", "amused",
    "skeptical", "hesitant", "sighs", "chuckles", "laughs softly", "whispers", "emphatic",
)

TEMPERAMENT = {
    "opus-5.5": "Large and calm, deliberate; weighs each point before speaking. Slow, grounded tags (thoughtful, calm, serious).",
    "sonnet-5.5": "Light and quick, brisk, a little playful. Short bright tags (curious, amused, confident).",
    "fable-5.1": "A storyteller, warm; speaks as if telling a story to the room. Warm, narrative tags (warmly, thoughtful, amused).",
    "gpt-6.1-sol": "Warmer and direct; says what it thinks plainly. Warmly, confident, emphatic where it matters.",
    "gpt-6-astra": "Colder and precise; an analyst. Few tags, mostly none; serious or skeptical only when the content demands it.",
    "host": "A neutral broadcast host. Few tags; calm, warmly or confident at most.",
}
NEUTRAL = "Neutral, even delivery. Few tags."

_SENTENCE_GAP = re.compile(r"""[.!?…]+["'»”’)\]]*\s+""")
_memory: dict[str, list[dict]] = {}


# ---------------------------------------------------------------------------------------------------- sentences

def split_sentences(text: str) -> list[int]:
    """Offsets of sentence starts: 0 (first non-space) and the first non-space char after `.`, `!`, `?`, `…`
    (closing quotes and brackets included) followed by whitespace."""
    starts: list[int] = []
    first = len(text) - len(text.lstrip())
    if first < len(text):
        starts.append(first)
    for m in _SENTENCE_GAP.finditer(text):
        if m.end() < len(text):
            starts.append(m.end())
    return starts


def tagged_preview(text: str, tags: list[dict]) -> str:
    """The text with `[tag] ` inserted at the offsets: what the provider sends to the engine."""
    out, last = [], 0
    for t in sorted(tags, key=lambda t: t["at"]):
        out.append(text[last:t["at"]])
        out.append(f"[{t['tag']}] ")
        last = t["at"]
    out.append(text[last:])
    return "".join(out)


# ---------------------------------------------------------------------------------------------------- prompt

def build_prompt(speaker: str, sentences: list[str]) -> str:
    temper = TEMPERAMENT.get(speaker, NEUTRAL)
    numbered = "\n".join(f"{i}: {s}" for i, s in enumerate(sentences))
    cap = math.ceil(len(sentences) / 2)
    return (
        "You place delivery tags for a text-to-speech voice (ElevenLabs v4). The text is Russian; "
        "a speaker reads it aloud in a live show.\n\n"
        f"Speaker: {speaker}. Temperament: {temper}\n\n"
        f"Allowed tags (nothing else): {', '.join(TAGS)}.\n\n"
        "Rules:\n"
        "- A tag goes before a sentence and changes how that sentence is delivered. Follow the meaning of the "
        "sentence: doubt -> skeptical or hesitant, praise -> warmly, a problem -> serious or sighs, "
        "a finding or a turn -> thoughtful or emphatic.\n"
        f"- At most one tag per sentence, at most {cap} tags in total.\n"
        "- Restraint over decoration. Most sentences carry no tag. An empty list is a valid answer.\n"
        "- Never answer with text, only the JSON array.\n\n"
        "Answer with a JSON array only, no prose, no code fence: "
        '[{"s": <sentence number>, "tag": "<tag>"}, ...]. Empty answer: [].\n\n'
        f"Sentences:\n{numbered}\n"
    )


# ---------------------------------------------------------------------------------------------------- runner

def cli_runner(prompt: str, timeout: float) -> str:
    """Run the local Claude Code CLI in print mode, no tools, no saved session; return the `result` string."""
    with tempfile.TemporaryDirectory(prefix="stage-tagger-") as cwd:  # no CLAUDE.md of the repo gets loaded
        proc = subprocess.run(
            ["claude", "-p", "--model", MODEL, "--output-format", "json", "--tools", "",
             "--no-session-persistence", "--disable-slash-commands"],
            input=prompt, capture_output=True, text=True, timeout=timeout, cwd=cwd,
        )
    if proc.returncode != 0:
        raise RuntimeError(f"claude exited with {proc.returncode}: {proc.stderr.strip()[:200]}")
    data = json.loads(proc.stdout)
    if data.get("is_error"):
        raise RuntimeError(f"claude error: {str(data.get('result'))[:200]}")
    return str(data.get("result", ""))


def _first_json_array(raw: str):
    dec = json.JSONDecoder()
    for m in re.finditer(r"\[", raw):
        try:
            value, _ = dec.raw_decode(raw[m.start():])
        except ValueError:
            continue
        if isinstance(value, list):
            return value
    raise ValueError("no JSON array in the answer")


# ---------------------------------------------------------------------------------------------------- cache

def cache_dir() -> Path:
    return Path(os.environ.get("OPENEGIZ_STAGE_TAGS_CACHE") or Path.home() / ".cache" / "openegiz-stage" / "tags")


def cache_key(speaker: str, text: str) -> str:
    return hashlib.sha256((speaker + "\0" + text).encode("utf-8")).hexdigest()[:32]


def _cache_read(key: str) -> list[dict] | None:
    if key in _memory:
        return [dict(t) for t in _memory[key]]
    try:
        data = json.loads((cache_dir() / f"{key}.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(data, list):
        return None
    _memory[key] = data
    return [dict(t) for t in data]


def _cache_write(key: str, tags: list[dict]) -> None:
    _memory[key] = [dict(t) for t in tags]
    try:
        d = cache_dir()
        d.mkdir(parents=True, exist_ok=True)
        tmp = d / f"{key}.json.tmp{os.getpid()}"
        tmp.write_text(json.dumps(tags, ensure_ascii=False), encoding="utf-8")
        tmp.replace(d / f"{key}.json")
    except OSError:
        pass


# ---------------------------------------------------------------------------------------------------- api

def _validate(answer: list, starts: list[int]) -> list[dict]:
    """Whitelist, one tag per sentence, cap of ceil(n/2) (the first ones by order win)."""
    picked: dict[int, str] = {}
    for item in answer:
        if not isinstance(item, dict):
            continue
        s, tag = item.get("s"), item.get("tag")
        if isinstance(s, bool) or not isinstance(s, int) or not 0 <= s < len(starts):
            continue
        if not isinstance(tag, str):
            continue
        tag = tag.strip().strip("[]").strip().lower()
        if tag not in TAGS or s in picked:
            continue
        picked[s] = tag
    cap = math.ceil(len(starts) / 2)
    return [{"at": starts[s], "tag": picked[s]} for s in sorted(picked)[:cap]]


def auto_tags(speaker: str, text: str, timeout: float = 20.0,
              runner: Callable[[str, float], str] | None = None) -> list[dict]:
    """[{"at": int, "tag": str}, ...] sorted by at; `at` is the character offset of a sentence start in `text`."""
    try:
        starts = split_sentences(text)
        if not starts:
            return []
        key = cache_key(speaker, text)
        cached = _cache_read(key)
        if cached is not None:
            return cached
        sentences = [text[a:b].strip() for a, b in zip(starts, starts[1:] + [len(text)])]
        raw = (runner or cli_runner)(build_prompt(speaker, sentences), timeout)
        tags = _validate(_first_json_array(raw), starts)
        _cache_write(key, tags)
        return tags
    except Exception:  # noqa: BLE001 - the contract is "never raises"
        return []


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Show the audio tags auto_tags() picks for a text.")
    ap.add_argument("text")
    ap.add_argument("--speaker", default="host")
    ap.add_argument("--timeout", type=float, default=20.0)
    args = ap.parse_args(argv)
    t0 = time.monotonic()
    tags = auto_tags(args.speaker, args.text, timeout=args.timeout)
    print(json.dumps(tags, ensure_ascii=False))
    print(tagged_preview(args.text, tags))
    print(f"({time.monotonic() - t0:.1f}s)", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
