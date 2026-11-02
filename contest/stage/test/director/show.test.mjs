// The show as the director plays it, over every synthetic replay (all of it synthetic test data).
import { test } from "node:test";
import assert from "node:assert/strict";
import { Director, drive } from "../../director/director.js";
import { RecordingSink } from "../../director/sinks.js";
import { memoryStore, cursorFromLocation } from "../../director/cursor.js";
import { EstimateVoice } from "../../director/voice.js";
import { ReplaySource } from "../../director/sources/replay.js";
import { LEGACY, expectedKeys, keyOf, loadReplay, replayFiles, revealOrder, runShow, showCalls } from "./helpers.mjs";

const files = replayFiles();

test("the replays exist and are marked synthetic", () => {
  assert.ok(files.length >= 8, `found ${files.join(", ")}`);
  for (const f of files) {
    const src = loadReplay(f);
    assert.equal(src.synthetic, true, f);
    assert.match(src.header.note, /SYNTHETIC TEST DATA, never for air/);
  }
});

for (const f of files) for (const envelopes of [true, false]) {
  const mode = envelopes ? "envelopes" : "revealed at once";
  test(`${f} (${mode}): every message and every vote is played once, in engine order, verbatim`, async () => {
    const { sink, director, source } = await runShow(f, envelopes ? {} : LEGACY);
    assert.equal(director.finished, true, "the show reaches the final screen");
    const final = source.stateAt(Infinity);
    const played = showCalls(sink).map(keyOf).filter(Boolean);
    assert.deepEqual(played, expectedKeys(final, sink, { envelopes }));
    // counts, spelled out
    const messages = final.transcript.filter((e) => e.kind === "message");
    assert.equal(sink.of("say").length, messages.filter((m) => m.text != null).length);
    assert.equal(sink.of("unavailable").length, messages.filter((m) => m.text == null).length);
    // with envelopes: a Judge without a vote has its beat in every wave, the tokens of each place's
    // deciding round open once, after the debate
    const tallies = final.transcript.filter((e) => e.kind === "tally");
    const deciding = new Set(final.placements.filter((p) => p.decided_by !== "vacant").map((p) => tallies.filter((t) => t.place === p.place).at(-1)));
    const reveals = envelopes ? tallies.reduce((n, t) => n + t.votes.filter((v) => v.team == null).length + (deciding.has(t) ? t.votes.length : 0), 0) : final.votes.length;
    assert.equal(sink.of("voteReveal").length, reveals);
    assert.equal(sink.of("verdict").length, final.placements.length);
    // the verdict card (owner 2026-10-21): the reason of EVERY Judge who voted for the winner in the
    // deciding round, verbatim, none dropped, in reveal order; every other vote on the «Против» line;
    // the Judges without a vote apart
    for (const v of sink.of("verdict")) {
      const card = v.args[0];
      if (card.vacant) continue;
      const deciding = final.transcript.filter((e) => e.kind === "tally" && e.place === card.place).at(-1);
      const seq = revealOrder(deciding, sink);
      assert.deepEqual(card.reasons, seq.filter((x) => x.team === card.team && x.reason).map((x) => ({ judge: x.judge, text: x.reason })), `place ${card.place}: reasons`);
      assert.equal(card.reasons.length, seq.filter((x) => x.team === card.team).length, "no majority Judge dropped");
      assert.deepEqual(card.against.map((a) => [a.judge, a.team]), seq.filter((x) => x.team != null && x.team !== card.team).map((x) => [x.judge, x.team]), `place ${card.place}: against`);
      assert.deepEqual(card.absent, seq.filter((x) => x.team == null).map((x) => x.judge));
      assert.equal(card.reasons.length + card.against.length + card.absent.length, deciding.votes.length, "every vote of the deciding round is on the card");
    }
  });

  test(`${f} (${mode}): beats are numbered without gaps and never overlap`, async () => {
    const { sink } = await runShow(f, envelopes ? {} : LEGACY);
    const starts = new Map();
    for (const c of sink.calls.filter((c) => SHOW_CALL.has(c.method))) starts.set(c.meta.n, c.meta);
    const ns = [...starts.keys()];
    assert.deepEqual(ns, ns.map((_, i) => i), "0..N-1, none skipped");
    const metas = [...starts.values()];
    for (let i = 1; i < metas.length; i++) {
      assert.ok(metas[i].at >= metas[i - 1].at + metas[i - 1].durationS - 1e-9, `beat ${i} starts after beat ${i - 1} ends`);
    }
  });
}

const SHOW_CALL = new Set(["status", "say", "host", "unavailable", "voteCast", "voteReveal", "tally", "envelope", "lastWord", "verdict", "podium", "final"]);

test("the sequence of sink calls does not depend on the size of the clock step", async () => {
  for (const f of ["no-majority", "unavailable", "retry"]) {
    const a = await runShow(`synthetic-${f}.jsonl`, { stepS: 0.1 });
    const b = await runShow(`synthetic-${f}.jsonl`, { stepS: 7 });
    const c = await runShow(`synthetic-${f}.jsonl`, { stepS: 500 });
    const norm = (s) => s.sink.calls.map((x) => JSON.stringify([x.method, x.args, x.meta]));
    assert.deepEqual(norm(b), norm(a), `${f}: 7 s steps`);
    assert.deepEqual(norm(c), norm(a), `${f}: one giant step`);
  }
});

test("no majority: the banner, the bridge from the template, round 2", async () => {
  const { sink } = await runShow("no-majority", LEGACY);
  const results = sink.of("tally").filter((c) => c.args[0].stage === "result").map((c) => c.args[0]);
  assert.equal(results[0].result, "no_majority");
  assert.equal(results[0].banner, "Нет большинства → раунд 2 из 3");
  assert.deepEqual(results[0].next, { place: 1, round: 2 });
  assert.equal(results[1].result, "majority");
  assert.equal(results[1].winner, "team-003");
  const bridge = sink.of("host").map((c) => c.args[0]).find((t) => t.includes("нет большинства"));
  assert.equal(bridge, "2 голоса за «Горный поток», 2 за «Штрек», 1 за «Карьер-Ай» — нет большинства, раунд 2.");
  // the majority line and the bars: 1,2 for the leader, reached on the 3rd vote
  const reveals = sink.of("voteReveal").map((c) => c.args[0]).filter((v) => v.round === 2);
  assert.deepEqual(reveals.map((v) => v.reached), [false, false, true, false, true]);
  assert.ok(reveals.every((v) => v.line === 3 && v.voted === 5));
});

test("last word: its own card between the last tally and the verdict", async () => {
  const { sink } = await runShow("last-word", LEGACY);
  const order = showCalls(sink).map((c) => c.method).filter((m) => ["tally", "lastWord", "verdict", "podium"].includes(m));
  assert.deepEqual(order.slice(-4), ["tally", "lastWord", "verdict", "podium"]);
  const card = sink.of("lastWord")[0].args[0];
  assert.equal(card.rule, "10.4");
  assert.equal(card.team, "team-003");
  assert.equal(card.rank, 1);
  assert.equal(card.score, "78.12");
  assert.deepEqual(card.contenders.map((c) => c.team), ["team-003", "team-011", "team-007", "team-002", "team-014"]);
  const last = sink.of("tally").filter((c) => c.args[0].stage === "result").at(-1).args[0];
  assert.equal(last.result, "no_majority_last");
  assert.equal(last.next, null);
  const verdict = sink.of("verdict")[0].args[0];
  assert.equal(verdict.decided_by, "last_word");
  assert.equal(verdict.rounds, 2);
  assert.deepEqual(verdict.reasons, [{ judge: "gpt-6-astra", text: "Модель полнее всех." }]);
});

test("vacant: a card, no discussion, a vacant step on the podium", async () => {
  const { sink } = await runShow("vacant");
  const first = sink.of("verdict")[0].args[0];
  assert.equal(first.vacant, true);
  assert.equal(first.place, 1);
  assert.equal(sink.of("say").every((c) => c.args[1] && !c.args[1].includes("(место 1")), true, "nobody speaks for place 1");
  const podium = sink.of("podium").map((c) => c.args[0]);
  assert.equal(podium[0].places[0].vacant, true);
  assert.equal(podium.at(-1).places[1].team, "team-103");
  const fin = sink.of("final")[0].args[0].podium;
  assert.deepEqual(fin.map((p) => p.team), [null, "team-103", "team-102"]);
  assert.match(sink.of("final")[0].args[0].text, /Первое место не присуждено/);
});

test("unavailable Judge: dark, one Host explanation, line from the voters present", async () => {
  const { sink } = await runShow("unavailable", LEGACY);
  const dark = sink.of("unavailable");
  assert.equal(dark.length, 1);
  assert.equal(dark[0].args[0], "fable-5.1");
  assert.equal(dark[0].args[1].where, "message");
  const hosts = sink.of("host").map((c) => c.args[0]).filter((t) => t.includes("10.5"));
  assert.equal(hosts.length, 1, "explained once per Judge per round");
  assert.match(hosts[0], /^Fable 5\.1 недоступен/, "the display name, never the engine id");
  assert.ok(!sink.of("host").some((c) => /fable-5\.1/.test(c.args[0])), "no Host line says the raw id");
  const begin = sink.of("tally").map((c) => c.args[0]).find((t) => t.stage === "begin");
  assert.deepEqual([begin.voted, begin.judges, begin.line], [4, 5, 3], "3 of 4, from the voters, not from the five");
  const reveals = sink.of("voteReveal").map((c) => c.args[0]).filter((v) => v.round === 1);
  const dead = reveals.find((v) => v.judge === "fable-5.1");
  assert.equal(dead.unavailable, true);
  assert.equal(dead.team, null);
  assert.equal(sink.of("voteReveal").find((c) => c.args[0].judge === "fable-5.1" && c.args[0].round === 2).args[0].unavailable, false);
  // the silent reveal has the same signature as a voiced one: (info, voice, meta)
  const call = sink.of("voteReveal").find((c) => c.args[0].unavailable);
  assert.equal(call.args[1], null);
  // 2/2 of 4 is no majority at line 3
  const result = sink.of("tally").map((c) => c.args[0]).find((t) => t.stage === "result");
  assert.equal(result.result, "no_majority");
});

test("two Judges unavailable: 3 voters, the line is 2 and two votes win", async () => {
  const { sink } = await runShow("two-unavailable", LEGACY);
  const begin = sink.of("tally").map((c) => c.args[0]).find((t) => t.stage === "begin");
  assert.deepEqual([begin.voted, begin.judges, begin.line], [3, 5, 2]);
  const result = sink.of("tally").map((c) => c.args[0]).find((t) => t.stage === "result");
  assert.equal(result.result, "majority");
  assert.equal(result.banner, "2 из 3");
  const reveals = sink.of("voteReveal").map((c) => c.args[0]);
  assert.deepEqual(reveals.map((v) => v.reached), [false, false, false, true, false]);
  const hosts = sink.of("host").map((c) => c.args[0]);
  assert.equal(hosts.filter((t) => t.includes("10.5")).length, 2, "one explanation for each Judge");
  assert.ok(hosts.some((t) => t.includes("нужно 2 из 3") || t.includes("пункту 10.5")));
  const v = sink.of("verdict")[0].args[0];
  assert.deepEqual([v.votes, v.voted, v.judges], [2, 3, 5]);
  assert.match(v.text, /За него 2 из 3/);
});

test("retry: the live layer follows -a2", async () => {
  const { sink } = await runShow("retry");
  const sonnet = sink.of("judge").filter((c) => c.args[0] === "sonnet-5.5").map((c) => c.args[1]);
  assert.ok(sonnet.some((p) => p.turn?.attempt === 1 && p.turn.tid === "p1-r1-message-sonnet-5.5"));
  assert.ok(sonnet.some((p) => p.status === "недоступен"), "the failed first ask shows");
  assert.ok(sonnet.some((p) => p.turn?.attempt === 2 && p.turn.tid === "p1-r1-message-sonnet-5.5-a2" && p.status === "пишет"));
  const a2 = sonnet.findLast((p) => p.turn?.attempt === 2 && p.activity.length);
  assert.deepEqual(a2.activity.map((a) => [a.kind, a.label, a.path]), [["list", "Glob", "solutions/team-011/*.json"]], "only the retry's own activity");
  const sol = sink.of("judge").filter((c) => c.args[0] === "gpt-6.1-sol").map((c) => c.args[1]);
  assert.ok(sol.some((p) => p.turn?.tid === "p1-r1-vote-gpt-6.1-sol-a2" && p.status === "голосует"));
  // the show itself is not disturbed: the message and the vote are played once
  assert.equal(sink.of("say").filter((c) => c.args[0] === "sonnet-5.5").length, 1);
  assert.equal(sink.of("voteReveal").filter((c) => c.args[0].judge === "gpt-6.1-sol").length, 1);
});

test("ceiling: grey for place 1 only, and free below", async () => {
  const { sink } = await runShow("ceiling", LEGACY);
  const rounds = sink.of("status").map((c) => c.args[0]).filter((s) => s.phase === "discussion");
  const blocked = (s) => s.contenders.filter((c) => c.blocked).map((c) => c.team).sort();
  assert.deepEqual(blocked(rounds[0]), ["team-003", "team-011"]);
  assert.equal(rounds[0].contenders.find((c) => c.team === "team-003").blockedLabel, "не может занять 1-е место");
  assert.deepEqual(blocked(rounds[1]), [], "place 2: no one is grey");
  assert.equal(rounds[1].contenders.find((c) => c.team === "team-007").placed, 1, "the place-1 winner is marked placed");
  const podium = sink.of("podium").map((c) => c.args[0]).at(-1);
  assert.deepEqual(podium.places.map((p) => p.team), ["team-007", "team-003", "team-011"]);
});

test("the live layer keeps moving while a message beat plays", async () => {
  const { sink } = await runShow("activity");
  const says = sink.of("say");
  const first = says[0].meta; // opus-5.5 speaks after the opener and the ceiling line, for ~11 s
  const during = sink.of("judge").filter((c) => c.meta.at > first.at && c.meta.at < first.at + first.durationS);
  const others = during.filter((c) => c.args[0] !== "opus-5.5").map((c) => c.args[1]);
  assert.ok(others.some((p) => p.status === "пишет" && p.activity.length > 0), "another Judge works on its console while the first one speaks");
  assert.ok(new Set(during.filter((c) => c.args[1].status === "пишет").map((c) => c.args[0])).size >= 1, "and a turn starts while it speaks");
  assert.ok(during.some((c) => c.args[1].status === "пишет" && Math.abs(c.args[1].since - c.meta.at) < 1e-9), "a new turn begins during the line");
  // and none of that waited for the queue: the Judge's turn started at its real time
  const start = sink.of("judge").find((c) => c.args[0] === "sonnet-5.5" && c.args[1].status === "пишет");
  assert.ok(start.meta.at < first.at + first.durationS);
  assert.equal(start.args[1].sinceSource, "state");
  assert.equal(start.args[1].since, start.meta.at);
});

test("activity reaches the consoles, once each, reasoning not shown", async () => {
  const { sink } = await runShow("activity");
  const last = (judge) => sink.of("judge").filter((c) => c.args[0] === judge && c.args[1].turn?.kind === "message").at(-1).args[1];
  const triple = (a) => [a.kind, a.label, a.path];
  assert.deepEqual(last("opus-5.5").activity.map(triple), [
    ["open", "Read", "solutions/team-003/build_report.json"],
    ["list", "Glob", "solutions/team-003/screenshots/**/*.png"],
    ["image", "Read", "solutions/team-003/screenshots/opus/01.png"],
    ["search", "Grep «ceiling»", "solutions"],
  ]);
  assert.deepEqual(last("sonnet-5.5").activity.map(triple), [
    ["open", "mcp__final__read_file", "teams/team-003/source/src/SUBMISSION.md"],
    ["list", "mcp__final__list_dir", "solutions"],
    ["tool", "mcp__final__fancy_tool", null],
  ]);
  assert.deepEqual(last("fable-5.1").activity.map(triple), [
    ["list", "LS", "solutions/team-011"],
    ["read", "Read", "teams/team-011/source/src/SUBMISSION.md"],
    ["tool", "WebFetch", null],
  ]);
  assert.deepEqual(last("gpt-6.1-sol").activity.map(triple), [
    ["read", "sed", "solutions/team-003/scores/opus-5.5.json"],
    ["open", "mcp__final__read_file", "solutions/team-011/build_report.json"],
    ["search", "rg «сценар»", "solutions"],
  ]);
  assert.deepEqual(last("gpt-6-astra").activity.map(triple), [
    ["list", "ls", "solutions/team-003"],
    ["tool", "python3", null],
    ["image", "cat", "solutions/team-003/screenshots/astra/02.png"],
  ]);
  // the votes (no tools) have none
  const vote = sink.of("judge").filter((c) => c.args[1].turn?.kind === "vote").at(-1).args[1];
  assert.deepEqual(vote.activity, []);
  // the whole sink output carries no thinking/reasoning text
  assert.ok(!JSON.stringify(sink.calls.filter((c) => c.method === "judge")).includes("hidden"));
});

test("a turn's start time: the state's own since, else prompt.txt, else first seen", async () => {
  const lastPerTurn = (sink) => {
    const m = new Map();
    for (const c of sink.of("judge")) if (c.args[1].turn && ["пишет", "голосует"].includes(c.args[1].status)) m.set(c.args[1].turn.tid, c.args[1]);
    return [...m.values()];
  };
  const src = loadReplay("retry");
  const withState = lastPerTurn((await runShow(src)).sink);
  assert.ok(withState.length >= 11 && withState.every((p) => p.sinceSource === "state" && p.sinceIso));
  // drop `since` from every state: the director falls back to the prompt.txt record
  src.records = src.records.map((r) => {
    if (!r.state) return r;
    return { ...r, state: { ...r.state, judges: r.state.judges.map(({ since, ...j }) => j) } };
  });
  src.i = 0;
  const viaPrompt = lastPerTurn((await runShow(src)).sink);
  assert.ok(viaPrompt.every((p) => p.sinceSource === "prompt" && p.since !== null && p.sinceIso === null), JSON.stringify(viaPrompt.map((p) => p.sinceSource)));
  // and without prompt records too: first seen
  src.records = src.records.filter((r) => !r.prompt);
  src.i = 0;
  const seen = lastPerTurn((await runShow(src)).sink);
  assert.ok(seen.every((p) => p.sinceSource === "seen" && p.since !== null));
});

// ---- resume ----

const playedBeats = (sink) => [...new Map(showCalls(sink).map((c) => [c.meta.n, c.meta])).keys()];

for (const f of ["no-majority", "unavailable", "ceiling"]) {
  test(`resume (${f}): from a cursor the director plays the rest and nothing twice`, async () => {
    const full = await runShow(f);
    const all = playedBeats(full.sink);
    const fullKeys = showCalls(full.sink).map((c) => [c.meta.n, keyOf(c)]);
    for (const cursor of [0, 1, 7, Math.floor(all.length / 2), all.length - 1, all.length]) {
      const { sink, director } = await runShow(f, { from: cursor });
      assert.deepEqual(playedBeats(sink), all.slice(cursor), `from ${cursor}`);
      assert.deepEqual(showCalls(sink).map((c) => [c.meta.n, keyOf(c)]), fullKeys.filter(([n]) => n >= cursor));
      assert.equal(director.cursor, all.length);
    }
  });
}

test("resume: a reload in the middle of the show continues from the stored cursor", async () => {
  const source = loadReplay("no-majority");
  const store = memoryStore();
  const first = new RecordingSink();
  const d1 = new Director({ source, sink: first, store, clock: () => 0 });
  for (let t = 0; t <= 75; t += 0.5) await d1.tick(t); // stops during round 1's votes
  assert.ok(d1.cursor > 5 && !d1.finished);
  const shown = new Set(showCalls(first).map((c) => c.meta.n));
  assert.equal(store.get("stage.cursor.synthetic-no-majority"), d1.cursor, "the cursor is stored when a beat ends");

  const second = new RecordingSink();
  const d2 = new Director({ source: loadReplay("no-majority"), sink: second, store, clock: () => 0 });
  await drive(d2, { stepS: 1 });
  const again = new Set(showCalls(second).map((c) => c.meta.n));
  const finished = [...shown].filter((n) => n < d1.cursor); // beats that had ended before the reload
  for (const n of finished) assert.ok(!again.has(n), `beat ${n} was shown and is not shown again`);
  assert.deepEqual([...again].sort((a, b) => a - b)[0], d1.cursor, "continues at the first unfinished beat");
  const total = (await runShow("no-majority")).director.cursor;
  assert.equal(d2.cursor, total);
  assert.equal(second.of("restore").length, 1);
  assert.equal(second.of("restore")[0].args[0].cursor, d1.cursor);
});

test("resume: restore carries the podium and the status of the beat before the cursor", async () => {
  const full = await runShow("ceiling", LEGACY);
  const podiumAt = full.sink.of("podium")[0].meta.n; // first podium beat
  const { sink } = await runShow("ceiling", { ...LEGACY, from: podiumAt + 1 });
  const r = sink.of("restore")[0].args[0];
  assert.equal(r.cursor, podiumAt + 1);
  assert.equal(r.podium[0].team, "team-007");
  assert.equal(r.podium[1], null);
  assert.equal(r.status.phase, "decided");
  // restore comes before anything else of the show
  assert.equal(sink.calls.findIndex((c) => SHOW_CALL.has(c.method)) > sink.calls.findIndex((c) => c.method === "restore"), true);
});

test("resume: ?from= wins over the stored cursor, and is read from the URL", async () => {
  assert.equal(cursorFromLocation({ search: "?x=1&from=12" }), 12);
  assert.equal(cursorFromLocation({ search: "?from=abc" }), null);
  assert.equal(cursorFromLocation({ search: "" }), null);
  const key = "stage.cursor.synthetic-no-majority";
  const a = await runShow("no-majority", { store: memoryStore({ [key]: 20 }), from: 3 });
  assert.equal(showCalls(a.sink)[0].meta.n, 3);
  const b = await runShow("no-majority", { store: memoryStore({ [key]: 20 }) });
  assert.equal(showCalls(b.sink)[0].meta.n, 20);
});

// ---- voices and the queue ----

test("voices: the next line is prepared while the current one plays, never far ahead", async () => {
  // everything is in the data at once (a fast engine, or a Stage reload): the whole show is queued at t=0
  const full = loadReplay("no-majority");
  const source = new ReplaySource([{ t: 0, state: full.stateAt(Infinity) }], full.header);
  const sink = new RecordingSink();
  let now = 0;
  const prepared = [];
  const voice = { prepare: async (speaker, text) => { prepared.push({ speaker, text, at: now, started: sink.calls.length }); return new EstimateVoice().prepare(speaker, text); } };
  const d = new Director({ source, sink, voice, clock: () => now });
  for (now = 0; now <= 500 && !d.finished; now += 0.1) await d.tick(now);
  assert.equal(d.finished, true);
  assert.deepEqual(showCalls(sink).map(keyOf).filter(Boolean), expectedKeys(full.stateAt(Infinity), sink), "a show queued all at once is still played whole, in order");
  // the calls that carry a voice, in play order, matched with the order the voices were prepared in
  const voiced = sink.calls.filter((c) => SHOW_CALL.has(c.method) && c.args.at(-1)?.words);
  assert.ok(voiced.length > 20);
  assert.equal(prepared.length, voiced.length);
  voiced.forEach((call, k) => {
    const p = prepared[k];
    assert.equal(p.text.length > 0, true);
    if (k === 0) return;
    const prev = voiced[k - 1].meta;
    assert.ok(p.at <= prev.at + 0.11, `line ${k} prepared at ${p.at.toFixed(1)}, the one before started at ${prev.at.toFixed(1)}`);
    if (k >= 2) assert.ok(p.at >= voiced[k - 2].meta.at - 0.11, `line ${k} is not prepared more than one line ahead`);
  });
  // the Host's wave line repeats word for word in waves with the same numbers (vote.wave): not a second preparation
  const texts = prepared.map((p) => p.speaker + "|" + p.text).filter((t) => !t.startsWith("host|Судьи голосуют тайно"));
  assert.equal(new Set(texts).size, texts.length, "each line is prepared once");
});

test("voices: a slow voice holds the queue, not the live layer", async () => {
  const source = loadReplay("activity");
  const sink = new RecordingSink();
  let release;
  const gate = new Promise((r) => (release = r));
  const voice = { prepare: async (speaker, text) => {
    if (speaker === "opus-5.5") await gate; // the first Judge's line is slow
    return new EstimateVoice().prepare(speaker, text);
  } };
  const d = new Director({ source, sink, voice, clock: () => 0 });
  for (let t = 0; t <= 60; t += 0.5) await d.tick(t);
  assert.equal(sink.of("say").length, 0, "the queue waits for the voice");
  assert.ok(sink.of("judge").some((c) => c.args[0] === "fable-5.1" && c.args[1].status === "пишет"), "the live layer does not");
  release();
  await d.tick(60.5);
  await d.tick(61);
  const say = sink.of("say")[0];
  assert.ok(say, "plays once the voice is ready");
  assert.equal(say.args[0], "opus-5.5");
  assert.ok(say.meta.at >= 60, `starts when it is ready (at ${say.meta.at})`);
  await drive(d, { t0: 62, stepS: 1 });
  assert.equal(d.finished, true);
});

test("voices: one that fails falls back to the estimate and the show goes on", async () => {
  const warnings = [];
  const voice = { prepare: async () => { throw new Error("no network"); } };
  const { sink, director } = await runShow("no-majority", { voice, onWarn: (m) => warnings.push(m) });
  assert.equal(director.finished, true);
  assert.ok(warnings.some((w) => /no network/.test(w)));
  assert.ok(sink.of("say").every((c) => c.args[2].durationS > 0 && c.args[2].words.length > 0));
});

test("a sink that throws does not stop the show", async () => {
  const sink = new RecordingSink();
  sink.say = () => { throw new Error("boom"); };
  const warnings = [];
  const d = new Director({ source: loadReplay("no-majority"), sink, clock: () => 0, onWarn: (m) => warnings.push(m) });
  await drive(d, { stepS: 1 });
  assert.equal(d.finished, true);
  assert.ok(warnings.some((w) => /sink\.say threw/.test(w)));
});

test("the verdict card: all four majority reasons verbatim, the dissent, long enough for each Judge's shot", async () => {
  const { sink } = await runShow("no-majority");
  const v = sink.of("verdict")[0];
  // 7 s headline + 4 reasons × 4 s + 1 dissenter × 2.5 s + 1 s
  assert.equal(v.args[0].durationS, 26.5);
  assert.ok(v.meta.durationS >= 26.5);
  assert.deepEqual(v.args[0].reasons, [
    { judge: "opus-5.5", text: "Модель карьера полная и проверена на Стенде." },
    { judge: "sonnet-5.5", text: "Сценарии запускаются и отменяются." },
    { judge: "fable-5.1", text: "Согласен: модель важнее оформления." },
    { judge: "gpt-6-astra", text: "Аргументы по модели убедили." },
  ], "GPT 6 astra's reason is on the card too: none is capped");
  assert.deepEqual(v.args[0].against, [{ judge: "gpt-6.1-sol", team: "team-011", name: "Штрек" }]);
  assert.deepEqual(v.args[0].absent, []);
  assert.equal(v.args[0].text, "Первое место — «Горный поток». За него 4 из 5, против — 1: «Штрек». Раундов: 2.");
  assert.equal(v.args[0].votes, 4);
  assert.equal(v.args[0].voted, 5);
  assert.equal(v.args[0].rounds, 2);
});
