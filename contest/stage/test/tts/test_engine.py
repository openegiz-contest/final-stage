import json
import tempfile
import threading
import time
import unittest
from pathlib import Path

import support
from support import SHORT, wav_bytes

from engine import Engine, SynthError, cache_key
from providers import ProviderError, ProviderUnavailable


class Fake:
    """A provider that records calls and behaves as told: ok | fail | unavailable | hang."""

    def __init__(self, name, mode="ok", delay=0.0):
        self.name, self.mode, self.delay = name, mode, delay
        self.calls = 0
        self.running = 0
        self.peak = 0
        self.mu = threading.Lock()

    def synth(self, text, voice, settings=None, timeout=None, out_dir=None):
        with self.mu:
            self.calls += 1
            self.running += 1
            self.peak = max(self.peak, self.running)
        try:
            if self.delay:
                time.sleep(self.delay)
            if self.mode == "fail":
                raise ProviderError(f"{self.name} down")
            if self.mode == "unavailable":
                raise ProviderUnavailable(f"{self.name} has no key")
            if self.mode == "hang":
                time.sleep(30)
            out = Path(out_dir) / f"{self.name}-{self.calls}-{threading.get_ident()}.wav"
            out.write_bytes(wav_bytes())
            tokens = text.split()
            words, pos = [], 0
            for i, tok in enumerate(tokens):
                s = text.index(tok, pos)
                pos = s + len(tok)
                words.append({"start_char": s, "end_char": pos, "start_s": i * 0.1, "end_s": (i + 1) * 0.1})
            words[0]["start_char"] = 0
            for a, b in zip(words, words[1:]):
                a["end_char"] = b["start_char"]
            words[-1]["end_char"] = len(text)
            return {"path": str(out), "format": "wav", "duration_s": len(tokens) * 0.1, "words": words}
        finally:
            with self.mu:
                self.running -= 1


def config(timeout=0.5, cooldown=0, concurrency=2):
    return {
        "settings": {"timeout_s": timeout, "cooldown_s": cooldown, "concurrency": concurrency},
        "engines": {"elevenlabs": {"model_id": "m1"}},
        "speakers": {
            "a": {"chain": [{"engine": "elevenlabs", "voice": "v1", "stability": 0.5},
                            {"engine": "yandex", "voice": "filipp"},
                            {"engine": "macos", "voice": "Milena", "rate": 0.5}]},
            "b": {"chain": [{"engine": "macos", "voice": "Milena", "rate": 0.6}]},
        },
    }


class EngineTests(unittest.TestCase):
    def make(self, modes=("ok", "ok", "ok"), **kw):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        provs = {n: Fake(n, m) for n, m in zip(("elevenlabs", "yandex", "macos"), modes)}
        return Engine(config=config(**kw), cache_dir=self.tmp.name, providers=provs), provs

    def test_first_engine_wins_and_response_shape(self):
        eng, p = self.make()
        r = eng.synth("a", "Привет мир")
        self.assertEqual(r["engine"], "elevenlabs")
        self.assertEqual(r["voice"], "v1")
        self.assertRegex(r["audio"], r"^/audio/[0-9a-f]{64}\.wav$")
        self.assertEqual(len(r["words"]), 2)
        self.assertFalse(r["cached"])
        self.assertTrue(eng.audio_path(r["audio"].split("/")[-1]).exists())

    def test_failing_provider_falls_through_and_names_the_engine(self):
        eng, p = self.make(("fail", "fail", "ok"))
        r = eng.synth("a", "Привет мир")
        self.assertEqual(r["engine"], "macos")
        self.assertEqual([t["engine"] for t in r["fallback_from"]], ["elevenlabs", "yandex"])
        self.assertIn("down", r["fallback_from"][0]["error"])
        eng, p = self.make(("unavailable", "ok", "ok"))
        self.assertEqual(eng.synth("a", "Привет мир")["engine"], "yandex")

    def test_timeout_falls_through(self):
        eng, p = self.make(("hang", "ok", "ok"), timeout=0.3)
        t0 = time.time()
        r = eng.synth("a", "Привет мир")
        self.assertEqual(r["engine"], "yandex")
        self.assertIn("timed out", r["fallback_from"][0]["error"])
        self.assertLess(time.time() - t0, 3)

    def test_all_fail(self):
        eng, p = self.make(("fail", "fail", "fail"))
        with self.assertRaises(SynthError) as cm:
            eng.synth("a", "Привет мир")
        self.assertEqual(cm.exception.status, 502)
        self.assertEqual(len(cm.exception.tried), 3)

    def test_cache_hit_returns_without_synthesis(self):
        eng, p = self.make()
        first = eng.synth("a", "Привет мир")
        self.assertEqual(p["elevenlabs"].calls, 1)
        again = eng.synth("a", "Привет мир")
        self.assertEqual(p["elevenlabs"].calls, 1, "no second synthesis")
        self.assertTrue(again["cached"])
        self.assertEqual(again["audio"], first["audio"])
        self.assertEqual(again["words"], first["words"])
        # a new engine instance over the same cache dir hits too (prefetch by another process)
        eng2 = Engine(config=config(), cache_dir=self.tmp.name, providers={n: Fake(n) for n in ("elevenlabs", "yandex", "macos")})
        self.assertTrue(eng2.synth("a", "Привет мир")["cached"])

    def test_cache_key_counts_only_the_pronunciations_the_text_uses(self):
        say = {"README": "ридми"}
        more = {**say, "Финалист Ж": "Финалист Жэ"}
        line = "Мой фаворит — «Забой»."
        self.assertEqual(cache_key("e", "v", {"say": say}, line), cache_key("e", "v", {"say": more}, line))
        coded = "Мой фаворит — Финалист Ж."
        self.assertNotEqual(cache_key("e", "v", {"say": say}, coded), cache_key("e", "v", {"say": more}, coded))
        self.assertNotEqual(cache_key("e", "v", {"say": more}, coded), cache_key("e", "v", {"say": {"Финалист Ж": "Финалист Же"}}, coded))

    def test_cache_key_covers_engine_voice_settings_text(self):
        base = cache_key("e", "v", {"a": 1}, "t")
        for other in (cache_key("e2", "v", {"a": 1}, "t"), cache_key("e", "v2", {"a": 1}, "t"),
                      cache_key("e", "v", {"a": 2}, "t"), cache_key("e", "v", {"a": 1}, "t2")):
            self.assertNotEqual(base, other)
        self.assertEqual(base, cache_key("e", "v", {"a": 1}, "t"))
        eng, p = self.make()
        eng.synth("a", "Привет мир")
        eng.config["engines"]["elevenlabs"]["model_id"] = "m2"  # a settings change is a new key
        self.assertFalse(eng.synth("a", "Привет мир")["cached"])

    def test_cached_fallback_result_is_reused_without_retrying_a_dead_engine(self):
        eng, p = self.make(("fail", "ok", "ok"), cooldown=60)
        eng.synth("a", "Привет мир")
        self.assertEqual(p["elevenlabs"].calls, 1)
        eng.synth("a", "Другой текст здесь")   # elevenlabs is cooling: not tried again
        self.assertEqual(p["elevenlabs"].calls, 1)
        self.assertEqual(p["yandex"].calls, 2)
        again = eng.synth("a", "Привет мир")   # served from the cache of the engine that did it
        self.assertEqual(p["yandex"].calls, 2)
        self.assertEqual(again["engine"], "yandex")

    def test_last_engine_is_tried_even_when_cooling(self):
        eng, p = self.make(("fail", "fail", "ok"), cooldown=60)
        eng.synth("a", "один")
        self.assertEqual(eng.synth("a", "два")["engine"], "macos")

    def test_unavailable_engine_does_not_cool(self):
        eng, p = self.make(("unavailable", "ok", "ok"), cooldown=60)
        eng.synth("a", "один")
        eng.synth("a", "два")
        self.assertEqual(p["elevenlabs"].calls, 2)

    def test_at_most_two_jobs_at_once(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        slow = Fake("macos", delay=0.25)
        eng = Engine(config=config(), cache_dir=self.tmp.name, providers={"macos": slow})
        threads = [threading.Thread(target=eng.synth, args=("b", f"текст номер {i}")) for i in range(6)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        self.assertEqual(slow.calls, 6)
        self.assertEqual(slow.peak, 2)

    def test_identical_requests_in_flight_share_one_job(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        slow = Fake("macos", delay=0.3)
        eng = Engine(config=config(), cache_dir=self.tmp.name, providers={"macos": slow})
        out = []
        threads = [threading.Thread(target=lambda: out.append(eng.synth("b", "один и тот же текст"))) for _ in range(4)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        self.assertEqual(slow.calls, 1)
        self.assertEqual(len({o["audio"] for o in out}), 1)

    def test_bad_requests(self):
        eng, p = self.make()
        with self.assertRaises(SynthError) as cm:
            eng.synth("nobody", "текст")
        self.assertEqual(cm.exception.status, 400)
        with self.assertRaises(SynthError):
            eng.synth("a", "   ")
        with self.assertRaises(SynthError):
            eng.synth("a", "я" * 7000)

    def test_audio_path_is_confined_to_cache_files(self):
        eng, p = self.make()
        for bad in ("../x.wav", "abc.wav", "a" * 64 + ".exe", ("a" * 64) + ".wav/../../x"):
            self.assertIsNone(eng.audio_path(bad))

    def test_shipped_voices_json_is_valid(self):
        cfg = json.loads((support.TTS / "voices.json").read_text("utf-8"))
        want = {"opus-5.5", "sonnet-5.5", "fable-5.1", "gpt-6.1-sol", "gpt-6-astra", "host"}
        self.assertEqual(set(cfg["speakers"]), want)
        for name, sp in cfg["speakers"].items():
            self.assertEqual([c["engine"] for c in sp["chain"]], ["elevenlabs", "yandex", "macos"], name)
        for eng_name, cands in cfg["sample"]["candidates"].items():
            self.assertGreaterEqual(len(cands), 6, eng_name)


if __name__ == "__main__":
    unittest.main()
