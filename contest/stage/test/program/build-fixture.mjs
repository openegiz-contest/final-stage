// Writes test/program/fixture/program.json: a SYNTHETIC programme for show.html (never for air), in the
// contract tools/build.py fills (ui/program.js has it). The texts are made up here; the timing of every
// line is the director's estimate (145 words/min), no audio. The big screen (stage-tv), as on air (no
// Stand videos, no beats: owner 2026-10-28 evening): each Finalist's screenshots, cross-fading, of the
// shapes the Judges' screenshots have (16:9, 17:10, 16:10, 4:3); most have four (tools/build.py
// MAX_IMAGES), the 2nd two, the 4th one (no change: the default push in), the 9th three; the 7th none
// (its name on the wall). fixture/assets/stand-test.mp4 stays for the dormant video path (a programme
// with `video`). The Finalists are the Final fixture's (the first six are the ones of
// test/replays/synthetic-full.jsonl), the hashes are SHA-256 of made-up strings.
//   node contest/stage/test/program/build-fixture.mjs
import { writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { estimateTiming } from "../../director/voice.js";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "fixture", "program.json");
const sha = (s) => createHash("sha256").update(s).digest("hex");
const line = (text) => ({ text, ...estimateTiming(text) });

// ffmpeg -f lavfi -i "testsrc=size=1920x1080:rate=30:duration=60:decimals=2" -c:v libx264 -pix_fmt yuv420p -preset slow -crf 36 -movflags +faststart -an fixture/assets/stand-test.mp4
// the screenshots (stage-tv): ffmpeg -f lavfi -i "testsrc2=size=1920x1080:rate=1" -frames:v 1 -q:v 6 shot-16x9.jpg
// (mandelbrot 1700x1000 shot-17x10.jpg, smptehdbars 1440x900 shot-16x10.jpg, rgbtestsrc 1200x900 shot-4x3.jpg)
const SHOTS = ["assets/shot-16x9.jpg", "assets/shot-17x10.jpg", "assets/shot-16x10.jpg", "assets/shot-4x3.jpg"];
const turn = (k, n) => Array.from({ length: n }, (_, i) => SHOTS[(k + i) % SHOTS.length]);
const IMAGES = { 2: turn(1, 2), 4: turn(0, 1), 7: [], 9: [SHOTS[0], SHOTS[2], SHOTS[3]] }; // the rest: four each
const FINALISTS = [
  ["team-003", "Горный поток", "78.12"], ["team-011", "Штрек", "75.62"], ["team-007", "Карьер-Ай", "70.94"],
  ["team-002", "Забой", "53.75"], ["team-014", "Недра", "43.44"], ["team-009", "Рудник 4.0", "40", true],
  ["team-001", "Шахтёр", "38.5"], ["team-005", "Глубина", "36.25", true], ["team-006", "Отвал", "33.1"], ["team-012", "Квершлаг", "31.9"],
];

const INTRO = [
  "Добрый день. Это Финал открытого конкурса «Цифровой рудник на OpenEgiz».",
  "Десять команд построили цифровые двойники рудника, и сегодня пять Судей выберут из них три призовых места.",
  "Судьи — языковые модели, каждая в своём рабочем инструменте.",
  "От Anthropic за консолями Opus 5.5, Sonnet 5.5 и Fable 5.1.",
  "От OpenAI — GPT 6.1 sol и GPT 6 astra.",
  "Людей в этом решении нет: ни в зале, ни у пульта.",
  "Поэтому сначала проверим, что судит та самая версия, которую видели все.",
  "Хеш пайплайна ИИ-жюри опубликован до Заморозки, до того как команды сдали работы.",
  "На экране его проверка: сейчас считаем хеш заново и сравниваем с опубликованным.",
  "Хеш Материалов Финала опубликован вчера вместе со списком Финалистов: это всё, что Судьи могут прочитать сегодня.",
  "Оба значения совпадают, значит, судит ровно то, что было объявлено.",
  "Дальше программа такая.",
  "Сначала каждый Финалист получит минуту: от десятого места Отборочного этапа к первому.",
  "Тексты минут подготовил ИИ по материалам Отборочного этапа, без оценок от себя.",
  "Потом мы запустим Финал, и дальше никто его не трогает.",
  "Судьи обсуждают каждое место по очереди, начиная с первого.",
  "В каждом раунде каждый Судья говорит один раз, а потом все голосуют закрытыми жетонами.",
  "Место получает Финалист, за которого больше половины голосов.",
  "Если большинства нет, начинается следующий раунд, всего их не больше трёх.",
  "Если и после третьего раунда большинства нет, работает Правило последнего слова: место получает Финалист с наибольшим баллом Отборочного этапа.",
  "Финалист, чей балл ниже потолка, не может занять первое место; на экране он отмечен серым.",
  "Всё, что вы услышите от Судей, — их собственный текст, без пересказа и без правок.",
  "Начинаем с десятого места.",
].join(" ");

const POOL = [
  (n) => `На Стенде у ${n} поднимаются все заявленные модули, и это видно по скриншотам Судей.`,
  () => "Команда считает простои самосвалов на линии и показывает, сколько рейсов теряет смена.",
  () => "В отчёте сборки отмечено, что одна из проверок прошла только частично.",
  () => "Замысел короткий: одна проблема рудника, одна метрика и способ её измерить.",
  (n) => `Судьи Отборочного этапа отдельно отметили, как ${n} описывает данные датчиков.`,
  () => "Интерфейс собран на карте карьера, с уступами и маршрутом от забоя до дробилки.",
  () => "Слабое место, по оценкам, — прогноз на следующую смену: он есть, но не проверен на Стенде.",
  () => "Команда использовала шаблон OpenEgiz и дописала к нему два собственных модуля.",
  () => "В презентации — три слайда о том, кто будет пользоваться двойником и зачем.",
  () => "На скриншоте Стенда видна панель диспетчера с самосвалами на линии.",
];
function minute([team, name, score, ceiling], rank) {
  const n = `«${name}»`;
  const s = String(score).replace(".", ",");
  const parts = [
    `${n}, ${rank}-е место Отборочного этапа, балл ${s}.`,
    ...[0, 1, 2, 3, 4, 5, 6, 7].map((k) => POOL[(rank * 3 + k) % POOL.length](n)),
    ceiling ? `Балл ${n} ниже потолка, поэтому в Финале команда не может занять первое место.` : `Это ${n}.`,
  ];
  return line(parts.join(" "));
}

const program = {
  synthetic: true,
  note: "SYNTHETIC TEST DATA, never for air: made-up texts, estimated timing, no audio, test-pattern screenshots, made-up hashes (test/program/build-fixture.mjs).",
  built_at: "2026-10-21T12:00:00Z",
  publication: { path: "/tmp/stage-base/publication", sha256: sha("synthetic publication") },
  label: "подготовлено ИИ по материалам Отборочного этапа",
  hashes: { pipeline: sha("synthetic pipeline"), materials: sha("synthetic final materials"), checked: true },
  intro: line(INTRO),
  finalists: FINALISTS.map((f, i) => ({ team: f[0], name: f[1], rank: i + 1, score: f[2], ceiling: !!f[3], minute: minute(f, i + 1), images: IMAGES[i + 1] ?? turn(i, 4) })),
  outro: line("Финал окончен. Спасибо, что смотрели вместе с нами. Записи эфира и все тексты Судей будут опубликованы вместе с кодом Сцены."),
};
writeFileSync(OUT, JSON.stringify(program, null, 1) + "\n");
const total = program.intro.durationS + program.finalists.reduce((s, f) => s + f.minute.durationS, 0);
console.log(`wrote ${OUT}: intro ${program.intro.durationS} s, minutes ${program.finalists.map((f) => Math.round(f.minute.durationS)).join(" ")} s, spoken ${Math.round(total)} s`);
