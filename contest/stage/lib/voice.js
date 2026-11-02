// The Stage's voices, browser side (spec §7.7 «TTS», «Темп — очередь»): the director asks for a line, the TTS
// service (contest/stage/tts) synthesises it, WebAudio plays it, the text is typed under it, the robot's
// face light follows its level. Plain ES module; the pure parts also run in Node (test/voice/).
//
//   const voice = createVoice({ clock });                  clock: { now() → s, frozenAt? } (lib/clock.js, or its namespace)
//   voice.prepare(speaker, text) → Promise<prepared>       the director's voice interface; never rejects
//   prepared = { durationS, words, audioUrl?, text, speaker, engine, voice, cached, ... }
//       words        [{start_char, end_char, start_s, end_s}], char offsets converted to UTF-16
//       audioUrl     absolute URL of the cached audio on the service; absent for the silent estimate
//       engine       "elevenlabs" | "yandex" | "macos" (the service's answer) or "estimate" (fallback, 145 wpm)
//       reason       why the estimate was used (estimate only)
//       fallbackFrom the service's own skipped engines, if any
//   voice.play(prepared, { at }) → { end, stop() }         start the audio at show time `at` (a late call joins in the middle)
//   voice.typedAt(prepared, t) → n                         characters of prepared.text shown at show time t
//   voice.levelAt(t) → 0..1                                smoothed voice level of the line speaking at t; robot.setVoice(voice.levelAt)
//   voice.exportTrack(beats?, { from }) → [{audioUrl, at, durationS, speaker, engine}]   for tools/mux.mjs
//   voice.exportWav(beats?, { from, sampleRate }) → Uint8Array (WAV)
//   voice.audioPosition(play) → s | null                   how far the audio clock is into a line (play = an entry of voice.plays)
//   voice.report → [{speaker, engine, voice, cached, ms, reason?, fallbackFrom?}]   which engine spoke each line
//   voice.pause() / resume() / resync()                   the operator's pause (the audio clock stands) and, after a
//                                                          jump of the show clock, every line still to come rescheduled on it
//
// Two modes. Live: audio goes out through an AnalyserNode, `levelAt` reads it. Virtual (the page was opened with
// `?t=`, which is also how tools/clip.mjs and render.mjs open it): nothing is played, `levelAt` and `typedAt` are
// pure functions of t computed from the decoded samples, so stills and clips are repeatable.

import { EstimateVoice } from "../director/voice.js";

export const DEFAULT_BASE = "http://127.0.0.1:8790";
export const TIMEOUT_S = 40; // a request unanswered this long after it was SENT (tagger up to 15 s + ElevenLabs up to 20 s; a 563-character line took 27 s)
export const EXTEND_S = 30; // ... while the service answers /health: waited for this much longer (it is busy, e.g. still with a reloaded page's lines), then the estimate
export const COOLDOWN_S = 20; // after a timeout with the service down (/health does not answer) it is skipped for this long (a hung service must not cost a timeout per line)
export const MAX_INFLIGHT = 2; // requests to the service at once (tts/voices.json concurrency 2); the rest wait here, their timeout not running
export const LEAD_S = 0.25; // a word appears this long before it ends, at most half its length ahead: the text is never late,
// and the last word completes within LEAD_S of the audio's end
export const RELEASE_S = 0.12; // the level falls with this time constant; it rises with the 50 ms window of the RMS
const HOP_S = 0.01; // the envelope's step
const WINDOW_S = 0.05;
const TAIL_S = 0.4; // a line's level keeps decaying this long after its end

const LATE = Symbol("late");
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

// ---------------------------------------------------------------- typing

// Line time at which a word appears: LEAD_S before its end, or the middle of a short word.
export const revealTime = (w) => w.end_s - Math.min(LEAD_S, 0.5 * (w.end_s - w.start_s));

// Characters of prepared.text shown at show time t. The line started at `at` (default: where play() put it).
// Whole words, each at revealTime; once the last word is shown, the whole text (trailing whitespace included) is.
export function typedAt(prepared, t, at = prepared.at ?? 0) {
  const rel = t - at;
  const text = prepared.text ?? "";
  const words = prepared.words ?? [];
  if (!words.length) return rel >= (prepared.durationS ?? 0) && rel >= 0 ? text.length : 0;
  let n = 0;
  for (const w of words) {
    if (rel >= revealTime(w)) n = w.end_char;
    else break;
  }
  return n >= words[words.length - 1].end_char ? text.length : n;
}

// The service counts code points, the Stage slices UTF-16 strings: same unless the text has astral characters.
export function toUtf16Words(text, words) {
  if (!/[\ud800-\udfff]/.test(text)) return words;
  const at = [0]; // code point index → UTF-16 index
  for (let i = 0; i < text.length; ) {
    i += text.codePointAt(i) > 0xffff ? 2 : 1;
    at.push(i);
  }
  const u = (cp) => at[Math.min(cp, at.length - 1)];
  return words.map((w) => ({ ...w, start_char: u(w.start_char), end_char: u(w.end_char) }));
}

// ---------------------------------------------------------------- level

const envCache = new WeakMap();

// RMS of the 50 ms before each 10 ms step, and the line's reference loudness (p95 of the non-silent steps), so a
// quiet voice and a loud one drive the face light alike.
function envelopeOf(pcm) {
  let e = envCache.get(pcm.data);
  if (e) return e;
  const { data, sampleRate } = pcm;
  const hop = Math.max(1, Math.round(sampleRate * HOP_S));
  const win = Math.max(hop, Math.round(sampleRate * WINDOW_S));
  const steps = Math.ceil(data.length / hop);
  const env = new Float32Array(steps);
  for (let i = 0; i < steps; i++) {
    const end = Math.min(data.length, (i + 1) * hop);
    const start = Math.max(0, end - win);
    let s = 0;
    for (let k = start; k < end; k++) s += data[k] * data[k];
    env[i] = end > start ? Math.sqrt(s / (end - start)) : 0;
  }
  const live = Array.from(env).filter((v) => v > 1e-4).sort((a, b) => a - b);
  const ref = live.length ? Math.max(live[Math.floor(live.length * 0.95)], 0.005) : 0.1;
  e = { env, ref };
  envCache.set(pcm.data, e);
  return e;
}

export const referenceOf = (pcm) => envelopeOf(pcm).ref;

// Peak hold with an exponential release over raw(i) (one value per HOP_S), softened by a 4-step average so the
// attack is not a jump. A pure function of i: the same t gives the same level in any order of calls.
function released(raw, i) {
  const K = Math.ceil((4 * RELEASE_S) / HOP_S);
  const hold = (n) => {
    let best = 0;
    for (let k = 0; k <= K; k++) {
      const v = raw(n - k);
      if (v > 0) best = Math.max(best, v * Math.exp((-k * HOP_S) / RELEASE_S));
    }
    return best;
  };
  return clamp01((hold(i) + hold(i - 1) + hold(i - 2) + hold(i - 3)) / 4);
}

// Level 0..1 `rel` seconds into decoded audio { data: Float32Array mono, sampleRate }.
export function levelFromPcm(pcm, rel) {
  if (rel < 0) return 0;
  const { env, ref } = envelopeOf(pcm);
  return released((j) => (j >= 0 && j < env.length ? env[j] / ref : 0), Math.floor(rel / HOP_S));
}

// The silent estimate has no samples: the mouth opens on each word (a bump with a syllable wobble).
export function levelFromWords(words, rel) {
  if (rel < 0 || !words?.length) return 0;
  const raw = (j) => {
    const r = j * HOP_S;
    const w = words.find((x) => r >= x.start_s && r < x.end_s);
    if (!w) return 0;
    const u = (r - w.start_s) / Math.max(1e-6, w.end_s - w.start_s);
    return 0.3 + 0.55 * Math.sin(Math.PI * u) + 0.12 * Math.sin(r * 2 * Math.PI * 5.5);
  };
  return released(raw, Math.floor(rel / HOP_S));
}

// ---------------------------------------------------------------- WAV

export function encodeWav(data, sampleRate) {
  const out = new Uint8Array(44 + data.length * 2);
  const v = new DataView(out.buffer);
  const str = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF"); v.setUint32(4, 36 + data.length * 2, true); str(8, "WAVE"); str(12, "fmt ");
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, "data"); v.setUint32(40, data.length * 2, true);
  for (let i = 0; i < data.length; i++) v.setInt16(44 + i * 2, Math.round(Math.max(-1, Math.min(1, data[i])) * 32767), true);
  return out;
}

// Mono mix of the voiced beats at their `at` (minus `from`), linear resampling to `sampleRate`.
export function mixBeats(beats, { from = 0, sampleRate = 44100, tailS = 0.5 } = {}) {
  const voiced = beats.filter((b) => b.prepared.pcm);
  const endS = Math.max(0, ...voiced.map((b) => b.at - from + b.prepared.durationS)) + tailS;
  const mix = new Float32Array(Math.ceil(endS * sampleRate));
  for (const { prepared, at } of voiced) {
    const { data, sampleRate: sr } = prepared.pcm;
    const offset = Math.round((at - from) * sampleRate);
    for (let i = Math.max(0, -offset); i < Math.ceil((data.length / sr) * sampleRate) && offset + i < mix.length; i++) {
      const x = (i / sampleRate) * sr;
      const k = Math.floor(x);
      const a = data[k] ?? 0;
      mix[offset + i] += a + ((data[k + 1] ?? a) - a) * (x - k);
    }
  }
  return { data: mix, sampleRate };
}

// ---------------------------------------------------------------- the voice

async function decodeWithWebAudio(arrayBuffer, ctx) {
  const buffer = await ctx.decodeAudioData(arrayBuffer);
  let data = buffer.getChannelData(0);
  if (buffer.numberOfChannels > 1) {
    data = new Float32Array(buffer.length);
    for (let c = 0; c < buffer.numberOfChannels; c++) buffer.getChannelData(c).forEach((x, i) => (data[i] += x / buffer.numberOfChannels));
  }
  return { data, sampleRate: buffer.sampleRate, buffer };
}

export function createVoice({
  base = DEFAULT_BASE,
  clock = { now: () => performance.now() / 1000 },
  timeoutS = TIMEOUT_S,
  extendS = EXTEND_S,
  cooldownS = COOLDOWN_S,
  maxInflight = MAX_INFLIGHT,
  fetch: fetchFn = (...a) => globalThis.fetch(...a),
  decode, // (ArrayBuffer) → Promise<{data, sampleRate, buffer?}>; default WebAudio. Tests inject theirs.
  estimate = new EstimateVoice(),
  virtual,
  onReport,
} = {}) {
  const frozen = virtual ?? clock.virtual ?? (clock.frozenAt != null || (typeof location !== "undefined" && new URLSearchParams(location.search).has("t")));
  const cache = new Map(); // speaker + text → Promise<prepared>
  const plays = [];
  const report = [];
  let ctx = null;
  let analyser = null;
  let analyserBuf = null;
  let downUntil = 0;
  let live = { t: null, level: 0 };
  let held = false; // operator-controls: paused by the operator (ui/operator.js): the audio clock stands

  const audioContext = () => {
    if (!ctx) {
      ctx = new (globalThis.AudioContext || globalThis.webkitAudioContext)();
      analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0;
      analyserBuf = new Float32Array(analyser.fftSize);
      analyser.connect(ctx.destination);
    }
    return ctx;
  };
  const decodeAudio = decode ?? ((ab) => decodeWithWebAudio(ab, frozen ? new OfflineAudioContext(1, 1, 44100) : audioContext()));

  async function fromService(speaker, text, signal) {
    const url = `${base}/synth?speaker=${encodeURIComponent(speaker)}&text=${encodeURIComponent(text)}`;
    const r = await fetchFn(url, { signal });
    if (!r.ok) throw new Error(`synth ${r.status}`);
    const j = await r.json();
    if (!j.audio || !Array.isArray(j.words)) throw new Error("synth: no audio or words in the answer");
    const audioUrl = new URL(j.audio, base).href;
    const a = await fetchFn(audioUrl, { signal });
    if (!a.ok) throw new Error(`audio ${a.status}`);
    const pcm = await decodeAudio(await a.arrayBuffer());
    return {
      durationS: Math.max(j.duration_s ?? 0, pcm.data.length / pcm.sampleRate),
      words: toUtf16Words(text, j.words),
      audioUrl,
      engine: j.engine,
      voice: j.voice ?? null,
      cached: !!j.cached,
      ...(j.fallback_from?.length ? { fallbackFrom: j.fallback_from } : {}),
      pcm: { data: pcm.data, sampleRate: pcm.sampleRate },
      buffer: pcm.buffer ?? null,
    };
  }

  // at most maxInflight requests at the service; the others wait their turn here, untimed (a reload's
  // or a backlog's lines must not time out in a queue and send the following lines to the estimate)
  let inflight = 0;
  const turns = [];
  const slot = () => (inflight < maxInflight ? (inflight++, Promise.resolve()) : new Promise((r) => turns.push(r)));
  const free = () => {
    const next = turns.shift();
    if (next) next();
    else inflight--;
  };
  async function healthy() {
    try {
      const r = await fetchFn(`${base}/health`, { signal: AbortSignal.timeout(3000) });
      return !!(r.ok && (await r.json())?.ok);
    } catch {
      return false;
    }
  }
  // the service's answer, or null at the deadline: timeoutS after sending, extendS more while the
  // service answers /health (busy, not down); { down: true } when it does not
  async function ask(speaker, text) {
    const ctl = new AbortController();
    const req = fromService(speaker, text, ctl.signal);
    req.catch(() => {});
    let timer;
    const late = (s) => new Promise((r) => (timer = setTimeout(() => r(LATE), s * 1000)));
    try {
      let r = await Promise.race([req, late(timeoutS)]);
      clearTimeout(timer);
      if (r !== LATE) return r;
      const up = extendS > 0 && (await healthy());
      if (up) r = await Promise.race([req, late(extendS)]);
      if (r !== LATE) return r;
      ctl.abort();
      throw Object.assign(new Error(`no answer in ${up ? timeoutS + extendS : timeoutS} s${up ? " (service up, busy)" : ""}`), { timeout: true, down: !up });
    } finally {
      clearTimeout(timer);
    }
  }

  async function load(speaker, text) {
    const started = performance.now();
    let prepared;
    let reason = null;
    if (!text.trim()) reason = "empty text";
    else if (Date.now() < downUntil) reason = "service skipped after a timeout";
    else {
      await slot();
      try {
        if (Date.now() < downUntil) reason = "service skipped after a timeout"; // went down while this line waited
        else prepared = await ask(speaker, text);
      } catch (e) {
        reason = e.timeout ? e.message : String(e?.message ?? e);
        if (e.timeout && e.down) downUntil = Date.now() + cooldownS * 1000;
      } finally {
        free();
      }
    }
    if (!prepared) {
      const est = await estimate.prepare(speaker, text);
      prepared = { durationS: est.durationS, words: est.words, engine: "estimate", voice: null, cached: false, reason };
    }
    prepared = { ...prepared, speaker, text };
    const entry = {
      speaker, engine: prepared.engine, voice: prepared.voice, cached: prepared.cached,
      ms: Math.round(performance.now() - started),
      ...(prepared.reason ? { reason: prepared.reason } : {}), ...(prepared.fallbackFrom ? { fallbackFrom: prepared.fallbackFrom } : {}),
    };
    report.push(entry);
    onReport?.(entry);
    return prepared;
  }

  function prepare(speaker, text) {
    text = String(text ?? "");
    const key = `${speaker}\u0000${text}`;
    if (!cache.has(key)) cache.set(key, load(speaker, text));
    return cache.get(key);
  }

  // the line's audio on the audio clock, `at` on the show clock (a late start joins in the middle)
  function startSource(entry) {
    const { prepared, at } = entry;
    const c = audioContext();
    if (c.state === "suspended" && !held) c.resume().catch(() => {});
    const source = c.createBufferSource();
    source.buffer = prepared.buffer;
    source.connect(analyser);
    const delay = at - clock.now();
    if (delay >= 0) source.start(c.currentTime + delay);
    else if (-delay < prepared.buffer.duration) source.start(0, -delay);
    source.onended = () => (entry.endedAt = clock.now());
    entry.source = source;
    entry.ctxStart = c.currentTime + delay;
  }

  function play(prepared, { at = clock.now() } = {}) {
    prepared.at = at;
    const entry = { prepared, speaker: prepared.speaker, at, end: at + prepared.durationS, source: null, endedAt: null };
    plays.push(entry);
    if (!frozen && prepared.buffer) startSource(entry);
    return {
      end: entry.end,
      stop() {
        try { entry.source?.stop(); } catch {}
      },
    };
  }

  function current(t) {
    for (let i = plays.length - 1; i >= 0; i--) {
      const p = plays[i];
      if (t >= p.at && t < p.end + TAIL_S) return p;
    }
    return null;
  }

  function levelAt(t) {
    const p = current(t);
    const dt = live.t == null ? 0 : Math.max(0, t - live.t);
    live.t = t;
    if (!p) return frozen ? 0 : (live.level *= Math.exp(-dt / RELEASE_S));
    const { prepared } = p;
    if (!prepared.pcm) return levelFromWords(prepared.words, t - p.at);
    if (frozen) return levelFromPcm(prepared.pcm, t - p.at);
    if (!p.source || !analyser) return levelFromPcm(prepared.pcm, t - p.at); // late or unplayable: from the samples
    analyser.getFloatTimeDomainData(analyserBuf);
    let s = 0;
    for (const x of analyserBuf) s += x * x;
    const raw = Math.sqrt(s / analyserBuf.length) / referenceOf(prepared.pcm);
    live.level = Math.max(raw, live.level * Math.exp(-dt / RELEASE_S));
    return clamp01(live.level);
  }

  // Seconds of a line's audio played so far by the audio clock (null in virtual mode or for a silent line):
  // the check that typing follows what is heard, not just the show clock.
  const audioPosition = (entry) => (ctx && entry.source ? ctx.currentTime - entry.ctxStart : null);

  const asBeats = (beats) => (beats ?? plays).map((b) => ({ prepared: b.prepared ?? b, at: b.at ?? b.prepared?.at ?? 0 }));

  function exportTrack(beats, { from = 0 } = {}) {
    const seen = new Set();
    return asBeats(beats)
      .filter((b) => b.prepared.audioUrl)
      .map((b) => ({ audioUrl: b.prepared.audioUrl, at: +(b.at - from).toFixed(3), durationS: b.prepared.durationS, speaker: b.prepared.speaker, engine: b.prepared.engine }))
      .filter((b) => !seen.has(`${b.audioUrl}@${b.at}`) && seen.add(`${b.audioUrl}@${b.at}`))
      .sort((a, b) => a.at - b.at);
  }

  function exportWav(beats, { from = 0, sampleRate = 44100 } = {}) {
    const mix = mixBeats(asBeats(beats), { from, sampleRate });
    return encodeWav(mix.data, mix.sampleRate);
  }

  return {
    prepare,
    play,
    levelAt,
    typedAt: (prepared, t, at) => typedAt(prepared, t, at),
    exportTrack,
    exportWav,
    audioPosition,
    // Resume the AudioContext from a click (autoplay policy); a no-op in virtual mode.
    async unlock() {
      if (frozen) return "virtual";
      const c = audioContext();
      if (c.state === "suspended") await c.resume().catch(() => {});
      return c.state;
    },
    // operator-controls (ui/operator.js): the operator's pause stops the audio clock with the show
    // clock; after the show clock jumps, every line still to be heard is scheduled again on it.
    async pause() {
      held = true;
      if (ctx && ctx.state === "running") await ctx.suspend().catch(() => {});
    },
    async resume() {
      held = false;
      if (ctx && ctx.state === "suspended") await ctx.resume().catch(() => {});
    },
    resync() {
      if (frozen || !ctx) return;
      const t = clock.now();
      for (const e of plays) {
        if (e.source) {
          e.source.onended = null;
          try { e.source.stop(); } catch {}
          e.source = null;
        }
        if (e.prepared.buffer && e.end > t) startSource(e);
      }
    },
    get audioState() { return ctx?.state ?? null; },
    // Drop a line's decoded audio (a Final has dozens of lines, each a few MB decoded).
    release(prepared) {
      cache.delete(`${prepared.speaker}\u0000${prepared.text}`);
      prepared.buffer = null;
      prepared.pcm = null;
    },
    get report() { return report; },
    get plays() { return plays; },
    get virtual() { return frozen; },
    get engine() { return report.at(-1)?.engine ?? null; },
  };
}
