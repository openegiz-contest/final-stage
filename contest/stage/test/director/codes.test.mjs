// Finalist codes until the envelopes (ui/codes.js, ADR-0010): the draw, the coding of a line, and the
// show as the director plays it with the codes installed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Director, drive } from "../../director/director.js";
import { RecordingSink } from "../../director/sinks.js";
import { EstimateVoice } from "../../director/voice.js";
import { readFileSync } from "node:fs";
import { FINALIST, LETTERS, SPOKEN, createCoder, drawCodes, installCodes, nameForms } from "../../ui/codes.js";
import { loadReplay, replayFiles } from "./helpers.mjs";

const FINALISTS = [
  { team: "team-003", name: "Горный поток" }, { team: "team-011", name: "Штрек" }, { team: "team-007", name: "Карьер-Ай" },
  { team: "team-002", name: "Забой" }, { team: "team-014", name: "Недра" }, { team: "team-009", name: "Рудник 4.0" },
  { team: "team-001", name: "Шахтёр" }, { team: "team-005", name: "Глубина" },
];

test("the draw: one distinct clean letter per Finalist, the same for the same run, another for another run", () => {
  const teams = FINALISTS.map((f) => f.team);
  const a = drawCodes(teams, "2026-10-31T10:00:00+00:00");
  assert.deepEqual([...a], [...drawCodes([...teams].reverse(), "2026-10-31T10:00:00+00:00")]);
  assert.equal(new Set(a.values()).size, teams.length);
  for (const l of a.values()) assert.ok(LETTERS.includes(l), l);
  const keys = ["a", "b", "c", "d", "e"].map((k) => [...drawCodes(teams, k).values()].join(""));
  assert.ok(new Set(keys).size > 1, "the key changes the draw");
});

test("the codes: Latin letters that do not look Cyrillic, each spelled out in every case form for the voice", () => {
  assert.equal(LETTERS.length, 10);
  for (const l of LETTERS) assert.ok(/^[A-Z]$/.test(l) && !"ABCEHKMOPTXY".includes(l), l);
  const say = JSON.parse(readFileSync(new URL("../../tts/voices.json", import.meta.url), "utf8")).engines.elevenlabs.say;
  for (const l of Object.keys(SPOKEN)) for (const f of new Set(Object.values(FINALIST))) assert.equal(say[`${f} ${l}`], `${f} ${SPOKEN[l]}`, `${f} ${l}`);
});

test("a name's case forms", () => {
  const f = Object.fromEntries(nameForms("Горный поток").map((x) => [x.text, [...x.cases].sort().join("/")]));
  assert.equal(f["Горного потока"], "gen");
  assert.equal(f["Горным потоком"], "ins");
  assert.equal(f["Горный поток"], "acc/nom");
  assert.equal(nameForms("Карьер-Ай")[0].cases, null, "a hyphenated name does not decline");
  assert.ok(nameForms("Рудник 4.0").some((x) => x.text === "Рудника"), "a name without its number");
  assert.ok(nameForms("Глубина").some((x) => x.text === "Глубиной"));
  assert.ok(nameForms("Недра").some((x) => x.text === "Недрами"));
});

test("a line: names in every case and team ids become codes, nothing else changes", () => {
  const c = createCoder({ finalists: FINALISTS, key: "k" });
  const L = (t, k = "nom") => c.label(t, k);
  const cases = [
    ["Мой фаворит — «Горный поток»: связанная модель.", `Мой фаворит — ${L("team-003")}: связанная модель.`],
    ["Мой фаворит — «Горный поток (team-003)». Слабость", `Мой фаворит — ${L("team-003")}. Слабость`],
    ["Мой фаворит — Горный поток (team-003). Главная", `Мой фаворит — ${L("team-003")}. Главная`],
    ["у «Горного потока» уровень 3", `у ${L("team-003", "gen")} уровень 3`],
    ["Преимущество «Штрека» в полноте", `Преимущество ${L("team-011", "gen")} в полноте`],
    ["соперник — Штрек с лучшей моделью", `соперник — ${L("team-011")} с лучшей моделью`],
    ["«Модель рудника» Штрек выигрывает", `«Модель рудника» ${L("team-011")} выигрывает`],
    ["в пользу «Карьер-Ай»: два", `в пользу ${L("team-007", "gen")}: два`],
    ["у Карьер-Ай два сценария", `у ${L("team-007", "gen")} два сценария`],
    ["модель «Карьер-Ай», несмотря", `модель ${L("team-007", "gen")}, несмотря`],
    ["а Карьер-Ай остаётся", `а ${L("team-007")} остаётся`],
    ["голосую за Забой", `голосую за ${L("team-002", "acc")}`],
    ["сравнить с Глубиной и Недрами", `сравнить с ${L("team-005", "ins")} и ${L("team-014", "ins")}`],
    ["у Рудника 4.0 и у Шахтера", `у ${L("team-009", "gen")} и у ${L("team-001", "gen")}`],
    ["Сильнее team-002, чем team-014.", `Сильнее ${L("team-002")}, чем ${L("team-014")}.`],
    // the mine's own words stay: lowercase, inside a scenario's name, an unknown team
    ["закрытый штрек и «Закрыть штрек», глубина модели", "закрытый штрек и «Закрыть штрек», глубина модели"],
    ["Сравнил с team-099.", "Сравнил с team-099."],
    // an opening quote of a longer quote stays
    ["Он написал «Штрек сильнее», и всё.", `Он написал «${L("team-011")} сильнее», и всё.`],
  ];
  for (const [src, want] of cases) assert.equal(c.code(src).text, want, src);
  assert.deepEqual(c.code("у «Горного потока» и Штрека").teams, ["team-003", "team-011"]);
});

// the show with the codes installed: every call the sink got, and the record
async function codedShow(source, opts = {}) {
  const sink = new RecordingSink();
  const est = new EstimateVoice(), prepared = [];
  const voice = { prepare: (speaker, text) => (prepared.push(text), est.prepare(speaker, text)) };
  const director = new Director({ source, sink, voice, clock: () => 0, ...opts });
  const rec = installCodes(director, { enabled: opts.plan?.envelopes !== false });
  await drive(director, { stepS: 1, maxS: source.endT + 3600 });
  return { sink, director, rec, prepared };
}
const NAMES = (finalists) => new RegExp(`(${finalists.map((f) => f.name.split(" ")[0].slice(0, 5)).join("|")}|team-\\d{3})`);
const spoken = (c) => (c.method === "say" ? c.args[1] : c.method === "host" ? c.args[0] : c.method === "voteReveal" ? c.args[0].reason : c.args[0]?.text) ?? "";

for (const f of ["real-live-probe-20261021b.jsonl", ...replayFiles()]) {
  test(`${f}: no Finalist named in a Judge's line before the first envelope, every code mapped at the envelopes`, async () => {
    const { sink, director, rec, prepared } = await codedShow(loadReplay(f));
    assert.equal(director.finished, true);
    const finalists = director.planner.finalists;
    const names = NAMES(finalists);
    const calls = sink.calls.filter((c) => ["say", "host", "voteReveal", "envelope", "verdict", "lastWord", "final"].includes(c.method));
    const first = calls.findIndex((c) => c.method === "envelope" && c.args[0].stage === "open");
    const before = first < 0 ? calls : calls.slice(0, first);
    for (const c of before.filter((x) => x.method === "say" || x.method === "voteReveal")) assert.doesNotMatch(spoken(c), names, spoken(c));
    // the voice gets the coded line, never the original
    for (const c of sink.calls.filter((x) => x.method === "say")) assert.ok(prepared.includes(c.args[1]), c.args[1]);
    for (const t of rec.original.values()) assert.ok(!prepared.includes(t), t);
    if (!rec.used.size) return;
    assert.ok(first >= 0, "an envelope opens");
    // every code used is mapped once, at an envelope, and its name is said after the first envelope
    const mapped = rec.maps.flatMap((m) => m.pairs.map(([code]) => code));
    assert.equal(new Set(mapped).size, mapped.length);
    assert.deepEqual(new Set(mapped), new Set([...rec.used].map((t) => rec.coder.label(t))));
    const after = calls.slice(first).map(spoken).join("\n");
    for (const t of rec.used) assert.ok(after.includes(director.planner.byTeam.get(t).name), t);
    // the debate's first Host line says what the codes are
    assert.match(calls.find((c) => c.method === "host")?.args[0] ?? "", /под кодами/);
  });
}

test("resume: a reload of the same run draws the same codes and plays the same coded lines", async () => {
  const full = await codedShow(loadReplay("real-live-probe-20261021b.jsonl"));
  const says = full.sink.calls.filter((c) => c.method === "say");
  const from = says[Math.floor(says.length / 2)].meta.n;
  const resumed = await codedShow(loadReplay("real-live-probe-20261021b.jsonl"), { from });
  assert.deepEqual([...resumed.rec.coder.codes], [...full.rec.coder.codes]);
  const tail = (s) => s.calls.filter((c) => (c.method === "say" || c.method === "envelope") && c.meta.n >= from).map((c) => JSON.stringify(c.args.slice(0, 2)));
  assert.deepEqual(tail(resumed.sink), tail(full.sink));
  assert.ok(resumed.rec.maps.length > 0);
});

test("?reveal=each: no codes (every place is shown as it is decided)", async () => {
  const { sink, rec } = await codedShow(loadReplay("real-live-probe-20261021b.jsonl"), { plan: { envelopes: false } });
  assert.equal(rec.coder, null);
  assert.ok(sink.calls.some((c) => c.method === "say" && /Горн|Штрек/.test(c.args[1])));
});
