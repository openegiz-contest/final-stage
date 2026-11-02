// The presentation queue with a voice that is late: the beat starts when the voice is ready, never in the past.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PresentationQueue } from "../../director/queue.js";

function lateVoice() {
  let release;
  const gate = new Promise((r) => (release = r));
  return {
    release: () => release(),
    prepare: async () => (await gate, { durationS: 4, words: [] }),
  };
}

const beat = { n: 0, type: "say", voice: { speaker: "opus-5.5", text: "Слово." } };

test("queue: a voice that resolves between ticks starts its beat at the tick it is seen ready", async () => {
  const voice = lateVoice();
  const starts = [];
  const sink = { say: (_s, _t, _v, meta) => starts.push(meta.at) };
  const q = new PresentationQueue({ voice, sink });
  q.push({ ...beat, calls: [{ method: "say", args: ["opus-5.5", "Слово."], voiced: true }] }, 0);
  await q.advance(0);          // not ready: stalls
  await q.advance(1);          // still not ready
  voice.release();
  await new Promise((r) => setTimeout(r, 5)); // resolves between ticks
  await q.advance(5);
  assert.ok(q.current, "the beat started");
  assert.equal(q.current.start, 5, "starts when its voice was seen ready, not at 0");
  assert.equal(q.current.end >= 9, true);
});
