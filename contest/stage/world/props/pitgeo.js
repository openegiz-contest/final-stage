// The open pit as plain geometry, shared by the pit outside (pit.js) and the dispatch board's
// plan of it (props/board.js): the rim, the benches, the haul road with its switchbacks and where
// each haul truck is at time t. Metres, the hall's frame (y up, the glass faces -Z): the control
// room stands on a waste dump on the near rim, H0 above it, so the whole far wall is in view.
//
// Proportions from references 05, 07 and 10: 15 m benches, ~65° faces, 10-14 m catch berms,
// an overall wall slope of ~40°, a 32 m two-lane haul road at ~8% with hairpins on the far wall.
import { rng } from "../timeline.js";

const q = new URLSearchParams(typeof location !== "undefined" ? location.search : "");
const qv = (k, d) => (q.has(k) ? Number(q.get(k)) : d); // dev only: ?pith0=&pitnear=&pitra=&pitrb=

export const H0 = qv("pith0", 26);          // the hall's floor above the pit's rim
export const NEAR = qv("pitnear", 70);      // the near rim's distance in front of the glass
export const RA = qv("pitra", 600);        // rim semi-axes: across the view, and away from it
export const RB = qv("pitrb", 640);
export const C = { x: qv("pitx", -60), y: -H0, z: -(9.6 + NEAR + RB) };
export const N = 12, BH = 15, D = N * BH;   // benches, bench height, depth
export const FACE = 7;                      // a face's horizontal run (15 m at ~65°)
export const FAR = -Math.PI / 2;            // the far wall's angle (the hall is at +Z of the pit)

// berm widths, top bench first: catch berms 10-14 m, two wider working benches
const BERM = (() => {
  const r = rng(41), b = [];
  for (let k = 0; k < N; k++) b.push(10 + r() * 4 + (k === 4 || k === 8 ? 16 : 0));
  return b;
})();
/** Inset (m from the rim crest, measured inward) of bench k's crest; k = 0 is the rim. */
export const CREST = (() => {
  const c = [0];
  for (let k = 0; k < N; k++) c.push(c[k] + FACE + BERM[k]);
  return c;
})();
export const RUN = CREST[N] - BERM[N - 1] + 2; // from the rim crest to the floor's edge

/** Shape of the rim: an irregular superellipse. */
function rimK(th) {
  return 1 + 0.04 * Math.sin(3 * th + 0.7) + 0.025 * Math.sin(5 * th + 2.1) + 0.012 * Math.sin(11 * th + 0.3);
}
/** The rim's point at angle th: { x, z, r } (r = its distance from the centre). */
export function rim(th) {
  const k = rimK(th), c = Math.cos(th), s = Math.sin(th);
  const n = Math.pow(Math.pow(Math.abs(c), 2.4) + Math.pow(Math.abs(s), 2.4), 1 / 2.4);
  const x = (RA * k * c) / n, z = (RB * k * s) / n;
  return { x: C.x + x, z: C.z + z, r: Math.hypot(x, z) };
}
/** A point inset d metres from the rim along the radius at th (d < 0: the plain beyond). */
export function wallXZ(th, d) {
  const p = rim(th), f = Math.max(0, (p.r - d) / p.r);
  return { x: C.x + (p.x - C.x) * f, z: C.z + (p.z - C.z) * f };
}
/** The terrain's height (relative to the rim) at inset d, before the road: terraces. */
export function terraceY(d) {
  if (d <= 0) return 0;
  if (d >= RUN) return -D;
  let k = 0;
  while (k < N - 1 && d >= CREST[k + 1]) k++;
  const f = (d - CREST[k]) / FACE;
  if (f >= 1) return -(k + 1) * BH; // on the berm below the face
  const s = f * f * (3 - 2 * f) * 0.15 + f * 0.85; // a near-straight face, the crest a touch rounded
  return -(k + s) * BH;
}
/** The smooth wall (the overall slope) at inset d: where a road at height y sits. */
const baseInset = (y) => (-y / D) * RUN;

// ---- the haul road: from the shovel on the working bench, along its berm, four legs up the far
// wall with three hairpins, out over the rim and along the plain to the primary crusher
export const ROAD_HALF = 16;
export const WORK = 8; // the working bench: the berm below face 8 (the wide one), 45 m above the floor
export const WORK_D = CREST[WORK] + FACE + (CREST[WORK + 1] - CREST[WORK] - FACE) * 0.55; // its middle
const WORK_H = D - (WORK + 1) * BH;
const LEGS = [ // [angle off the far wall, height above the floor]
  [FAR + 0.08, WORK_H], [FAR + 0.4, WORK_H], [FAR + 0.95, 88], [FAR + 0.3, 130], [FAR + 0.9, 166], [FAR + 0.56, D],
];
export const ROAD = (() => {
  const pts = [];
  const push = (th, d, y) => {
    const p = wallXZ(th, d);
    pts.push({ x: p.x, z: p.z, y, th, d });
  };
  // along the working bench, from the shovel to the ramp's foot
  for (let i = 0; i <= 30; i++) {
    const u = i / 30, th = LEGS[0][0] + (LEGS[1][0] - LEGS[0][0]) * u;
    push(th, WORK_D, -D + WORK_H);
  }
  for (let l = 1; l < LEGS.length - 1; l++) {
    const [th0, h0] = LEGS[l], [th1, h1] = LEGS[l + 1];
    const n = 90;
    for (let i = 1; i <= n; i++) {
      const u = i / n, th = th0 + (th1 - th0) * u, y = -D + h0 + (h1 - h0) * u;
      push(th, baseInset(y) - 3, y);
    }
  }
  // over the rim and along the plain to the crusher
  const [thR] = LEGS.at(-1);
  for (let i = 1; i <= 40; i++) {
    const u = i / 40;
    push(thR - 0.42 * u, -6 - 70 * Math.sin((u * Math.PI) / 2), 0.4);
  }
  let s = 0;
  pts.forEach((p, i) => {
    if (i) s += Math.hypot(p.x - pts[i - 1].x, p.z - pts[i - 1].z, p.y - pts[i - 1].y);
    p.s = s;
  });
  return { pts, length: s };
})();

/** The road's centre at arc length s: { x, y, z, dx, dz } (dx, dz: the unit heading uphill). */
export function roadAt(s) {
  const P = ROAD.pts;
  s = Math.max(0, Math.min(ROAD.length, s));
  let lo = 0, hi = P.length - 1;
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1;
    if (P[m].s <= s) lo = m;
    else hi = m;
  }
  const a = P[lo], b = P[hi], u = (s - a.s) / Math.max(1e-6, b.s - a.s);
  const dx = b.x - a.x, dz = b.z - a.z, l = Math.hypot(dx, dz) || 1;
  return { x: a.x + dx * u, y: C.y + a.y + (b.y - a.y) * u, z: a.z + dz * u, dx: dx / l, dz: dz / l };
}

/** Distance from (x, z) to the road's centreline and the road's height there (relative to the rim). */
export function roadNear(x, z) {
  const P = ROAD.pts;
  let best = Infinity, by = 0;
  for (let i = 1; i < P.length; i++) {
    const a = P[i - 1], b = P[i];
    const ex = b.x - a.x, ez = b.z - a.z, l2 = ex * ex + ez * ez;
    let u = l2 ? ((x - a.x) * ex + (z - a.z) * ez) / l2 : 0;
    u = Math.max(0, Math.min(1, u));
    const px = a.x + ex * u - x, pz = a.z + ez * u - z, d2 = px * px + pz * pz;
    if (d2 < best) (best = d2), (by = a.y + (b.y - a.y) * u);
  }
  return { dist: Math.sqrt(best), y: by };
}

/** The floodlight masts: [angle, inset of the base, inset on the wall it lights, reach]. */
export const MASTS = [
  [FAR + 0.0, WORK_D + 2, CREST[5], 200],                // on the working bench by the shovel, lighting the faces above it
  [FAR + 0.62, CREST[4] + FACE + 14, CREST[2] + 4, 190], // on the upper working bench, among the hairpins
  [FAR - 0.38, CREST[8] + FACE + 14, CREST[5], 180],     // on the lower working bench, left
];

// ---- the fleet: haul trucks cycle loaded up the right lane, empty down the other
export const LANE = 7;
const UP = 3.4, DOWN = 6.5; // m/s: a loaded hauler on an 8% ramp, an empty one coming down
const LOAD = 150, DUMP = 60; // s at the shovel and at the crusher
const CYCLE = ROAD.length / UP + ROAD.length / DOWN + LOAD + DUMP;
/** Each truck's place in the cycle at t = 0 (s): two climbing loaded, one coming down, one at the shovel. */
export const FLEET = [
  { id: 1, at: LOAD + 0.30 * (ROAD.length / UP), seed: 4 },
  { id: 2, at: LOAD + 0.68 * (ROAD.length / UP), seed: 9 },
  { id: 3, at: LOAD + ROAD.length / UP + DUMP + 0.45 * (ROAD.length / DOWN), seed: 2 },
  { id: 4, at: LOAD + 0.06 * (ROAD.length / UP), seed: 6 },
  { id: 5, at: 40, seed: 3 }, // under the shovel
];
/** Where truck f is at t: { x, y, z, yaw, loaded, moving, s }. */
export function truckAt(f, t) {
  let c = (((f.at + t) % CYCLE) + CYCLE) % CYCLE;
  let s, loaded, moving = true, up = true;
  if (c < LOAD) (s = 0), (loaded = c > LOAD * 0.5), (moving = false);
  else if ((c -= LOAD) < ROAD.length / UP) (s = c * UP), (loaded = true);
  else if ((c -= ROAD.length / UP) < DUMP) (s = ROAD.length), (loaded = false), (moving = false);
  else (s = ROAD.length - (c - DUMP) * DOWN), (loaded = false), (up = false);
  const p = roadAt(s);
  // the right-hand lane in the direction of travel
  const hx = up ? p.dx : -p.dx, hz = up ? p.dz : -p.dz;
  const lane = moving ? LANE : 0;
  return { x: p.x - hz * lane, y: p.y, z: p.z + hx * lane, yaw: Math.atan2(hx, hz), loaded, moving, s };
}
