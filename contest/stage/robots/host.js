// The Host as a character: the mine's own dispatcher, neither vendor's (the model:
// tools/blender/robots.py). Graphite powder coat, a safety-amber hard hat with a cap lamp (its face
// light), hi-vis bands, two dark camera eyes, two wheels: it rolls, it does not walk, it has no console.
// When it speaks it turns to the ballot box and presents it once with an open hand; waiting, it
// looks along the row of Judges.
import { HOUSE } from "/world/palette.js";
import { smooth, clamp01, wrap } from "/world/timeline.js";
import { BALLOT } from "/world/layout.js";

const env = (u, a = 0.22, b = 0.72) => smooth(u / a) * (1 - smooth((u - b) / (1 - b)));

/** The pose that presents the ballot box: `side` is the yaw to the box from where the Host faces. */
function present(side, e) {
  const s = Math.sign(side) || 1, turn = Math.max(-1.2, Math.min(1.2, side));
  const arm = s > 0 ? { shLx: -0.75 * e, shLz: 0.55 * e, elL: -0.35 * e, twL: 1.25 * e, fgL: -0.32 * e, wfL: -0.25 * e }
    : { shRx: -0.75 * e, shRz: -0.55 * e, elR: -0.35 * e, twR: 1.25 * e, fgR: -0.32 * e, wfR: -0.25 * e };
  return { ...arm, twist: 0.32 * turn * e, hdY: 0.5 * turn * e, hdP: 0.05 * e };
}

const ballotSide = (place, yaw) => {
  const p = place.post;
  return wrap(Math.atan2(BALLOT.x - p.x, BALLOT.z - p.z) - yaw);
};

export const host = {
  face: { kind: "lamp", size: [0.08, 0.068], surface: "#20201f", light: HOUSE.lamp, gain: 2.2 },
  motion: { tempo: 1.0, gesture: 0.8, breath: 0.5 },
  look: {
    waiting: { hdP: 0.04, shLx: 0.02, shRx: 0.02, elL: -0.45, elR: -0.45, twL: -0.2, twR: -0.2, face: 0.12 },
    speaking: { shRx: -0.4, elR: -0.9, shRz: -0.2, face: 0.45 },
  },
  gestureDur: 2.2,
  // an open hand toward the ballot box (on its left from its post)
  gesture(u) {
    return present(1.3, env(u));
  },
  // speaking: it turns toward the box and presents it once with an open hand as it starts, then holds,
  // turned a little to the box (not on the voice: each word kicked the arm; owner 2026-10-28); waiting,
  // it looks along the Judges' row
  extra(out, t, ctx) {
    if (ctx.state === "speaking") {
      const side = ballotSide(ctx.place, ctx.yaw);
      const e = env(clamp01((ctx.since - 0.3) / 2.4));
      const base = 0.35 + 0.15 * Math.sin(ctx.ts * 0.4);
      const p = present(side, e);
      for (const k in p) out[k] += p[k];
      out.twist += 0.12 * Math.sign(side) * base;
      out.hdY += 0.25 * Math.sign(side) * base;
    } else if (ctx.state === "waiting") {
      out.hdY += 0.45 * Math.sin(ctx.ts * 0.17 + 1.3);
      out.twist += 0.1 * Math.sin(ctx.ts * 0.17 + 1.0);
    }
  },
};

