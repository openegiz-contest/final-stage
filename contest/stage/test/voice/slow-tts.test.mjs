// A slow TTS service after a reload (the rehearsal of 2026-10-28: after a ⌘R in the debate Fable 5.1's
// line and the ones after it went silent). Time is scaled ×0.01: a line takes 25 s (0.25), the timeout
// is 40 s (0.40), the extension 30 s (0.30). The service, like tts/engine.py, synthesises 2 lines at
// once and keeps working on a request its client dropped; the reloaded page left 2 of them running.
//   node --test contest/stage/test/voice/slow-tts.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { createVoice } from "../../lib/voice.js";
import { PresentationQueue } from "../../director/queue.js";
import { SYNTH_ANSWER } from "./fixture.mjs";

const K = 0.01, LINE_S = 25 * K;
// a line is a few seconds long, scaled too
const ANSWER = { ...SYNTH_ANSWER, duration_s: SYNTH_ANSWER.duration_s * K, words: SYNTH_ANSWER.words.map((w) => ({ ...w, start_s: w.start_s * K, end_s: w.end_s * K })) };
const fakeDecode = async () => ({ data: new Float32Array(16), sampleRate: 48000 });
const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000));

function slowService({ slots = 2 } = {}) {
  let busy = 0;
  const wait = [];
  const take = () => (busy < slots ? (busy++, Promise.resolve()) : new Promise((r) => wait.push(r)));
  const give = () => (wait.length ? wait.shift()() : busy--);
  const work = async () => {
    await take();
    await sleep(LINE_S);
    give();
  };
  const stats = { synth: 0 };
  return {
    stats,
    orphan: () => void work(), // a request of the page before the reload: the service finishes it anyway
    fetch: async (url, { signal } = {}) => {
      const u = String(url);
      if (u.endsWith("/health")) return { ok: true, status: 200, json: async () => ({ ok: true }) };
      if (u.includes("/synth?")) {
        stats.synth++;
        const done = work();
        await Promise.race([done, new Promise((_, rej) => signal?.addEventListener("abort", () => rej(new Error("aborted"))))]);
        return { ok: true, status: 200, json: async () => ANSWER };
      }
      return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(8) };
    },
  };
}
const voiceOn = (svc, opts = {}) =>
  createVoice({ base: "http://tts", fetch: svc.fetch, decode: fakeDecode, virtual: true, timeoutS: 40 * K, extendS: 30 * K, cooldownS: 20 * K, ...opts });
const lines = Array.from({ length: 10 }, (_, i) => [i % 2 ? "fable-5.1" : "gpt-6-astra", `Реплика ${i + 1} из очереди после перезагрузки.`]);

test("a backlog of 10 lines after a reload on a slow, busy service: none falls back to the estimate", async () => {
  const svc = slowService();
  svc.orphan();
  svc.orphan();
  const voice = voiceOn(svc);
  const got = await Promise.all(lines.map(([s, t]) => voice.prepare(s, t)));
  const est = got.filter((p) => p.engine === "estimate").map((p) => p.reason);
  assert.deepEqual(est, [], `estimated: ${est.join("; ")}`);
});

test("the same backlog with the old client (every request at once, timeout from the call, no extension): lines go silent", async () => {
  const svc = slowService();
  svc.orphan();
  svc.orphan();
  const voice = voiceOn(svc, { maxInflight: Infinity, extendS: 0 });
  const got = await Promise.all(lines.map(([s, t]) => voice.prepare(s, t)));
  assert.ok(got.some((p) => p.engine === "estimate"), "the old behaviour reproduces the silent lines");
});

test("the presentation queue holds a beat whose voice is late, then plays it voiced (no beat estimated)", async () => {
  const svc = slowService();
  svc.orphan();
  svc.orphan();
  const voice = voiceOn(svc);
  const played = [];
  const sink = { say: (speaker, text, v, meta) => played.push({ n: meta.n, at: meta.at, engine: v?.engine }) };
  const q = new PresentationQueue({ voice, sink, gapS: 0.3 * K });
  lines.forEach(([speaker, text], n) => q.push({ n, type: "message", voice: { speaker, text }, calls: [{ method: "say", args: [speaker, text], voiced: true }] }, 0));
  const t0 = performance.now() / 1000;
  while (played.length < lines.length && performance.now() / 1000 - t0 < 30) {
    await q.advance(performance.now() / 1000 - t0);
    await sleep(0.01);
  }
  assert.equal(played.length, lines.length, "every beat played");
  assert.deepEqual(played.map((p) => p.n), lines.map((_, i) => i), "in order");
  assert.deepEqual(played.filter((p) => p.engine === "estimate"), [], "none estimated");
  assert.ok(played[0].at >= LINE_S, `the first beat waited for its voice (${played[0].at.toFixed(2)} s) instead of playing silent`);
});
