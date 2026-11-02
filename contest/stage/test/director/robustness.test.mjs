// Engine restarts, reloads after the end, truncated data.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Director, drive } from "../../director/director.js";
import { RecordingSink } from "../../director/sinks.js";
import { ReplaySource } from "../../director/sources/replay.js";
import { FINALISTS, JUDGES, L } from "./sim.mjs";
import { loadReplay, runShow, showCalls } from "./helpers.mjs";

const base = (over = {}) => ({ status: "running", started_at: "2026-10-24T12:00:00.000Z", finished_at: null, duration_s: null,
  settings: { places: 1, rounds_per_place: 3, retries: 1 }, finalists: FINALISTS, votes: [], placements: [],
  judges: JUDGES.map((j) => ({ ...j, status: "ждёт", log: null })), current: { place: 1, round: 1, phase: "discussion" },
  transcript: [{ kind: "round", place: 1, round: 1, at: "x" }], ...over });
const opusWrites = (s) => ({ ...s, judges: s.judges.map((j) => (j.name === "opus-5.5" ? { ...j, status: "пишет" } : j)) });
const TID = "p1-r1-message-opus-5.5";
const opusLast = (sink) => sink.of("judge").filter((c) => c.args[0] === "opus-5.5").at(-1).args[1];

async function play(records) {
  const sink = new RecordingSink();
  const d = new Director({ source: new ReplaySource(records, { startedAt: "2026-10-24T12:00:00.000Z" }), sink, clock: () => 0 });
  for (let t = 0; t <= 10; t += 0.5) await d.tick(t);
  return sink;
}

test("an engine restarted with --resume counts its turns again: the interrupted turn is attempt 1", async () => {
  const sink = await play([
    { t: 0, state: opusWrites(base()) },
    { t: 0.1, tid: TID, prompt: true },
    { t: 1, tid: TID, line: L.claudeTool("a", "Read", { file_path: "first.md" }) },
    { t: 2, state: base({ started_at: "2026-10-24T12:00:02.000Z", transcript: [], current: null }) }, // a new engine process
    { t: 3, state: opusWrites(base({ started_at: "2026-10-24T12:00:02.000Z" })) },
    { t: 4, tid: TID, line: L.claudeTool("b", "Grep", { pattern: "x" }) },
  ]);
  const p = opusLast(sink);
  assert.equal(p.turn.tid, TID);
  assert.equal(p.turn.attempt, 1);
  assert.deepEqual(p.activity.map((a) => a.label), ["Grep «x»"]);
});

test("a wrong guess of the attempt is corrected by the first evidence from the source", async () => {
  // the same engine process, the turn runs twice in the statuses (a poll saw it start again) but the
  // log directory is the first attempt's: the log wins
  const sink = await play([
    { t: 0, state: opusWrites(base()) },
    { t: 1, state: base({ judges: base().judges.map((j) => (j.name === "opus-5.5" ? { ...j, status: "недоступен" } : j)) }) },
    { t: 2, state: opusWrites(base()) },
    { t: 3, tid: TID, line: L.claudeTool("b", "Grep", { pattern: "x" }) },
  ]);
  const seen = sink.of("judge").filter((c) => c.args[0] === "opus-5.5").map((c) => c.args[1].turn?.tid);
  assert.ok(seen.includes(`${TID}-a2`), "guessed a2 from the statuses");
  const p = opusLast(sink);
  assert.equal(p.turn.tid, TID);
  assert.deepEqual(p.activity.map((a) => a.label), ["Grep «x»"]);
  // but once a turn is confirmed, leftovers of an older attempt do not pull it back
  const sink2 = await play([
    { t: 0, state: opusWrites(base()) },
    { t: 0.1, tid: TID, prompt: true },
    { t: 1, state: base({ judges: base().judges.map((j) => (j.name === "opus-5.5" ? { ...j, status: "недоступен" } : j)) }) },
    { t: 2, state: opusWrites(base()) },
    { t: 2.1, tid: `${TID}-a2`, prompt: true },
    { t: 2.5, tid: TID, line: L.claudeTool("old", "Read", { file_path: "stale.md" }) },
    { t: 3, tid: `${TID}-a2`, line: L.claudeTool("new", "Grep", { pattern: "y" }) },
  ]);
  const q = opusLast(sink2);
  assert.equal(q.turn.tid, `${TID}-a2`);
  assert.deepEqual(q.activity.map((a) => a.label), ["Grep «y»"]);
});

test("a Stage reloaded after the end has nothing left to play and says so", async () => {
  const full = await runShow("no-majority");
  const total = full.director.cursor;
  const { sink, director } = await runShow("no-majority", { from: total });
  assert.equal(director.finished, true);
  assert.equal(showCalls(sink).length, 0);
  const r = sink.of("restore")[0].args[0];
  assert.equal(r.cursor, total);
  assert.equal(r.status.phase, "done");
  assert.equal(r.podium[0].team, "team-003");
});

test("data that ends before the final: drive() returns false at once", async () => {
  const src = loadReplay("no-majority");
  const cut = new ReplaySource(src.records.slice(0, 40), src.header);
  const d = new Director({ source: cut, sink: new RecordingSink(), clock: () => 0 });
  const t0 = Date.now();
  assert.equal(await drive(d, { stepS: 1 }), false);
  assert.ok(Date.now() - t0 < 2000);
  assert.ok(d.cursor > 3, "what was there was played");
});

test("the transcript is taken by index: two polls that skip entries lose none", async () => {
  // replay with the states thinned out: only every 7th snapshot is delivered
  const src = loadReplay("unavailable");
  const states = src.records.filter((r) => r.state);
  const keep = new Set(states.filter((_, i) => i % 7 === 0 || i === states.length - 1));
  const thin = new ReplaySource(src.records.filter((r) => !r.state || keep.has(r)), src.header);
  const a = await runShow(thin);
  const b = await runShow("unavailable");
  // fewer snapshots see the vote turns end at other times, so a wave's walks and reveals may come in
  // another order (README "Finish order"); within a wave the same calls, none lost
  const keys = (s) => {
    const out = [];
    let run = [];
    const flush = () => (out.push(...run.sort()), (run = []));
    for (const c of showCalls(s.sink)) {
      const k = c.method + JSON.stringify(c.method === "voteCast" ? c.args[0] : c.args[0]?.judge ? [c.args[0].judge, c.args[0].reason] : c.args[0]?.reason ?? c.args[1]?.slice?.(0, 20) ?? "");
      if (c.method === "voteCast" || c.method === "voteReveal") run.push(k);
      else (flush(), out.push(k));
    }
    flush();
    return out.join("|");
  };
  assert.equal(a.director.finished, true);
  assert.equal(showCalls(a.sink).length, showCalls(b.sink).length, "the same show, even from fewer snapshots");
  assert.equal(keys(a), keys(b));
});
