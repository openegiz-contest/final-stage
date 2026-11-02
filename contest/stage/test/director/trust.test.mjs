// The red team's trust fixes (2026-10-21, spec §7.7 «Голоса», «Место»): the verdict card names every
// vote, the Host's lines are templates over the data with display names, the ceiling is explained,
// an unavailable Judge is shown as such. All of it synthetic test data.
import { test } from "node:test";
import assert from "node:assert/strict";
import { host, labels, judgeName, againstPhrase } from "../../director/host.js";
import { Planner, verdictDuration } from "../../director/plan.js";
import { LEGACY, runShow as runShowBase, showCalls } from "./helpers.mjs";
// The trust rules of each card, on the show that reveals each place at once (helpers LEGACY); the sealed
// envelopes (the air show) are envelopes.test.mjs.
const runShow = (name, opts = {}) => runShowBase(name, { ...LEGACY, ...opts });


const nameOf = (t) => ({ a: "«Горный поток»", b: "«Штрек»", c: "«Забой»" })[t] ?? t;

test("display names: the roster's, and the same spelling for an id it does not know", () => {
  assert.deepEqual(["opus-5.5", "sonnet-5.5", "fable-5.1", "gpt-6.1-sol", "gpt-6-astra"].map(judgeName),
    ["Opus 5.5", "Sonnet 5.5", "Fable 5.1", "GPT 6.1 sol", "GPT 6 astra"]);
  assert.equal(judgeName("gpt-7-nova"), "GPT 7 nova");
  assert.equal(judgeName("haiku-6"), "Haiku 6");
  assert.match(host.unavailableMessage({ judge: "fable-5.1" }), /^Fable 5\.1 недоступен/);
  assert.match(host.unavailableVote({ judge: "gpt-6-astra", line: 3, voted: 4 }), /^GPT 6 astra недоступен и не голосует/);
  assert.equal(labels.abstains("fable-5.1"), "Fable 5.1 — не голосует (п. 10.5)");
  assert.equal(labels.away("fable-5.1"), "Fable 5.1 — недоступен");
  assert.equal(labels.reducedLine(3, 4, 1), "3 из 4: один Судья недоступен");
  assert.equal(labels.reducedLine(2, 3, 2), "2 из 3: два Судьи недоступны");
  assert.equal(labels.changed("fable-5.1", "«Штрек»", "«Горный поток»"), "Fable 5.1: «Штрек» → «Горный поток»");
});

test("the verdict's Host line: counts and teams only, from the data", () => {
  const v = (n, voted, against) => host.verdict({ place: 1, name: "«Горный поток»", n, voted, rounds: 2, decidedBy: "majority", against, nameOf });
  assert.equal(v(4, 5, [{ team: "b" }]), "Первое место — «Горный поток». За него 4 из 5, против — 1: «Штрек». Раундов: 2.");
  assert.equal(v(4, 4, []), "Первое место — «Горный поток». За него 4 из 4, единогласно. Раундов: 2.");
  assert.equal(v(3, 5, [{ team: "c" }, { team: "c" }]), "Первое место — «Горный поток». За него 3 из 5, против — 2: «Забой». Раундов: 2.");
  assert.equal(againstPhrase([{ team: "b" }, { team: "c" }, { team: "c" }], nameOf), "против — 3: «Забой» — 2, «Штрек» — 1");
  assert.equal(againstPhrase([], nameOf), null);
  // no reason text ever enters the Host's line
  const line = v(4, 5, [{ team: "b", reason: "Потоки." }]);
  assert.ok(!line.includes("Потоки"));
});

test("the verdict card's length grows with the Judges it names", () => {
  assert.equal(verdictDuration({ reasons: 3, against: 0 }), 25);
  assert.equal(verdictDuration({ reasons: 4, against: 1 }), 26.5);
  assert.equal(verdictDuration({ reasons: 5, against: 0 }), 28);
  assert.equal(verdictDuration({ reasons: 3, against: 2 }), 25);
});

test("full: each verdict card names every vote of its deciding round, in reveal order", async () => {
  const { sink } = await runShow("full");
  const cards = sink.of("verdict").map((c) => c.args[0]);
  const row = (c) => [c.reasons.map((r) => r.judge), c.against.map((a) => `${a.judge}>${a.team}`), c.absent];
  assert.deepEqual(row(cards[0]), [["sonnet-5.5", "gpt-6-astra", "fable-5.1", "opus-5.5"], ["gpt-6.1-sol>team-011"], []]);
  assert.deepEqual(row(cards[1]), [["gpt-6.1-sol", "opus-5.5", "gpt-6-astra", "sonnet-5.5"], [], ["fable-5.1"]]);
  assert.deepEqual(row(cards[2]), [["fable-5.1", "sonnet-5.5", "opus-5.5"], ["gpt-6-astra>team-002", "gpt-6.1-sol>team-002"], []]);
  assert.equal(cards[1].text, "Второе место — «Штрек». За него 4 из 4, единогласно. Раундов: 1.");
  assert.deepEqual([cards[1].line, cards[1].voted, cards[1].judges], [3, 4, 5]);
  assert.equal(cards[2].text, "Третье место — «Карьер-Ай». За него 3 из 5, против — 2: «Забой». Раундов: 1.");
  // every Judge appears on a verdict card at every place it voted (reason, or the «Против» line)
  for (const c of cards) assert.equal(new Set([...c.reasons.map((r) => r.judge), ...c.against.map((a) => a.judge), ...c.absent]).size, 5);
});

test("last word: the winner's reasons from the last round, every other vote against", async () => {
  const { sink } = await runShow("last-word");
  const c = sink.of("verdict")[0].args[0];
  assert.deepEqual(c.reasons, [{ judge: "gpt-6-astra", text: "Модель полнее всех." }]);
  assert.equal(c.against.length, 4);
  assert.match(c.text, /по Правилу последнего слова после 2 раундов/);
});

test("place 1 opens with the ceiling: one Host line, п. 9.3, before the first message", async () => {
  const { sink } = await runShow("full");
  const calls = showCalls(sink);
  const ceiling = sink.of("host").filter((c) => c.meta.type === "ceiling");
  assert.equal(ceiling.length, 1);
  assert.equal(ceiling[0].args[0], "«Рудник 4.0» не может занять первое место: к его баллу Отборочного этапа применён потолок 40 баллов. По пункту 9.3 Положения такое Решение не может стать Победителем.");
  assert.ok(calls.indexOf(ceiling[0]) < calls.findIndex((c) => c.method === "say"), "before the debate starts");
  assert.equal(ceiling[0].meta.place, 1);
  // the place-2 and place-3 openers carry no ceiling line
  const two = await runShow("ceiling");
  const lines = two.sink.of("host").filter((c) => c.meta.type === "ceiling").map((c) => c.args[0]);
  assert.deepEqual(lines, ["«Горный поток» и «Штрек» не могут занять первое место: к их баллам Отборочного этапа применён потолок 40 баллов. По пункту 9.3 Положения такие Решения не могут стать Победителем."]);
  // no Finalist under the ceiling: no line
  const p = new Planner();
  p.plan({ type: "setup", finalists: [{ team: "a", name: "A", rank: 1, score: "70", ceiling: false }, { team: "b", name: "B", rank: 2, score: "60", ceiling: false }], settings: {} });
  assert.deepEqual(p.plan({ type: "round", place: 1, round: 1 }).map((b) => b.type), ["round"]);
});

test("unavailable: its own reveal beat (2 s at least) before the tokens, its name in the status", async () => {
  const { sink } = await runShow("full");
  const dark = sink.of("voteReveal").filter((c) => c.args[0].unavailable);
  assert.equal(dark.length, 1);
  const d = dark[0];
  assert.equal(d.args[0].judge, "fable-5.1");
  assert.ok(d.meta.durationS >= 2, `the abstain beat lasts ${d.meta.durationS} s`);
  assert.equal(d.args[0].index, 0, "first in the reveal");
  assert.deepEqual(d.args[0].unavailable, true);
  assert.deepEqual([d.args[0].line, d.args[0].voted, d.args[0].judges], [3, 4, 5]);
  // the status of the wave and the tally name the Judges without a vote
  const voting = sink.of("status").map((c) => c.args[0]).filter((s) => s.phase === "voting" && s.place === 2);
  assert.deepEqual(voting.map((s) => s.away), [["fable-5.1"]]);
  const begin = sink.of("tally").map((c) => c.args[0]).find((t) => t.stage === "begin" && t.place === 2);
  assert.deepEqual(begin.away, ["fable-5.1"]);
  const result = sink.of("tally").map((c) => c.args[0]).find((t) => t.stage === "result" && t.place === 2);
  assert.deepEqual(result.away, ["fable-5.1"]);
  // a new round starts with nobody away
  assert.ok(sink.of("status").map((c) => c.args[0]).filter((s) => s.phase === "discussion").every((s) => Array.isArray(s.away) && s.away.length === 0));
});

test("unavailable for a message: a restore after that beat names the Judge away", async () => {
  const full = await runShow("full");
  const beat = full.sink.of("unavailable")[0].meta.n;
  const { sink } = await runShow("full", { from: beat + 1 });
  assert.deepEqual(sink.of("restore")[0].args[0].status.away, ["fable-5.1"]);
});
