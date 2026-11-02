import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import support

ENV = {**os.environ, "OPENEGIZ_STAGE_KEYS": "/nonexistent/keys.env"}
ENV.pop("ELEVENLABS_API_KEY", None)
ENV.pop("YANDEX_API_KEY", None)


class Scripts(unittest.TestCase):
    def test_prerender_fills_cache_and_writes_manifest(self):
        with tempfile.TemporaryDirectory() as d:
            script = Path(d) / "intro.json"
            script.write_text(json.dumps([
                {"id": "intro-1", "speaker": "host", "text": "Добрый вечер, начинаем финал."},
                {"speaker": "opus-5.5", "text": "Я Opus, и я спокоен."},
                {"id": "dup", "speaker": "host", "text": "Добрый вечер, начинаем финал."},
            ], ensure_ascii=False))
            cache = Path(d) / "cache"
            r = subprocess.run([sys.executable, str(support.TTS / "prerender.py"), str(script), "--cache", str(cache)],
                               capture_output=True, text=True, env=ENV, timeout=120)
            self.assertEqual(r.returncode, 0, r.stderr)
            m = json.loads((Path(d) / "intro.manifest.json").read_text("utf-8"))
            self.assertEqual([x["id"] for x in m], ["intro-1", "1", "dup"])
            self.assertEqual(m[0]["audio"], m[2]["audio"], "same speaker and text share one cache entry")
            for x in m:
                self.assertTrue(Path(x["file"]).is_file())
                self.assertEqual(x["engine"], "macos")
                self.assertTrue(x["words"])
            self.assertEqual(len(list(cache.glob("*.wav"))), 2)

    def test_sample_macos_makes_six_files_and_index(self):
        with tempfile.TemporaryDirectory() as d:
            r = subprocess.run([sys.executable, str(support.TTS / "sample.py"), "--engine", "macos", "--out", d],
                               capture_output=True, text=True, env=ENV, timeout=120)
            self.assertEqual(r.returncode, 0, r.stderr)
            files = sorted(p.name for p in Path(d).glob("*.wav"))
            self.assertEqual(len(files), 6)
            self.assertTrue(files[0].startswith("01-") and files[5].startswith("06-"))
            page = (Path(d) / "index.html").read_text("utf-8")
            for f in files:
                self.assertIn(f'src="{f}"', page)
            self.assertIn("один и тот же голос", page)

    def test_sample_without_keys_reports_instead_of_crashing(self):
        with tempfile.TemporaryDirectory() as d:
            r = subprocess.run([sys.executable, str(support.TTS / "sample.py"), "--engine", "elevenlabs", "--out", d],
                               capture_output=True, text=True, env=ENV, timeout=60)
            self.assertEqual(r.returncode, 1)
            self.assertIn("ELEVENLABS_API_KEY", r.stderr)
            self.assertIn("не получилось", (Path(d) / "index.html").read_text("utf-8"))


if __name__ == "__main__":
    unittest.main()
