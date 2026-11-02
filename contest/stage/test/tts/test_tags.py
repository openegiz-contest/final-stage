"""Audio tags: inserted only into the spoken text, words stay over the original text, the engine passes them
to engines that take them and keys the cache on them."""

import tempfile
import unittest

import support  # noqa: F401  (import path)
from engine import Engine
from providers.common import words_from_chars
from providers.elevenlabs import untag_alignment, with_tags
from test_engine import Fake

TEXT = "Коллеги, «Север-7» набрал 86. Но карта простоя пуста."


def fake_alignment(spoken: str) -> dict:
    """One character every 0.05 s, as ElevenLabs returns it: the characters equal the spoken text."""
    n = len(spoken)
    return {"characters": list(spoken), "character_start_times_seconds": [i * 0.05 for i in range(n)],
            "character_end_times_seconds": [(i + 1) * 0.05 for i in range(n)]}


class TagTests(unittest.TestCase):
    def test_tags_go_into_the_spoken_text_only(self):
        tags = [{"at": 0, "tag": "thoughtful"}, {"at": TEXT.index("Но"), "tag": "sighs"}]
        spoken, index = with_tags(TEXT, tags)
        self.assertEqual(spoken, "[thoughtful] Коллеги, «Север-7» набрал 86. [sighs] Но карта простоя пуста.")
        self.assertEqual("".join(spoken[k] for k, i in enumerate(index) if i is not None), TEXT)

    def test_bad_tags_are_dropped(self):
        spoken, _ = with_tags(TEXT, [{"at": 999, "tag": "x"}, {"at": 0, "tag": "a]b"}, {"at": "0", "tag": "x"},
                                     {"at": 3, "tag": ""}])
        self.assertEqual(spoken, TEXT)

    def test_words_are_over_the_original_text_and_skip_the_tag_time(self):
        tags = [{"at": 0, "tag": "thoughtful"}, {"at": TEXT.index("Но"), "tag": "sighs"}]
        spoken, index = with_tags(TEXT, tags)
        chars, starts, ends = untag_alignment(spoken, index, fake_alignment(spoken), TEXT)
        self.assertEqual("".join(chars), TEXT)
        words = words_from_chars(TEXT, chars, starts, ends, len(spoken) * 0.05)
        self.assertEqual(words[0]["start_char"], 0)
        self.assertEqual(words[-1]["end_char"], len(TEXT))
        no = next(w for w in words if TEXT[w["start_char"]:w["end_char"]].startswith("Но"))
        self.assertAlmostEqual(no["start_s"], spoken.index("Но") * 0.05)

    def test_normalised_alignment_drops_tag_marks(self):
        spoken, index = with_tags(TEXT, [{"at": 0, "tag": "calm"}])
        al = fake_alignment(spoken.replace("86", "восемьдесят шесть"))
        chars, _, _ = untag_alignment(spoken, index, al)
        self.assertFalse("".join(chars).startswith("["))


    def test_say_replaces_a_word_only_in_the_spoken_text(self):
        text = "В README «Кобальта» шаги есть, readme.md тоже."
        spoken, index = with_tags(text, [{"at": 0, "tag": "calm"}], {"README": "ридми"})
        self.assertEqual(spoken, "[calm] В ридми «Кобальта» шаги есть, ридми.md тоже.")
        chars, starts, ends = untag_alignment(spoken, index, fake_alignment(spoken), text)
        self.assertEqual("".join(chars), text)
        words = words_from_chars(text, chars, starts, ends, len(spoken) * 0.05)
        rd = next(w for w in words if text[w["start_char"]:w["end_char"]].startswith("README"))
        self.assertAlmostEqual(rd["start_s"], spoken.index("ридми") * 0.05)
        self.assertEqual(with_tags("READMEs", None, {"README": "ридми"})[0], "READMEs")


class EngineTagTests(unittest.TestCase):
    def make(self, auto=True):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        cfg = {"settings": {"timeout_s": 2, "cooldown_s": 0, "auto_tags": auto},
               "engines": {"elevenlabs": {"model_id": "eleven_v4", "audio_tags": True}},
               "speakers": {"a": {"chain": [{"engine": "elevenlabs", "voice": "v1"}, {"engine": "macos", "voice": "M"}]}}}
        provs = {"elevenlabs": Fake("elevenlabs"), "macos": Fake("macos")}
        seen = []
        orig = provs["elevenlabs"].synth

        def spy(text, voice, settings=None, **kw):
            seen.append(dict(settings or {}))
            return orig(text, voice, settings, **kw)

        provs["elevenlabs"].synth = spy
        return Engine(config=cfg, cache_dir=self.tmp.name, providers=provs), seen

    def test_explicit_tags_reach_the_provider_and_the_response(self):
        eng, seen = self.make()
        tags = [{"at": 0, "tag": "calm"}]
        r = eng.synth("a", TEXT, tags)
        self.assertEqual(seen[-1]["tags"], tags)
        self.assertEqual(r["tags"], tags)

    def test_tags_are_part_of_the_cache_key(self):
        eng, seen = self.make()
        eng.synth("a", TEXT, [{"at": 0, "tag": "calm"}])
        r = eng.synth("a", TEXT, [{"at": 0, "tag": "serious"}])
        self.assertFalse(r["cached"])
        self.assertTrue(eng.synth("a", TEXT, [{"at": 0, "tag": "serious"}])["cached"])

    def test_none_and_auto_off_send_no_tags(self):
        eng, seen = self.make(auto=False)
        eng.synth("a", TEXT, "auto")
        self.assertNotIn("tags", seen[-1])
        eng2, seen2 = self.make()
        eng2.synth("a", TEXT, "none")
        self.assertNotIn("tags", seen2[-1])


if __name__ == "__main__":
    unittest.main()


class StageDictionaryTests(unittest.TestCase):
    """voices.json engines.elevenlabs.say: model versions read as versions, Finalist codes as letter names."""

    def setUp(self):
        import json
        from pathlib import Path
        self.say = json.loads((Path(support.TTS) / "voices.json").read_text("utf-8"))["engines"]["elevenlabs"]["say"]

    def test_model_versions_are_read_as_versions(self):
        text = "Судей пять: Opus 5.5, Sonnet 5.5 и Fable 5.1 от Anthropic, GPT 6.1 sol и GPT 6 astra от OpenAI."
        spoken, _ = with_tags(text, None, self.say)
        self.assertEqual(spoken, "Судей пять: Opus пять точка пять, Sonnet пять точка пять и Fable пять точка один от Anthropic, "
                                 "GPT шесть точка один Сол и GPT шесть Астра от OpenAI.")
        self.assertEqual(with_tags("Согласен с GPT 6.1 и GPT 6.", None, self.say)[0], "Согласен с GPT шесть точка один и GPT шесть.")

    def test_codes_are_spoken_as_english_letter_names(self):
        spoken, _ = with_tags("Мой фаворит — Финалист G, а у Финалиста Q и с Финалистом Z хуже.", None, self.say)
        self.assertEqual(spoken, "Мой фаворит — Финалист Джи, а у Финалиста Кью и с Финалистом Зед хуже.")
