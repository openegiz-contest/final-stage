// Sealed envelopes (owner 2026-10-28, spec §7.7 «Конверты»): the engine decides the places 1 → 2 → 3, the
// show keeps them sealed until every place is decided, then opens the envelopes 3 → 2 → 1. Checked on
// both real recordings of a live Final (2026-10-21), the recording of `judge.final run --fake`, every
// synthetic replay, and one simulated Final (a Last Word at place 2, no majority at place 3) built here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Director, drive } from "../../director/director.js";
import { RecordingSink } from "../../director/sinks.js";
import { ReplaySource } from "../../director/sources/replay.js";
import { Planner } from "../../director/plan.js";
import { host, labels } from "../../director/host.js";
import { expectedKeys, keyOf, loadReplay, replayFiles, revealOrder, runShow, showCalls } from "./helpers.mjs";
import { Sim } from "./sim.mjs";

const REAL = ["real-live-probe-20261021.jsonl", "real-live-probe-20261021b.jsonl"];
const ALL = [...REAL, ...replayFiles()];

// a simulated Final: place 1 by majority in round 2, place 2 by the Last Word Rule after 3 rounds, place 3
// with a Judge without a vote. SYNTHETIC TEST DATA.
function lastWordAtTwo() {
  const s = new Sim({ name: "envelopes", note: "Place 2 goes to the Last Word Rule; place 3 has a Judge without a vote." });
  const J = ["opus-5.5", "sonnet-5.5", "fable-5.1", "gpt-6.1-sol", "gpt-6-astra"];
  const talk = (place, round) => {
    s.round(place, round);
    J.forEach((j) => s.message(j, `Реплика ${j}, место ${place}, раунд ${round}.`, { dur: 3 }));
  };
  const votes = (teams, reason) => s.votes(J.map((j, i) => ({ judge: j, team: teams[i], reason: teams[i] ? `${reason} ${j}.` : null })));
  talk(1, 1);
  votes(["team-003", "team-003", "team-011", "team-011", "team-007"], "Раунд 1:");
  talk(1, 2);
  votes(["team-003", "team-003", "team-003", "team-011", "team-003"], "За первое:");
  s.placement("team-003", "majority", 2);
  for (const r of [1, 2, 3]) {
    talk(2, r);
    votes(["team-011", "team-011", "team-007", "team-007", "team-002"], `Место 2, раунд ${r}:`);
  }
  s.placement("team-011", "last_word", 3);
  talk(3, 1);
  votes(["team-007", "team-007", null, "team-002", "team-002"], "Место 3, раунд 1:");
  talk(3, 2);
  votes(["team-007", "team-007", null, "team-007", "team-002"], "Место 3, раунд 2:");
  s.placement("team-007", "majority", 2).finish();
  return ReplaySource.parse(s.toJsonl());
}

const load = (name) => (name === "sim" ? lastWordAtTwo() : loadReplay(name));
const NAMES = [...ALL, "sim"];

// the show calls before the first envelope opens: the debate (and a vacant place's own card)
function beforeReveal(sink) {
  const calls = showCalls(sink);
  const i = calls.findIndex((c) => c.meta.type === "reveal.intro");
  return i < 0 ? calls : calls.slice(0, i);
}

// every value under a key named like a result, anywhere in a payload, except the Judges' own words
const RESULT_KEYS = new Set(["team", "winner", "counts", "reason", "reasons", "against", "teamVotes", "reached", "previous", "pick", "rival", "votes", "name"]);
function resultValues(x, path = "", out = []) {
  if (Array.isArray(x)) x.forEach((v, i) => resultValues(v, `${path}[${i}]`, out));
  else if (x && typeof x === "object") {
    for (const [k, v] of Object.entries(x)) {
      if (k === "contenders") continue; // every Finalist, the same rows for every place (checked apart)
      const empty = v == null || v === false || v === 0 || (typeof v === "object" && Object.keys(v).length === 0);
      if (RESULT_KEYS.has(k) && !empty) out.push(`${path}.${k}=${JSON.stringify(v)}`);
      else resultValues(v, `${path}.${k}`, out);
    }
  }
  return out;
}

for (const name of NAMES) {
  test(`${name}: nothing of a result is shown before the envelopes open`, async () => {
    const source = load(name);
    const { sink, director } = await runShow(source);
    assert.equal(director.finished, true);
    const final = source.stateAt(Infinity);
    const vacant = new Set(final.placements.filter((p) => p.decided_by === "vacant").map((p) => p.place));
    const pre = beforeReveal(sink);
    const teams = final.finalists.map((f) => f.team);
    for (const c of pre) {
      const where = `#${c.meta.n} ${c.method} (${c.meta.type})`;
      // no token opened, no count, no majority card, no verdict, no podium step, no final screen
      if (c.method === "voteReveal") assert.equal(c.args[0].unavailable, true, `${where}: only a Judge without a vote has a beat`);
      if (c.method === "tally") {
        assert.equal(c.args[0].stage, "result", `${where}: no count begins`);
        assert.equal(c.args[0].result, "no_majority", `${where}: only «no majority → next round»`);
        assert.equal(c.args[0].sealed, true);
      }
      assert.ok(!["lastWord", "final"].includes(c.method), `${where}`);
      if (c.method === "verdict" || c.method === "podium") assert.ok(vacant.has(c.args[0].place ?? c.args[0].filled), `${where}: only a vacant place`);
      // no payload names a result (the Judges' messages are theirs, verbatim; vacant cards name none)
      if (c.method !== "say") assert.deepEqual(resultValues(c.args), [], `${where}`);
      // the Host names no team (the ceiling line names the Finalists under it, known before the Final)
      if (c.method === "host" && c.meta.type !== "ceiling") {
        for (const f of final.finalists) assert.ok(!c.args[0].includes(f.team) && !c.args[0].includes(`«${f.name}»`), `${where}: ${c.args[0]}`);
      }
      // the rows: every Finalist, none placed, at every place (a missing row would name a winner)
      if (c.method === "status") {
        assert.deepEqual(c.args[0].contenders.map((r) => r.team), teams, `${where}: every Finalist`);
        assert.ok(c.args[0].contenders.every((r) => r.placed == null), `${where}: none placed`);
      }
      if (c.method === "envelope") assert.equal(c.args[0].stage, "sealed");
    }
    // a Stage reloaded anywhere in the debate gets nothing more: the restore views
    const sink2 = new RecordingSink();
    const d = new Director({ source: load(name), sink: sink2, clock: () => 0 });
    const views = [];
    const plan = d.planner.plan.bind(d.planner);
    d.planner.plan = (ev) => plan(ev).map((b) => (views.push(b), b));
    await drive(d, { stepS: 1, maxS: 24 * 3600 });
    const firstOpen = views.findIndex((b) => b.type === "reveal.intro");
    for (const b of views.slice(0, firstOpen < 0 ? views.length : firstOpen)) {
      assert.ok(b.view.podium.every((p) => p == null || p.vacant), `beat ${b.n}: an empty podium`);
      assert.ok((b.view.status?.contenders ?? []).every((r) => r.placed == null), `beat ${b.n}: no row placed`);
    }
  });

  test(`${name}: the envelopes open 3 → 2 → 1, each with its deciding round, its result, its card`, async () => {
    const source = load(name);
    const { sink } = await runShow(source);
    const final = source.stateAt(Infinity);
    const sealedPlaces = final.placements.filter((p) => p.decided_by !== "vacant").map((p) => p.place).sort((a, b) => b - a);
    const calls = showCalls(sink);
    const opens = sink.of("envelope").filter((c) => c.args[0].stage === "open");
    assert.deepEqual(opens.map((c) => c.args[0].place), sealedPlaces, "descending");
    // a sealed beat per place, in the engine's order 1 → 2 → 3, before any envelope opens
    const seals = sink.of("envelope").filter((c) => c.args[0].stage === "sealed");
    assert.deepEqual(seals.map((c) => c.args[0].place), [...sealedPlaces].reverse());
    for (const c of seals) assert.equal(c.args[0].text, host.sealed({ place: c.args[0].place }));
    if (seals.length) assert.ok(calls.indexOf(seals.at(-1)) < calls.indexOf(opens[0]));
    // the podium fills in the order the envelopes open; the final screen comes last
    const filled = sink.of("podium").map((c) => c.args[0].filled).filter((p) => !final.placements.find((x) => x.place === p && x.decided_by === "vacant"));
    assert.deepEqual(filled, sealedPlaces);
    assert.equal(calls.at(-1).method, "final");
    assert.deepEqual(sink.of("final")[0].args[0].podium.map((p) => p.team), final.placements.sort((a, b) => a.place - b.place).map((p) => p.team));
    // each envelope: its deciding round's tokens in the real urn order, then the result, the Last Word
    // card when the rule decided, the verdict with the rounds, the podium step
    opens.forEach((open, k) => {
      const place = open.args[0].place;
      const from = calls.indexOf(open), to = k + 1 < opens.length ? calls.indexOf(opens[k + 1]) : calls.length - 2;
      const seg = calls.slice(from, to);
      const deciding = final.transcript.filter((e) => e.kind === "tally" && e.place === place).at(-1);
      const placement = final.placements.find((p) => p.place === place);
      assert.equal(open.args[0].round, deciding.round);
      assert.deepEqual(seg.filter((c) => c.method === "voteReveal").map((c) => [c.args[0].judge, c.args[0].team, c.args[0].reason]),
        revealOrder(deciding, sink).map((v) => [v.judge, v.team, v.reason]), `place ${place}: every token of the deciding round, verbatim, in urn order`);
      const begin = seg.find((c) => c.method === "tally" && c.args[0].stage === "begin").args[0];
      assert.deepEqual(begin.urn, revealOrder(deciding, sink).filter((v) => v.team != null).map((v) => v.judge), "the urn order goes to the Stage");
      const result = seg.find((c) => c.method === "tally" && c.args[0].stage === "result").args[0];
      assert.equal(result.result, placement.decided_by === "majority" ? "majority" : "no_majority_last");
      const kinds = seg.map((c) => c.method).filter((m) => ["tally", "voteReveal", "lastWord", "verdict", "podium"].includes(m));
      assert.deepEqual(kinds.slice(-3 - (placement.decided_by === "last_word" ? 1 : 0)),
        [...(placement.decided_by === "last_word" ? ["tally", "lastWord"] : ["tally"]), "verdict", "podium"]);
      const card = seg.find((c) => c.method === "verdict").args[0];
      assert.equal(card.team, placement.team);
      assert.equal(card.rounds, placement.rounds, "the round count is on the card");
      const seq = revealOrder(deciding, sink);
      assert.deepEqual(card.reasons, seq.filter((v) => v.team === card.team && v.reason).map((v) => ({ judge: v.judge, text: v.reason })), "every majority reason, verbatim");
      assert.deepEqual(card.against.map((a) => [a.judge, a.team]), seq.filter((v) => v.team && v.team !== card.team).map((v) => [v.judge, v.team]), "the «Против» line");
    });
    // every Judge word is shown verbatim, once, in engine order
    assert.deepEqual(showCalls(sink).map(keyOf).filter(Boolean), expectedKeys(final, sink));
  });
}

for (const name of [...REAL, "synthetic-fake-engine.jsonl", "synthetic-full.jsonl", "sim"]) {
  test(`${name}: a reload anywhere in the reveal resumes it: the same beats, the podium and the opened tokens restored`, async () => {
    const full = await runShow(load(name));
    const key = (c) => JSON.stringify([c.method, c.args, c.meta.n, c.meta.type]);
    const fullCalls = showCalls(full.sink);
    const intro = fullCalls.find((c) => c.meta.type === "reveal.intro").meta.n;
    const total = full.director.cursor;
    const podiumAt = new Map(); // beat n -> the podium after it
    for (const c of full.sink.of("podium")) podiumAt.set(c.meta.n, c.args[0].places);
    for (let from = intro; from < total; from++) {
      const { sink, director } = await runShow(load(name), { from });
      assert.equal(director.finished, true, `from ${from}`);
      const view = sink.of("restore")[0].args[0];
      assert.equal(view.cursor, from);
      // the podium: the steps opened before the cursor
      const before = [...podiumAt.entries()].filter(([n]) => n < from).at(-1)?.[1] ?? [null, null, null];
      assert.deepEqual(view.podium, before.map((p) => (p ? { ...p } : null)), `from ${from}: podium`);
      // in an envelope: its tokens and the ones opened before the cursor
      const opened = fullCalls.filter((c) => c.method === "envelope" && c.args[0].stage === "open" && c.meta.n < from).at(-1);
      const done = opened && fullCalls.some((c) => c.method === "podium" && c.meta.n < from && c.args[0].filled === opened.args[0].place);
      if (opened && !done && view.status.phase === "reveal") {
        const place = opened.args[0].place;
        const shown = fullCalls.filter((c) => c.method === "voteReveal" && c.args[0].place === place && c.args[0].team && c.meta.n >= opened.meta.n && c.meta.n < from)
          .map((c) => ({ judge: c.args[0].judge, team: c.args[0].team }));
        assert.deepEqual(view.status.reveal.shown, shown, `from ${from}: the tokens already open`);
        assert.equal(view.status.reveal.urn.length > 0 || from === opened.meta.n + 1, true);
      }
      // then exactly the rest of the show
      assert.deepEqual(showCalls(sink).map(key), fullCalls.filter((c) => c.meta.n >= from).map(key), `from ${from}`);
    }
  });
}

test("the Host's lines with envelopes: no team, no count", () => {
  assert.equal(host.sealed({ place: 1 }), "Первое место решено. Конверт запечатан.");
  assert.equal(host.sealed({ place: 3 }), "Третье место решено. Конверт запечатан.");
  assert.equal(host.noMajoritySealed({ round: 1, rounds: 3 }), "Нет большинства. Раунд 2 из 3.");
  assert.equal(host.voteWaveSealed({ line: 3, voted: 5 }), "Судьи голосуют тайно: нужно 3 из 5.");
  assert.match(host.voteWaveSealed({ line: 3, voted: 4, first: true, places: 3 }), /^Судьи голосуют тайно: нужно 3 из 4\. Жетоны не открываем: .* третье, второе, первое место\.$/);
  assert.match(host.revealIntro({ places: 3 }), /^Все места решены\. Вскрываем конверты: третье, второе, первое место\./);
  assert.equal(host.openEnvelope({ place: 1, round: 2, rounds: 3 }), "Конверт первого места. Решающий раунд — 2 из 3.");
  assert.equal(labels.noMajority(2, 3), "Нет большинства → раунд 2 из 3");
});

test("sim: no majority before the last round says so without counts; the last round goes straight to the envelope", async () => {
  const { sink } = await runShow(lastWordAtTwo());
  const pre = beforeReveal(sink);
  const results = pre.filter((c) => c.method === "tally").map((c) => [c.meta.place, c.meta.round, c.args[0].banner]);
  // place 1 round 1, place 2 rounds 1-2, place 3 round 1: the banner; place 2 round 3 (the rule) none
  assert.deepEqual(results, [[1, 1, "Нет большинства → раунд 2 из 3"], [2, 1, "Нет большинства → раунд 2 из 3"], [2, 2, "Нет большинства → раунд 3 из 3"], [3, 1, "Нет большинства → раунд 2 из 3"]]);
  const lines = pre.filter((c) => c.method === "host").map((c) => c.args[0]);
  assert.ok(lines.includes("Нет большинства. Раунд 3 из 3."));
  assert.ok(!lines.some((l) => /\d+ голос\S* за|— нет большинства|Правило последнего слова, пункт|Раундов больше нет/.test(l)), "no count, no Last Word before the reveal");
  // the Last Word card of place 2 lists the Finalists with a vote in its last round and the winner,
  // never the one placed above it (a missing top score would name the 1st place)
  const lw = sink.of("lastWord")[0].args[0];
  assert.equal(lw.place, 2);
  assert.deepEqual(lw.contenders.map((c) => c.team).sort(), ["team-002", "team-007", "team-011"]);
  // the Judge without a vote at place 3: its beat in the debate (once explained), again silent in the reveal
  const fable = sink.of("voteReveal").filter((c) => c.args[0].judge === "fable-5.1" && c.args[0].place === 3);
  assert.deepEqual(fable.map((c) => c.meta.round), [1, 2, 2]);
  assert.ok(fable.every((c) => c.args[0].unavailable && c.args[0].previous === null));
});

test("the show of 2026-10-21 stays available: envelopes: false reveals each place at once", async () => {
  const { sink } = await runShow("full", { plan: { envelopes: false } });
  assert.equal(sink.of("envelope").length, 0);
  assert.deepEqual(sink.of("podium").map((c) => c.args[0].filled), [1, 2, 3]);
  const p = new Planner();
  assert.equal(p.envelopes, true, "envelopes by default");
});
