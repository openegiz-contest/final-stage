import { test } from "node:test";
import assert from "node:assert/strict";
import { host, labels, plural, countsPhrase } from "../../director/host.js";
import { EstimateVoice, estimateTiming, WORDS_PER_MINUTE } from "../../director/voice.js";
import { StateDiffer, majorityLine, parseTid, makeTid } from "../../director/events.js";

test("plural forms", () => {
  const f = (n) => plural(n, "голос", "голоса", "голосов");
  assert.deepEqual([1, 2, 4, 5, 11, 12, 14, 21, 22, 25, 101, 111].map(f),
    ["голос", "голоса", "голоса", "голосов", "голосов", "голосов", "голосов", "голос", "голоса", "голосов", "голос", "голосов"]);
});

test("Host templates fill from data and say nothing else", () => {
  const nameOf = (t) => ({ a: "«X»", b: "«Y»", c: "«Z»" })[t];
  assert.equal(countsPhrase({ a: 2, b: 2, c: 1 }, nameOf), "2 голоса за «X», 2 за «Y», 1 за «Z»");
  assert.equal(countsPhrase({ a: 3, b: 1 }, nameOf), "3 голоса за «X», 1 за «Y»");
  assert.equal(countsPhrase({ a: 5 }, nameOf), "5 голосов за «X»");
  assert.equal(host.noMajority({ counts: { a: 2, b: 2, c: 1 }, voted: 5, round: 1, nameOf }), "2 голоса за «X», 2 за «Y», 1 за «Z» — нет большинства, раунд 2.");
  assert.equal(host.noMajority({ counts: {}, voted: 0, round: 2, nameOf }), "Ни один Судья не проголосовал — нет большинства, раунд 3.");
  assert.equal(host.openPlace({ place: 2, rounds: 3 }), "Определяем второе место. Раундов — не больше 3.");
  assert.match(host.verdict({ place: 1, name: "«X»", n: 3, voted: 5, rounds: 2, decidedBy: "majority" }), /^Первое место — «X». За него 3 из 5. Раундов: 2\.$/);
  assert.match(host.verdict({ place: 3, name: "«X»", n: 1, voted: 5, rounds: 3, decidedBy: "last_word" }), /по Правилу последнего слова после 3 раундов/);
  assert.match(host.lastWord({ rounds: 3, name: "«X»", score: "78.12", rank: 1 }), /пункт 10\.4.*«X»: балл 78,12, 1-е место Отборочного этапа/);
  assert.match(host.unavailableVote({ judge: "fable-5.1", line: 3, voted: 4 }), /нужно 3 из 4/);
  assert.match(host.unavailableMessage({ judge: "fable-5.1" }), /пункту 10\.5/);
  assert.equal(labels.noMajority(2, 3), "Нет большинства → раунд 2 из 3");
  assert.equal(labels.ceiling(), "не может занять 1-е место");
});

test("the majority line is more than half of those who voted", () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5].map(majorityLine), [1, 1, 2, 2, 3, 3]);
});

test("the voice estimate: 145 words a minute, words in order with character offsets", async () => {
  const text = "Это сообщение из десяти слов, чтобы проверить оценку длительности речи.";
  const n = text.split(/\s+/).length;
  const v = await new EstimateVoice().prepare("opus-5.5", text);
  assert.equal(WORDS_PER_MINUTE, 145);
  assert.ok(Math.abs(v.durationS - (n * 60) / 145) < 0.002, `${v.durationS}`);
  assert.equal(v.words.length, n);
  let prevEnd = 0;
  for (const w of v.words) {
    assert.ok(text.slice(w.start_char, w.end_char).length > 0 && !/\s/.test(text.slice(w.start_char, w.end_char)));
    assert.ok(w.start_s >= prevEnd - 1e-9 && w.end_s > w.start_s);
    prevEnd = w.end_s;
  }
  assert.equal(text.slice(v.words[0].start_char, v.words[0].end_char), "Это");
  assert.equal(text.slice(v.words.at(-1).start_char, v.words.at(-1).end_char), "речи.");
  assert.ok(Math.abs(v.words.at(-1).end_s - v.durationS) < 0.01);
  assert.deepEqual(estimateTiming(""), { durationS: 0, words: [] });
  assert.equal((await new EstimateVoice({ wpm: 290 }).prepare("x", text)).durationS, v.durationS / 2);
});

test("turn ids", () => {
  assert.deepEqual(parseTid("p1-r2-message-gpt-6.1-sol"), { place: 1, round: 2, kind: "message", judge: "gpt-6.1-sol", attempt: 1 });
  assert.deepEqual(parseTid("p3-r1-vote-opus-5.5-a2"), { place: 3, round: 1, kind: "vote", judge: "opus-5.5", attempt: 2 });
  assert.deepEqual(parseTid("p3-r1-vote-gpt-6-astra-a3"), { place: 3, round: 1, kind: "vote", judge: "gpt-6-astra", attempt: 3 });
  assert.equal(parseTid("place-1"), null);
  assert.equal(makeTid({ place: 1, round: 2, kind: "vote", judge: "x", attempt: 1 }), "p1-r2-vote-x");
  assert.equal(makeTid({ place: 1, round: 2, kind: "vote", judge: "x", attempt: 2 }), "p1-r2-vote-x-a2");
});

test("StateDiffer: entries once each, a shorter transcript waits, done once", () => {
  const judges = [{ name: "a", agent: "claude", status: "ждёт", log: null }];
  const base = { status: "running", settings: {}, finalists: [], judges, current: { place: 1, round: 1, phase: "discussion" }, votes: [], placements: [] };
  const e1 = { kind: "round", place: 1, round: 1, at: "t" };
  const e2 = { kind: "message", place: 1, round: 1, judge: "a", text: "hi", error: null, at: "t" };
  const e3 = { kind: "message", place: 1, round: 1, judge: "b", text: null, error: "x", at: "t" };
  const d = new StateDiffer();
  const types = (evs) => evs.map((e) => e.type);
  assert.deepEqual(types(d.diff({ ...base, transcript: [e1] })), ["setup", "round"]);
  assert.deepEqual(types(d.diff({ ...base, transcript: [e1] })), [], "the same snapshot again: nothing");
  assert.deepEqual(types(d.diff({ ...base, transcript: [e1, e2, e3] })), ["message", "unavailable"], "two entries in one poll, in order");
  assert.deepEqual(types(d.diff({ ...base, transcript: [e1] })), [], "an engine restarted from its journal: wait");
  assert.deepEqual(types(d.diff({ ...base, transcript: [e1, e2] })), []);
  assert.deepEqual(types(d.diff({ ...base, transcript: [e1, e2, e3, { ...e2, judge: "c" }] })), ["message"], "picks up where it was");
  const done = d.diff({ ...base, status: "done", transcript: [e1, e2, e3, { ...e2, judge: "c" }] });
  assert.deepEqual(types(done), ["done"]);
  assert.deepEqual(types(d.diff({ ...base, status: "done", transcript: [e1, e2, e3, { ...e2, judge: "c" }] })), []);
});

test("StateDiffer: turns start and end from the statuses, a retry is attempt 2", () => {
  const mk = (status, since = null) => ({ status: "running", settings: {}, finalists: [], transcript: [], votes: [], placements: [],
    current: { place: 2, round: 1, phase: "discussion" }, judges: [{ name: "opus-5.5", agent: "claude", status, since, log: null }] });
  const d = new StateDiffer();
  const log = [];
  for (const s of [mk("ждёт"), mk("пишет", "T1"), mk("недоступен"), mk("пишет", "T2"), mk("ждёт")]) log.push(...d.diff(s).filter((e) => e.type.startsWith("turn")));
  assert.deepEqual(log.map((e) => [e.type, e.tid, e.outcome ?? null]), [
    ["turn.start", "p2-r1-message-opus-5.5", null],
    ["turn.end", "p2-r1-message-opus-5.5", "unavailable"],
    ["turn.start", "p2-r1-message-opus-5.5-a2", null],
    ["turn.end", "p2-r1-message-opus-5.5-a2", "ok"],
  ]);
});
