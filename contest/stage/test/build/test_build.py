"""stage build (contest/stage/tools/build.py) on a synthetic publication, with a fake Claude runner.

    python3 -m unittest discover contest/stage/test/build
"""

import json
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent.parent / "tools"))

import build  # noqa: E402

CRITERIA = [("model", 25), ("behavior", 20), ("visualization", 25), ("scenarios", 10), ("modules", 5),
            ("concept", 15)]


def write_publication(root: Path, n_ranked=12, with_rank=False, shots=None, down=None) -> Path:
    """A publication in the judge layout: results.json, solutions/team-NNN/{build_report.json, scores/},
    teams/team-NNN/source/src/SUBMISSION.md beside it. Team k (1-based) scores 100 - 5k from every Judge,
    so team-001 is the 1st; one extra team is disqualified with the best score. Team `down` did not come up
    (the ceiling fires)."""
    pub = root / "publication"
    rows = []
    for k in range(1, n_ranked + 2):
        team, status = f"team-{k:03d}", "ranked" if k <= n_ranked else "disqualified"
        d = pub / "solutions" / team
        (d / "scores").mkdir(parents=True)
        report = {"team": team, "sha": "0" * 40, "came_up": k != down, "steps": [
            {"readme_step": "make up", "command": "make up", "exit_code": 0 if k != down else 2, "duration_s": 140,
             "log": "logs/01.txt"}],
            "healthchecks": [{"name": "containers_running", "ok": k != down, "evidence": "docker ps"}],
            "modules": [{"name": "Вентиляция", "claimed_in_submission": True, "works": "yes",
                         "evidence": f"CO снижен с 31 до {k + 10} ppm"}],
            "built_on_openegiz": {"verdict": "yes", "evidence": "двойники в Ditto"}, "notes": ""}
        (d / "build_report.json").write_text(json.dumps(report, ensure_ascii=False), encoding="utf-8")
        total = 100 - 5 * k if status == "ranked" else 100
        for judge in ("opus-5.5", "gpt-6.1-sol"):
            crit = [{"id": cid, "level": 2, "max": mx, "points": mx * total / 100, "reasoning": "по Стенду",
                     "references": []} for cid, mx in CRITERIA]
            (d / "scores" / f"{judge}.json").write_text(json.dumps(
                {"team": team, "judge": judge, "criteria": crit, "total": total}), encoding="utf-8")
        row = {"team": team, "name": f"Команда {k}", "status": status}
        if with_rank and status == "ranked":
            row |= {"rank": k, "score": min(total, 40) if k == down else total,
                    "ceiling": ["did_not_come_up"] if k == down else []}
        rows.append(row)
        src = pub.parent / "teams" / team / "source" / "src"
        src.mkdir(parents=True)
        (src / "SUBMISSION.md").write_text(f"# SUBMISSION\n\n## Concept\n\nДвойник шахты из {k * 6} объектов.\n\n"
                                           "## Modules\n\n- Вентиляция\n", encoding="utf-8")
    for team, files in (shots or {}).items():
        for rel in files:
            p = pub / "solutions" / team / "screenshots" / rel
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_bytes(b"\x89PNG fake")
    (pub / "results.json").write_text(json.dumps({"rows": rows}, ensure_ascii=False), encoding="utf-8")
    return pub


FILLER = "На Стенде видно, как двойники берут данные платформы и как меняется картина, когда включают сценарий."


class FakeClaude:
    """Answers like the model: a minute from the prompt's own facts. `invent` says, per call, whether to add a
    number the material does not have."""

    def __init__(self, invent=()):
        self.calls, self.invent, self.mu = [], list(invent), threading.Lock()

    def __call__(self, prompt, model, timeout):
        with self.mu:
            self.calls.append(prompt)
            invent = self.invent.pop(0) if self.invent else False
        mat = prompt.split("<<<MATERIAL\n", 1)[1]
        name = re.search(r"Команда «([^»]+)»", mat).group(1)
        objects = re.search(r"из (\d+) объектов", mat).group(1)
        text = f"Команда «{name}» построила двойник шахты из {objects} объектов. " + " ".join([FILLER] * 6)
        if invent:
            text += " Самосвалы проехали 9876 километров."
        return "**" + text + "**"


def load(out: Path) -> dict:
    return json.loads((out / "program.json").read_text(encoding="utf-8"))


class BuildTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="stage-build-test-"))
        self.cache = self.tmp / "cache"
        self.out = self.tmp / "out"

    def run_build(self, pub, runner, **kw):
        return build.build(pub, self.out, audio=kw.pop("audio", False), runner=runner, cache=self.cache, **kw)

    def check_speech(self, item):
        text, words = item["text"], item["words"]
        self.assertTrue(text.strip())
        self.assertGreater(item["durationS"], 0)
        self.assertEqual(len(words), len(text.split()))
        self.assertEqual(words[0]["start_char"], 0)
        self.assertEqual(words[-1]["end_char"], len(text))
        for a, b in zip(words, words[1:]):
            self.assertEqual(a["end_char"], b["start_char"])
            self.assertLessEqual(a["start_s"], b["start_s"])
        self.assertLessEqual(words[-1]["end_s"], item["durationS"] + 1e-6)
        self.assertEqual("".join(text[w["start_char"]:w["end_char"]] for w in words), text)

    def test_program_shape(self):
        pub = write_publication(self.tmp, shots={"team-002": ["opus-5.5/a.png", "opus-5.5/b.png", "opus-5.5/c.png",
                                                              "gpt-6.1-sol/a.jpg", "gpt-6.1-sol/b.png"]},
                                down=10, n_ranked=10)
        self.run_build(pub, FakeClaude())
        p = load(self.out)
        self.assertEqual(set(p), {"built_at", "publication", "label", "intro", "finalists", "outro"})
        self.assertEqual(p["label"], "подготовлено ИИ по материалам Отборочного этапа")
        self.assertEqual(set(p["publication"]), {"path", "sha256"})
        self.assertEqual(len(p["publication"]["sha256"]), 64)
        for part in (p["intro"], p["outro"]):
            self.assertEqual(set(part), {"text", "durationS", "words"})  # --no-audio: no audio key
            self.check_speech(part)
        self.assertIn("пять", p["intro"]["text"])
        for f in p["finalists"]:
            self.assertEqual(set(f), {"team", "name", "rank", "score", "ceiling", "minute", "images"})
            self.assertEqual(set(f["minute"]), {"text", "durationS", "words"})
            self.check_speech(f["minute"])
            self.assertNotIn("**", f["minute"]["text"])
            self.assertAlmostEqual(f["minute"]["durationS"], len(f["minute"]["text"].split()) * 60 / 145, places=1)
        by = {f["team"]: f for f in p["finalists"]}
        self.assertEqual(by["team-002"]["images"], ["assets/team-002/1.jpg", "assets/team-002/2.png",
                                                    "assets/team-002/3.png", "assets/team-002/4.png"])
        for rel in by["team-002"]["images"]:
            self.assertTrue((self.out / rel).is_file())
        self.assertEqual(by["team-001"]["images"], [])
        self.assertEqual(by["team-010"]["ceiling"], True)  # did not come up: the ceiling fired
        self.assertEqual(by["team-010"]["score"], "40")
        self.assertEqual(by["team-009"]["ceiling"], False)
        self.assertIn("40", p["intro"]["text"])  # a Finalist under the ceiling: the intro names the rule
        self.assertEqual(by["team-001"]["score"], "95")

    def test_play_order_ten_to_one(self):
        pub = write_publication(self.tmp)
        self.run_build(pub, FakeClaude())
        p = load(self.out)
        self.assertEqual([f["rank"] for f in p["finalists"]], list(range(10, 0, -1)))
        self.assertEqual(p["finalists"][0]["team"], "team-010")
        self.assertEqual(p["finalists"][-1]["team"], "team-001")
        self.assertNotIn("team-013", {f["team"] for f in p["finalists"]})  # disqualified, best score
        self.assertIn("от десятого места", p["intro"]["text"])

    def test_finalists_option_and_published_rank(self):
        pub = write_publication(self.tmp, with_rank=True)
        self.run_build(pub, FakeClaude(), finalists_n=2)
        p = load(self.out)
        self.assertEqual([(f["team"], f["rank"]) for f in p["finalists"]], [("team-002", 2), ("team-001", 1)])

    def test_invented_number_is_rejected_then_retried(self):
        pub = write_publication(self.tmp, n_ranked=1)
        runner = FakeClaude(invent=[True, False])
        self.run_build(pub, runner, finalists_n=1)
        self.assertEqual(len(runner.calls), 2)
        self.assertIn("9876", runner.calls[1])  # the retry names what was wrong
        self.assertNotIn("9876", load(self.out)["finalists"][0]["minute"]["text"])

    def test_invented_number_twice_fails_the_build(self):
        pub = write_publication(self.tmp, n_ranked=1)
        runner = FakeClaude(invent=[True, True])
        with self.assertRaises(build.BuildError):
            self.run_build(pub, runner, finalists_n=1)
        self.assertFalse((self.out / "program.json").exists())
        self.assertFalse(list(self.cache.glob("*.json")) if self.cache.exists() else [])  # a failure is not cached

    def test_check_minute_numbers(self):
        mat = "Команда «Штрек». Отборочный этап: место 8, балл 7.81 из 100. Охват: шахта из 60 двойников.\n"
        ok = "Восьмое место — Команда «Штрек», 7,81 балла из 100; шестьдесят двойников. "
        self.assertFalse([p for p in build.check_minute(ok, mat, "Штрек") if "numbers" in p])
        spelled = "Команда «Штрек»: откатка падает с девятисот двадцати шести до восьмисот тридцати четырёх тысяч тонн."
        self.assertFalse([p for p in build.check_minute(spelled, mat + "Откатка 926 → 834 тыс. т.\n", "Штрек")
                          if "numbers" in p])
        self.assertEqual(set(build.numbers_in("двести пять и триста")), {205, 300})
        for bad, shown in (("Команда «Штрек», 7,8 балла.", "7,8"), ("Команда «Штрек»: восемнадцать датчиков.",
                                                                     "восемнадцать"),
                           ("Команда «Штрек» заняла третье место.", "третье")):
            problems = [p for p in build.check_minute(bad, mat, "Штрек") if "numbers" in p]
            self.assertTrue(problems, bad)
            self.assertIn(shown, problems[0])

    def test_cache_hit_skips_the_runner(self):
        pub = write_publication(self.tmp)
        first = FakeClaude()
        self.run_build(pub, first)
        self.assertEqual(len(first.calls), 10)
        texts = [f["minute"]["text"] for f in load(self.out)["finalists"]]
        second = FakeClaude()
        self.run_build(pub, second)
        self.assertEqual(second.calls, [])
        self.assertEqual([f["minute"]["text"] for f in load(self.out)["finalists"]], texts)
        third = FakeClaude()
        self.run_build(pub, third, model="another-model")  # a different input hash
        self.assertEqual(len(third.calls), 10)

    def test_audio_through_the_engine(self):
        pub = write_publication(self.tmp, n_ranked=2)

        class FakeEngine:
            cache_dir = self.tmp / "tts"

            def __init__(self):
                self.calls = []

            def synth(self, speaker, text, tags):
                self.calls.append((speaker, tags))
                name = f"{len(self.calls):064x}.mp3"
                self.cache_dir.mkdir(exist_ok=True)
                (self.cache_dir / name).write_bytes(b"ID3 fake")
                dur, words = build.estimate_words(text, 160)
                return {"audio": f"/audio/{name}", "format": "mp3", "duration_s": dur, "words": words,
                        "engine": "fake", "voice": "v"}

        eng = FakeEngine()
        build.build(pub, self.out, audio=True, runner=FakeClaude(), cache=self.cache, engine=eng)
        p = load(self.out)
        self.assertEqual({c for c in eng.calls}, {("host", "auto")})
        self.assertEqual(len(eng.calls), 4)
        self.assertEqual(p["intro"]["audio"], "assets/audio/intro.mp3")
        self.assertEqual(p["finalists"][0]["minute"]["audio"], "assets/audio/team-002.mp3")
        for part in (p["intro"], p["outro"], *(f["minute"] for f in p["finalists"])):
            self.assertTrue((self.out / part["audio"]).is_file())
            self.check_speech(part)

    # ---- the minute: the Concept and the Stand only (spec §7.7, preshow) ----

    def test_minute_material_is_the_concept_and_the_stand(self):
        pub = write_publication(self.tmp, n_ranked=1)
        rp = pub / "solutions" / "team-001" / "build_report.json"
        rep = json.loads(rp.read_text(encoding="utf-8"))
        rep["modules"] += [{"name": "Энергетика", "works": "partly", "evidence": "насосы не отвечали"},
                           {"name": "Водоотлив", "works": "no", "evidence": "модуля нет в коде"}]
        rep["scenarios"] = [{"name": "Обрушение", "works": "yes", "undone": "yes", "evidence": "участок закрыт"}]
        rp.write_text(json.dumps(rep, ensure_ascii=False), encoding="utf-8")
        claude = FakeClaude()
        self.run_build(pub, claude, finalists_n=1)
        mat = claude.calls[0].split("<<<MATERIAL\n", 1)[1]
        for present in ("Двойник шахты из 6 объектов", "Модуль «Вентиляция»: CO снижен", "Модуль «Энергетика».",
                        "Сценарий «что если» «Обрушение»: участок закрыт"):
            self.assertIn(present, mat)
        for absent in ("балл", "место", "opus", "итог", "по Стенду", "Водоотлив", "насосы не отвечали",
                       "make up", "Поднялось"):
            self.assertNotIn(absent, mat)

    def test_rating_words_are_rejected_unless_the_material_has_them(self):
        mat = "Команда «Штрек».\nСценарий «что если» «Сильный дождь»: дорога закрыта.\n"
        text = "Команда «Штрек» показывает, что будет в сильный дождь. " + " ".join([FILLER] * 6)
        self.assertEqual(build.check_minute(text, mat, "Штрек"), [])
        for bad in ("лучший", "впечатляющий", "балла"):
            problems = build.check_minute(text + f" Это {bad} двойник.", mat, "Штрек")
            self.assertEqual(len(problems), 1, problems)
            self.assertIn(bad, problems[0])

    def test_a_thin_material_may_give_a_shorter_minute(self):
        thin = "Команда «Штрек».\nДвойник участка для диспетчера.\n"
        short = "Команда «Штрек» построила двойник участка рудника для диспетчера смены. " * 3
        self.assertEqual(build.check_minute(short, thin, "Штрек"), [])
        self.assertIn("the material is short", build.build_prompt({"name": "Штрек"}, thin))
        full = thin + "Слово " * 300
        self.assertIn("27 words", " ".join(build.check_minute(short, full, "Штрек")))
        self.assertIn("95 to 110 words", build.build_prompt({"name": "Штрек"}, full))

    # ---- --videos: the Stand video per Finalist ----

    @staticmethod
    def probe_info(codec="h264", size=(1920, 1080), duration="60.0", audio=False):
        streams = [{"codec_type": "video", "codec_name": codec, "width": size[0], "height": size[1]}]
        if audio:
            streams.append({"codec_type": "audio", "codec_name": "aac"})
        return {"streams": streams, "format": {"duration": duration}}

    def test_videos_valid_wrong_and_missing(self):
        pub = write_publication(self.tmp, n_ranked=5, shots={"team-002": ["opus-5.5/a.png"]})
        videos = self.tmp / "videos"
        videos.mkdir()
        infos = {"team-001": self.probe_info(), "team-002": self.probe_info(size=(1280, 720)),
                 "team-003": self.probe_info(audio=True), "team-004": self.probe_info(duration="42.5")}
        for team in infos:
            (videos / f"{team}.mp4").write_bytes(team.encode())  # team-005 has none
        probed = []

        def probe(path):
            probed.append(path.name)
            return infos[path.stem]

        self.run_build(pub, FakeClaude(), videos=videos, probe=probe)
        by = {f["team"]: f for f in load(self.out)["finalists"]}
        self.assertEqual(sorted(probed), [f"team-00{k}.mp4" for k in range(1, 5)])
        self.assertEqual((by["team-001"]["video"], by["team-001"]["videoDurationS"]),
                         ("assets/team-001/stand.mp4", 60.0))
        self.assertEqual((self.out / "assets/team-001/stand.mp4").read_bytes(), b"team-001")
        for team in ("team-002", "team-003", "team-004", "team-005"):
            self.assertNotIn("video", by[team])
            self.assertNotIn("videoDurationS", by[team])
            self.assertFalse((self.out / "assets" / team / "stand.mp4").exists())
        self.assertEqual(by["team-002"]["images"], ["assets/team-002/1.png"])  # screenshots stay

    def test_video_problems(self):
        self.assertEqual(build.video_problems(self.probe_info()), [])
        self.assertEqual(build.video_problems(self.probe_info(duration="55")), [])
        self.assertEqual(build.video_problems(self.probe_info(size=(1920, 1088))), ["1920×1088, not 1920×1080"])
        self.assertEqual(build.video_problems(self.probe_info(codec="hevc")), ["codec hevc, not H.264"])
        self.assertEqual(build.video_problems(self.probe_info(duration="65.4")), ["65.4 s, not 55-65 s"])
        self.assertEqual(build.video_problems(self.probe_info(audio=True)), ["has an audio stream"])
        self.assertEqual(build.video_problems({"streams": [{"codec_type": "audio"}]}), ["no video stream"])
        self.assertEqual(build.video_problems({"error": "ffprobe: Invalid data"}), ["ffprobe: Invalid data"])

    def test_videos_folder_must_exist(self):
        pub = write_publication(self.tmp, n_ranked=1)
        claude = FakeClaude()
        with self.assertRaisesRegex(build.BuildError, "no such folder"):
            self.run_build(pub, claude, videos=self.tmp / "nope")
        self.assertEqual(claude.calls, [])

    @unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"), "ffmpeg not installed")
    def test_videos_through_ffprobe(self):
        videos = self.tmp / "videos"
        videos.mkdir()

        def make(team, size, seconds, audio=False):
            cmd = ["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", f"testsrc=size={size}:rate=30",
                   *(["-f", "lavfi", "-i", "sine"] if audio else []), "-t", str(seconds), "-c:v", "libx264",
                   "-preset", "ultrafast", "-crf", "51", "-pix_fmt", "yuv420p", str(videos / f"{team}.mp4")]
            subprocess.run(cmd, check=True)

        make("team-001", "1920x1080", 56)
        make("team-002", "1280x720", 56)
        make("team-003", "1920x1080", 56, audio=True)
        (videos / "team-004.mp4").write_bytes(b"not a video")
        pub = write_publication(self.tmp, n_ranked=5)
        self.run_build(pub, FakeClaude(), videos=videos)
        by = {f["team"]: f for f in load(self.out)["finalists"]}
        self.assertEqual(by["team-001"]["video"], "assets/team-001/stand.mp4")
        self.assertAlmostEqual(by["team-001"]["videoDurationS"], 56, delta=0.1)
        self.assertEqual(build.video_problems(build.ffprobe(videos / "team-002.mp4")), ["1280×720, not 1920×1080"])
        self.assertEqual(build.video_problems(build.ffprobe(videos / "team-003.mp4")), ["has an audio stream"])
        self.assertTrue(build.video_problems(build.ffprobe(videos / "team-004.mp4")))
        self.assertEqual([t for t, f in by.items() if "video" in f], ["team-001"])

    # ---- hashes: the Final Materials hash from the judge repo's command ----

    def fake_judge_repo(self, body):
        repo = self.tmp / "judge-repo"
        pkg = repo / "judge" / "final"
        pkg.mkdir(parents=True, exist_ok=True)
        (repo / "judge" / "__init__.py").write_text("", encoding="utf-8")
        (pkg / "__init__.py").write_text("", encoding="utf-8")
        (pkg / "materials.py").write_text(body, encoding="utf-8")
        return repo

    def test_materials_hash_is_parsed_from_the_command_output(self):
        sha = "ab" * 32
        repo = self.fake_judge_repo(
            "import sys\nassert sys.argv[1] == '--qualifying'\n"
            f"print('Final Materials sha256 {sha}: 531 files, 3319606 B, sources of 10/10 Finalists')\n")
        self.assertEqual(build.compute_materials_hash(self.tmp / "publication", repo), sha)

    def test_materials_hash_command_failures_are_build_errors(self):
        with self.assertRaises(build.BuildError):
            build.compute_materials_hash(self.tmp, self.tmp / "no-such-repo")
        repo = self.fake_judge_repo("import sys\nprint('boom', file=sys.stderr)\nsys.exit(2)\n")
        with self.assertRaisesRegex(build.BuildError, "exit 2"):
            build.compute_materials_hash(self.tmp, repo)
        repo = self.fake_judge_repo("print('something else')\n")
        with self.assertRaises(build.BuildError):
            build.compute_materials_hash(self.tmp, repo)

    def test_published_hash_comes_from_final_json(self):
        run = self.tmp / "run"
        run.mkdir()
        sha = "cd" * 32
        (run / "final.json").write_text(json.dumps({"materials": {"sha256": sha, "files": 3}}), encoding="utf-8")
        self.assertEqual(build.published_materials_hash(run), sha)
        (run / "final.json").write_text(json.dumps({"materials": None}), encoding="utf-8")  # a --text-only run
        self.assertIsNone(build.published_materials_hash(run))
        with self.assertRaises(build.BuildError):
            build.published_materials_hash(self.tmp / "nothing")

    def fake_hashes_repo(self, main_body):
        repo = self.fake_judge_repo("print('Final Materials sha256 ' + 'ef' * 32 + ': 1 files')\n")
        (repo / "judge" / "final" / "hashes.py").write_text("", encoding="utf-8")
        (repo / "judge" / "final" / "__main__.py").write_text(main_body, encoding="utf-8")
        return repo

    JUDGE_MAIN = (
        "import json, sys\n"
        "a = sys.argv[1:]\n"
        "assert a[:3] == ['hashes', '--qualifying', a[2]] and '--json' in a\n"
        "pub = json.load(open(a[a.index('--published') + 1])) if '--published' in a else {}\n"
        "comp = {'pipeline': 'aa' * 32, 'materials': 'bb' * 32}\n"
        "same = lambda k: None if k not in pub else pub[k] == comp[k]\n"
        "r = {'pipeline': {'commit': 'c' * 40, 'computed': comp['pipeline'], 'published': pub.get('pipeline'), 'match': same('pipeline')},\n"
        "     'materials': {'computed': comp['materials'], 'published': pub.get('materials'), 'match': same('materials')}}\n"
        "print(json.dumps(r))\n"
        "sys.exit(1 if False in (same('pipeline'), same('materials')) else 0)\n")

    def test_judge_hashes_command_is_run_with_the_published_values(self):
        repo = self.fake_hashes_repo(self.JUDGE_MAIN)
        r = build.compute_hashes(self.tmp, repo)
        self.assertEqual((r["pipeline"]["match"], r["materials"]["match"]), (None, None))
        r = build.compute_hashes(self.tmp, repo, {"pipeline": "aa" * 32, "materials": "00" * 32})
        self.assertEqual((r["pipeline"]["match"], r["materials"]["match"]), (True, False))  # exit 1 keeps the JSON
        self.assertEqual(build.mismatches(r), [f"materials: computed {'bb' * 32}, published {'00' * 32}"])

    def test_judge_refusal_falls_back_to_the_materials_row(self):
        repo = self.fake_hashes_repo("import sys\nsys.exit('hashes: tracked files have uncommitted changes')\n")
        with self.assertRaisesRegex(build.BuildError, "uncommitted"):
            build.compute_hashes(self.tmp, repo)
        r = build.check_hashes(self.tmp, repo, {"materials": "ef" * 32})
        self.assertNotIn("pipeline", r)
        self.assertEqual(r["materials"], {"computed": "ef" * 32, "published": "ef" * 32, "match": True})
        h = build.hashes_block(r)
        self.assertEqual(h["commands"], {"materials": "python -m judge.final.materials"})
        self.assertTrue(h["checked"])

    def test_hashes_in_program_json(self):
        pub = write_publication(self.tmp, n_ranked=2)
        repo = self.fake_hashes_repo(self.JUDGE_MAIN)
        # computed only: nothing was compared
        self.run_build(pub, FakeClaude(), hashes=lambda p: build.check_hashes(p, repo))
        h = load(self.out)["hashes"]
        self.assertEqual(h, {"pipeline": "aa" * 32, "materials": "bb" * 32, "commit": "c" * 40, "checked": False,
                             "match": {"pipeline": None, "materials": None},
                             "commands": {"materials": "python -m judge.final hashes"}})
        # one row published and equal: still not checked, that row matches
        self.run_build(pub, FakeClaude(), hashes=lambda p: build.check_hashes(p, repo, {"materials": "bb" * 32}))
        h = load(self.out)["hashes"]
        self.assertEqual((h["checked"], h["match"], h["published"]),
                         (False, {"pipeline": None, "materials": True}, {"materials": "bb" * 32}))
        # both published and equal
        both = {"pipeline": "aa" * 32, "materials": "bb" * 32}
        self.run_build(pub, FakeClaude(), hashes=lambda p: build.check_hashes(p, repo, both))
        self.assertTrue(load(self.out)["hashes"]["checked"])

    def test_a_published_mismatch_stops_the_build(self):
        pub = write_publication(self.tmp, n_ranked=2)
        repo = self.fake_hashes_repo(self.JUDGE_MAIN)
        claude = FakeClaude()
        with self.assertRaisesRegex(build.BuildError, "differs"):
            self.run_build(pub, claude, hashes=lambda p: build.check_hashes(p, repo, {"pipeline": "00" * 32}))
        self.assertFalse((self.out / "program.json").exists())

    def test_no_hash_command_no_hashes(self):
        pub = write_publication(self.tmp, n_ranked=2)

        def broken(_pub):
            raise build.BuildError("no judge repo")

        self.run_build(pub, FakeClaude(), hashes=broken)
        self.assertNotIn("hashes", load(self.out))
        self.run_build(pub, FakeClaude())
        self.assertNotIn("hashes", load(self.out))

    def test_published_file_is_read_and_checked(self):
        f = self.tmp / "published.json"
        f.write_text(json.dumps({"pipeline": "AA" * 32}), encoding="utf-8")
        self.assertEqual(build.read_published(str(f)), {"pipeline": "aa" * 32})
        f.write_text(json.dumps({"materials": "short"}), encoding="utf-8")
        with self.assertRaises(build.BuildError):
            build.read_published(str(f))


if __name__ == "__main__":
    unittest.main()
