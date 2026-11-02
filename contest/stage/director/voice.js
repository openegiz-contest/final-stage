// Voices: how long a line is spoken and which character is on which word.
//
//   voice.prepare(speaker, text) -> Promise<{ durationS, words, audioUrl? }>
//     speaker   "host" or a Judge's name (the voice engine picks the robot's voice from it)
//     words     [{ start_char, end_char, start_s, end_s }]; chars are UTF-16 offsets into text, seconds are
//               from the start of the line. The Stage types text under the voice with them.
//     audioUrl  where the Stage plays the sound from; absent for the silent estimate
//
// A TTS implementation (ElevenLabs, Yandex SpeechKit, macOS) lives outside the director and is passed to it:
// it only has to return this shape. Rejecting is allowed; the director then falls back to the estimate.

export const WORDS_PER_MINUTE = 145;

// Estimated timing: 145 words/min, a word's share of the time follows its length, a comma or a full
// stop adds a short pause.
export function estimateTiming(text, wpm = WORDS_PER_MINUTE) {
  const t = String(text ?? "");
  const found = [...t.matchAll(/\S+/g)];
  if (!found.length) return { durationS: 0, words: [] };
  const durationS = (found.length * 60) / wpm;
  const weight = (w) => w.length + (/[.!?…]$/.test(w) ? 5 : /[,;:—–-]$/.test(w) ? 2.5 : 0);
  const total = found.reduce((s, m) => s + weight(m[0]), 0);
  let at = 0;
  const words = found.map((m) => {
    const dur = (weight(m[0]) / total) * durationS;
    const w = { start_char: m.index, end_char: m.index + m[0].length, start_s: round3(at), end_s: round3(at + dur) };
    at += dur;
    return w;
  });
  return { durationS: round3(durationS), words };
}

const round3 = (x) => Math.round(x * 1000) / 1000;

export class EstimateVoice {
  constructor({ wpm = WORDS_PER_MINUTE } = {}) {
    this.wpm = wpm;
  }

  async prepare(_speaker, text) {
    return estimateTiming(text, this.wpm);
  }
}
