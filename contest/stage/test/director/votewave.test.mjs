// The Host's line at the start of every vote wave: secret ballot, tokens open when everyone has voted.
import { test } from "node:test";
import assert from "node:assert/strict";
import { host } from "../../director/host.js";
import { LEGACY, replayFiles, runShow as runShowBase } from "./helpers.mjs";
// The wave's own mechanics, on the show that reveals each place at once (helpers LEGACY); the sealed
// envelopes (the air show) are envelopes.test.mjs.
const runShow = (name, opts = {}) => runShowBase(name, { ...LEGACY, ...opts });


const WAVE = /^Судьи голосуют тайно\./;
const waveLines = (sink) => sink.calls.filter((c) => c.method === "host" && c.meta.type === "vote.wave").map((c) => c.args[0]);

test("voteWave: the line, with the majority line and the number of voters", () => {
  assert.equal(host.voteWave({ line: 3, voted: 5 }), "Судьи голосуют тайно. Жетоны откроем, когда проголосуют все: нужно 3 из 5.");
  assert.equal(host.voteWave({ line: 2, voted: 3 }), "Судьи голосуют тайно. Жетоны откроем, когда проголосуют все: нужно 2 из 3.");
});

for (const f of replayFiles()) {
  test(`${f}: the wave line is said once per wave, before the wave's first voteCast`, async () => {
    const { sink } = await runShow(f);
    const calls = sink.calls.filter((c) => (c.method === "host" && c.meta.type === "vote.wave") || c.method === "voteCast" || (c.method === "tally" && c.args[0].stage === "begin"));
    const waves = calls.filter((c) => c.method === "tally").map((c) => c.args[0]);
    assert.ok(waves.length > 0);
    assert.equal(calls.filter((c) => c.method === "host").length, waves.length, "one line per wave");
    let i = 0;
    for (const w of waves) {
      const line = calls[i];
      assert.equal(line.method, "host", `the wave ${w.place}-${w.round} starts with the Host`);
      assert.equal(line.args[0], host.voteWave({ line: w.line, voted: w.voted }));
      assert.match(line.args[0], WAVE);
      const casts = [];
      for (i++; calls[i].method === "voteCast"; i++) casts.push(calls[i]);
      assert.equal(casts.length, w.judges, "the walks follow the line");
      assert.ok(casts.every((c) => c.meta.at >= line.meta.at));
      assert.equal(calls[i].method, "tally");
      i++;
    }
    assert.equal(i, calls.length);
  });
}

test("a Judge is unavailable: the line counts the available voters", async () => {
  const one = waveLines((await runShow("unavailable")).sink);
  assert.ok(one.length >= 1);
  assert.equal(one[0], "Судьи голосуют тайно. Жетоны откроем, когда проголосуют все: нужно 3 из 4.");
  const two = waveLines((await runShow("two-unavailable")).sink);
  assert.equal(two[0], "Судьи голосуют тайно. Жетоны откроем, когда проголосуют все: нужно 2 из 3.");
});

test("the line is a Host beat of its own; the first voteCast keeps the voting status", async () => {
  const { sink } = await runShow("no-majority");
  assert.equal(waveLines(sink).length, 2, "two waves, two lines");
  const firstCast = sink.calls.findIndex((c) => c.method === "voteCast");
  assert.equal(sink.calls[firstCast - 1].method, "status");
  assert.equal(sink.calls[firstCast - 1].args[0].phase, "voting");
});
