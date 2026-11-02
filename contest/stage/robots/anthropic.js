// The Anthropic family as characters: matte cream ceramic and terracotta (the models:
// tools/blender/robots.py). Each gives its tempo, its rest poses, its own speaking gesture and its face.
//   Opus 5.5    large and calm: 1.95 m, broad, heavy; slow (0.7x), long weight shifts; weighs with both palms
//   Sonnet 5.5  light: 1.57 m, slim; quick (1.25x), small fast motions; a quick open-hand flick, a head tilt
//   Fable 5.1   the storyteller: 1.77 m, terracotta, a rounded head with one warm projector lens;
//               open palms in a slow arc, a slow head tilt
import { CERAMIC } from "/world/palette.js";
import { smooth } from "/world/timeline.js";

// an envelope for a gesture over u = 0..1: in, hold, out
const env = (u, a = 0.22, b = 0.72) => smooth(u / a) * (1 - smooth((u - b) / (1 - b)));

export const opus = {
  face: { kind: "eyes", size: [0.33, 0.07], eyes: [[-0.062, 0.002, 0.016], [0.062, 0.002, 0.016]], surface: "#15110f", light: CERAMIC.glow, gain: 2.6 },
  motion: { tempo: 0.7, stride: 0.27, knee: 0.55, stepLen: 0.48, speed: 0.8, bob: 0.014, sway: 0.05, armSwing: 0.2, gesture: 0.75, dropReach: -1.05,
    breath: 1.3, shiftAmp: 0.8, shiftPeriod: 9.5, stance: 1.12, stagger: 0.035 },
  look: {
    waiting: { lean: 0.0, hdP: 0.1, shLz: 0.08, shRz: -0.08, elL: -0.36, elR: -0.36, fgL: 0.5, fgR: 0.5 },
    speaking: { shLx: -0.2, elL: -0.75, shRx: -0.3, elR: -0.85 },
  },
  gestureDur: 2.4,
  // both palms open at the chest, weighing: they rise and fall against each other, a slow nod
  gesture(u) {
    const e = env(u), w = Math.sin(u * Math.PI * 3) * 0.07;
    return { shLx: -0.45 * e + w * e, shLz: 0.1 * e, elL: -0.75 * e, twL: 1.35 * e, fgL: -0.3 * e,
      shRx: -0.45 * e - w * e, shRz: -0.1 * e, elR: -0.6 * e, twR: 0.9 * e, fgR: -0.25 * e, hdP: 0.08 * e, lean: -0.015 * e };
  },
};

export const sonnet = {
  face: { kind: "eyes", size: [0.1, 0.121], eyes: [[-0.022, 0.018, 0.0115], [0.022, 0.018, 0.0115]], surface: "#15110f", light: CERAMIC.glow, gain: 2.6 },
  motion: { tempo: 1.25, stride: 0.36, knee: 0.7, stepLen: 0.56, speed: 1.2, bob: 0.018, sway: 0.03, armSwing: 0.34, gesture: 1.2, dropReach: -1.2,
    breath: 0.8, shiftAmp: 1.0, shiftPeriod: 5.5, stance: 1.05, stagger: 0.04 },
  look: {
    waiting: { hdP: 0.02, hdR: 0.04, elL: -0.26, elR: -0.34, fgL: 0.4, fgR: 0.45 },
    working: { lean: 0.12, hdP: 0.22 },
  },
  gestureDur: 1.5,
  // a quick open-hand flick toward the room, the head tilts with it
  gesture(u) {
    const e = smooth(u / 0.14) * (1 - smooth((u - 0.6) / 0.4));
    const flick = Math.sin(Math.min(1, u / 0.35) * Math.PI) * 0.2;
    return { shRx: -0.55 * e - flick, shRz: 0.05 * e, elR: -0.55 * e, twR: 0.7 * e, fgR: -0.35 * e, wfR: -0.25 * e, hdR: 0.13 * e, hdY: -0.08 * e, twist: -0.06 * e };
  },
};

export const fable = {
  face: { kind: "lens", size: [0.058, 0.058], surface: "#1a120c", light: "#ffad59", gain: 3.0 },
  motion: { tempo: 0.85, stride: 0.3, knee: 0.6, stepLen: 0.5, speed: 0.95, bob: 0.014, sway: 0.04, armSwing: 0.18, gesture: 0.9, dropReach: -1.1,
    breath: 1.0, shiftAmp: 1.0, shiftPeriod: 7, stance: 1.08, stagger: 0.04 },
  look: {
    waiting: { lean: 0.04, hdP: 0.12, hdR: 0.07, shLx: -0.05, elL: -0.45, elR: -0.4, twL: -0.1, twR: -0.1, fgL: 0.35, fgR: 0.35 },
    speaking: { hdR: 0.06, shLx: -0.25, elL: -0.8, twL: 0.6, shRx: -0.3, elR: -0.85, twR: 0.6 },
  },
  gestureDur: 2.6,
  // the storyteller: both palms open outward in a slow arc, the head tilts slowly to one side
  gesture(u) {
    const e = env(u, 0.3, 0.7), arc = smooth(u / 0.65);
    return { shLx: -0.5 * e, shLz: (0.12 + 0.42 * arc) * e, elL: -0.7 * e + 0.3 * arc * e, twL: 1.3 * e, fgL: -0.35 * e, wfL: -0.2 * e,
      shRx: -0.5 * e, shRz: -(0.12 + 0.42 * arc) * e, elR: -0.7 * e + 0.3 * arc * e, twR: 1.3 * e, fgR: -0.35 * e, wfR: -0.2 * e,
      hdR: 0.16 * smooth(u / 0.8) * e, hdP: -0.06 * e, lean: -0.02 * e };
  },
};
