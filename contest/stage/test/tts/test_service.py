import json
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.parse
import urllib.request
from http.server import ThreadingHTTPServer

import support
from support import FIXTURES, SHORT, check_words

from engine import Engine
from providers import default_providers
import serve

ORIGIN = "http://127.0.0.1:8780"


class ServiceWithMacOS(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cfg = json.loads((support.TTS / "voices.json").read_text("utf-8"))
        # no keys in the tests: elevenlabs and yandex are unavailable, every speaker falls to macOS
        import os
        cls.env_keys = {k: os.environ.pop(k, None) for k in ("ELEVENLABS_API_KEY", "YANDEX_API_KEY")}
        os.environ["OPENEGIZ_STAGE_KEYS"] = "/nonexistent/keys.env"
        cls.engine = Engine(config=cfg, cache_dir=cls.tmp.name, providers=default_providers())
        cls.srv = ThreadingHTTPServer(("127.0.0.1", 0), serve.make_handler(cls.engine, ORIGIN))
        cls.srv.daemon_threads = True
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()
        cls.base = f"http://127.0.0.1:{cls.srv.server_port}"

    @classmethod
    def tearDownClass(cls):
        import os
        cls.srv.shutdown()
        cls.tmp.cleanup()
        os.environ.pop("OPENEGIZ_STAGE_KEYS", None)
        for k, v in cls.env_keys.items():
            if v is not None:
                os.environ[k] = v

    def get(self, path, headers=None):
        req = urllib.request.Request(self.base + path, headers=headers or {})
        return urllib.request.urlopen(req, timeout=60)

    def synth(self, speaker, text):
        q = urllib.parse.urlencode({"speaker": speaker, "text": text})
        with self.get("/synth?" + q) as r:
            self.assertEqual(r.headers["Access-Control-Allow-Origin"], ORIGIN)
            return json.loads(r.read())

    def test_synth_audio_and_cache(self):
        t0 = time.time()
        a = self.synth("opus-5.5", SHORT)
        first = time.time() - t0
        self.assertEqual(a["engine"], "macos")
        self.assertEqual([t["engine"] for t in a["fallback_from"]], ["elevenlabs", "yandex"])
        check_words(self, SHORT, a["words"], a["duration_s"])
        t0 = time.time()
        b = self.synth("opus-5.5", SHORT)
        second = time.time() - t0
        self.assertTrue(b["cached"])
        self.assertEqual(a["audio"], b["audio"])
        self.assertLess(second, 0.25)
        print(f"\n  service round trip, {len(SHORT.split())} words: first {first:.2f} s, cached {second*1000:.0f} ms")
        with self.get(a["audio"]) as r:
            self.assertEqual(r.headers["Content-Type"], "audio/wav")
            body = r.read()
        self.assertEqual(body[:4], b"RIFF")
        # Range
        with self.get(a["audio"], {"Range": "bytes=0-99"}) as r:
            self.assertEqual(r.status, 206)
            self.assertEqual(len(r.read()), 100)
            self.assertTrue(r.headers["Content-Range"].startswith("bytes 0-99/"))

    def test_speakers_sound_different(self):
        a = self.synth("opus-5.5", "Проверка голоса номер один.")
        b = self.synth("sonnet-5.5", "Проверка голоса номер один.")
        self.assertNotEqual(a["audio"], b["audio"])
        self.assertNotEqual(a["duration_s"], b["duration_s"])

    def test_90_word_message_round_trip(self):
        text = (FIXTURES / "judge90.txt").read_text("utf-8").strip()
        t0 = time.time()
        a = self.synth("fable-5.1", text)
        dt = time.time() - t0
        print(f"\n  service round trip, {len(text.split())} words, {a['duration_s']:.1f} s of audio: {dt:.2f} s")
        check_words(self, text, a["words"], a["duration_s"])

    def test_errors(self):
        for path, code in (("/synth?speaker=nobody&text=hi", 400), ("/synth?speaker=host", 400),
                           ("/audio/" + "0" * 64 + ".wav", 404), ("/nothing", 404),
                           ("/audio/..%2F..%2Fetc%2Fpasswd", 404)):
            with self.assertRaises(urllib.error.HTTPError) as cm:
                self.get(path)
            self.assertEqual(cm.exception.code, code, path)
            self.assertEqual(cm.exception.headers["Access-Control-Allow-Origin"], ORIGIN)

    def test_preflight_and_speakers(self):
        req = urllib.request.Request(self.base + "/synth", method="OPTIONS")
        with urllib.request.urlopen(req) as r:
            self.assertEqual(r.status, 204)
            self.assertEqual(r.headers["Access-Control-Allow-Origin"], ORIGIN)
        with self.get("/speakers") as r:
            sp = json.loads(r.read())
        self.assertEqual(set(sp), {"opus-5.5", "sonnet-5.5", "fable-5.1", "gpt-6.1-sol", "gpt-6-astra", "host"})


if __name__ == "__main__":
    unittest.main()
