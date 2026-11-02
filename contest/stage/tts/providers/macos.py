"""macOS provider: the Swift tool (swift/macos_tts.swift -> bin/macos_tts) over AVSpeechSynthesizer.write()."""

from __future__ import annotations

import json
import subprocess
import tempfile
from pathlib import Path

from .common import ProviderError, ProviderUnavailable, probe_duration, utf16_to_cp, words_from_ranges

TTS_DIR = Path(__file__).resolve().parent.parent
SOURCE = TTS_DIR / "swift" / "macos_tts.swift"
BINARY = TTS_DIR / "bin" / "macos_tts"


def build(force: bool = False) -> Path:
    """Compile the tool when the binary is missing or older than the source."""
    if not force and BINARY.exists() and BINARY.stat().st_mtime >= SOURCE.stat().st_mtime:
        return BINARY
    BINARY.parent.mkdir(parents=True, exist_ok=True)
    try:
        r = subprocess.run(["swiftc", "-O", str(SOURCE), "-o", str(BINARY)], capture_output=True, text=True,
                           timeout=300)
    except (OSError, subprocess.SubprocessError) as e:
        raise ProviderUnavailable(f"swiftc failed to start: {e}") from e
    if r.returncode != 0:
        raise ProviderUnavailable(f"swiftc failed: {r.stderr.strip()[:300]}")
    return BINARY


def fix_last_word(ranges: list[tuple[int, int, float]], duration: float) -> list[tuple[int, int, float]]:
    """AVSpeechSynthesizer reports the last word late: its callback comes after the final audio buffers (measured:
    start 35.21 s of a 35.23 s message, while the word is ~0.6 s long and the previous word starts at 34.41 s).
    When the last word starts later than the room its length needs, pull it back by the speaking rate of the
    words before it."""
    if len(ranges) < 4:
        return ranges
    ranges = sorted(ranges)
    tail = ranges[-7:-1]
    chars = sum(b - a for a, b, _ in tail[:-1])
    secs = tail[-1][2] - tail[0][2]
    if chars <= 0 or secs <= 0:
        return ranges
    a, b, t = ranges[-1]
    expected = (b - a) * secs / chars
    if duration - t < 0.6 * expected:
        t = max(ranges[-2][2] + 0.05, duration - expected * 1.15)
        ranges[-1] = (a, b, min(t, ranges[-1][2]))
    return ranges


class MacOS:
    name = "macos"

    def synth(self, text: str, voice: str, settings: dict | None = None, timeout: float | None = None,
              out_dir: str | Path | None = None) -> dict:
        s = settings or {}
        binary = build()
        out_dir = Path(out_dir or tempfile.mkdtemp(prefix="stage-tts-"))
        out_dir.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile("w", suffix=".txt", dir=out_dir, delete=False, encoding="utf-8") as f:
            f.write(text)
            text_file = f.name
        wav = tempfile.NamedTemporaryFile(suffix=".wav", dir=out_dir, delete=False)
        wav.close()
        cmd = [str(binary), "--text-file", text_file, "--out", wav.name, "--voice", voice or "Milena"]
        if s.get("rate") is not None:
            cmd += ["--rate", str(s["rate"])]
        if s.get("pitch") is not None:
            cmd += ["--pitch", str(s["pitch"])]
        try:
            r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout or 60)
        except subprocess.TimeoutExpired as e:
            raise ProviderError(f"macos tool timed out after {timeout}s") from e
        except OSError as e:
            raise ProviderUnavailable(f"macos tool cannot run: {e}") from e
        finally:
            Path(text_file).unlink(missing_ok=True)
        if r.returncode != 0:
            Path(wav.name).unlink(missing_ok=True)
            err = r.stderr.strip()[:300]
            cls = ProviderUnavailable if "voice not installed" in err else ProviderError
            raise cls(f"macos tool: {err or 'exit ' + str(r.returncode)}")
        try:
            data = json.loads(r.stdout)
        except ValueError as e:
            raise ProviderError(f"macos tool: bad output: {r.stdout[:200]}") from e
        table = utf16_to_cp(text)
        ranges = []
        for w in data["words"]:
            a = table[min(w["loc"], len(table) - 1)]
            b = table[min(w["loc"] + w["len"], len(table) - 1)]
            ranges.append((a, b, w["start_s"]))
        duration = float(data["duration_s"])
        ranges = fix_last_word(ranges, duration)
        return {
            "path": wav.name, "format": "wav", "duration_s": round(duration, 3),
            "words": words_from_ranges(text, ranges, duration),
            "stats": {"synth_s": data.get("synth_s"), "first_audio_s": data.get("first_audio_s"),
                      "sample_rate": data.get("sample_rate")},
        }
