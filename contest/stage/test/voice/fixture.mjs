// A synthetic line: 4 s at 16 kHz mono. Silence to 1 s, a loud burst 1–2 s, silence to 2.5 s, a quiet burst
// (a quarter of the loudness) 2.5–3.5 s, silence to 4 s. Words follow the bursts, in the service's shape.
export const SAMPLE_RATE = 16000;
export const DURATION_S = 4;
export const TEXT = "раз два три четыре";
export const WORDS = [
  { start_char: 0, end_char: 4, start_s: 1.0, end_s: 1.5 },
  { start_char: 4, end_char: 8, start_s: 1.5, end_s: 2.0 },
  { start_char: 8, end_char: 12, start_s: 2.5, end_s: 3.0 },
  { start_char: 12, end_char: 18, start_s: 3.0, end_s: 3.5 },
];

export function makePcm() {
  const data = new Float32Array(SAMPLE_RATE * DURATION_S);
  for (let i = 0; i < data.length; i++) {
    const t = i / SAMPLE_RATE;
    const amp = t >= 1 && t < 2 ? 0.4 : t >= 2.5 && t < 3.5 ? 0.1 : 0;
    data[i] = amp * Math.sin(2 * Math.PI * 220 * t);
  }
  return { data, sampleRate: SAMPLE_RATE };
}

export function makePrepared(extra = {}) {
  return { speaker: "opus-5.5", text: TEXT, words: WORDS, durationS: DURATION_S, pcm: makePcm(), audioUrl: "http://127.0.0.1:8790/audio/x.wav", engine: "macos", ...extra };
}

// What /synth answers for the fixture, and the audio bytes it points to (any bytes: tests inject `decode`).
export const SYNTH_ANSWER = { audio: "/audio/x.wav", duration_s: DURATION_S, words: WORDS, engine: "macos", voice: "Milena", cached: false, format: "wav" };

export function fakeFetch({ synth = () => ({ status: 200, body: SYNTH_ANSWER }), calls = [] } = {}) {
  return async (url, { signal } = {}) => {
    calls.push(String(url));
    const gone = new Promise((_, rej) => signal?.addEventListener("abort", () => rej(new Error("aborted"))));
    if (String(url).includes("/synth?")) {
      const r = await Promise.race([Promise.resolve(synth(url)), gone]);
      return { ok: r.status === 200, status: r.status, json: async () => r.body };
    }
    return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(8) };
  };
}
export const fakeDecode = async () => makePcm();
