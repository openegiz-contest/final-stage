import json
import os
import tempfile
import unittest

import support  # noqa: F401 - puts contest/stage/tts on sys.path

import tagger
from tagger import auto_tags, split_sentences, tagged_preview

TEXT = ("Коллеги, команда «Север-7» набрала 86 баллов из 100. Диспетчер не терял самосвалы… Но карта простоя пуста! "
        "Кто за неё отвечает?! Нужно пояснение.")


class Fake:
    def __init__(self, answer="[]", exc=None):
        self.answer, self.exc, self.calls, self.prompts = answer, exc, 0, []

    def __call__(self, prompt, timeout):
        self.calls += 1
        self.prompts.append(prompt)
        if self.exc:
            raise self.exc
        return self.answer


class TaggerTest(unittest.TestCase):
    def setUp(self):
        tagger._memory.clear()
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.old = os.environ.get("OPENEGIZ_STAGE_TAGS_CACHE")
        os.environ["OPENEGIZ_STAGE_TAGS_CACHE"] = self.tmp.name
        self.addCleanup(self._restore)

    def _restore(self):
        if self.old is None:
            os.environ.pop("OPENEGIZ_STAGE_TAGS_CACHE", None)
        else:
            os.environ["OPENEGIZ_STAGE_TAGS_CACHE"] = self.old

    def test_sentence_offsets(self):
        starts = split_sentences(TEXT)
        self.assertEqual([TEXT[i:i + 8] for i in starts],
                         ["Коллеги,", "Диспетче", "Но карта", "Кто за н", "Нужно по"])
        self.assertEqual(starts[0], 0)

    def test_offsets_skip_leading_space_and_quotes(self):
        t = "  Он сказал: «Да.» Потом ушёл. Конец"
        starts = split_sentences(t)
        self.assertEqual([t[i:i + 5] for i in starts], ["Он ск", "Потом", "Конец"])

    def test_no_split_inside_number_or_without_space(self):
        self.assertEqual(split_sentences("Итого 3.5 балла.Дальше"), [0])
        self.assertEqual(split_sentences(""), [])
        self.assertEqual(split_sentences("   "), [])

    def test_maps_sentence_index_to_offset(self):
        starts = split_sentences(TEXT)
        fake = Fake('[{"s": 2, "tag": "serious"}, {"s": 0, "tag": "warmly"}]')
        tags = auto_tags("fable-5.1", TEXT, runner=fake)
        self.assertEqual(tags, [{"at": starts[0], "tag": "warmly"}, {"at": starts[2], "tag": "serious"}])

    def test_whitelist_drop(self):
        fake = Fake('[{"s": 0, "tag": "screams"}, {"s": 1, "tag": "Sighs"}, {"s": 9, "tag": "calm"}, '
                    '{"s": "2", "tag": "calm"}, "junk", {"s": 3}]')
        tags = auto_tags("host", TEXT, runner=fake)
        self.assertEqual([t["tag"] for t in tags], ["sighs"])

    def test_one_tag_per_sentence(self):
        fake = Fake('[{"s": 1, "tag": "calm"}, {"s": 1, "tag": "serious"}]')
        tags = auto_tags("host", TEXT, runner=fake)
        self.assertEqual(tags, [{"at": split_sentences(TEXT)[1], "tag": "calm"}])

    def test_cap_keeps_first_by_order(self):
        # 5 sentences -> at most 3 tags; the answer is out of order, the first three by sentence order stay
        fake = Fake(json.dumps([{"s": i, "tag": "calm"} for i in (4, 3, 2, 1, 0)]))
        tags = auto_tags("host", TEXT, runner=fake)
        starts = split_sentences(TEXT)
        self.assertEqual([t["at"] for t in tags], starts[:3])

    def test_prose_around_array_and_code_fence(self):
        fake = Fake('Вот ответ:\n```json\n[{"s": 0, "tag": "thoughtful"}]\n```')
        self.assertEqual(auto_tags("host", TEXT, runner=fake), [{"at": 0, "tag": "thoughtful"}])

    def test_bad_json_returns_empty_and_is_not_cached(self):
        fake = Fake("not json at all")
        self.assertEqual(auto_tags("host", TEXT, runner=fake), [])
        self.assertEqual(auto_tags("host", TEXT, runner=fake), [])
        self.assertEqual(fake.calls, 2)
        self.assertEqual(os.listdir(self.tmp.name), [])

    def test_runner_failures_return_empty(self):
        for exc in (RuntimeError("boom"), TimeoutError(), FileNotFoundError("claude"), OSError("x")):
            self.assertEqual(auto_tags("host", TEXT, runner=Fake(exc=exc)), [])

    def test_cli_missing_and_timeout(self):
        old = tagger.subprocess.run
        self.addCleanup(setattr, tagger.subprocess, "run", old)

        def missing(*a, **k):
            raise FileNotFoundError("claude")

        def slow(*a, **k):
            raise tagger.subprocess.TimeoutExpired("claude", 1)

        tagger.subprocess.run = missing
        self.assertEqual(auto_tags("host", TEXT), [])
        tagger.subprocess.run = slow
        self.assertEqual(auto_tags("host", TEXT), [])

    def test_cache_hit_skips_runner(self):
        fake = Fake('[{"s": 1, "tag": "serious"}]')
        first = auto_tags("host", TEXT, runner=fake)
        self.assertEqual(auto_tags("host", TEXT, runner=fake), first)
        self.assertEqual(fake.calls, 1)
        # memory dropped: the disk cache answers
        tagger._memory.clear()
        self.assertEqual(auto_tags("host", TEXT, runner=fake), first)
        self.assertEqual(fake.calls, 1)
        self.assertEqual(len(os.listdir(self.tmp.name)), 1)
        # another speaker is another key
        auto_tags("opus-5.5", TEXT, runner=fake)
        self.assertEqual(fake.calls, 2)

    def test_empty_answer_is_cached(self):
        fake = Fake("[]")
        self.assertEqual(auto_tags("host", TEXT, runner=fake), [])
        self.assertEqual(auto_tags("host", TEXT, runner=fake), [])
        self.assertEqual(fake.calls, 1)

    def test_prompt_has_speaker_hint_and_numbered_sentences(self):
        fake = Fake()
        auto_tags("gpt-6-astra", TEXT, runner=fake)
        self.assertIn("colder", fake.prompts[0].lower())
        self.assertIn("2: Но карта простоя пуста!", fake.prompts[0])
        fake = Fake()
        auto_tags("someone-else", "Раз. Два.", runner=fake)
        self.assertIn("Neutral", fake.prompts[0])

    def test_preview_reconstructs_text(self):
        fake = Fake('[{"s": 0, "tag": "warmly"}, {"s": 2, "tag": "laughs softly"}, {"s": 4, "tag": "serious"}]')
        tags = auto_tags("host", TEXT, runner=fake)
        preview = tagged_preview(TEXT, tags)
        self.assertIn("[laughs softly] Но карта", preview)
        self.assertTrue(preview.startswith("[warmly] Коллеги"))
        stripped = preview
        for t in tags:
            stripped = stripped.replace(f"[{t['tag']}] ", "")
        self.assertEqual(stripped, TEXT)

    @unittest.skipUnless(os.environ.get("STAGE_TAGGER_LIVE") == "1", "set STAGE_TAGGER_LIVE=1 to run the real CLI")
    def test_live(self):
        text = ("Команда «Север-7» набрала 86 баллов, и это сильный результат. Но карта простоя осталась без единого "
                "пояснения, и я не уверен, что диспетчер ей доверяет. Это стоит исправить до финала.")
        for speaker in ("fable-5.1", "gpt-6-astra"):
            tags = auto_tags(speaker, text, timeout=60)
            print(f"\n[{speaker}] {tags}\n{tagged_preview(text, tags)}")
            for t in tags:
                self.assertIn(t["tag"], tagger.TAGS)


if __name__ == "__main__":
    unittest.main()
