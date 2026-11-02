import base64
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import support
from support import SHORT, Mock, check_words, wav_bytes

from providers import ProviderError, ProviderUnavailable
from providers.common import read_keys_file, words_from_items, words_from_chars
from providers.elevenlabs import ElevenLabs
from providers.yandex import Yandex, parse_stream


def eleven_payload(text, per_char=0.06, alignment_key="alignment", normalized=None):
    chars = list(text)
    starts = [round(i * per_char, 3) for i in range(len(chars))]
    ends = [round((i + 1) * per_char, 3) for i in range(len(chars))]
    al = {"characters": chars, "character_start_times_seconds": starts, "character_end_times_seconds": ends}
    out = {"audio_base64": base64.b64encode(b"ID3fakeaudio").decode(), "normalized_alignment": normalized or al}
    out[alignment_key] = al
    return out


class ElevenLabsMock(unittest.TestCase):
    def setUp(self):
        self.env = mock.patch.dict(os.environ, {"ELEVENLABS_API_KEY": "k-test"})
        self.env.start()

    def tearDown(self):
        self.env.stop()

    def test_request_and_parse(self):
        m = Mock(lambda p, h, b: (200, json.dumps(eleven_payload(b["text"])).encode()))
        try:
            r = ElevenLabs().synth(SHORT, "VOICE123", {"base_url": m.url, "stability": 0.6, "speed": 0.95}, timeout=5)
        finally:
            m.close()
        call = m.calls[0]
        self.assertEqual(call["path"], "/v1/text-to-speech/VOICE123/with-timestamps?output_format=mp3_44100_128")
        self.assertEqual(call["headers"]["xi-api-key"], "k-test")
        self.assertEqual(call["body"]["model_id"], "eleven_multilingual_v2")
        self.assertEqual(call["body"]["voice_settings"], {"stability": 0.6, "speed": 0.95})
        self.assertEqual(call["body"]["text"], SHORT)
        self.assertEqual(r["format"], "mp3")
        self.assertTrue(Path(r["path"]).read_bytes().startswith(b"ID3"))
        # fake audio cannot be probed: duration falls back to the last character end
        self.assertAlmostEqual(r["duration_s"], len(SHORT) * 0.06, places=2)
        check_words(self, SHORT, r["words"], r["duration_s"])
        first = r["words"][0]
        self.assertEqual(SHORT[first["start_char"]:first["end_char"]].strip(), "Коллеги,")
        self.assertAlmostEqual(first["start_s"], 0.0)
        self.assertAlmostEqual(first["end_s"], 8 * 0.06, places=2)  # "Коллеги," is 8 characters

    def test_model_id_configurable(self):
        m = Mock(lambda p, h, b: (200, json.dumps(eleven_payload(b["text"])).encode()))
        try:
            ElevenLabs().synth("Привет мир", "V", {"base_url": m.url, "model_id": "eleven_v3"}, timeout=5)
        finally:
            m.close()
        self.assertEqual(m.calls[0]["body"]["model_id"], "eleven_v3")

    def test_alignment_of_different_characters_is_matched_by_words(self):
        text = "Набрала 86 баллов"
        spoken = "Набрала восемьдесят шесть баллов"
        payload = eleven_payload(text, normalized=None)
        # the service returns the normalised characters only
        payload["alignment"] = None
        payload["normalized_alignment"] = eleven_payload(spoken)["alignment"]
        m = Mock(lambda p, h, b: (200, json.dumps(payload).encode()))
        try:
            r = ElevenLabs().synth(text, "V", {"base_url": m.url}, timeout=5)
        finally:
            m.close()
        check_words(self, text, r["words"], r["duration_s"])
        self.assertEqual(len(r["words"]), 3)
        # "86" spans "восемьдесят шесть"
        self.assertAlmostEqual(r["words"][1]["start_s"], 8 * 0.06, places=2)
        self.assertAlmostEqual(r["words"][1]["end_s"], 25 * 0.06, places=2)

    def test_errors(self):
        m = Mock(lambda p, h, b: (401, b'{"detail":{"status":"invalid_api_key"}}'))
        try:
            with self.assertRaises(ProviderError) as cm:
                ElevenLabs().synth("Привет", "V", {"base_url": m.url}, timeout=5)
        finally:
            m.close()
        self.assertIn("401", str(cm.exception))
        m = Mock(lambda p, h, b: (200, b'{"audio_base64": "AAAA"}'))
        try:
            with self.assertRaises(ProviderError):
                ElevenLabs().synth("Привет", "V", {"base_url": m.url}, timeout=5)
        finally:
            m.close()

    def test_no_key_is_unavailable(self):
        with mock.patch.dict(os.environ, {"OPENEGIZ_STAGE_KEYS": "/nonexistent/keys.env"}):
            os.environ.pop("ELEVENLABS_API_KEY")
            with self.assertRaises(ProviderUnavailable):
                ElevenLabs().synth("Привет", "V")


def yandex_stream(text_words, wrap=True, split_at=None):
    """A streamed body: two audio chunks and wordTimings (startMs counted from the start of the stream)."""
    t = 0
    timings = []
    for w in text_words:
        ln = 90 + 40 * len(w)
        timings.append({"word": w, "startMs": str(t), "lengthMs": str(ln)})
        t += ln + 30
    split_at = split_at or len(timings) // 2
    chunks = [
        {"audioChunk": {"data": base64.b64encode(b"ID3chunk1").decode()}, "wordTimings": timings[:split_at]},
        {"audioChunk": {"data": base64.b64encode(b"chunk2").decode()}, "wordTimings": timings[split_at:]},
    ]
    return ("\n".join(json.dumps({"result": c} if wrap else c) for c in chunks) + "\n").encode()


class YandexMock(unittest.TestCase):
    def setUp(self):
        self.env = mock.patch.dict(os.environ, {"YANDEX_API_KEY": "y-test", "YANDEX_FOLDER_ID": "folder1"})
        self.env.start()

    def tearDown(self):
        self.env.stop()

    def test_parse_stream_shapes(self):
        words = ["привет", "мир"]
        for wrap in (True, False):
            audio, items = parse_stream(yandex_stream(words, wrap=wrap, split_at=1))
            self.assertEqual(audio, b"ID3chunk1chunk2")
            self.assertEqual([w for w, _, _ in items], words)
        # snake_case and a JSON array of objects are accepted too
        body = json.dumps([{"audio_chunk": {"data": base64.b64encode(b"x").decode()},
                            "word_timings": [{"word": "а", "start_ms": 10, "length_ms": 20}]}])
        audio, items = parse_stream(body)
        self.assertEqual(items, [("а", 0.01, 0.03)])

    def test_request_and_words_with_spoken_numbers(self):
        # the service reads "86" as two words and "100" as one: the aligner resynchronises
        spoken = ["Коллеги", "команда", "Север", "семь", "набрала", "восемьдесят", "шесть", "баллов", "из", "сто",
                  "диспетчер", "не", "терял", "самосвалы", "но", "карта", "простоя", "осталась", "без", "единого",
                  "пояснения"]
        m = Mock(lambda p, h, b: (200, yandex_stream(spoken)))
        try:
            r = Yandex().synth(SHORT, "filipp", {"base_url": m.url, "role": "good", "speed": 0.95}, timeout=5)
        finally:
            m.close()
        call = m.calls[0]
        self.assertEqual(call["path"], "/tts/v3/utteranceSynthesis")
        self.assertEqual(call["headers"]["authorization"], "Api-Key y-test")
        self.assertEqual(call["headers"]["x-folder-id"], "folder1")
        self.assertEqual(call["body"]["hints"], [{"voice": "filipp"}, {"role": "good"}, {"speed": 0.95}])
        self.assertEqual(call["body"]["outputAudioSpec"], {"containerAudio": {"containerAudioType": "MP3"}})
        self.assertTrue(call["body"]["unsafeMode"])
        self.assertEqual(r["format"], "mp3")
        check_words(self, SHORT, r["words"], r["duration_s"])
        tokens = SHORT.split()
        i86 = tokens.index("86")
        # "86" is spoken as two words (indices 5, 6): it spans both, and the next token starts after them
        stream = [json.loads(line)["result"] for line in yandex_stream(spoken).decode().splitlines()]
        timings = [t for c in stream for t in c["wordTimings"]]
        want_start = int(timings[5]["startMs"]) / 1000
        want_end = (int(timings[6]["startMs"]) + int(timings[6]["lengthMs"])) / 1000
        self.assertAlmostEqual(r["words"][i86]["start_s"], want_start, places=2)
        self.assertAlmostEqual(r["words"][i86]["end_s"], want_end, places=2)
        self.assertAlmostEqual(r["words"][i86 + 1]["start_s"], int(timings[7]["startMs"]) / 1000, places=2)

    def test_aligner_resync_exact(self):
        text = "Набрала 86 баллов из 100: хорошо."
        items = [("Набрала", 0, 1), ("восемьдесят", 1, 2), ("шесть", 2, 3), ("баллов", 3, 4), ("из", 4, 5),
                 ("сто", 5, 6), ("хорошо", 6, 7)]
        words = words_from_items(text, items, 7.0)
        got = [(text[w["start_char"]:w["end_char"]].strip(), w["start_s"], w["end_s"]) for w in words]
        self.assertEqual(got, [("Набрала", 0, 1), ("86", 1, 3), ("баллов", 3, 4), ("из", 4, 5), ("100:", 5, 6),
                               ("хорошо.", 6, 7)])

    def test_errors(self):
        m = Mock(lambda p, h, b: (403, b'{"code":7,"message":"Permission denied"}'))
        try:
            with self.assertRaises(ProviderError) as cm:
                Yandex().synth("Привет", "filipp", {"base_url": m.url}, timeout=5)
        finally:
            m.close()
        self.assertIn("403", str(cm.exception))
        with self.assertRaises(ProviderError):
            parse_stream(b'{"result": {"textChunk": {"text": "x"}}}')

    def test_no_key_is_unavailable(self):
        with mock.patch.dict(os.environ, {"OPENEGIZ_STAGE_KEYS": "/nonexistent/keys.env"}):
            os.environ.pop("YANDEX_API_KEY")
            with self.assertRaises(ProviderUnavailable):
                Yandex().synth("Привет", "filipp")


class KeysFile(unittest.TestCase):
    def test_format(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "keys.env"
            p.write_text('# comment\nELEVENLABS_API_KEY=abc\nexport YANDEX_API_KEY="q w"\n\nYANDEX_FOLDER_ID = f1\n')
            self.assertEqual(read_keys_file(p), {"ELEVENLABS_API_KEY": "abc", "YANDEX_API_KEY": "q w",
                                                 "YANDEX_FOLDER_ID": "f1"})
            with mock.patch.dict(os.environ, {"OPENEGIZ_STAGE_KEYS": str(p)}):
                os.environ.pop("ELEVENLABS_API_KEY", None)
                from providers.common import get_key
                self.assertEqual(get_key("ELEVENLABS_API_KEY"), "abc")
                os.environ["ELEVENLABS_API_KEY"] = "from-env"
                self.assertEqual(get_key("ELEVENLABS_API_KEY"), "from-env")


if __name__ == "__main__":
    unittest.main()
