import struct
import unittest
import wave

import support
from support import FIXTURES, SHORT, check_words

from providers import ProviderUnavailable
from providers.macos import MacOS
from providers.common import probe_duration


def low_energy_near(path, t, radius=0.15, rel=0.05):
    """True when the audio has a quiet 10 ms frame within `radius` seconds of t (a pause before a word)."""
    w = wave.open(str(path))
    sr, n = w.getframerate(), w.getnframes()
    d = struct.unpack("<%dh" % n, w.readframes(n))
    hop = sr // 100
    env = [(sum(v * v for v in d[i:i + hop]) / hop) ** 0.5 for i in range(0, n - hop, hop)]
    thr = max(env) * rel
    lo, hi = max(int((t - radius) * 100), 0), min(int((t + radius) * 100) + 1, len(env))
    return any(e < thr for e in env[lo:hi])


class MacOSProvider(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.p = MacOS()

    def test_short_phrase_end_to_end(self):
        r = self.p.synth(SHORT, "Milena", {"rate": 0.5, "pitch": 1.0})
        self.assertEqual(r["format"], "wav")
        real = probe_duration(r["path"])
        self.assertIsNotNone(real, "afinfo reads the file")
        self.assertAlmostEqual(real, r["duration_s"], delta=0.05)
        self.assertGreater(r["duration_s"], 5)
        check_words(self, SHORT, r["words"], r["duration_s"])

    def test_judge_message_90_words(self):
        text = (FIXTURES / "judge90.txt").read_text("utf-8").strip()
        r = self.p.synth(text, "Milena", {"rate": 0.5, "pitch": 1.0})
        check_words(self, text, r["words"], r["duration_s"])
        # Timing is not just plausible: words after a sentence end or colon sit next to a real pause in the audio.
        # Measured on this text: 12 of 13 punctuation boundaries within 0.15 s, the worst at 0.4 s (the callback
        # around an opening quote runs early), so the test asks for most within 0.15 s and all within 0.5 s.
        near, far, checked = 0, [], 0
        for a, b in zip(r["words"], r["words"][1:]):
            prev = text[a["start_char"]:a["end_char"]].strip()
            if prev.endswith((".", ":", ",")):
                checked += 1
                if low_energy_near(r["path"], b["start_s"], 0.15):
                    near += 1
                elif not low_energy_near(r["path"], b["start_s"], 0.5):
                    far.append((b["start_s"], prev))
        self.assertGreaterEqual(checked, 8)
        self.assertEqual(far, [])
        self.assertGreaterEqual(near / checked, 0.7)

    def test_rate_and_pitch_change_the_audio(self):
        slow = self.p.synth(SHORT, "Milena", {"rate": 0.42, "pitch": 1.0})["duration_s"]
        fast = self.p.synth(SHORT, "Milena", {"rate": 0.58, "pitch": 1.0})["duration_s"]
        self.assertGreater(slow, fast + 1.0)

    def test_non_bmp_text_keeps_code_point_offsets(self):
        text = "Привет 🙂 мир, это проверка смещений."
        r = self.p.synth(text, "Milena")
        check_words(self, text, r["words"], r["duration_s"], tol=0.5)

    def test_missing_voice_is_unavailable(self):
        with self.assertRaises(ProviderUnavailable):
            self.p.synth("Привет", "NoSuchVoice")


if __name__ == "__main__":
    unittest.main()
