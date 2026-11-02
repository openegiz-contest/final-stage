// voteCast: the Judges' walks to the urn, in the order their vote turns really finished.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Director, drive } from "../../director/director.js";
import { RecordingSink } from "../../director/sinks.js";
import { ReplaySource } from "../../director/sources/replay.js";
import { turnEndFromLine } from "../../director/activity.js";
import { LEGACY, REPLAYS, loadReplay, replayFiles, runShow as runShowBase } from "./helpers.mjs";
// The wave's own mechanics, on the show that reveals each place at once (helpers LEGACY); the sealed
// envelopes (the air show) are envelopes.test.mjs.
const runShow = (name, opts = {}) => runShowBase(name, { ...LEGACY, ...opts });

import { L } from "./sim.mjs";

const casts = (sink) => sink.of("voteCast").map((c) => c.args);
const names = (list) => list.map(([judge]) => judge);

test("vote-order: the walks follow the finish order, not the roster; the log beats the state within a poll", async () => {
  const { sink } = await runShow("vote-order");
  const all = casts(sink);
  const r1 = all.slice(0, 5), r2 = all.slice(5);
  // round 1: fable 2 s, astra 3 s, sol's log at 3.3 s (its state says 5 s), sonnet unavailable at 4 s, opus's log at 4.8 s (state 6 s)
  assert.deepEqual(names(r1), ["fable-5.1", "gpt-6-astra", "gpt-6.1-sol", "sonnet-5.5", "opus-5.5"]);
  assert.deepEqual(r1.map(([, c]) => c.order), [1, 2, 3, null, 4]);
  assert.deepEqual(r1.map(([, c]) => c.unavailable), [false, false, false, true, false]);
  // at = when the turn was seen to end (seconds into the recording; the wave starts at 20)
  const at = r1.map(([, c]) => c.at);
  assert.deepEqual([at[0], at[1], at[3]], [22, 23, 24]);
  assert.ok(Math.abs(at[2] - 23.333) < 0.01 && Math.abs(at[4] - 24.8) < 0.01, `${at}`);
  assert.ok(r1.every(([, c]) => c.of === 4 && c.place === 1 && c.round === 1));
  // round 2: all five end in the same second; astra's log (1.5 s) and fable's (2.25 s) break the tie, the rest keep the roster
  assert.deepEqual(names(r2), ["gpt-6-astra", "fable-5.1", "opus-5.5", "sonnet-5.5", "gpt-6.1-sol"]);
  assert.deepEqual(r2.map(([, c]) => c.order), [1, 2, 3, 4, 5]);
});

test("a token is sealed: no team, no reason in the voteCast", async () => {
  const { sink } = await runShow("vote-order");
  for (const c of sink.of("voteCast")) {
    assert.deepEqual(Object.keys(c.args[1]).sort(), ["at", "of", "order", "place", "round", "unavailable"]);
  }
});

test("the walks come before the round's tally and reveals; the tokens open in the order the Judges reached the urn", async () => {
  const { sink, source } = await runShow("vote-order");
  const calls = sink.calls.filter((c) => ["status", "voteCast", "tally", "voteReveal"].includes(c.method));
  const firstReveal = calls.findIndex((c) => c.method === "voteReveal");
  const beginAt = calls.findIndex((c) => c.method === "tally" && c.args[0].stage === "begin");
  const lastCast = calls.map((c) => c.method).lastIndexOf("voteCast", beginAt);
  assert.ok(lastCast < beginAt && beginAt < firstReveal);
  assert.equal(calls[beginAt - 6].method, "status", "the voting status comes first, then the five walks");
  assert.equal(calls[beginAt - 6].args[0].phase, "voting");
  const reveals = sink.of("voteReveal").map((c) => c.args[0]);
  // round 1: sonnet without a vote first (its beat), then the tokens as their Judges reached the urn
  assert.deepEqual(reveals.slice(0, 5).map((v) => v.judge), ["sonnet-5.5", "fable-5.1", "gpt-6-astra", "gpt-6.1-sol", "opus-5.5"]);
  assert.deepEqual(reveals.slice(5).map((v) => v.judge), ["gpt-6-astra", "fable-5.1", "opus-5.5", "sonnet-5.5", "gpt-6.1-sol"]);
  assert.equal(source.stateAt(Infinity).votes[0].judge, "opus-5.5", "the engine's own order is the roster");
});

for (const f of replayFiles()) {
  test(`${f}: the reveal order is the walk order, the Judges without a vote first`, async () => {
    const { sink, source } = await runShow(f);
    for (const e of source.stateAt(Infinity).transcript.filter((x) => x.kind === "tally")) {
      const walks = sink.of("voteCast").filter((c) => c.args[1].place === e.place && c.args[1].round === e.round);
      const reveals = sink.of("voteReveal").filter((c) => c.args[0].place === e.place && c.args[0].round === e.round).map((c) => c.args[0]);
      const tokens = reveals.filter((v) => !v.unavailable);
      assert.deepEqual(tokens.map((v) => v.judge), walks.filter((c) => !c.args[1].unavailable).map((c) => c.args[0]), `${f} p${e.place} r${e.round}: tokens`);
      assert.deepEqual(tokens.map((v) => v.order), tokens.map((_, i) => i + 1));
      const firstToken = reveals.findIndex((v) => !v.unavailable);
      assert.ok(reveals.slice(firstToken < 0 ? reveals.length : firstToken).every((v) => !v.unavailable), "no dark beat between the tokens");
      assert.deepEqual(reveals.map((v) => v.index), reveals.map((_, i) => i));
    }
  });

  test(`${f}: the result is announced only after the last token`, async () => {
    const { sink } = await runShow(f);
    const calls = sink.calls.filter((c) => ["voteReveal", "tally"].includes(c.method));
    for (const res of calls.filter((c) => c.method === "tally" && c.args[0].stage === "result")) {
      const { place, round } = res.args[0];
      const wave = calls.filter((c) => c.method === "voteReveal" && c.args[0].place === place && c.args[0].round === round);
      const tokens = wave.filter((c) => !c.args[0].unavailable);
      // every reveal of the wave is played before the result, and only the wave's last token is `last`
      assert.ok(wave.every((c) => c.meta.n < res.meta.n));
      assert.equal(res.meta.n, (wave.at(-1)?.meta.n ?? res.meta.n - 2) + 1, "the result is the beat right after the last reveal");
      assert.deepEqual(tokens.map((c) => c.args[0].last), tokens.map((_, i) => i === tokens.length - 1));
      // a reveal carries no result: the majority banner is the tally's alone
      for (const c of wave) assert.ok(!("result" in c.args[0]) && !("banner" in c.args[0]) && !("winner" in c.args[0]));
      // the bar facts stay true: `reached` = the team's count at the line after this token
      for (const c of tokens) assert.equal(c.args[0].reached, c.args[0].counts[c.args[0].team] >= c.args[0].line);
    }
  });
}

test("a vote change since the previous round of the same place rides on that Judge's reveal", async () => {
  const { sink } = await runShow("full");
  const changed = sink.of("voteReveal").map((c) => c.args[0]).filter((v) => v.changed);
  assert.deepEqual(changed.map((v) => [v.place, v.round, v.judge, v.previous.team, v.previous.name, v.team, v.name]), [
    [1, 2, "gpt-6-astra", "team-007", "Карьер-Ай", "team-003", "Горный поток"],
    [1, 2, "fable-5.1", "team-011", "Штрек", "team-003", "Горный поток"],
  ]);
  assert.ok(changed.every((v) => v.previous.round === 1));
  const all = sink.of("voteReveal").map((c) => c.args[0]);
  // round 1 of a place has no previous vote; a Judge that kept its vote has one, unchanged
  assert.ok(all.filter((v) => v.round === 1).every((v) => v.previous === null && v.changed === false));
  const sol = all.find((v) => v.place === 1 && v.round === 2 && v.judge === "gpt-6.1-sol");
  assert.deepEqual([sol.previous.team, sol.team, sol.changed], ["team-011", "team-011", false]);
  // a new place starts over: place 2's first round has no previous vote though place 1 had two rounds
  assert.ok(all.filter((v) => v.place === 2).every((v) => v.previous === null));
});

test("a Judge that did not vote last round has no previous vote; a Judge without a vote now is not a change", async () => {
  const { sink } = await runShow("unavailable");
  const r2 = sink.of("voteReveal").map((c) => c.args[0]).filter((v) => v.round === 2);
  const fable = r2.find((v) => v.judge === "fable-5.1");
  assert.equal(fable.previous, null, "fable had no vote in round 1");
  assert.equal(fable.changed, false);
  const r1dark = sink.of("voteReveal").map((c) => c.args[0]).find((v) => v.unavailable);
  assert.equal(r1dark.changed, false);
});

test("an unavailable Judge: voteCast {unavailable: true}, no order, and it takes no time", async () => {
  const { sink } = await runShow("unavailable");
  const dark = sink.of("voteCast").filter((c) => c.args[1].unavailable);
  assert.deepEqual(dark.map((c) => [c.args[0], c.args[1].order, c.args[1].round]), [["fable-5.1", null, 1]]);
  assert.equal(dark[0].meta.durationS, 0);
  const walkers = sink.of("voteCast").filter((c) => c.args[1].round === 1 && !c.args[1].unavailable);
  assert.deepEqual(walkers.map((c) => c.args[1].order), [1, 2, 3, 4]);
});

test("a vote asked again (-a2) finishes when the retry ends, not the first ask", async () => {
  const { sink } = await runShow("retry");
  // gpt-6.1-sol fails once (3 s), the retry ends at 6 s; the others end at 3 s
  assert.deepEqual(names(casts(sink)), ["opus-5.5", "sonnet-5.5", "fable-5.1", "gpt-6-astra", "gpt-6.1-sol"]);
});

for (const f of replayFiles()) {
  test(`${f}: one voteCast per vote, every wave, before its tally`, async () => {
    const { sink, source } = await runShow(f);
    const final = source.stateAt(Infinity);
    assert.equal(sink.of("voteCast").length, final.votes.length);
    assert.equal(sink.of("voteCast").filter((c) => c.args[1].unavailable).length, final.votes.filter((v) => v.team == null).length);
    for (const e of final.transcript.filter((x) => x.kind === "tally")) {
      const wave = sink.of("voteCast").filter((c) => c.args[1].place === e.place && c.args[1].round === e.round);
      assert.deepEqual(wave.map((c) => c.args[0]).sort(), e.votes.map((v) => v.judge).sort(), `${f} p${e.place} r${e.round}`);
      const begin = sink.calls.findIndex((c) => c.method === "tally" && c.args[0].stage === "begin" && c.args[0].place === e.place && c.args[0].round === e.round);
      assert.ok(wave.every((c) => sink.calls.indexOf(c) < begin));
      assert.deepEqual(wave.filter((c) => !c.args[1].unavailable).map((c) => c.args[1].order), wave.filter((c) => !c.args[1].unavailable).map((_, i) => i + 1));
    }
  });
}

test("the sequence of calls with voteCast does not depend on the size of the clock step", async () => {
  const norm = (s) => s.sink.calls.map((x) => JSON.stringify([x.method, x.args, x.meta]));
  const a = await runShow("synthetic-vote-order.jsonl", { stepS: 0.1 });
  assert.deepEqual(norm(await runShow("synthetic-vote-order.jsonl", { stepS: 9 })), norm(a));
  assert.deepEqual(norm(await runShow("synthetic-vote-order.jsonl", { stepS: 900 })), norm(a));
});

test("a Stage opened after the Judges finished: no finish seen, the engine's vote order, at null", async () => {
  const full = loadReplay("vote-order");
  const source = new ReplaySource([{ t: 0, state: full.stateAt(Infinity) }], full.header);
  const { sink } = await runShow(source);
  const r1 = casts(sink).slice(0, 5);
  assert.deepEqual(names(r1), ["opus-5.5", "sonnet-5.5", "fable-5.1", "gpt-6.1-sol", "gpt-6-astra"]);
  assert.deepEqual(r1.map(([, c]) => c.at), [null, null, null, null, null]);
  assert.deepEqual(r1.map(([, c]) => c.order), [1, null, 2, 3, 4]);
});

test("resume: the walks are beats like any other, a cursor past them skips them", async () => {
  const full = await runShow("vote-order");
  const firstCast = full.sink.of("voteCast")[0].meta.n;
  const reveal = full.sink.of("voteReveal")[0].meta.n;
  const { sink } = await runShow("vote-order", { from: reveal });
  assert.equal(sink.of("voteCast").filter((c) => c.args[1].round === 1).length, 0);
  assert.equal(sink.of("voteCast").length, 5, "round 2's walks are still to come");
  assert.equal(sink.of("restore")[0].args[0].status.phase, "voting");
  const mid = await runShow("vote-order", { from: firstCast + 2 });
  assert.deepEqual(mid.sink.of("voteCast").filter((c) => c.args[1].round === 1).map((c) => c.meta.n), [firstCast + 2, firstCast + 3, firstCast + 4]);
});

// ---- the sink says when the walk is done ----

async function playWith(voteCast, { stepS = 0.5, holdMaxS, from } = {}) {
  const source = loadReplay("vote-order");
  const sink = new RecordingSink();
  const warnings = [];
  const inner = sink.voteCast;
  sink.voteCast = (...args) => { inner(...args); return voteCast(...args); };
  const d = new Director({ ...LEGACY, source, sink, clock: () => 0, onWarn: (m) => warnings.push(m), from, ...(holdMaxS ? { holdMaxS } : {}) });

  await drive(d, { stepS, maxS: source.endT + 3600 });
  return { sink, d, warnings };
}
const starts = (sink, method) => sink.of(method).map((c) => c.meta.at);

test("a sink that returns {end}: the next beat starts then", async () => {
  const { sink } = await playWith((judge, c, meta) => (c.unavailable ? undefined : { end: meta.at + 2.5 }));
  const walks = sink.of("voteCast").filter((c) => c.args[1].round === 1);
  assert.deepEqual(walks.map((c) => +(c.meta.at - walks[0].meta.at).toFixed(2)), [0, 2.5, 5, 7.5, 7.5], "the dark Judge takes no time");
  assert.equal(sink.of("tally").find((c) => c.args[0].stage === "begin").meta.at, walks[0].meta.at + 10);
  // and the same whatever the step
  const big = await playWith((judge, c, meta) => (c.unavailable ? undefined : { end: meta.at + 2.5 }), { stepS: 40 });
  assert.deepEqual(big.sink.calls.map((c) => c.meta?.at), sink.calls.map((c) => c.meta?.at));
  const dur = await playWith((judge, c, meta) => (c.unavailable ? undefined : { durationS: 2.5 }));
  assert.deepEqual(starts(dur.sink, "voteCast"), starts(sink, "voteCast"));
});

test("a sink that returns a promise: the queue waits for it, then goes on", async () => {
  const pending = [];
  const source = loadReplay("vote-order");
  const sink = new RecordingSink();
  const inner = sink.voteCast;
  sink.voteCast = (...args) => { inner(...args); return new Promise((resolve) => pending.push({ judge: args[0], resolve, at: args.at(-1).at })); };
  let now = 0;
  const d = new Director({ source, sink, clock: () => now, holdMaxS: 1e6 });
  const tickTo = async (t) => { for (; now <= t; now += 0.5) await d.tick(now); };
  await tickTo(200);
  assert.equal(pending.length, 1, "only the first walk has begun; the rest wait for it");
  assert.equal(pending[0].judge, "fable-5.1");
  pending[0].resolve({ end: pending[0].at + 4 });
  await tickTo(220);
  assert.equal(pending.length, 2);
  assert.equal(pending[1].at, pending[0].at + 4, "the next walk starts when the first one ended");
  pending[1].resolve(); // no end given: the time the queue saw it
  await tickTo(230);
  assert.equal(pending.length, 3);
  assert.ok(pending[2].at >= pending[1].at && pending[2].at <= 221, `${pending[2].at}`);
});

test("a promise that rejects or never settles does not hold the show for good", async () => {
  const rejected = await playWith(async (judge) => { if (judge === "fable-5.1") throw new Error("no path to the urn"); });
  assert.equal(rejected.d.finished, true);
  assert.ok(rejected.warnings.some((w) => /no path to the urn/.test(w)));
  const stuck = await playWith(() => new Promise(() => {}), { holdMaxS: 5 });
  assert.equal(stuck.d.finished, true, "the show goes on after holdMaxS");
  assert.ok(stuck.warnings.some((w) => /did not finish in 5 s/.test(w)));
  const walks = stuck.sink.of("voteCast").filter((c) => c.args[1].round === 1);
  assert.equal(+(walks[1].meta.at - walks[0].meta.at).toFixed(2), 5);
  const threw = await playWith(() => { throw new Error("boom"); });
  assert.equal(threw.d.finished, true);
});

// ---- the end of a turn in a log ----

test("the end of a CLI turn: Claude result, Codex turn.completed; a failed attempt says so", () => {
  const end = (line) => turnEndFromLine(line);
  assert.deepEqual(end(L.claudeDone()), { failed: false });
  assert.deepEqual(end(JSON.stringify({ type: "result", subtype: "error_max_turns", is_error: true })), { failed: true });
  assert.deepEqual(end(L.codexDone()), { failed: false });
  assert.deepEqual(end(JSON.stringify({ type: "turn.failed", error: { message: "x" } })), { failed: true });
  for (const line of [L.claudeInit(), L.claudeText("x"), L.claudeResult("1"), L.codexStart(), L.codexCmd("a", "ls"), "nope", "[]"]) assert.equal(end(line), null, line);
});

test("the first sign wins: a turn the state shows ended before its log says so, and the other way round", async () => {
  // opus: log done at 2, state at 5 -> 2. sonnet: state at 3, log done at 4 -> 3. Roster says opus, sonnet; so does the time: swap them.
  const full = loadReplay("vote-order").stateAt(Infinity);
  assert.ok(full);
  const J = (name, status) => ({ name, agent: "claude", model: "m", cli: "c", status, log: null });
  const mk = (a, b) => ({ status: "running", started_at: "2026-10-24T12:00:00.000Z", settings: { places: 1, rounds_per_place: 1, retries: 1 }, finalists: full.finalists,
    judges: [J("opus-5.5", a), J("sonnet-5.5", b)], current: { place: 1, round: 1, phase: "voting" }, votes: [], placements: [],
    transcript: [{ kind: "round", place: 1, round: 1, at: "x" }] });
  const T = (j) => `p1-r1-vote-${j}`;
  const tally = { kind: "tally", place: 1, round: 1, voted: 2, judges: 2, majority: true, counts: { "team-003": 2 },
    votes: [{ judge: "opus-5.5", place: 1, round: 1, team: "team-003", reason: "a" }, { judge: "sonnet-5.5", place: 1, round: 1, team: "team-003", reason: "b" }] };
  const sink = new RecordingSink();
  const source = new ReplaySource([{ t: 0, state: mk("голосует", "голосует") },
    { t: 0.1, tid: T("opus-5.5"), prompt: true }, { t: 0.1, tid: T("sonnet-5.5"), prompt: true },
    { t: 2, tid: T("opus-5.5"), line: L.claudeDone() },
    { t: 3, state: mk("голосует", "ждёт") },
    { t: 4, tid: T("sonnet-5.5"), line: L.claudeDone() },
    { t: 5, state: { ...mk("ждёт", "ждёт"), transcript: [...mk().transcript, tally], votes: tally.votes } }], { startedAt: "2026-10-24T12:00:00.000Z" });
  const d = new Director({ source, sink, clock: () => 0 });
  for (let t = 0; t <= 40; t += 0.5) await d.tick(t); // past the opener and the ceiling line
  assert.deepEqual(sink.of("voteCast").map((c) => [c.args[0], c.args[1].at]), [["opus-5.5", 2], ["sonnet-5.5", 3]]);
  // swap the roles: sonnet's log first
  const sink2 = new RecordingSink();
  const source2 = new ReplaySource([{ t: 0, state: mk("голосует", "голосует") },
    { t: 0.1, tid: T("opus-5.5"), prompt: true }, { t: 0.1, tid: T("sonnet-5.5"), prompt: true },
    { t: 1, tid: T("sonnet-5.5"), line: L.claudeDone() },
    { t: 3, state: mk("ждёт", "голосует") },
    { t: 5, state: { ...mk("ждёт", "ждёт"), transcript: [...mk().transcript, tally], votes: tally.votes } }], { startedAt: "2026-10-24T12:00:00.000Z" });
  const d2 = new Director({ source: source2, sink: sink2, clock: () => 0 });
  for (let t = 0; t <= 40; t += 0.5) await d2.tick(t); // past the opener and the ceiling line
  assert.deepEqual(sink2.of("voteCast").map((c) => [c.args[0], c.args[1].at]), [["sonnet-5.5", 1], ["opus-5.5", 3]]);
});

test("cli prints the casts in finish order", () => {
  const r = spawnSync("node", [resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "director", "cli.mjs"), "--replay", join(REPLAYS, "synthetic-vote-order.jsonl"), "--brief"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.split("\n").filter((l) => /\] #\d+ CAST/.test(l)).map((l) => l.replace(/^.*CAST /, "").replace(/ \(finished.*$/, ""));
  assert.deepEqual(lines.slice(0, 5), ["fable-5.1 token 1/4", "gpt-6-astra token 2/4", "gpt-6.1-sol token 3/4", "sonnet-5.5 unavailable, no token", "opus-5.5 token 4/4"]);
  assert.deepEqual(lines.slice(5, 7), ["gpt-6-astra token 1/5", "fable-5.1 token 2/5"]);
});
