import { test } from "node:test";
import assert from "node:assert/strict";
import { createVoice, typedAt, toUtf16Words, levelFromPcm, levelFromWords, encodeWav, revealTime } from "../../lib/voice.js";
import { TEXT, WORDS, DURATION_S, makePcm, makePrepared, fakeFetch, fakeDecode, SYNTH_ANSWER } from "./fixture.mjs";

const at = revealTime; // when a word appears, line time

test("typedAt: whole words, nothing before the first, everything after the last", () => {
  const p = makePrepared();
  assert.equal(typedAt(p, 0, 0), 0);
  assert.equal(typedAt(p, at(WORDS[0]) - 0.01, 0), 0);
  assert.equal(typedAt(p, at(WORDS[0]), 0), 4);
  assert.equal(typedAt(p, at(WORDS[1]) - 0.01, 0), 4);
  assert.equal(typedAt(p, at(WORDS[1]), 0), 8);
  assert.equal(typedAt(p, at(WORDS[2]) + 0.01, 0), 12);
  assert.equal(typedAt(p, at(WORDS[3]), 0), TEXT.length);
  assert.equal(typedAt(p, 99, 0), TEXT.length);
  for (const t of [0, 1.2, 1.6, 2.7, 3.2, 9]) assert.ok([0, 4, 8, 12, 18].includes(typedAt(p, t, 0)), `t=${t}: a word boundary`);
});

test("typedAt: show time through `at`; never decreases; the last character lands near the audio end", () => {
  const p = makePrepared();
  p.at = 10;
  assert.equal(typedAt(p, 10.2), 0);
  assert.equal(typedAt(p, 11.3), 4);
  assert.equal(typedAt(p, 11.3, 0), TEXT.length); // an explicit `at` wins
  let prev = 0;
  let full = null;
  for (let t = 9; t < 16; t += 0.01) {
    const n = typedAt(p, t);
    assert.ok(n >= prev);
    prev = n;
    if (n === TEXT.length && full === null) full = t;
  }
  assert.ok(Math.abs(full - (10 + DURATION_S)) <= 0.8, `fully typed at ${full}`); // the fixture's audio ends 0.5 s after its last word
  assert.ok(Math.abs(full - (10 + WORDS[3].end_s)) <= 0.3);
});

test("revealTime: short words in the middle, long ones 0.25 s before their end", () => {
  assert.equal(revealTime({ start_s: 1, end_s: 1.2 }), 1.1);
  assert.equal(revealTime({ start_s: 1, end_s: 2 }), 1.75);
});

test("typedAt: a line without words is shown whole when it ends; an empty one is empty", () => {
  assert.equal(typedAt({ text: "ok", words: [], durationS: 1 }, 0.5, 0), 0);
  assert.equal(typedAt({ text: "ok", words: [], durationS: 1 }, 1, 0), 2);
  assert.equal(typedAt({ text: "", words: [], durationS: 0 }, 0, 0), 0);
});

test("toUtf16Words: code point offsets become UTF-16 offsets", () => {
  const text = "а 😀 б";
  const words = [{ start_char: 0, end_char: 2, start_s: 0, end_s: 1 }, { start_char: 2, end_char: 4, start_s: 1, end_s: 2 }, { start_char: 4, end_char: 5, start_s: 2, end_s: 3 }];
  const u = toUtf16Words(text, words);
  assert.deepEqual(u.map((w) => text.slice(w.start_char, w.end_char)), ["а ", "😀 ", "б"]);
  assert.equal(toUtf16Words("abc", words), words);
});

test("levelFromPcm: silent in silence, loud in a burst, a quiet burst reads quieter, falls after the end", () => {
  const pcm = makePcm();
  assert.equal(levelFromPcm(pcm, 0.5), 0);
  assert.equal(levelFromPcm(pcm, -1), 0);
  assert.ok(levelFromPcm(pcm, 1.5) > 0.9, `loud burst: ${levelFromPcm(pcm, 1.5)}`);
  const quiet = levelFromPcm(pcm, 3.0);
  assert.ok(quiet > 0.15 && quiet < 0.4, `quiet burst: ${quiet}`);
  let prev = levelFromPcm(pcm, 2.0);
  for (let t = 2.0; t < 2.5; t += 0.01) {
    const l = levelFromPcm(pcm, t);
    assert.ok(l <= prev + 1e-9, "release never rises in silence");
    prev = l;
  }
  assert.ok(levelFromPcm(pcm, 2.45) < 0.05);
  assert.equal(levelFromPcm(pcm, 99), 0);
});

test("levelFromPcm: deterministic and smooth, whatever the order of calls", () => {
  const pcm = makePcm();
  const ts = Array.from({ length: 400 }, (_, i) => i * 0.01);
  const forward = ts.map((t) => levelFromPcm(pcm, t));
  const shuffled = [...ts].reverse().map((t) => levelFromPcm(pcm, t)).reverse();
  assert.deepEqual(forward, shuffled);
  assert.deepEqual(forward, ts.map((t) => levelFromPcm(makePcm(), t)));
  for (const l of forward) assert.ok(l >= 0 && l <= 1);
  const frame = 1 / 30;
  for (let i = 1; i < forward.length; i++) assert.ok(Math.abs(forward[i] - forward[i - 1]) < 0.25, `no jump at ${ts[i]}`);
  assert.ok(Math.max(...ts.map((t) => Math.abs(levelFromPcm(pcm, t + frame) - levelFromPcm(pcm, t)))) < 0.9);
});

test("levelFromWords: the silent estimate moves the mouth on words only", () => {
  assert.equal(levelFromWords(WORDS, 0.5), 0);
  assert.ok(levelFromWords(WORDS, 1.25) > 0.3);
  assert.ok(levelFromWords(WORDS, 2.3) < levelFromWords(WORDS, 1.25));
  assert.ok(levelFromWords(WORDS, 3.95) < 0.05);
});

test("encodeWav: a valid 16-bit mono header", () => {
  const w = encodeWav(new Float32Array([0, 1, -1, 0.5]), 8000);
  const v = new DataView(w.buffer);
  assert.equal(String.fromCharCode(...w.slice(0, 4)), "RIFF");
  assert.equal(String.fromCharCode(...w.slice(8, 12)), "WAVE");
  assert.equal(v.getUint32(24, true), 8000);
  assert.equal(v.getUint32(40, true), 8);
  assert.equal(w.length, 44 + 8);
  assert.equal(v.getInt16(46, true), 32767);
  assert.equal(v.getInt16(48, true), -32767);
});

const make = (opts = {}) => createVoice({ fetch: fakeFetch(), decode: fakeDecode, virtual: true, clock: { now: () => 0 }, ...opts });

test("prepare: shape from /synth, the audio fetched and decoded, the same promise for the same line", async () => {
  const calls = [];
  const voice = make({ fetch: fakeFetch({ calls }) });
  const a = voice.prepare("opus-5.5", TEXT);
  assert.equal(voice.prepare("opus-5.5", TEXT), a);
  assert.notEqual(voice.prepare("sonnet-5.5", TEXT), a);
  const p = await a;
  assert.equal(p.engine, "macos");
  assert.equal(p.voice, "Milena");
  assert.equal(p.audioUrl, "http://127.0.0.1:8790/audio/x.wav");
  assert.equal(p.durationS, DURATION_S);
  assert.equal(p.text, TEXT);
  assert.deepEqual(p.words, WORDS);
  assert.ok(p.pcm.data.length > 0);
  assert.equal(calls.filter((u) => u.includes("/synth?")).length, 2, "one /synth per distinct line");
  assert.match(calls[0], /speaker=opus-5\.5&text=%D1%80%D0%B0%D0%B7/);
  assert.deepEqual(voice.report.map((r) => [r.speaker, r.engine]), [["opus-5.5", "macos"], ["sonnet-5.5", "macos"]]);
});

test("prepare: falls back to the estimate, and says why, when the service is down, errs or is slow", async () => {
  const down = make({ fetch: async () => { throw new TypeError("Failed to fetch"); } });
  const d = await down.prepare("host", "Добрый вечер, коллеги");
  assert.equal(d.engine, "estimate");
  assert.match(d.reason, /Failed to fetch/);
  assert.equal(d.audioUrl, undefined);
  assert.equal(d.words.length, 3);
  assert.ok(d.durationS > 1);

  const bad = make({ fetch: fakeFetch({ synth: () => ({ status: 502, body: { error: "all engines failed" } }) }) });
  assert.match((await bad.prepare("host", "текст")).reason, /synth 502/);

  const slow = make({ fetch: fakeFetch({ synth: () => new Promise(() => {}) }), timeoutS: 0.05, cooldownS: 5 });
  const t0 = Date.now();
  const s = await slow.prepare("host", "текст");
  assert.ok(Date.now() - t0 < 1000);
  assert.equal(s.engine, "estimate");
  assert.match(s.reason, /no answer/);
  const t1 = Date.now();
  const s2 = await slow.prepare("host", "другой текст");
  assert.ok(Date.now() - t1 < 50, "after a timeout the service is skipped for a while");
  assert.match(s2.reason, /skipped/);

  assert.equal((await make().prepare("host", "   ")).engine, "estimate");
});

test("play in virtual mode: logged, no audio, the level and the typing follow t", async () => {
  const voice = make();
  const p = await voice.prepare("opus-5.5", TEXT);
  const h = voice.play(p, { at: 20 });
  assert.equal(h.end, 20 + DURATION_S);
  assert.equal(voice.levelAt(19), 0);
  assert.ok(voice.levelAt(21.5) > 0.9);
  assert.equal(voice.levelAt(21.5), voice.levelAt(21.5));
  assert.equal(voice.levelAt(30), 0);
  assert.equal(voice.typedAt(p, 20.1), 0);
  assert.equal(voice.typedAt(p, 30), TEXT.length);
  const est = await make({ fetch: async () => { throw new Error("down"); } }).prepare("host", "раз два три");
  const v2 = make();
  v2.play(est, { at: 0 });
  assert.ok(Math.max(...Array.from({ length: 100 }, (_, i) => v2.levelAt(i * 0.02))) > 0.3, "the estimate still opens the mouth");
});

test("exportTrack and exportWav: the voiced lines at their times, relative to --from", async () => {
  const voice = make();
  const a = await voice.prepare("opus-5.5", TEXT);
  const b = await voice.prepare("host", "Другая реплика");
  const silent = { speaker: "host", text: "x", words: [], durationS: 1, engine: "estimate" };
  voice.play(a, { at: 2 });
  voice.play(a, { at: 2 });
  voice.play(b, { at: 8.5 });
  voice.play(silent, { at: 12 });
  const track = voice.exportTrack();
  assert.deepEqual(track.map((l) => l.at), [2, 8.5]);
  assert.equal(voice.exportTrack(undefined, { from: 1 })[0].at, 1);
  assert.deepEqual(Object.keys(track[0]).sort(), ["at", "audioUrl", "durationS", "engine", "speaker"]);
  const wav = voice.exportWav(undefined, { sampleRate: 8000 });
  const v = new DataView(wav.buffer);
  assert.equal(v.getUint32(24, true), 8000);
  assert.equal((wav.length - 44) / 2, Math.ceil((8.5 + DURATION_S + 0.5) * 8000));
  const at3 = (s) => v.getInt16(44 + Math.round(s * 8000) * 2, true);
  assert.equal(at3(1), 0);
  assert.ok(Math.abs(at3(2 + 1.002)) + Math.abs(at3(2 + 1.0045)) > 0, "the burst of the first line sits at 3 s");
});
