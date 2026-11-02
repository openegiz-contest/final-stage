// The Walk (GLOSSARY «Прогулка», spec §7.7, owner 2026-10-28): the Stage becomes playable. A Co-host
// drives the robot Host through the night control room from a third-person camera, over the same
// broadcast: the director's beats, the queue, the voices and the subtitles never wait for it.
//
//   P           the Walk on / off (?walk=1: on from the start). Off, the page is exactly as before; off
//               after a walk, the Host rolls back to its post by itself and the camera eases back to
//               the director.
//   W A S D     walk, relative to the camera (W away from it); the Host turns where it goes
//   mouse drag  turn the camera round the Host;  wheel: closer / further
//   click       on a Judge, a console, the dispatch wall, the ballot box or a tube: an "interact" event
//   E           the same for the target the Host stands at and faces
//   dbl-click   on the floor or an object: the Host goes there by itself, round what stands in the way
//               (any move key takes over again)
//   Space, ← →  stay the operator's (ui/operator.js): no jump, no arrows here
//
// Who holds the camera. Before the debate and in the holds the Walk does, except the director's own
// beats the page hands in (ctx.beats(): the check of the hashes, the run appearing on the wall). In the
// debate the director takes it over whenever a Judge speaks, decides, walks to the box, its token is
// revealed, or a card is up (the planner's segments, ctx.planner().trace; live also the queue's next
// beat, so the camera is the director's by the time the beat starts), and gives it back when that
// ends; the Host's own lines stay with the Walk. Every hand-over is an eased move (no cut). The Host
// never overlaps a Judge on its way to the box: from a few seconds before a Judge walks, its path (post
// to drop spot) is closed and the Host steps aside; while the director holds a close shot, the Host
// steps out of its line of sight.
//
// Everything runs on the show clock in fixed steps (STEP_S), so the same input gives the same picture,
// and a pause (Space) stops the Walk too. ?t= (stills, clips): ?walkdemo=1 drives a scripted walk.
//
// The interface (ui/walk-interact.js builds on it; keep it):
//   createWalk(ctx)       ctx: { scene, camera (the director camera, stage.camera), lens (THREE camera),
//                         renderer, robots, world (the stage), planner: () => planner | null,
//                         queue: () => director queue | null, beats: () => [{ from, to }], clock: { now },
//                         voice, canvas, virtual, q }
//   walk.enabled          boolean
//   walk.on(ev, fn)       "interact" -> { kind, id, point }; "toggle" -> { enabled }; returns off()
//   walk.focus(object3d, { seconds })   frame a target gently, then hand the camera back (a promise);
//                         an Object3D without meshes is framed as a point
//   walk.busy(bool)       true while an interaction plays: no new interact events
//   walk.stage            the world (world/stage.js: scene, robots, desks, ballot)
//   walk.share()          the Walk's share of the picture on screen, 0 (the director's) .. 1
//   walk.frame(t)         before every frame (ui/program.js), before stage.renderAt(t)
// Targets: object.userData.walkTarget = { kind: "judge" | "console" | "wall" | "urn", id } (world/stage.js,
// world/ballot.js); id: the Judge's roster name for judge and console, "wall", "urn".
import * as THREE from "three";
import { DESKS, BALLOT, HOST_POST, GLASS_R, SIDE_X, BACK_Z, CEILING, dropSpot } from "/world/layout.js";
import { JUDGE_IDS } from "/robots/roster.js";
import { BOARD_W } from "/world/props/board.js";

export const WALK = {
  speed: 1.25, // m/s
  accel: 2.4, decel: 3.4, // m/s²
  turn: 3.4, // rad/s at most
  stepLen: 0.62, // m per step of the walk cycle (robots/rig.js stepPose)
  radius: 0.33, // the Host's footprint (its arms at rest: 0.3)
  judgeR: { "opus-5.5": 0.41, "gpt-6.1-sol": 0.37, "sonnet-5.5": 0.3, "gpt-6-astra": 0.37, "fable-5.1": 0.33 },
  corridor: 0.1, // m kept clear around a walking Judge's path, past both bodies
  aheadS: 3.0, // s before a Judge walks its path is closed
  push: 1.1, // m/s the Host steps aside at
  reach: 1.35, // m: E finds a target this close
  faceCone: 1.1, // rad: and this far off the Host's heading
};
export const CAM = {
  fov: 48, pivotY: 1.3, shoulder: 0.42, dist: 3.1, distMin: 1.5, distMax: 7, pitch: 0.2, pitchMin: -0.12, pitchMax: 0.85,
  follow: 0.14, look: 0.09, // s: the camera's lag behind the Host, behind the mouse
  autoFollow: 1.0, // rad/s: moving forward, the camera swings behind the Host (the mouse idle)
  exposure: 2.7, // the room at night from the Host's height (world/camera.js EXPOSURE.wide 2.3, host 3.8)
  toDirector: 0.9, toWalk: 1.3, // s: the hand-overs
  holdAfter: 0.5, // s the director keeps the camera after its beat
  mergeGap: 2.6, // s: two director beats closer than this keep it in between
};
const STEP_S = 1 / 120;
// the planner's segments (ui/planner.js add({ tag })) that take the camera: a Judge speaks, decides,
// walks, drops, is revealed; the tubes, the cards. Not the Host's own lines: the Walk is the Host (and the
// director's Host shot frames its post, empty while the Host walks)
const DIRECTOR_TAGS = /^(say|decide|walk|slot|card|tube|reason|abstain|cards|tally|wave)\b/;
const DIRECTOR_METHODS = new Set(["say", "voteCast", "voteReveal", "envelope", "lastWord", "verdict", "podium", "final"]);
const SIGHT = { maxLen: 4.5, r: 0.5 }; // a director's shot closer than maxLen m: the Host keeps r m off its line of sight
const HOME = { x: HOST_POST.pos.x, z: HOST_POST.pos.z, yaw: HOST_POST.yaw };

const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const ease = (u) => (u <= 0 ? 0 : u >= 1 ? 1 : u * u * (3 - 2 * u));
const damp = (tau, h) => 1 - Math.exp(-h / tau);

// ---- the floor plan ------------------------------------------------------------------------------
// A 10 cm grid over the room: what stands on the floor (every mesh of the scene between ankle and head
// height, by its bounding box; not the robots, not what is rebuilt per round) and the room's own walls
// (the D: the glass arc with its sill, the side walls, the back wall), then each free cell's distance
// to the nearest blocked one. The Host's clearance anywhere is that distance, bilinear, so it slides
// along a desk instead of catching on cell corners.
const GRID = { x0: -10, z0: -10, cell: 0.1, nx: 200, nz: 190 };
const GLASS_IN = GLASS_R - 0.4; // the sill's ledge reaches 0.36 m in from the glass

export function inRoom(x, z, m = 0) {
  if (Math.abs(x) > SIDE_X - 0.1 - m || z > BACK_Z - m) return false;
  return z >= 0 || x * x + z * z <= (GLASS_IN - m) ** 2;
}

function edt1d(f, n, d, v, zz) {
  let k = 0;
  v[0] = 0;
  zz[0] = -Infinity;
  zz[1] = Infinity;
  for (let q = 1; q < n; q++) {
    let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= zz[k]) {
      k--;
      s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q;
    zz[k] = s;
    zz[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (zz[k + 1] < q) k++;
    d[q] = (q - v[k]) ** 2 + f[v[k]];
  }
}

export function buildFloorPlan(scene, { skip = () => false } = {}) {
  const { x0, z0, cell, nx, nz } = GRID;
  const blocked = new Uint8Array(nx * nz);
  const cx = (i) => x0 + (i + 0.5) * cell, cz = (j) => z0 + (j + 0.5) * cell;
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) if (!inRoom(cx(i), cz(j))) blocked[j * nx + i] = 1;
  scene.updateMatrixWorld(true);
  const corners = Array.from({ length: 8 }, () => V());
  const footprints = [];
  scene.traverse((o) => {
    if (!o.isMesh || o.isInstancedMesh || !o.geometry) return;
    for (let p = o; p; p = p.parent) if (!p.visible || skip(p) || p.userData?.walkDynamic) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    if (mats.every((m) => !m || (m.transparent && m.depthWrite === false))) return; // glass, beams, glows
    if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
    const b = o.geometry.boundingBox;
    if (!b || b.isEmpty()) return;
    let k = 0, y0 = Infinity, y1 = -Infinity;
    for (const x of [b.min.x, b.max.x]) for (const y of [b.min.y, b.max.y]) for (const z of [b.min.z, b.max.z]) {
      const c = corners[k++].set(x, y, z).applyMatrix4(o.matrixWorld);
      y0 = Math.min(y0, c.y);
      y1 = Math.max(y1, c.y);
    }
    if (y0 > 1.5 || y1 < 0.08) return; // above the head or flat on the floor
    const hull = convexHull(corners.map((c) => [c.x, c.z]));
    const area = Math.abs(hull.reduce((a, p, i) => { const q = hull[(i + 1) % hull.length]; return a + p[0] * q[1] - q[0] * p[1]; }, 0)) / 2;
    if (area > 6) return; // the floor, the glass arc's sill (the D covers those)
    footprints.push(hull);
    let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
    for (const [x, z] of hull) (a0 = Math.min(a0, x)), (a1 = Math.max(a1, x)), (b0 = Math.min(b0, z)), (b1 = Math.max(b1, z));
    const i0 = Math.max(0, Math.floor((a0 - x0) / cell)), i1 = Math.min(nx - 1, Math.ceil((a1 - x0) / cell));
    const j0 = Math.max(0, Math.floor((b0 - z0) / cell)), j1 = Math.min(nz - 1, Math.ceil((b1 - z0) / cell));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) if (inHull(hull, cx(i), cz(j))) blocked[j * nx + i] = 1;
  });
  // the distance transform (squared, in cells), then metres to the blocked cell's edge
  const BIG = 1e9, f = new Float64Array(Math.max(nx, nz)), d = new Float64Array(Math.max(nx, nz));
  const v = new Int32Array(Math.max(nx, nz)), zz = new Float64Array(Math.max(nx, nz) + 1);
  const sq = new Float64Array(nx * nz);
  for (let k = 0; k < nx * nz; k++) sq[k] = blocked[k] ? 0 : BIG;
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < nz; j++) f[j] = sq[j * nx + i];
    edt1d(f, nz, d, v, zz);
    for (let j = 0; j < nz; j++) sq[j * nx + i] = d[j];
  }
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) f[i] = sq[j * nx + i];
    edt1d(f, nx, d, v, zz);
    for (let i = 0; i < nx; i++) sq[j * nx + i] = d[i];
  }
  const dist = new Float32Array(nx * nz);
  for (let k = 0; k < nx * nz; k++) dist[k] = blocked[k] ? -cell / 2 : Math.sqrt(sq[k]) * cell - cell / 2;
  /** Metres from (x, z) to the nearest thing that stands (negative inside one). */
  const clearance = (x, z) => {
    const fx = (x - x0) / cell - 0.5, fz = (z - z0) / cell - 0.5;
    const i = Math.floor(fx), j = Math.floor(fz);
    if (i < 0 || j < 0 || i >= nx - 1 || j >= nz - 1) return -1;
    const u = fx - i, w = fz - j, k = j * nx + i;
    return (dist[k] * (1 - u) + dist[k + 1] * u) * (1 - w) + (dist[k + nx] * (1 - u) + dist[k + nx + 1] * u) * w;
  };
  return { ...GRID, blocked, dist, clearance, footprints, cellOf: (x, z) => [Math.floor((x - x0) / cell), Math.floor((z - z0) / cell)], centre: (i, j) => [cx(i), cz(j)] };
}

function convexHull(pts) {
  const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], hi = [];
  for (const q of p) {
    while (lo.length >= 2 && cross(lo.at(-2), lo.at(-1), q) <= 1e-12) lo.pop();
    lo.push(q);
  }
  for (const q of p.reverse()) {
    while (hi.length >= 2 && cross(hi.at(-2), hi.at(-1), q) <= 1e-12) hi.pop();
    hi.push(q);
  }
  return lo.slice(0, -1).concat(hi.slice(0, -1));
}
function inHull(h, x, z) {
  if (h.length < 3) return false;
  for (let i = 0; i < h.length; i++) {
    const a = h[i], b = h[(i + 1) % h.length];
    if ((b[0] - a[0]) * (z - a[1]) - (b[1] - a[1]) * (x - a[0]) < -1e-9) return false;
  }
  return true;
}

// segment distance (x, z) to [a, b] in the plane
function segDist(x, z, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az, L = dx * dx + dz * dz;
  const u = L > 0 ? clamp(((x - ax) * dx + (z - az) * dz) / L, 0, 1) : 0;
  return Math.hypot(x - (ax + u * dx), z - (az + u * dz));
}

// ---- the path: A* on the floor plan, then pulled straight where the Host fits ----------------------
function findPath(plan, ok, from, to) {
  const { nx, nz } = plan;
  const [si, sj] = plan.cellOf(from.x, from.z), [gi, gj] = plan.cellOf(to.x, to.z);
  const N = nx * nz, g = new Float32Array(N).fill(Infinity), came = new Int32Array(N).fill(-1), closed = new Uint8Array(N);
  const heap = []; // [f, k]
  const push = (f, k) => {
    heap.push([f, k]);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heap[p][0] <= heap[i][0]) break;
      [heap[p], heap[i]] = [heap[i], heap[p]];
      i = p;
    }
  };
  const pop = () => {
    const top = heap[0], last = heap.pop();
    if (heap.length) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
        if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i], heap[m]];
        i = m;
      }
    }
    return top;
  };
  const hx = (i, j) => {
    const dx = Math.abs(i - gi), dz = Math.abs(j - gj);
    return Math.max(dx, dz) + 0.4142 * Math.min(dx, dz);
  };
  const s = sj * nx + si, goal = gj * nx + gi;
  g[s] = 0;
  push(hx(si, sj), s);
  let found = false;
  for (let it = 0; heap.length && it < 200000; it++) {
    const [, k] = pop();
    if (closed[k]) continue;
    closed[k] = 1;
    if (k === goal) {
      found = true;
      break;
    }
    const i = k % nx, j = (k - i) / nx;
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      if (!di && !dj) continue;
      const ii = i + di, jj = j + dj;
      if (ii < 0 || jj < 0 || ii >= nx || jj >= nz) continue;
      const kk = jj * nx + ii;
      if (closed[kk] || !ok(ii, jj)) continue;
      if (di && dj && (!ok(i + di, j) || !ok(i, j + dj))) continue; // no corner cutting
      const ng = g[k] + (di && dj ? 1.4142 : 1);
      if (ng < g[kk]) {
        g[kk] = ng;
        came[kk] = k;
        push(ng + hx(ii, jj), kk);
      }
    }
  }
  if (!found) return null;
  const cells = [];
  for (let k = goal; k !== -1; k = came[k]) cells.push(k);
  cells.reverse();
  return cells.map((k) => {
    const i = k % nx, j = (k - i) / nx;
    const [x, z] = plan.centre(i, j);
    return { x, z };
  });
}

// ---- the Walk ------------------------------------------------------------------------------------

export function createWalk(ctx) {
  const { scene, robots, world } = ctx;
  const dirCam = ctx.camera; // the director camera (world/camera.js): its update() is wrapped below
  const lens = ctx.lens ?? world?.lens; // the THREE camera
  const canvas = ctx.canvas ?? ctx.renderer?.domElement;
  const now = ctx.clock?.now ?? ctx.clock ?? (() => performance.now() / 1000);
  const q = ctx.q ?? new URLSearchParams(location.search);
  const virtual = !!ctx.virtual;
  const host = robots.host;
  const warn = (m) => console.warn(`[walk] ${m}`);

  const robotRoots = new Set(Object.values(robots).map((r) => r.object3d));
  let plan = null; // the floor plan, built the first time the Walk goes on (a page that never walks pays nothing)
  const ballot = world?.ballot ?? null;

  // ---- what stands in the way right now: the Judges, the tubes, the paths of the Judges who walk
  const judgeRadius = (id) => WALK.judgeR[id] ?? 0.36;
  const paths = Object.fromEntries(JUDGE_IDS.map((id) => [id, { a: DESKS[id].post, b: dropSpot(id) }]));
  const dyn = { judges: [], corridors: [], urns: [], sight: null };
  function updateObstacles(t) {
    dyn.judges = JUDGE_IDS.map((id) => {
      const p = robots[id].object3d.position;
      return { id, x: p.x, z: p.z, r: judgeRadius(id) };
    });
    // a Judge that walks now or within aheadS: its whole path is closed (it has priority)
    dyn.corridors = [];
    for (const id of JUDGE_IDS) {
      const r = robots[id];
      let on = false;
      for (const dt of [0, 1, 2, WALK.aheadS]) if (r.phaseAt?.(t + dt)) on = true;
      if (!on) continue;
      const { a, b } = paths[id];
      dyn.corridors.push({ id, ax: a.x, az: a.z, bx: b.x, bz: b.z, r: judgeRadius(id) + WALK.corridor });
    }
    // the director's close shot: the Host steps out of its line of sight (soft: never into a hard obstacle)
    dyn.sight = null;
    const l = S.enabled && S.owner === "director" ? dirCam.lens : null;
    if (l?.pos && l.target && l.pos.distanceTo(l.target) < SIGHT.maxLen) dyn.sight = { ax: l.pos.x, az: l.pos.z, bx: l.target.x, bz: l.target.z, r: SIGHT.r };
    dyn.urns = [];
    if (ballot?.anchors?.teams) for (const team of ballot.anchors.teams()) {
      const u = ballot.anchors.urn(team);
      if (u) dyn.urns.push({ x: u.x, z: u.z, hw: 0.26, hd: 0.18 });
    }
  }
  /** The Host's clearance at (x, z): metres from its centre to the nearest obstacle (static or not). */
  function clearance(x, z, { corridors = true } = {}) {
    let c = plan.clearance(x, z);
    for (const j of dyn.judges) c = Math.min(c, Math.hypot(x - j.x, z - j.z) - j.r);
    if (corridors) for (const k of dyn.corridors) c = Math.min(c, segDist(x, z, k.ax, k.az, k.bx, k.bz) - k.r);
    for (const u of dyn.urns) {
      const dx = Math.max(Math.abs(x - u.x) - u.hw, 0), dz = Math.max(Math.abs(z - u.z) - u.hd, 0);
      c = Math.min(c, Math.hypot(dx, dz) - (dx === 0 && dz === 0 ? 0.05 : 0));
    }
    return c;
  }
  const g2 = { x: 0, z: 0 };
  function gradient(x, z, opts) {
    const e = 0.03;
    g2.x = clearance(x + e, z, opts) - clearance(x - e, z, opts);
    g2.z = clearance(x, z + e, opts) - clearance(x, z - e, opts);
    const n = Math.hypot(g2.x, g2.z) || 1;
    g2.x /= n;
    g2.z /= n;
    return g2;
  }

  // ---- the state, advanced in fixed steps on the show clock
  const S = {
    enabled: false, homing: false, // homing: the Walk is off, the Host rolls back to its post
    x: HOME.x, z: HOME.z, vx: 0, vz: 0, yaw: HOME.yaw, phi: 0, speed: 0, lean: 0,
    auto: null, // { path: [{x,z}], i, faceYaw, stuck, goal }
    cam: { yaw: HOME.yaw, pitch: CAM.pitch, dist: CAM.dist, yawGoal: HOME.yaw, pitchGoal: CAM.pitch, distGoal: CAM.dist, distEff: CAM.dist, pivot: V(HOME.x, CAM.pivotY, HOME.z), pos: V(), target: V(), fov: CAM.fov },
    focus: null, // { pos, target, fov, from, hold, to, u, resolve }
    owner: "director", // who holds the camera: "walk" | "director"
    hand: { from: null, at: -Infinity, dur: 1 }, // the hand-over in progress (u = (t - at) / dur)
    homeSince: 0, homeRetry: 0,
    lastInput: -Infinity, lastMouse: -Infinity,
  };
  let simT = null, prev = null, cur = null; // interpolation between the last two steps
  let busy = false, broken = false, installed = false;
  const listeners = { interact: new Set(), toggle: new Set() };
  const emit = (ev, data) => {
    for (const fn of listeners[ev] ?? []) {
      try {
        fn(data);
      } catch (e) {
        warn(`${ev} listener: ${e?.message ?? e}`);
      }
    }
  };

  // ---- input
  const keys = new Set();
  const input = { dyaw: 0, dpitch: 0, zoom: 0 }; // accumulated between steps
  const demo = virtual || q.get("walkdemo") ? demoScript(q.get("walkdemo")) : null;

  // ---- the director's beats: when the camera is the director's
  // the planner's director segments, sorted by start (the trace only grows); the long ones apart
  const idx = { planner: null, n: 0, spans: [], long: [] };
  function plannerSpans(t, out) {
    const planner = ctx.planner?.();
    if (!planner?.trace) return;
    if (planner !== idx.planner) Object.assign(idx, { planner, n: 0, spans: [], long: [] });
    const tr = planner.trace;
    for (; idx.n < tr.length; idx.n++) {
      const s = tr[idx.n];
      if (!DIRECTOR_TAGS.test(s.tag ?? "")) continue;
      const sp = { from: s.from, to: s.to, tag: s.tag };
      if (sp.to - sp.from > 60) idx.long.push(sp);
      else {
        let i = idx.spans.length;
        while (i > 0 && idx.spans[i - 1].from > sp.from) i--;
        idx.spans.splice(i, 0, sp);
      }
    }
    for (const sp of idx.long) if (sp.to > t - 5 && sp.from < t + 10) out.push(sp);
    // the last span starting before t + 10, back to the ones that started 60 s before t - 5
    let lo = 0, hi = idx.spans.length - 1, k = -1;
    while (lo <= hi) {
      const m = (lo + hi) >> 1;
      if (idx.spans[m].from < t + 10) (k = m), (lo = m + 1);
      else hi = m - 1;
    }
    for (let i = k; i >= 0 && idx.spans[i].from > t - 70; i--) if (idx.spans[i].to > t - 5) out.push(idx.spans[i]);
  }
  function directorSpans(t) {
    const out = [];
    for (const b of ctx.beats?.() ?? []) if (b.to > t - 5 && b.from < t + 10) out.push(b);
    plannerSpans(t, out);
    // live: the queue's next beat, once it is known, so the camera is the director's when it starts
    const qd = ctx.queue?.();
    if (qd && !virtual) {
      const head = qd.pending?.[0];
      if (head && head.beat?.calls?.some((c) => DIRECTOR_METHODS.has(c.method))) {
        const at = Math.max(qd.current?.end ?? -Infinity, qd.lastEnd ?? -Infinity, head.availableAt ?? -Infinity);
        if (Number.isFinite(at)) out.push({ from: at, to: at + 1, tag: "next" });
      }
      const c = qd.current;
      if (c?.beat?.calls?.some((x) => DIRECTOR_METHODS.has(x.method))) out.push({ from: c.start, to: c.end, tag: "current" });
    }
    return out;
  }
  function directorWants(t) {
    for (const s of directorSpans(t)) if (t >= s.from - CAM.toDirector && t < s.to + CAM.holdAfter) return true;
    return false;
  }
  // once the director holds it: keep it while its next beat is near (no ping-pong)
  function directorKeeps(t) {
    for (const s of directorSpans(t)) if (t >= s.from - CAM.toDirector - CAM.mergeGap && t < s.to + CAM.holdAfter) return true;
    return false;
  }

  // ---- steps
  function step(t, h) {
    updateObstacles(t);
    if (demo) demo.drive(t, api);
    const active = S.enabled || S.homing;
    // the wanted velocity: the keys (relative to the camera), the autopilot, or nothing
    let wx = 0, wz = 0, faceTo = null;
    const kx = (keys.has("d") ? 1 : 0) - (keys.has("a") ? 1 : 0), kz = (keys.has("w") ? 1 : 0) - (keys.has("s") ? 1 : 0);
    if (S.enabled && (kx || kz)) {
      S.auto = null;
      S.lastInput = t;
      const cy = S.cam.yaw, fx = Math.sin(cy), fz = Math.cos(cy), rx = -Math.cos(cy), rz = Math.sin(cy);
      wx = fx * kz + rx * kx;
      wz = fz * kz + rz * kx;
      const n = Math.hypot(wx, wz);
      wx = (wx / n) * WALK.speed;
      wz = (wz / n) * WALK.speed;
    } else if (active && S.auto) {
      const a = autopilot(t);
      wx = a.vx;
      wz = a.vz;
      faceTo = a.faceYaw;
    }
    // turn toward where it goes; slow down while the heading is far off (it turns, then goes)
    const wsp = Math.hypot(wx, wz);
    if (wsp > 0.05) {
      const err = wrap(Math.atan2(wx, wz) - S.yaw);
      S.yaw = wrap(S.yaw + clamp(err * 7 * h, -WALK.turn * h, WALK.turn * h));
      const k = clamp((Math.cos(err) + 0.35) / 1.35, 0.25, 1);
      wx *= k;
      wz *= k;
    } else if (faceTo !== null) {
      const err = wrap(faceTo - S.yaw);
      S.yaw = wrap(S.yaw + clamp(err * 6 * h, -WALK.turn * 0.7 * h, WALK.turn * 0.7 * h));
    }
    // accelerate toward it
    const dvx = wx - S.vx, dvz = wz - S.vz, dv = Math.hypot(dvx, dvz);
    const lim = (wx * S.vx + wz * S.vz > 0 && Math.hypot(wx, wz) >= Math.hypot(S.vx, S.vz) ? WALK.accel : WALK.decel) * h;
    if (dv > lim) (S.vx += (dvx / dv) * lim), (S.vz += (dvz / dv) * lim);
    else (S.vx = wx), (S.vz = wz);
    // move, sliding along what it meets; pushed out of a path a Judge is about to walk
    const R = WALK.radius, x0 = S.x, z0 = S.z;
    let nx = S.x + S.vx * h, nz = S.z + S.vz * h;
    if (clearance(nx, nz) < R) {
      const n = gradient(nx, nz);
      const vn = S.vx * n.x + S.vz * n.z;
      if (vn < 0) (S.vx -= vn * n.x), (S.vz -= vn * n.z);
      nx = S.x + S.vx * h;
      nz = S.z + S.vz * h;
      if (clearance(nx, nz) < R && clearance(nx, nz) < clearance(S.x, S.z)) {
        S.vx = S.vz = 0;
        nx = S.x;
        nz = S.z;
      }
    }
    const c0 = clearance(nx, nz);
    if (c0 < R) {
      // something came to where it stands (a Judge's path opened): step aside, away from all of it
      const n = gradient(nx, nz);
      const d = Math.min(WALK.push * h, R - c0 + 0.002);
      nx += n.x * d;
      nz += n.z * d;
    }
    // out of the director's close shot: away from its line of sight, where the way is free
    const k = dyn.sight;
    if (k) {
      const d = segDist(nx, nz, k.ax, k.az, k.bx, k.bz) - k.r - R;
      if (d < 0) {
        const e = 0.03, gx = segDist(nx + e, nz, k.ax, k.az, k.bx, k.bz) - segDist(nx - e, nz, k.ax, k.az, k.bx, k.bz), gz = segDist(nx, nz + e, k.ax, k.az, k.bx, k.bz) - segDist(nx, nz - e, k.ax, k.az, k.bx, k.bz);
        const gn = Math.hypot(gx, gz) || 1, step = Math.min(WALK.push * h, -d + 0.002);
        const px = nx + (gx / gn) * step, pz = nz + (gz / gn) * step;
        if (clearance(px, pz) >= Math.min(R, clearance(nx, nz))) (nx = px), (nz = pz);
      }
    }
    if (inRoom(nx, nz, R * 0.5)) (S.x = nx), (S.z = nz);
    const moved = Math.hypot(S.x - x0, S.z - z0) / h;
    const fwdAcc = ((moved - S.speed) / h) * (S.vx * Math.sin(S.yaw) + S.vz * Math.cos(S.yaw) >= 0 ? 1 : -1);
    S.speed = moved;
    S.phi += (moved * h / WALK.stepLen) * Math.PI;
    S.lean += (clamp(fwdAcc * 0.012, -0.05, 0.05) - S.lean) * damp(0.25, h);
    if (S.homing) {
      // back to the post: a path when there is one (a Judge's path may close the way for a while), the
      // post's heading, then the show has the Host again; after 20 s it is put there
      const off = Math.hypot(S.x - HOME.x, S.z - HOME.z);
      if (!S.auto && off > 0.05 && t >= S.homeRetry && !goTo(HOME.x, HOME.z, { faceYaw: HOME.yaw, why: "home" })) S.homeRetry = t + 0.5;
      if (!S.auto && off <= 0.05 && Math.abs(wrap(S.yaw - HOME.yaw)) > 0.01) S.auto = { path: [{ x: S.x, z: S.z }, { x: HOME.x, z: HOME.z }], i: 1, faceYaw: HOME.yaw, goal: { x: HOME.x, z: HOME.z }, why: "home", stuck: 0, replans: 0 };
      if ((!S.auto && off < 0.05 && Math.abs(wrap(S.yaw - HOME.yaw)) <= 0.01 && S.speed < 0.02) || t - S.homeSince > 20) finishHome();
    }
    stepCamera(t, h);
    stepOwner(t);
  }

  // ---- the autopilot: a path to a point, then a heading
  function goTo(x, z, { faceYaw = null, faceAt = null, why = "click" } = {}) {
    updateObstacles(simT ?? now());
    const R = WALK.radius + 0.04;
    const sx = S.x, sz = S.z;
    const ok = (i, j) => {
      const [x2, z2] = plan.centre(i, j);
      // tight beside where it stands (it may stand close to a desk): the cells it can roll out over
      const near = Math.hypot(x2 - sx, z2 - sz) < 0.45;
      if (plan.dist[j * plan.nx + i] < (near ? WALK.radius - 0.08 : R)) return false;
      return clearance(x2, z2) >= (near ? WALK.radius - 0.08 : R - 0.02);
    };
    // the goal: the free cell nearest to the point (a click on a desk: in front of it)
    let [gi, gj] = plan.cellOf(x, z);
    const free = gi >= 0 && gj >= 0 && gi < plan.nx && gj < plan.nz && ok(gi, gj);
    if (!free) {
      let best = null;
      for (let r = 1; r < 40 && !best; r++) {
        for (let dj = -r; dj <= r; dj++) for (let di = -r; di <= r; di++) {
          if (Math.max(Math.abs(di), Math.abs(dj)) !== r) continue;
          const ii = gi + di, jj = gj + dj;
          if (ii < 0 || jj < 0 || ii >= plan.nx || jj >= plan.nz || !ok(ii, jj)) continue;
          const [cx, cz] = plan.centre(ii, jj);
          // nearest to the point, then nearest to the Host (its side of the object)
          const score = Math.hypot(cx - x, cz - z) + 0.15 * Math.hypot(cx - S.x, cz - S.z);
          if (!best || score < best.score) best = { ii, jj, score };
        }
      }
      if (!best) return false;
      gi = best.ii;
      gj = best.jj;
    }
    const [tx, tz] = plan.centre(gi, gj);
    const goal = free ? { x, z } : { x: tx, z: tz }; // the point itself where the Host fits, else the free spot
    const cells = findPath(plan, ok, { x: S.x, z: S.z }, goal);
    if (!cells) return false;
    const path = pull([{ x: S.x, z: S.z }, ...cells.slice(1, -1), goal], R - 0.02);
    if (faceAt) faceYaw = Math.atan2(faceAt.x - goal.x, faceAt.z - goal.z);
    S.auto = { path, i: 1, faceYaw, goal, why, stuck: 0, replans: 0, faceAt };
    return true;
  }
  // straight lines where the Host fits along them
  function pull(pts, R) {
    const fits = (a, b) => {
      const L = Math.hypot(b.x - a.x, b.z - a.z), n = Math.ceil(L / 0.05);
      for (let k = 1; k <= n; k++) {
        const u = k / n;
        if (clearance(a.x + (b.x - a.x) * u, a.z + (b.z - a.z) * u) < R) return false;
      }
      return true;
    };
    const out = [pts[0]];
    let i = 0;
    while (i < pts.length - 1) {
      let j = pts.length - 1;
      while (j > i + 1 && !fits(pts[i], pts[j])) j--;
      out.push(pts[j]);
      i = j;
    }
    return out;
  }
  function autopilot(t) {
    const a = S.auto;
    // the point 0.5 m ahead on the path (pure pursuit), slowing to a stop at its end
    while (a.i < a.path.length - 1 && Math.hypot(a.path[a.i].x - S.x, a.path[a.i].z - S.z) < 0.35) a.i++;
    const p = a.path[a.i];
    const end = a.path.at(-1);
    let rest = Math.hypot(p.x - S.x, p.z - S.z);
    for (let k = a.i; k < a.path.length - 1; k++) rest += Math.hypot(a.path[k + 1].x - a.path[k].x, a.path[k + 1].z - a.path[k].z);
    const dx = p.x - S.x, dz = p.z - S.z, d = Math.hypot(dx, dz);
    if (a.i === a.path.length - 1 && Math.hypot(end.x - S.x, end.z - S.z) < 0.04) {
      // there: face what it came for, then let go
      const fy = a.faceYaw;
      if (fy === null || Math.abs(wrap(fy - S.yaw)) < 0.012) S.auto = null;
      return { vx: 0, vz: 0, faceYaw: fy };
    }
    const v = Math.min(WALK.speed, Math.sqrt(2 * 1.5 * Math.max(0, rest - 0.02)) + 0.05);
    // no progress for a while (a Judge's path closed across it): a new path, twice, then stop
    if (S.speed < 0.05 && v > 0.2) {
      a.stuck += STEP_S;
      if (a.stuck > 0.8) {
        a.stuck = 0;
        if (a.replans++ < 2) {
          const why = a.why, faceYaw = a.faceYaw, goal = a.goal;
          if (!goTo(goal.x, goal.z, { faceYaw, why })) S.auto = null;
          else S.auto.replans = a.replans;
        } else S.auto = null;
        return { vx: 0, vz: 0, faceYaw: null };
      }
    } else a.stuck = 0;
    return { vx: (dx / (d || 1)) * v, vz: (dz / (d || 1)) * v, faceYaw: null };
  }
  function finishHome() {
    S.homing = false;
    S.x = HOME.x;
    S.z = HOME.z;
    S.yaw = HOME.yaw;
    S.vx = S.vz = S.speed = 0;
    host.steer(null); // the Host is the show's again: at its post, as if it never left
  }

  // ---- the camera
  const tmp = V(), tmp2 = V();
  function followPose(out) {
    const c = S.cam;
    const f = tmp.set(Math.sin(c.yaw) * Math.cos(c.pitch), -Math.sin(c.pitch), Math.cos(c.yaw) * Math.cos(c.pitch));
    const right = tmp2.set(-Math.cos(c.yaw), 0, Math.sin(c.yaw));
    const base = out.base.copy(c.pivot).addScaledVector(right, CAM.shoulder);
    out.pos.copy(base).addScaledVector(f, -c.distEff);
    out.target.copy(base).addScaledVector(f, 4);
    out.fov = CAM.fov;
    return out;
  }
  // the furthest the camera can be behind the pivot: inside the room, under the ceiling, not in a cabinet
  function maxDist(c, want) {
    const fx = Math.sin(c.yaw) * Math.cos(c.pitch), fy = -Math.sin(c.pitch), fz = Math.cos(c.yaw) * Math.cos(c.pitch);
    const bx = c.pivot.x - Math.cos(c.yaw) * CAM.shoulder, by = c.pivot.y, bz = c.pivot.z + Math.sin(c.yaw) * CAM.shoulder;
    let ok = 0.6;
    for (let d = 0.6; d <= want + 1e-6; d += 0.1) {
      const x = bx - fx * d, y = by - fy * d, z = bz - fz * d;
      if (!inRoom(x, z, 0.25) || y > CEILING - 0.35 || y < 0.3 || (y < 2.25 && plan.clearance(x, z) < 0.12)) break;
      ok = d;
    }
    return Math.min(want, ok);
  }
  const fp = { base: V(), pos: V(), target: V(), fov: CAM.fov };
  function stepCamera(t, h) {
    const c = S.cam;
    c.yawGoal = wrap(c.yawGoal + input.dyaw);
    c.pitchGoal = clamp(c.pitchGoal + input.dpitch, CAM.pitchMin, CAM.pitchMax);
    c.distGoal = clamp(c.distGoal * Math.exp(input.zoom), CAM.distMin, CAM.distMax);
    input.dyaw = input.dpitch = input.zoom = 0;
    // walking forward with the mouse idle, the camera swings in behind the Host
    const fwd = S.speed > 0.1 ? (S.vx * Math.sin(S.yaw) + S.vz * Math.cos(S.yaw)) / Math.max(S.speed, 1e-6) : 0;
    const kz = keys.has("w") && !keys.has("s");
    if (t - S.lastMouse > 1.0 && (kz || S.auto) && fwd > 0.3) {
      const e = wrap(S.yaw - c.yawGoal);
      c.yawGoal = wrap(c.yawGoal + clamp(e, -1, 1) * CAM.autoFollow * (S.speed / WALK.speed) * fwd * h);
    }
    c.yaw = wrap(c.yaw + wrap(c.yawGoal - c.yaw) * damp(CAM.look, h));
    c.pitch += (c.pitchGoal - c.pitch) * damp(CAM.look, h);
    c.dist += (c.distGoal - c.dist) * damp(0.16, h);
    tmp.set(S.x, CAM.pivotY, S.z);
    c.pivot.lerp(tmp, damp(CAM.follow, h));
    const md = maxDist(c, c.dist);
    c.distEff += (md - c.distEff) * damp(md < c.distEff ? 0.05 : 0.35, h);
    followPose(fp);
    c.pos.copy(fp.pos);
    c.target.copy(fp.target);
    c.fov = fp.fov;
    // a focus (walk.focus): eased in, held, eased out
    const F = S.focus;
    if (F) {
      F.u += h;
      const k = F.u < F.inS ? ease(F.u / F.inS) : F.u < F.inS + F.hold ? 1 : ease(1 - (F.u - F.inS - F.hold) / F.outS);
      c.pos.lerp(F.pos, k);
      c.target.lerp(F.target, k);
      c.fov += (F.fov - c.fov) * k;
      if (F.u >= F.inS + F.hold + F.outS) {
        S.focus = null;
        F.resolve();
      }
    }
  }

  // ---- who holds the camera
  function stepOwner(t) {
    let want = "director";
    if (S.enabled) want = S.owner === "director" && directorKeeps(t) ? "director" : directorWants(t) ? "director" : "walk";
    if (want !== S.owner) {
      S.owner = want;
      S.hand = { from: null, at: t, dur: want === "director" ? CAM.toDirector : CAM.toWalk }; // from: the picture of the next frame
    }
  }
  const handU = (t) => (S.hand.at === -Infinity ? 1 : clamp((t - S.hand.at) / S.hand.dur, 0, 1));

  // ---- the frame: interpolated between the last two steps
  function snap() {
    return { x: S.x, z: S.z, yaw: S.yaw, phi: S.phi, speed: S.speed, lean: S.lean, pos: S.cam.pos.clone(), target: S.cam.target.clone(), fov: S.cam.fov };
  }
  const view = { x: 0, z: 0, yaw: 0, phi: 0, amp: 0, lean: 0, pos: V(), target: V(), fov: CAM.fov, t: 0 };
  function frame(t) {
    if (broken) return;
    try {
      // never switched on, or off and settled: nothing to do (the page is as before)
      if (!installed || (!S.enabled && !S.homing && S.owner === "director" && handU(t) >= 1)) {
        simT = t;
        cur = prev = null;
        return;
      }
      if (simT === null || !cur) reset(t);
      // a jump of the show clock (the operator's ← →) is not a walk: back, the walk goes on from there;
      // forward, at most 0.25 s is simulated
      if (t < simT) reset(t);
      if (!virtual && t - simT > 0.25) simT = t - 0.25;
      while (simT + STEP_S <= t + 1e-9) {
        prev = cur;
        simT += STEP_S;
        step(simT, STEP_S);
        cur = snap();
      }
      prev ??= cur;
      const a = clamp((t - simT) / STEP_S, 0, 1);
      // the picture runs one step behind the simulation, blended between its last two states
      view.x = prev.x + (cur.x - prev.x) * a;
      view.z = prev.z + (cur.z - prev.z) * a;
      view.yaw = prev.yaw + wrap(cur.yaw - prev.yaw) * a;
      view.phi = prev.phi + (cur.phi - prev.phi) * a;
      view.amp = clamp((prev.speed + (cur.speed - prev.speed) * a) / WALK.speed, 0, 1);
      view.lean = prev.lean + (cur.lean - prev.lean) * a;
      view.pos.lerpVectors(prev.pos, cur.pos, a);
      view.target.lerpVectors(prev.target, cur.target, a);
      view.fov = prev.fov + (cur.fov - prev.fov) * a;
      view.t = t;
    } catch (e) {
      fail(e);
    }
  }
  function reset(t) {
    simT = t;
    cur = prev = snap();
  }
  function fail(e) {
    broken = true;
    warn(`stopped: ${e?.stack ?? e}; the show goes on without the Walk`);
    try {
      host.steer(null);
    } catch {}
    S.enabled = false;
    S.homing = false;
  }

  // ---- the Host and the camera inside stage.renderAt
  const steerOut = { pos: V(), yaw: 0, phi: 0, amp: 0, lean: 0 };
  const hostSteer = () => {
    if (broken || !(S.enabled || S.homing)) return null;
    steerOut.pos.set(view.x, 0, view.z);
    steerOut.yaw = view.yaw;
    steerOut.phi = view.phi;
    steerOut.amp = view.amp;
    steerOut.lean = view.lean;
    return steerOut;
  };
  const dirUpdate = dirCam.update;
  const shown = { pos: V(), quat: new THREE.Quaternion(), fov: 35, exposure: V(1, 1, 1), focus: 0, aperture: 0, valid: false };
  const walkQ = new THREE.Quaternion(), m4 = new THREE.Matrix4(), UP = V(0, 1, 0);
  const lensOut = { pos: V(), target: V(), fov: 35, focus: 0, aperture: 0, exposure: V(), iso: 1, white: [1, 1, 1] };
  function cameraUpdate(t) {
    const lensD = dirUpdate.call(dirCam, t); // the director's frame, always (it is a pure function of t)
    if (broken) return lensD;
    try {
      const u = handU(view.t);
      const w = S.owner === "walk" ? ease(u) : 1 - ease(u); // the walk's share of the picture
      const passThrough = S.owner === "director" && u >= 1;
      if (passThrough) {
        remember(lensD);
        return lensD;
      }
      // the director's picture now
      const dPos = lens.position.clone(), dQuat = lens.quaternion.clone(), dFov = lens.fov;
      // the walk's
      m4.lookAt(view.pos, view.target, UP);
      walkQ.setFromRotationMatrix(m4);
      const wExp = CAM.exposure, wFocus = view.pos.distanceTo(tmp.set(view.x, 1.1, view.z));
      // from what was on screen when the hand-over began, to the side that takes the camera
      if (!S.hand.from && shown.valid) {
        S.hand.from = { pos: shown.pos.clone(), quat: shown.quat.clone(), fov: shown.fov, exposure: shown.exposure.clone(), focus: shown.focus, aperture: shown.aperture };
        S.hand.at = Math.min(S.hand.at, view.t); // the move starts from the picture on screen
      }
      const F = S.hand.from;
      const k = ease(handU(view.t));
      const toPos = S.owner === "walk" ? view.pos : dPos, toQuat = S.owner === "walk" ? walkQ : dQuat;
      const toFov = S.owner === "walk" ? view.fov : dFov;
      const toExp = S.owner === "walk" ? tmp2.setScalar(wExp) : lensD.exposure;
      const toFocus = S.owner === "walk" ? wFocus : lensD.focus, toAp = S.owner === "walk" ? 0 : lensD.aperture;
      if (F && k < 1) {
        const dist = F.pos.distanceTo(toPos);
        lens.position.lerpVectors(F.pos, toPos, k).addScaledVector(UP, Math.sin(Math.PI * k) * Math.min(0.4, dist * 0.05));
        lens.quaternion.slerpQuaternions(F.quat, toQuat, k);
        lens.fov = F.fov + (toFov - F.fov) * k;
        lensOut.exposure.lerpVectors(F.exposure, toExp, k);
        lensOut.focus = F.focus + (toFocus - F.focus) * k;
        lensOut.aperture = F.aperture + (toAp - F.aperture) * k;
      } else {
        lens.position.copy(toPos);
        lens.quaternion.copy(toQuat);
        lens.fov = toFov;
        lensOut.exposure.copy(toExp);
        lensOut.focus = toFocus;
        lensOut.aperture = toAp;
      }
      lens.updateProjectionMatrix();
      lens.updateMatrixWorld();
      lensOut.pos.copy(lens.position);
      lensOut.fov = lens.fov;
      lensOut.iso = lensOut.exposure.y;
      lensOut.white = [1, 1, 1];
      lensOut.walk = w;
      remember(lensOut);
      return lensOut;
    } catch (e) {
      fail(e);
      return lensD;
    }
  }
  function remember(l) {
    shown.pos.copy(lens.position);
    shown.quat.copy(lens.quaternion);
    shown.fov = lens.fov;
    if (l.exposure?.isVector3) shown.exposure.copy(l.exposure);
    else shown.exposure.setScalar(l.exposure ?? 1);
    shown.focus = l.focus ?? 0;
    shown.aperture = l.aperture ?? 0;
    shown.valid = true;
  }
  function install() {
    if (installed) return;
    plan = buildFloorPlan(scene, { skip: (o) => robotRoots.has(o) });
    installed = true;
    dirCam.update = cameraUpdate;
    host.steer(hostSteer);
  }

  // ---- on / off
  function setEnabled(on) {
    if (broken || on === S.enabled) return;
    install();
    const t = simT ?? now();
    S.enabled = on;
    if (on) {
      if (!S.homing) {
        // from where the Host is: the show never moves it from its post
        Object.assign(S, { x: HOME.x, z: HOME.z, yaw: HOME.yaw, vx: 0, vz: 0, speed: 0 });
      }
      S.homing = false;
      S.auto = null;
      // the camera over the Host's shoulder toward the ballot box and the consoles, already in place
      // (the hand-over brings the picture there)
      const c = S.cam;
      c.yaw = c.yawGoal = Math.atan2(BALLOT.x - S.x, BALLOT.z - S.z);
      c.pitch = c.pitchGoal = CAM.pitch;
      c.dist = c.distGoal = CAM.dist;
      c.pivot.set(S.x, CAM.pivotY, S.z);
      c.distEff = maxDist(c, c.dist);
      followPose(fp);
      c.pos.copy(fp.pos);
      c.target.copy(fp.target);
      S.lastMouse = t;
      lazyInteract();
    } else {
      keys.clear();
      S.focus?.resolve();
      S.focus = null;
      // back to its post by itself
      S.homing = true;
      S.homeSince = t;
      S.homeRetry = t;
      S.auto = null;
    }
    cur = prev = snap();
    emit("toggle", { enabled: on });
  }
  // ui/walk-interact.js (another session's module) is loaded the first time the Walk goes on: a page
  // that never walks asks for nothing (the module may be absent: the import fails silently)
  let interactLoaded = false;
  function lazyInteract() {
    if (interactLoaded || !ctx.attachInteract) return;
    interactLoaded = true;
    try {
      ctx.attachInteract(api);
    } catch (e) {
      warn(`walk-interact: ${e?.message ?? e}`);
    }
  }

  // ---- targets: a click, E
  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const targetOf = (o) => {
    for (let p = o; p; p = p.parent) if (p.userData?.walkTarget) return { obj: p, ...p.userData.walkTarget };
    return null;
  };
  const tagged = () => {
    const out = [];
    scene.traverse((o) => o.userData?.walkTarget && out.push(o));
    return out;
  };
  let taggedList = null;
  /** What is under a point of the frame (px of the 1920×1080 frame): { target?, point } or null. */
  function pick(px, py, { floor = false } = {}) {
    const W = canvas?.width || 1920, H = canvas?.height || 1080;
    ndc.set((px / W) * 2 - 1, -(py / H) * 2 + 1);
    ray.setFromCamera(ndc, lens);
    taggedList ??= tagged();
    // the Host is the Co-host's own body: clicks go through it
    const seen = (h) => {
      for (let p = h.object; p; p = p.parent) if (!p.visible || p === host.object3d) return false;
      return true;
    };
    const hits = ray.intersectObjects(floor ? scene.children : taggedList, true).filter((h) => {
      if (!seen(h)) return false;
      const m = Array.isArray(h.object.material) ? h.object.material[0] : h.object.material;
      return !(m?.transparent && m.depthWrite === false && !targetOf(h.object));
    });
    if (floor) {
      const h = hits[0];
      const tg = h ? targetOf(h.object) : null;
      if (h) return { target: tg, point: h.point.clone() };
      // nothing hit: the floor plane
      const tF = -ray.ray.origin.y / ray.ray.direction.y;
      return tF > 0 ? { target: null, point: ray.ray.at(tF, V()) } : null;
    }
    // the first hit decides (a Judge in front of its console is the Judge)
    const occl = ray.intersectObjects(scene.children, true).find((h) => {
      if (!seen(h)) return false;
      const m = Array.isArray(h.object.material) ? h.object.material[0] : h.object.material;
      return !(m?.transparent && m.depthWrite === false);
    });
    const h = hits[0];
    if (!h) return null;
    if (occl && occl.distance < h.distance - 0.05 && !targetOf(occl.object)) return null; // behind something untagged
    return { target: targetOf(h.object), point: h.point.clone() };
  }
  function interact(target, point) {
    if (!S.enabled || busy || !target) return false;
    emit("interact", { kind: target.kind, id: target.id, point: point.clone() });
    return true;
  }
  /** The target the Host stands at and faces (E): { kind, id, obj, point } or null. */
  function nearTarget() {
    const fx = Math.sin(S.yaw), fz = Math.cos(S.yaw);
    const cands = [];
    const add = (kind, id, x, z, d, obj, point) => {
      const ang = Math.acos(clamp(((x - S.x) * fx + (z - S.z) * fz) / (Math.hypot(x - S.x, z - S.z) || 1), -1, 1));
      if (d <= WALK.reach && ang <= WALK.faceCone) cands.push({ kind, id, d: d + ang * 0.25, obj, point });
    };
    for (const id of JUDGE_IDS) {
      const r = robots[id].object3d;
      add("judge", id, r.position.x, r.position.z, Math.hypot(r.position.x - S.x, r.position.z - S.z) - judgeRadius(id) - WALK.radius, r, r.position.clone().setY(1.5));
      const D = DESKS[id];
      const desk = world?.desks?.[id]?.object3d ?? null;
      add("console", id, D.pos.x, D.pos.z, Math.hypot(D.pos.x - S.x, D.pos.z - S.z) - 0.5 - WALK.radius, desk, D.pos.clone().setY(1.4));
    }
    const wallX = -SIDE_X + 0.07, wz0 = 0.6 - BOARD_W / 2, wz1 = 0.6 + BOARD_W / 2, cz = clamp(S.z, wz0, wz1);
    add("wall", "wall", wallX, cz, Math.abs(S.x - wallX) - WALK.radius, scene.getObjectByName("dispatch-board"), V(wallX, 1.78, cz));
    add("urn", "urn", BALLOT.x, BALLOT.z, Math.hypot(BALLOT.x - S.x, BALLOT.z - S.z) - 0.25 - WALK.radius, null, BALLOT.clone().setY(1.2));
    for (const u of dyn.urns) add("urn", "urn", u.x, u.z, Math.hypot(u.x - S.x, u.z - S.z) - 0.2 - WALK.radius, null, V(u.x, 0.8, u.z));
    cands.sort((a, b) => a.d - b.d);
    return cands[0] ?? null;
  }

  // ---- focus
  function focus(object3d, { seconds = 3 } = {}) {
    if (!object3d) return Promise.resolve();
    S.focus?.resolve();
    const box = new THREE.Box3().setFromObject(object3d);
    // an empty marker (an Object3D without meshes) is a point: its world position
    const c = box.isEmpty() ? object3d.getWorldPosition(V()) : box.getCenter(V()), size = box.isEmpty() ? V() : box.getSize(V());
    const r = Math.max(0.35, 0.5 * Math.hypot(size.x, size.y, size.z));
    const fov = 40, need = r / Math.tan(THREE.MathUtils.degToRad(fov / 2)) * 1.05;
    // over the Host's shoulder toward the object, far enough to hold it in frame, inside the room
    const from = V(S.x - c.x, 0, S.z - c.z);
    if (from.lengthSq() < 1e-4) from.set(Math.sin(S.yaw), 0, Math.cos(S.yaw)).negate();
    from.normalize();
    const side = V(from.z, 0, -from.x);
    const d0 = Math.max(Math.hypot(S.x - c.x, S.z - c.z) + 1.1, Math.min(need, 6));
    let pos = null;
    for (let d = d0; d >= 1.2 && !pos; d -= 0.2) {
      const p = c.clone().addScaledVector(from, d).addScaledVector(side, 0.55).setY(clamp(c.y + 0.35, 1.2, 2.4));
      if (inRoom(p.x, p.z, 0.3) && (p.y > 2.25 || plan.clearance(p.x, p.z) > 0.12)) pos = p;
    }
    pos ??= S.cam.pos.clone();
    return new Promise((resolve) => {
      S.focus = { pos, target: c, fov, u: 0, inS: 1.1, hold: Math.max(0, seconds), outS: 1.3, resolve };
    });
  }

  // ---- the page's input (live only)
  if (!virtual && typeof window !== "undefined") {
    const isMove = (k) => k === "w" || k === "a" || k === "s" || k === "d";
    const keyOf = (e) => (e.code?.startsWith("Key") ? e.code.slice(3).toLowerCase() : String(e.key).toLowerCase());
    const safe = (fn) => (e) => {
      try {
        fn(e);
      } catch (err) {
        fail(err);
      }
    };
    window.addEventListener("keydown", safe((e) => {
      if (e.metaKey || e.ctrlKey || e.altKey || broken) return;
      const k = keyOf(e);
      if (k === "p") {
        e.preventDefault();
        if (!e.repeat) setEnabled(!S.enabled);
        return;
      }
      if (!S.enabled) return;
      if (isMove(k)) {
        e.preventDefault();
        keys.add(k);
      } else if (k === "e" && !e.repeat) {
        e.preventDefault();
        const tg = nearTarget();
        if (tg) interact(tg, tg.point);
      }
    }));
    window.addEventListener("keyup", (e) => keys.delete(keyOf(e)));
    window.addEventListener("blur", () => keys.clear());
    const el = canvas ?? window;
    const toFrame = (e) => {
      const r = (canvas ?? document.documentElement).getBoundingClientRect();
      return [((e.clientX - r.left) / r.width) * (canvas?.width || 1920), ((e.clientY - r.top) / r.height) * (canvas?.height || 1080)];
    };
    let drag = null;
    el.addEventListener("pointerdown", (e) => {
      if (!S.enabled || e.button !== 0) return;
      drag = { x: e.clientX, y: e.clientY, moved: false, id: e.pointerId };
      el.setPointerCapture?.(e.pointerId);
    });
    el.addEventListener("pointermove", (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) < 4) return;
      drag.moved = true;
      drag.x = e.clientX;
      drag.y = e.clientY;
      const r = (canvas ?? document.documentElement).getBoundingClientRect(), k = 1920 / (r.width || 1920);
      input.dyaw -= dx * k * 0.0045;
      input.dpitch += dy * k * 0.0035;
      S.lastMouse = simT ?? now();
    });
    const endDrag = (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const was = drag;
      drag = null;
      el.releasePointerCapture?.(e.pointerId);
      if (was.moved) {
        suppressClick = true;
        setTimeout(() => (suppressClick = false), 0);
      }
    };
    let suppressClick = false;
    el.addEventListener("pointerup", endDrag);
    el.addEventListener("pointercancel", endDrag);
    el.addEventListener("click", safe((e) => {
      if (!S.enabled || suppressClick || e.detail > 1) return;
      const [px, py] = toFrame(e);
      const hit = pick(px, py);
      if (hit?.target) interact(hit.target, hit.point);
    }));
    el.addEventListener("dblclick", safe((e) => {
      if (!S.enabled) return;
      e.preventDefault();
      const [px, py] = toFrame(e);
      goToPick(px, py);
    }));
    el.addEventListener("wheel", (e) => {
      if (!S.enabled) return;
      e.preventDefault();
      input.zoom += clamp(e.deltaY, -200, 200) * 0.0012;
    }, { passive: false });
  }
  function goToPick(px, py) {
    const hit = pick(px, py, { floor: true });
    if (!hit) return false;
    if (hit.target) {
      // an object: the nearest free spot in front of it, facing it
      const o = hit.target.obj, c = new THREE.Box3().setFromObject(o).getCenter(V());
      const at = hit.target.kind === "judge" ? o.position : hit.target.kind === "wall" ? V(-SIDE_X + 0.07, 0, clamp(hit.point.z, 0.6 - BOARD_W / 2 + 0.3, 0.6 + BOARD_W / 2 - 0.3)) : V(hit.point.x, 0, hit.point.z);
      const aim = V(at.x, 0, at.z).addScaledVector(V(S.x - at.x, 0, S.z - at.z).normalize(), hit.target.kind === "wall" ? 1.4 : 0.2);
      return goTo(aim.x, aim.z, { faceAt: hit.target.kind === "wall" ? V(at.x, 0, at.z) : c, why: hit.target.kind });
    }
    return goTo(hit.point.x, hit.point.z, { why: "floor" });
  }

  // ---- the API
  const share = () => (S.owner === "walk" ? ease(handU(view.t)) : 1 - ease(handU(view.t)));
  const api = {
    get enabled() {
      return S.enabled;
    },
    set enabled(v) {
      setEnabled(!!v);
    },
    toggle: () => setEnabled(!S.enabled),
    on(ev, fn) {
      (listeners[ev] ??= new Set()).add(fn);
      return () => listeners[ev].delete(fn);
    },
    focus,
    /** the Walk's share of the picture on screen: 0 the director's, 1 the Walk's (walk-interact fades by it) */
    share,
    /** the world (world/stage.js: scene, robots, desks, ballot) for ui/walk-interact.js */
    get stage() {
      return ctx.world;
    },
    busy(b) {
      busy = !!b;
    },
    get isBusy() {
      return busy;
    },
    frame,
    /** for checks and the demo: the state, the floor plan, the targets */
    debug: {
      get state() {
        const near = S.enabled ? nearTarget() : null;
        return {
          enabled: S.enabled, homing: S.homing, broken, x: S.x, z: S.z, yaw: S.yaw, speed: S.speed, owner: S.owner, hand: handU(view.t),
          walkShare: S.owner === "walk" ? ease(handU(view.t)) : 1 - ease(handU(view.t)), auto: S.auto ? { why: S.auto.why, goal: S.auto.goal, n: S.auto.path.length } : null,
          cam: { x: view.pos.x, y: view.pos.y, z: view.pos.z }, near: near && { kind: near.kind, id: near.id }, corridors: dyn.corridors.map((c) => c.id), sight: !!dyn.sight, focus: !!S.focus, t: simT,
        };
      },
      get plan() {
        return plan;
      },
      clearance: (x, z) => clearance(x, z),
      keys,
      press: (k, on = true) => (on ? keys.add(k) : keys.delete(k)),
      orbit: (dyaw, dpitch = 0) => ((input.dyaw += dyaw), (input.dpitch += dpitch), (S.lastMouse = simT ?? now())),
      goTo: (x, z, o) => goTo(x, z, o),
      goToPick,
      pick,
      nearTarget,
      interactNear: () => {
        const tg = nearTarget();
        return tg ? interact(tg, tg.point) : false;
      },
      directorWants,
      /** the show time of the last frame */
      get viewT() {
        return view.t;
      },
      /** the walk's share of the picture on screen (0: the director's, 1: the Walk's) */
      share,
      place(x, z, yaw = S.yaw) {
        Object.assign(S, { x, z, yaw, vx: 0, vz: 0, speed: 0, auto: null });
        S.cam.yaw = S.cam.yawGoal = yaw;
        S.cam.pivot.set(x, CAM.pivotY, z);
        cur = snap();
        prev = cur;
      },
    },
  };
  if (q.get("walk") === "1") setEnabled(true);
  return api;
}

// ---- the scripted walk for clips (?t= with ?walkdemo=1): keys and clicks as a function of the clock
function demoScript(which) {
  if (!which) return null;
  if (which === "stress") {
    // for checks: every 4 s the Host heads for another point on the Judges' ways to the box
    const pts = [];
    for (const id of JUDGE_IDS) {
      const a = DESKS[id].post, b = dropSpot(id);
      pts.push([b.x + (a.x - b.x) * 0.5, b.z + (a.z - b.z) * 0.5], [b.x, b.z]);
    }
    let k = -1;
    return {
      drive(t, api) {
        if (!api.enabled) return;
        const n = Math.floor(t / 4);
        if (n === k) return;
        k = n;
        const p = pts[n % pts.length];
        api.debug.goTo(p[0], p[1], { why: "stress" });
      },
    };
  }
  // [t0, t1, action]: keys held over [t0, t1); "go" a point at t0; "orbit" rad/s over [t0, t1)
  const S1 = [
    [1.2, 4.6, { keys: "w" }],
    [2.0, 4.0, { orbit: -0.35 }],
    [4.6, 6.4, { keys: "wd" }],
    [6.6, 6.6, { go: [-0.6, -1.25], face: [0.8, -2.9] }], // in front of the ballot box, between the tubes and the box
    [11.5, 13.5, { orbit: 0.5 }],
    [13.6, 13.6, { go: [-7.9, 0.9], face: [-9.4, 0.6] }], // to the dispatch wall
    [14.0, 16.5, { orbit: -0.25 }],
  ];
  const done = new Set();
  return {
    drive(t, api) {
      if (!api.enabled) return;
      const want = new Set();
      let orbit = 0;
      S1.forEach(([a, b, act], i) => {
        if (act.keys && t >= a && t < b) for (const k of act.keys) want.add(k);
        if (act.orbit && t >= a && t < b) orbit += act.orbit;
        if (act.go && t >= a && !done.has(i)) {
          done.add(i);
          api.debug.goTo(act.go[0], act.go[1], { faceAt: act.face ? new THREE.Vector3(act.face[0], 0, act.face[1]) : null, why: "demo" });
        }
      });
      for (const k of ["w", "a", "s", "d"]) api.debug.press(k, want.has(k));
      if (orbit) api.debug.orbit(orbit * STEP_S);
    },
  };
}
