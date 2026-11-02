// The Judges' monitors under the codes (ui/veil.js, ADR-0010): what a console would write before the
// first envelope opens names no Finalist and no team id, over everything the real Judges read.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Director, drive } from "../../director/director.js";
import { RecordingSink } from "../../director/sinks.js";
import { createCoder, installCodes } from "../../ui/codes.js";
import { createVeil, UNKNOWN_TEAM } from "../../ui/veil.js";
import { loadReplay } from "./helpers.mjs";

const FINALISTS = [
  { team: "team-003", name: "Горный поток" }, { team: "team-011", name: "Штрек" }, { team: "team-007", name: "Карьер-Ай" },
  { team: "team-009", name: "Рудник 4.0" }, { team: "team-005", name: "Глубина" },
];
// a name's first five letters at a word's start, capitalised as the Team writes it, or a team id
const namedRe = (finalists) => new RegExp(`(?<![\\p{L}])(${finalists.map((f) => f.name.split(" ")[0].slice(0, 5).replace(/[ёе]/g, "[её]")).join("|")})|team-\\d{3}`, "u");

const veilOf = (finalists, opts) => createVeil({ codes: { coder: createCoder({ finalists, key: "k" }) }, ...opts });

test("veil: on from the debate's start until the first envelope; never without codes; a jump back veils again", () => {
  const v = veilOf(FINALISTS, { from: 100 });
  assert.equal(v.on(50), false, "the preshow is not veiled");
  assert.equal(v.on(100), true);
  assert.equal(v.on(1e6), true, "no envelope opened yet");
  v.open(500);
  v.open(800); // a later opening does not move it
  assert.equal(v.on(499.9), true);
  assert.equal(v.on(500), false);
  assert.equal(v.on(300), true, "a jump back before the envelope");
  assert.equal(createVeil({ codes: { coder: null } }).on(0), false, "no codes (?reveal=each): never veiled");
  v.override = false;
  assert.equal(v.on(300), false);
});

test("veil: paths and labels by code (nominative), unknown team ids masked, prose coded in its case", () => {
  const v = veilOf(FINALISTS);
  const c = v.codes.coder;
  const G = c.label("team-003");
  assert.equal(v.path("publication/solutions/team-003/screenshots/opus-5.5/01-overview.png"), `publication/solutions/${G}/screenshots/opus-5.5/01-overview.png`);
  assert.equal(v.path("teams/team-041/source/src/SUBMISSION.md"), `teams/${UNKNOWN_TEAM}/source/src/SUBMISSION.md`, "a team of no Finalist");
  assert.equal(v.path("search_text «Горный поток»"), `search_text ${G}`);
  assert.equal(v.path("view_image"), "view_image");
  const prose = v.text("## Замысел «Горного потока» (team-003)\nКоманда «Штрек» сравнивает с Рудником 4.0.");
  assert.ok(!namedRe(FINALISTS).test(prose), prose);
  assert.ok(prose.includes(`Финалиста ${c.codes.get("team-003")}`), prose);
  const rows = v.ballot(FINALISTS.map((f) => ({ ...f, ceiling: f.team === "team-009" })));
  assert.deepEqual(rows.map((r) => r.code), [...c.codes.values()].sort(), "the letters' order, every contender");
  assert.ok(rows.every((r) => !("ceiling" in r) && !("name" in r) && !("team" in r)), "no rank, no ceiling, no name");
});

for (const name of ["real-live-probe-20261021.jsonl", "real-live-probe-20261021b.jsonl"]) {
  test(`veil: every console item the Judges read before the first envelope, veiled, names no Finalist (${name})`, async () => {
    const source = loadReplay(name), sink = new RecordingSink();
    const d = new Director({ source, sink, clock: () => 0 });
    const codes = installCodes(d);
    await drive(d, { stepS: 1, maxS: source.endT + 3600 });
    const v = createVeil({ codes });
    const NAMED = namedRe(d.planner.finalists);
    const first = sink.calls.findIndex((x) => x.method === "envelope" && x.args[0].stage === "open");
    assert.ok(first > 0, "an envelope opens");
    let items = 0, named = 0;
    const seen = new Set();
    for (const call of sink.calls.slice(0, first)) {
      if (call.method === "judge") for (const a of call.args[1].activity ?? []) {
        const key = `${a.label}|${a.path}|${a.content?.text ?? ""}`;
        if (seen.has(key)) continue;
        seen.add(key);
        items++;
        const raw = [a.label, a.path, a.content?.text].filter(Boolean).join("\n");
        if (NAMED.test(raw)) named++;
        for (const s of [v.path(a.label ?? ""), v.path(a.path ?? ""), v.text(a.content?.text ?? "")]) assert.ok(!NAMED.test(s), s.slice(0, 200));
      }
      if (call.method === "tally" && call.args[0].contenders) for (const r of v.ballot(call.args[0].contenders)) assert.ok(!NAMED.test(r.label), r.label);
      if (call.method === "status" && call.args[0].contenders) for (const r of v.ballot(call.args[0].contenders)) assert.ok(!NAMED.test(r.label), r.label);
    }
    if (name === "real-live-probe-20261021.jsonl") assert.ok(items > 30 && named > 30, `the recording's consoles named the Finalists (${named} of ${items} items)`);
  });
}

test("veil: what the matcher of ui/codes.js leaves (lowercase, a part of a name) is masked on a monitor", () => {
  const v = veilOf(FINALISTS);
  assert.equal(v.path("search_text «горный поток»"), "search_text «… …»");
  assert.equal(v.path("rg «Горн» teams/team-003/source"), `rg «…» teams/${v.codes.coder.label("team-003")}/source`);
  assert.equal(v.path("search_text «водоотлив»"), "search_text «водоотлив»", "other words stay");
  assert.ok(!/Штрек/.test(v.text("Сравним со Штреком-2 и штреком.")));
  assert.equal(v.path(v.codes.coder.label("team-011")), v.codes.coder.label("team-011"), "a code stays a code");
});

test("veil: a tool label keeps the quotes around its coded query", () => {
  const v = veilOf(FINALISTS);
  assert.equal(v.label("search_text «Горный поток»"), `search_text «${v.codes.coder.label("team-003")}»`);
  assert.equal(v.label("Grep «team-011»"), `Grep «${v.codes.coder.label("team-011")}»`);
  assert.equal(v.label("view_image"), "view_image");
});
