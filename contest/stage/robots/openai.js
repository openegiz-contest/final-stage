// The OpenAI family as characters: black glass, strict geometry, a light bar behind smoked glass (the
// models: tools/blender/robots.py). The same care as the ceramic family: own tempo, poses, gesture.
//   GPT 6.1 sol    warmer: soft chamfers, a wraparound visor with a warm bar (~3300 K); sets a point
//                  down with a flat hand
//   GPT 6 astra    colder: hard planar facets, a ridge down the face, a thin cold bar (~7500 K), 1.89 m;
//                  frames a box with both hands
import { GLASS } from "/world/palette.js";
import { smooth } from "/world/timeline.js";

// the bars' light: blackbody colours (CIE Planckian locus -> sRGB), so the two read as two temperatures
const K3300 = "#ffb46c", K7500 = "#ebecff";

const env = (u, a = 0.22, b = 0.72) => smooth(u / a) * (1 - smooth((u - b) / (1 - b)));

export const sol = {
  face: { kind: "bar", size: [0.22, 0.05], bar: 0.013, surface: GLASS.smoke, light: K3300, gain: 2.2, status: 1.6 },
  motion: { tempo: 1.0, stride: 0.33, knee: 0.62, stepLen: 0.58, speed: 1.12, bob: 0.012, sway: 0.03, armSwing: 0.28, gesture: 1, dropReach: -1.1,
    breath: 1.0, shiftAmp: 0.9, shiftPeriod: 7.8, stance: 1.08, stagger: 0.03 },
  look: {
    waiting: { hdP: 0.06, elL: -0.32, elR: -0.32 },
  },
  gestureDur: 1.9,
  // a flat right hand, edge down, that sets a point on an invisible table; a nod with it
  gesture(u) {
    const e = env(u, 0.2, 0.75), chop = smooth((u - 0.38) / 0.14) * 0.28;
    return { shRx: -0.75 * e + chop * e, shRz: 0.02 * e, elR: -1.0 * e, twR: -0.05 * e, fgR: -0.38 * e, wfR: -0.1 * e,
      shLx: -0.12 * e, elL: -0.3 * e, hdP: 0.1 * chop / 0.28 * e, lean: 0.02 * e };
  },
};

export const astra = {
  face: { kind: "bar", size: [0.19, 0.036], bar: 0.0105, surface: GLASS.smoke, light: K7500, gain: 2.5, status: 1.6 },
  motion: { tempo: 0.95, stride: 0.33, knee: 0.6, stepLen: 0.6, speed: 1.12, bob: 0.011, sway: 0.028, armSwing: 0.26, gesture: 0.9, dropReach: -1.1,
    breath: 0.9, shiftAmp: 0.7, shiftPeriod: 8.6, stance: 1.04, stagger: 0.02 },
  look: {
    waiting: { hdP: 0.04, lean: 0.0, elL: -0.28, elR: -0.28, fgL: 0.36, fgR: 0.36 },
  },
  gestureDur: 2.1,
  // both hands frame a box in front of the chest: palms facing, they set apart, hold, close in a little
  gesture(u) {
    const e = env(u, 0.22, 0.78), open = smooth((u - 0.2) / 0.25) * 0.12 - smooth((u - 0.55) / 0.15) * 0.04;
    return { shLx: -0.48 * e, shLz: (0.12 + open) * e, elL: -1.15 * e, twL: 0.05 * e, fgL: -0.36 * e,
      shRx: -0.48 * e, shRz: -(0.12 + open) * e, elR: -1.15 * e, twR: 0.05 * e, fgR: -0.36 * e, hdP: 0.05 * e };
  },
};
