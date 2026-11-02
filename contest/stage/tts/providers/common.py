"""Shared pieces of the TTS providers: errors, keys, probing, and word assembly.

Word contract (every provider returns it, the Stage relies on it):
  words = [{start_char, end_char, start_s, end_s}, ...] over the exact input text, one entry per
  whitespace-delimited token ("«Север-7»" is one word, "100:" is one word).
  Characters are partitioned: words[0].start_char == 0, words[i].end_char == words[i+1].start_char,
  words[-1].end_char == len(text). Typing text[:end_char] when the voice reaches end_s (or text[:start_char]
  at start_s) always shows verbatim text. start_s and end_s are non-decreasing; times are clamped to the audio.
"""

from __future__ import annotations

import os
import re
import shutil
import ssl
import subprocess
from pathlib import Path


class ProviderError(Exception):
    """The engine failed (network, HTTP error, bad response). The chain falls through and may cool the engine."""


class ProviderUnavailable(ProviderError):
    """The engine cannot be tried at all (no key, tool missing, voice not installed). Not a fault: no cooldown."""


# ---------------------------------------------------------------------------------------------------- https

def ssl_context() -> ssl.SSLContext:
    """CA bundle for the cloud engines. python.org builds on macOS ship without one: fall back to certifi or
    the system bundle instead of failing with CERTIFICATE_VERIFY_FAILED."""
    if os.environ.get("SSL_CERT_FILE"):
        return ssl.create_default_context()
    try:
        import certifi
        return ssl.create_default_context(cafile=certifi.where())
    except ImportError:
        pass
    for cafile in ("/etc/ssl/cert.pem", "/opt/homebrew/etc/ca-certificates/cert.pem"):
        if Path(cafile).is_file():
            return ssl.create_default_context(cafile=cafile)
    return ssl.create_default_context()


# ---------------------------------------------------------------------------------------------------- keys

def keys_file() -> Path:
    return Path(os.environ.get("OPENEGIZ_STAGE_KEYS") or Path.home() / ".config" / "openegiz-stage" / "keys.env")


def read_keys_file(path: Path | None = None) -> dict[str, str]:
    path = path or keys_file()
    out: dict[str, str] = {}
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return out
    for line in lines:
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        k = k.strip().removeprefix("export ").strip()
        v = v.strip()
        if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
            v = v[1:-1]
        out[k] = v
    return out


def get_key(name: str) -> str | None:
    """Environment first, then the keys file. Empty counts as absent."""
    return os.environ.get(name) or read_keys_file().get(name) or None


# ------------------------------------------------------------------------------------------------ probing

def probe_duration(path: str | Path) -> float | None:
    """Duration of an audio file in seconds: afinfo (macOS), then ffprobe. None when neither can read it."""
    afinfo = shutil.which("afinfo")
    if afinfo:
        try:
            r = subprocess.run([afinfo, str(path)], capture_output=True, text=True, timeout=10)
            m = re.search(r"estimated duration:\s*([0-9.]+)", r.stdout)
            if r.returncode == 0 and m:
                return float(m.group(1))
        except (OSError, subprocess.SubprocessError):
            pass
    ffprobe = shutil.which("ffprobe")
    if ffprobe:
        try:
            r = subprocess.run([ffprobe, "-v", "error", "-show_entries", "format=duration", "-of",
                                "default=nw=1:nk=1", str(path)], capture_output=True, text=True, timeout=10)
            if r.returncode == 0 and r.stdout.strip():
                return float(r.stdout.strip())
        except (OSError, ValueError, subprocess.SubprocessError):
            pass
    return None


# ------------------------------------------------------------------------------------------ word assembly

TOKEN = re.compile(r"\S+")


def tokenize(text: str) -> list[tuple[int, int]]:
    return [(m.start(), m.end()) for m in TOKEN.finditer(text)]


def norm(s: str) -> str:
    """Comparable form of a word: letters and digits only, casefolded, ё = е."""
    return "".join(c for c in s.casefold() if c.isalnum()).replace("ё", "е")


def assemble(text: str, spans: list[tuple[int, int]], times: list[tuple[float, float] | None],
             duration: float) -> list[dict]:
    """Build the final word list. times[i] is (start_s, end_s) of token i, or None when unknown (interpolated)."""
    n = len(spans)
    if n == 0:
        return []
    known = [i for i, t in enumerate(times) if t is not None]
    start = [0.0] * n
    end = [0.0] * n
    if not known:
        # No timing at all: spread over the audio by character count.
        total = sum(e - s for s, e in spans) or 1
        acc = 0
        for i, (s, e) in enumerate(spans):
            start[i] = duration * acc / total
            acc += e - s
            end[i] = duration * acc / total
    else:
        for i in known:
            start[i], end[i] = times[i]
        # Unknown tokens: split the gap between known neighbours evenly.
        i = 0
        while i < n:
            if times[i] is not None:
                i += 1
                continue
            j = i
            while j < n and times[j] is None:
                j += 1
            lo = end[i - 1] if i > 0 else 0.0
            hi = start[j] if j < n else duration
            hi = max(hi, lo)
            for k in range(i, j):
                start[k] = lo + (hi - lo) * (k - i) / (j - i)
                end[k] = lo + (hi - lo) * (k - i + 1) / (j - i)
            i = j
    words = []
    prev_start = 0.0
    for i, (s, e) in enumerate(spans):
        a = min(max(start[i], prev_start), duration)
        b = min(max(end[i], a), duration)
        prev_start = a
        words.append({"start_char": s, "end_char": e, "start_s": round(a, 3), "end_s": round(b, 3)})
    # Partition the characters.
    words[0]["start_char"] = 0
    for i in range(len(words) - 1):
        words[i]["end_char"] = words[i + 1]["start_char"]
    words[-1]["end_char"] = len(text)
    return words


def words_from_ranges(text: str, ranges: list[tuple[int, int, float]], duration: float) -> list[dict]:
    """ranges: (start_char, end_char, start_s) per spoken word, char offsets into `text`.
    Each range goes to the token containing its first character; a token starts when its first range starts and
    ends when the next token starts (the last one at `duration`). Used when the engine reports starts only."""
    spans = tokenize(text)
    times: list[tuple[float, float] | None] = [None] * len(spans)
    starts: dict[int, float] = {}
    ti = 0
    for s, _e, t in sorted(ranges):
        while ti < len(spans) and spans[ti][1] <= s:
            ti += 1
        if ti < len(spans) and ti not in starts:
            starts[ti] = t
    order = sorted(starts)
    for k, i in enumerate(order):
        nxt = starts[order[k + 1]] if k + 1 < len(order) else duration
        times[i] = (starts[i], max(nxt, starts[i]))
    return assemble(text, spans, times, duration)


def words_from_chars(text: str, chars: list[str], starts: list[float], ends: list[float],
                     duration: float) -> list[dict]:
    """Per-character timing (ElevenLabs). The characters normally equal the input text; when they do not, the
    whitespace-delimited words of the alignment are matched to the tokens of the text instead."""
    spans = tokenize(text)
    times: list[tuple[float, float] | None] = [None] * len(spans)
    if "".join(chars) == text and len(chars) == len(starts) == len(ends):
        for i, (s, e) in enumerate(spans):
            times[i] = (starts[s], ends[e - 1])
        return assemble(text, spans, times, duration)
    items = []
    joined = "".join(chars)
    for m in TOKEN.finditer(joined):
        # `chars` entries may be multi-character in odd cases; index timing by character position.
        a, b = m.start(), m.end()
        if b <= len(starts) and b <= len(ends):
            items.append((m.group(), starts[a], ends[b - 1]))
    return words_from_items(text, items, duration)


def words_from_items(text: str, items: list[tuple[str, float, float]], duration: float) -> list[dict]:
    """Word strings with times and no offsets (Yandex): align them to the tokens of the text in order.
    items: (word, start_s, end_s). A mismatch (digits spoken as words, a dropped word) is resynchronised by
    looking a few items and tokens ahead; what cannot be matched is interpolated."""
    spans = tokenize(text)
    tn = [norm(text[s:e]) for s, e in spans]
    times: list[tuple[float, float] | None] = [None] * len(spans)

    def put(j: int, a: float, b: float) -> None:
        old = times[j]
        times[j] = (a, b) if old is None else (min(old[0], a), max(old[1], b))

    j = 0   # token
    off = 0  # consumed length of the token's normalised form
    k = 0   # item
    LOOK = 6
    while k < len(items) and j < len(spans):
        w, a, b = items[k]
        wn = norm(w)
        if not wn:
            k += 1
            continue
        if not tn[j]:  # a token of punctuation only (a dash): no item belongs to it
            j += 1
            off = 0
            continue
        if tn[j].startswith(wn, off):
            put(j, a, b)
            off += len(wn)
            k += 1
            if off >= len(tn[j]):
                j += 1
                off = 0
            continue
        # Mismatch: find the nearest (item k2 >= k, token j2 > j) pair that matches.
        best = None
        for dk in range(0, LOOK):
            for dj in range(1, LOOK):
                if k + dk >= len(items) or j + dj >= len(spans):
                    continue
                w2 = norm(items[k + dk][0])
                if w2 and tn[j + dj].startswith(w2) and (best is None or dk + dj < best[0] + best[1]):
                    best = (dk, dj)
        if best is None:
            put(j, a, b)  # positional: this item stands for this token
            k += 1
            j += 1
            off = 0
        else:
            dk, dj = best
            for q in range(k, k + dk):
                put(j, items[q][1], items[q][2])
            k += dk
            j += dj
            off = 0
    if k < len(items) and j >= len(spans) and spans:
        last = len(spans) - 1  # surplus items: fold into the last token
        for q in range(k, len(items)):
            put(last, items[q][1], items[q][2])
    return assemble(text, spans, times, duration)


def utf16_to_cp(text: str) -> list[int]:
    """Map a UTF-16 code-unit offset to a code-point offset (len = utf16 length + 1)."""
    table: list[int] = []
    for i, ch in enumerate(text):
        table.append(i)
        if ord(ch) > 0xFFFF:
            table.append(i)
    table.append(len(text))
    return table
