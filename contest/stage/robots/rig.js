// The shared rig: one skeleton, one state machine, one walk and one idle life for every robot, so both
// vendor families move with the same care; each character (anthropic.js, openai.js, host.js) gives its
// tempo, poses and gestures, and its model (assets.js) gives the joints and the parts.
//
// Every frame is a function of t and of the calls kept as events (world/timeline.js): a state change
// eases from the pose the robot had at that moment (a snapshot), a change of facing is a turn on the
// spot with steps, a vote is a planned trip that owns the body until it ends, a beat ("decide",
// "gesture") is an event too. Standing, the feet stay planted (leg IK) while the pelvis breathes and
// shifts its weight; at the desk the hands rest on it (arm IK), whatever the robot's size.
import * as THREE from "three";
import { Track, clamp01, lerp, smooth, inOut3, wrap } from "/world/timeline.js";
import { POST_BACK, BALLOT } from "/world/layout.js";

export const STATES = ["waiting", "working", "speaking", "offline"];
const BLEND = 0.8; // s, the ease between two states
// the camera landing on a speaking robot cues one gesture (land): not while it still turns to the room
// and rises into the speaking pose (that is its move), not over a gesture, and on a new angle of the
// same robot only after a long calm hold
const LAND = { settle: 2.0, gap: 4, sameGap: 10 };
const DESK_TOP = 0.955; // world/desk.js: the console's top; its front edge is 0.4 m in front of the post
const DESK_EDGE = POST_BACK - 0.4;

// ---- the skeleton --------------------------------------------------------------------------

/**
 * Joints, all THREE.Group, the robot facing +Z with its left side at +X (metres):
 * root (on the floor) > pelvis (hipY) > hipL/R > kneeL/R > ankleL/R, pelvis > spine > shoulderL/R >
 * elbowL/R > handL/R > fingersL/R, spine > neck > head. A robot without legs (the Host) has a base on
 * the root instead.
 */
export function skeleton(d) {
  const G = () => new THREE.Group();
  const root = G(), pelvis = G(), spine = G(), neck = G(), head = G();
  pelvis.position.y = d.hipY;
  root.add(pelvis);
  pelvis.add(spine);
  const legs = {}, arms = {};
  for (const [k, s] of [["L", 1], ["R", -1]]) {
    if (d.legs !== false) {
      const hip = G(), knee = G(), ankle = G();
      hip.position.set(s * d.hipW, 0, 0);
      knee.position.y = -d.thigh;
      ankle.position.y = -d.shin;
      pelvis.add(hip);
      hip.add(knee);
      knee.add(ankle);
      legs[k] = { hip, knee, ankle };
    }
    const shoulder = G(), elbow = G(), hand = G(), fingers = G();
    shoulder.position.set(s * d.shoulderW, d.shoulderY, d.shoulderZ ?? 0);
    elbow.position.y = -d.upper;
    hand.position.y = -d.fore;
    fingers.position.y = -(d.palm ?? 0.09);
    spine.add(shoulder);
    shoulder.add(elbow);
    elbow.add(hand);
    hand.add(fingers);
    arms[k] = { shoulder, elbow, hand, fingers };
  }
  neck.position.y = d.neckY;
  spine.add(neck);
  neck.add(head);
  const base = G();
  root.add(base);
  return { root, pelvis, spine, legs, arms, neck, head, base };
}

// ---- poses ---------------------------------------------------------------------------------

// A pose: pelvis lift, roll and sideways shift, the chest's breath, spine lean (+ forward) and twist,
// legs (thigh + back, knee + bends; standing, the IK sets them), arms (x: − forward, z: + away from the
// body for the left, − for the right, elbow: − bends forward), forearm twist (+ turns the palm forward
// / up), wrist flex (+ toward the palm), finger curl (0 open .. 1 closed), the arm IK weights (hands on
// the desk), head (pitch + down, yaw, roll), the face light.
const ZERO = { lift: 0, roll: 0, shift: 0, breath: 0, lean: 0, twist: 0, thL: 0, knL: 0, anL: 0, thR: 0, knR: 0, anR: 0,
  shLx: 0, shLz: 0, elL: 0, twL: 0, wfL: 0, fgL: 0, shRx: 0, shRz: 0, elR: 0, twR: 0, wfR: 0, fgR: 0, ikL: 0, ikR: 0,
  hdP: 0, hdY: 0, hdR: 0, face: 0, reachR: 0 };
const KEYS = Object.keys(ZERO);

// how a state reads, the same on every robot (a character overrides a few numbers)
const BASE = {
  // at rest: weight on one foot, arms loose, elbows soft, palms to the thighs, fingers relaxed
  waiting: { lean: 0.02, hdP: 0.08, shLx: 0.05, shLz: 0.06, elL: -0.3, twL: -0.25, wfL: 0.08, fgL: 0.42,
    shRx: 0.05, shRz: -0.06, elR: -0.3, twR: -0.25, wfR: 0.08, fgR: 0.42, face: 0.1 },
  // at the console: leaning in, both hands on the desk (arm IK), the head down to the screen
  working: { lean: 0.17, hdP: 0.3, lift: -0.006, ikL: 1, ikR: 1, twL: -1.25, twR: -1.3, wfL: 0.25, wfR: 0.3, fgL: 0.3, fgR: 0.22,
    shLz: 0.1, shRz: -0.1, face: 0.17 },
  // to the room: upright, hands up and open, ready to gesture (once, as the camera lands: land)
  speaking: { lean: -0.02, hdP: -0.05, shLx: -0.14, shLz: 0.1, elL: -0.62, twL: 0.1, fgL: 0.3,
    shRx: -0.34, shRz: -0.14, elR: -0.95, twR: 0.45, fgR: 0.25, wfR: -0.1, face: 0.5 },
  // powered down: a machine at rest, not a sleeper: upright and square (no roll, twist or head
  // tilt), the head bowed a little, arms straight at the sides, knees locked, the face off, still.
  // (A slump with the head hanging read as drunk; red team 3.)
  offline: { lean: 0.03, hdP: 0.3, lift: -0.004,
    shLx: 0.01, shLz: 0.035, elL: -0.12, twL: -0.3, wfL: 0.04, fgL: 0.3, shRx: 0.01, shRz: -0.035, elR: -0.12, twR: -0.3, wfR: 0.04, fgR: 0.3, face: 0 },
};

const mixPose = (a, b, u, out = {}) => {
  for (const k of KEYS) out[k] = lerp(a[k] ?? 0, b[k] ?? 0, u);
  return out;
};
const addPose = (out, dlt, k = 1) => {
  for (const key in dlt) if (key in out) out[key] += dlt[key] * k;
  return out;
};

/** A smooth pulse: 0 outside [a, b], 1 inside after ramps of r seconds. */
const pulse = (t, a, b, r) => smooth((t - a) / r) * (1 - smooth((t - (b - r)) / r));

/**
 * Wrap a built body into a robot. `spec` = { dims, sk, face (material), anchors: { face, chest, hand? },
 * look: per-state pose overrides, motion: tempo and walk numbers, gesture(u) -> pose delta,
 * decide: { scale }, extra(pose, t, ctx), height }.
 * `place` = { post, deskYaw, roomYaw, spot, slot?, lift? }: set by the stage (slot: where the token goes over
 * the box's slot, world; lift: how far above the grip point the token's centre sits).
 */
export function makeRobot(id, info, sk, spec) {
  const d = { ...spec.dims, ...(spec.motion || {}) };
  const looks = {};
  for (const s of STATES) looks[s] = { ...ZERO, ...BASE[s], ...(spec.look?.[s] || {}) };
  const seed = [...id].reduce((a, c) => a + c.charCodeAt(0), 0) * 0.137;
  const states = new Track(); // { state, facing, snap?, hold? }
  const trips = new Track(); // { plan }
  const beats = new Track(); // { kind, t0, end, ... } the gestures (overlays); decide beats live in states
  let place = { post: new THREE.Vector3(), deskYaw: 0, roomYaw: 0 };
  let voice = () => 0;
  let onTrip = null; // (id, plan) => void: the stage hands the token to the ballot station
  let onBeat = null;
  const tempo = d.tempo ?? 1;
  const ankleH = d.legs === false ? 0 : d.hipY - d.thigh - d.shin;

  // the right hand's grip point: ballot.handOf takes (0, -0.15, 0) of this anchor, so the anchor sits
  // that far above the point between the thumb and the curled fingers
  const grip = new THREE.Group();
  grip.position.y = 0.15 - (d.palm ?? 0.09) * 1.05;
  sk.arms.R.hand.add(grip);
  const anchors = {
    head: sk.head,
    face: spec.anchors?.face ?? sk.head,
    hand: grip,
    chest: spec.anchors?.chest ?? sk.spine,
    base: sk.root,
  };

  // the yaw a state faces
  const yawOf = (e) => ((e.facing ?? (e.state === "speaking" ? "room" : "desk")) === "room" ? place.roomYaw : place.deskYaw);
  // a turn of more than ~140° goes through the side that faces the middle of the room
  function turnDelta(from, to) {
    let dlt = wrap(to - from);
    if (Math.abs(dlt) > 2.4) {
      const alt = dlt > 0 ? dlt - 2 * Math.PI : dlt + 2 * Math.PI;
      const toMid = -Math.sign(place.post.x || 1);
      const mid = (x) => Math.sin(from + x / 2) * toMid;
      if (mid(alt) > mid(dlt)) dlt = alt;
    }
    return dlt;
  }
  const turnDur = (dlt) => (Math.abs(dlt) < 0.05 ? 0 : (0.45 + (Math.abs(dlt) / Math.PI) * 0.75) / Math.sqrt(tempo));

  // ---- idle life: breath, weight shifts, glances (pure functions of t)
  const breathAt = (ts) => Math.sin(ts * (2 * Math.PI / 4.4) + seed);
  // the weight goes from foot to foot every few seconds, each robot on its own beat
  function weightAt(ts) {
    const P = d.shiftPeriod ?? 7.5, k = Math.floor((ts + seed * 3) / P), u = (ts + seed * 3) / P - k;
    const side = (n) => ((Math.sin(n * 12.9898 + seed) * 43758.5453) % 1 + 1) % 1 > 0.5 ? 1 : -1;
    return lerp(side(k), side(k + 1), smooth((u - 0.82) / 0.18));
  }
  // a glance: every 8-12 s (seeded), the head turns to its screen for ~2 s
  function glanceAt(ts) {
    const P = 9.5, k = Math.floor((ts + seed * 5) / P), u = ((ts + seed * 5) / P - k) * P;
    const off = 2 + (((Math.sin(k * 7.13 + seed) * 9137.1) % 1) + 1) % 1 * 4;
    return pulse(u, off, off + 2.2, 0.55);
  }

  // the live pose of a state at time t (idle life, reading, the speaking hold); t0: the state's start
  function live(state, t, out, yaw, t0 = -1e9) {
    Object.assign(out, looks[state]);
    const ts = t * tempo;
    if (state !== "offline") {
      out.breath = breathAt(ts) * (d.breath ?? 1);
      out.lean += 0.006 * out.breath;
      out.shLz += 0.012 * out.breath;
      out.shRz -= 0.012 * out.breath;
    }
    if (state === "waiting" || state === "speaking") {
      const w = weightAt(ts) * (d.shiftAmp ?? 1) * (state === "speaking" ? 0.6 : 1);
      out.shift += 0.018 * w;
      out.roll += 0.032 * w;
      out.twist += 0.02 * w;
      out.hdR -= 0.02 * w;
    }
    if (state === "waiting") {
      out.hdY += 0.05 * Math.sin(ts * 0.21 + seed);
      out.hdP += 0.02 * Math.sin(ts * 0.31 + seed * 2);
      out.fgL += 0.05 * Math.sin(ts * 0.4 + seed);
      // a glance: back over the shoulder at its own screen (facing the room), or along the row (at the desk)
      const g = glanceAt(ts), dy = wrap(place.deskYaw - yaw);
      const look = Math.abs(dy) > 0.3 ? Math.max(-1, Math.min(1, dy * 0.7)) : 0.5 * Math.sign(Math.sin(seed * 7) || 1);
      out.hdY += g * look;
      out.twist += g * 0.25 * look;
    } else if (state === "working") {
      // reading: the head follows lines down and returns, the right hand scrolls, a glance at the side monitor
      const line = (ts * 0.42 + seed) % 1;
      out.hdP += 0.05 * smooth(line / 0.85) - 0.05 * smooth((line - 0.85) / 0.15);
      out.hdY += 0.06 * Math.sin(ts * 0.37 + seed);
      out.fgR += 0.12 * Math.max(0, Math.sin(ts * 1.9 + seed));
      out.lean += 0.012 * Math.sin(ts * 0.5 + seed);
      const g = glanceAt(ts);
      out.hdY += 0.42 * g;
      out.twist += 0.05 * g;
    } else if (state === "speaking") {
      // a calm hold: the body does not follow the words (each word kicked the arms; owner 2026-10-28),
      // only a slow drift of the hands and the head; the voice shows in the face light. The robot moves
      // once, as it turns to the room and as the camera lands on it (land below).
      const k = d.gesture ?? 1;
      const g1 = Math.sin(ts * 0.42 + seed), g2 = Math.sin(ts * 0.29 + seed * 3);
      out.shRx += k * -0.035 * g1;
      out.elR += k * -0.05 * g2;
      out.shLx += k * -0.02 * Math.sin(ts * 0.33 + seed);
      out.hdY += 0.07 * Math.sin(ts * 0.21 + seed);
      out.hdP += 0.015 * Math.sin(ts * 0.27 + seed * 2);
      out.face = looks.speaking.face + 0.75 * clamp01(voice(t));
    }
    spec.extra?.(out, t, { state, voice: state === "speaking" ? clamp01(voice(t)) : 0, yaw, place, ts, since: t - t0 });
    return out;
  }

  // ---- the walk
  // legs at phase phi (one step = PI), amplitude amp (0 standing .. 1 full stride)
  function stepPose(out, phi, amp, sc = 1) {
    const A = (d.stride ?? 0.32) * sc, B = (d.knee ?? 0.62) * sc;
    const s = Math.sin(phi), c = Math.cos(phi), s2 = Math.sin(phi + Math.PI), c2 = Math.cos(phi + Math.PI);
    out.thL = -A * amp * s;
    out.knL = amp * (B * Math.max(0, c) + 0.07);
    out.anL = -0.85 * (out.thL + out.knL) - 0.12 * amp * Math.max(0, c);
    out.thR = -A * amp * s2;
    out.knR = amp * (B * Math.max(0, c2) + 0.07);
    out.anR = -0.85 * (out.thR + out.knR) - 0.12 * amp * Math.max(0, c2);
    const L = d.legs === false ? 0.8 : d.thigh + d.shin;
    out.lift = -L * (1 - Math.cos(A * amp)) * (1 - Math.cos(2 * phi)) * 0.5 + (d.bob ?? 0.012) * amp * Math.cos(2 * phi) - 0.01 * amp;
    out.roll = (d.sway ?? 0.035) * amp * s;
    out.twist = 0.05 * amp * s;
    const W = (d.armSwing ?? 0.32) * amp;
    out.shLx = W * s + 0.02;
    out.shRx = -W * s + 0.02;
    out.shLz = 0.07;
    out.shRz = -0.07;
    out.elL = -0.25 - 0.12 * amp * Math.max(0, s);
    out.elR = -0.25 - 0.12 * amp * Math.max(0, -s);
    out.twL = out.twR = -0.25;
    out.fgL = out.fgR = 0.45;
    return out;
  }
  const WALK = { ...ZERO, lean: 0.035, hdP: 0.06, face: 0.22 };

  // a trapezoid speed profile: distance along a walk of length len and duration T at time u (s)
  function along(len, T, u, ta = 0.5) {
    u = Math.min(Math.max(u, 0), T);
    const v = len / (T - ta);
    if (u < ta) return (0.5 * v * u * u) / ta;
    if (u > T - ta) return len - (0.5 * v * (T - u) * (T - u)) / ta;
    return 0.5 * v * ta + v * (u - ta);
  }

  function planTrip(t0, from) {
    const P0 = place.post.clone(), P1 = place.spot.clone();
    const len = P0.distanceTo(P1);
    const yawOut = Math.atan2(P1.x - P0.x, P1.z - P0.z), yawBack = wrap(yawOut + Math.PI);
    const k = paceAt(t0);
    const speed = (d.speed ?? 1.1) * k, stepLen = (d.stepLen ?? 0.62) * Math.sqrt(k); // brisk: longer and quicker steps
    const nSteps = Math.max(2, Math.round(len / stepLen));
    const walkT = len / speed + 0.5;
    const d1 = turnDelta(from.yaw, yawOut), d2 = turnDelta(yawOut, yawBack), d3 = turnDelta(yawBack, place.roomYaw);
    const T1 = t0 + Math.max(0.5, turnDur(d1)), T2 = T1 + walkT, T3 = T2 + 1.15 / Math.sqrt(k), T4 = T3 + Math.max(0.6, turnDur(d2)), T5 = T4 + walkT, T6 = T5 + Math.max(0.5, turnDur(d3));
    return { t0, P0, P1, len, nSteps, walkT, yaw0: from.yaw, yawOut, yawBack, d1, d2, d3, T1, T2, T3, T4, T5, T6, end: T6, dropAt: T2 + 0.55, backAt: T5 };
  }

  // arriveAt: at the box; leaveAt: turned back and walking away
  const tripTimes = (p) => ({ t0: p.t0, arriveAt: p.T2, dropAt: p.dropAt, leaveAt: p.T4, backAt: p.backAt, end: p.end });

  // the body during a trip
  function tripPose(p, t, out) {
    const pos = new THREE.Vector3();
    let yaw;
    const shuffle = (u, dlt) => stepPose(out, u * Math.max(2, Math.round(Math.abs(dlt) / 0.9)) * Math.PI, 0.42 * Math.sin(Math.PI * clamp01(u)) ** 0.5, 0.75);
    if (t < p.T1) {
      const u = (t - p.t0) / (p.T1 - p.t0);
      shuffle(u, p.d1);
      pos.copy(p.P0);
      yaw = p.yaw0 + p.d1 * inOut3(u);
    } else if (t < p.T2) {
      const u = t - p.T1, s = along(p.len, p.walkT, u);
      const phi = (s / p.len) * p.nSteps * Math.PI;
      const amp = Math.min(1, phi / Math.PI * 1.4, (p.nSteps * Math.PI - phi) / Math.PI * 1.4 + 0.15);
      stepPose(out, phi, Math.max(0, amp));
      pos.lerpVectors(p.P0, p.P1, s / p.len);
      yaw = p.yawOut;
    } else if (t < p.T3) {
      stepPose(out, 0, 0);
      pos.copy(p.P1);
      yaw = p.yawOut;
      // the drop: the arm goes out over the slot, the token falls in, the arm comes back
      const u = t - p.T2;
      if (place.slot) {
        // the hand goes to the slot (arm IK in apply) and is there by the time the token lets go
        // (dropAt - 0.32 s), stays while it falls, then comes back
        out.reachR = smooth((u + 0.25) / 0.45) * (1 - smooth((u - 0.75) / 0.4));
        out.twR = lerp(out.twR, 0.1, out.reachR);
        out.lean = 0.04 * out.reachR;
      } else {
        const up = smooth(u / 0.45) * (1 - smooth((u - 0.7) / 0.45));
        out.shRx = lerp(out.shRx, d.dropReach ?? -1.0, up);
        out.elR = lerp(out.elR, -0.32, up);
        out.shRz = lerp(out.shRz, -0.02, up);
        out.twR = lerp(out.twR, -1.2, up);
        out.lean = 0.07 * up;
      }
    } else if (t < p.T4) {
      const u = (t - p.T3) / (p.T4 - p.T3);
      shuffle(u, p.d2);
      pos.copy(p.P1);
      yaw = p.yawOut + p.d2 * inOut3(u);
    } else if (t < p.T5) {
      const u = t - p.T4, s = along(p.len, p.walkT, u);
      const phi = (s / p.len) * p.nSteps * Math.PI;
      const amp = Math.min(1, phi / Math.PI * 1.4, (p.nSteps * Math.PI - phi) / Math.PI * 1.4 + 0.15);
      stepPose(out, phi, Math.max(0, amp));
      pos.lerpVectors(p.P1, p.P0, s / p.len);
      yaw = p.yawBack;
    } else {
      const u = (t - p.T5) / (p.T6 - p.T5);
      shuffle(u, p.d3);
      pos.copy(p.P0);
      yaw = p.yawBack + p.d3 * inOut3(clamp01(u));
    }
    out.lean += WALK.lean;
    out.hdP = (t > p.T2 - 0.3 && t < p.T3 ? 0.3 : WALK.hdP);
    // the token hand is held in front of the chest until the drop, the fingers closed on it
    if (t < p.dropAt) {
      // upper arm forward and a little out, the forearm level: the hand at chest height in front of
      // the body, the elbow clear of the ribs (an arm folded across the belly reads as a stomach ache)
      out.shRx = Math.min(out.shRx, 0) * 0.4 - 0.72 + (t > p.T2 ? out.shRx * 0.6 : 0);
      if (t <= p.T2) (out.elR = -1.05), (out.twR = 0.1), (out.shRz = -0.16), (out.wfR = 0);
      out.fgR = 0.95;
    } else out.fgR = lerp(0.95, 0.3, smooth((t - p.dropAt) / 0.3));
    out.face = WALK.face;
    return { pos, yaw };
  }

  // ---- the decide beat: stop reading, straighten, a still beat, take the token, hold it at the chest
  const dScale = spec.decide?.scale ?? 1 / Math.sqrt(tempo);
  const DECIDE = [ // [nominal s, pose]
    [0.6, { lean: 0.04, hdP: 0.12, ikL: 0.6, ikR: 0.85, twL: -0.9, twR: -1.2, fgL: 0.35, fgR: 0.3, face: 0.24 }],
    [1.5, { lean: 0.03, hdP: 0.2, ikL: 0.6, ikR: 0.85, twL: -0.9, twR: -1.2, fgL: 0.35, fgR: 0.3, face: 0.26 }],
    [2.0, { lean: 0.12, hdP: 0.34, ikL: 0.6, ikR: 1, twL: -0.9, twR: -1.3, wfR: 0.2, fgL: 0.35, fgR: 0.02, face: 0.26 }],
    [2.25, { lean: 0.12, hdP: 0.32, ikL: 0.6, ikR: 1, twL: -0.9, twR: -1.3, wfR: 0.2, fgL: 0.35, fgR: 0.95, face: 0.26 }],
    [2.85, { lean: 0.02, hdP: 0.1, shLx: 0.04, shLz: 0.06, elL: -0.32, twL: -0.25, fgL: 0.42, shRx: -0.28, shRz: -0.1, elR: -1.5, twR: 0.15, wfR: -0.15, fgR: 0.95, face: 0.24 }],
  ];
  // the ballot's pace from t (setPace): a brisk wave decides and walks `k` times faster (ui/show.js: every
  // vote wave after the show's first, which plays at the robot's own pace)
  const paces = new Track(); // { k }
  const paceAt = (t) => paces.current(t)?.k ?? 1;
  const decideTimes = (t0) => {
    const sc = dScale / paceAt(t0);
    return { t0, scale: sc, dimAt: t0 + 0.5 * sc, tokenAt: t0 + 2.2 * sc, end: t0 + 2.85 * sc };
  };
  function decidePose(e, t, out, depth) {
    const s = (t - e.t) / (e.times?.scale ?? dScale);
    const from = snapshot(e, depth).pose;
    let prev = { ...from, ikL: from.ikL, ikR: from.ikR }, prevT = 0, cur = null;
    for (const [kt, kp] of DECIDE) {
      const target = { ...ZERO, ...looks.waiting, ...kp };
      if (s <= kt) {
        const u = inOut3((s - prevT) / (kt - prevT));
        cur = mixPose(prev, target, u, {});
        break;
      }
      prev = target;
      prevT = kt;
    }
    if (!cur) cur = { ...prev };
    Object.assign(out, cur);
    // breathing goes on; a small nod in the still beat
    out.breath = breathAt(t * tempo) * (d.breath ?? 1);
    out.hdP += 0.05 * pulse(s, 1.0, 1.5, 0.2);
    return out;
  }

  // ---- evaluation: the pose and the root at time t
  function evaluate(t, depth = 0) {
    // a trip in force owns the body
    const trip = trips.current(t);
    if (trip && t < trip.plan.end) {
      const out = { ...ZERO };
      const r = tripPose(trip.plan, t, out);
      const u = smooth((t - trip.t) / 0.45);
      if (u < 1) {
        const from = snapshot(trip, depth);
        mixPose(from.pose, out, u, out);
      }
      return { pose: out, pos: r.pos, yaw: r.yaw, phase: phaseOf(trip.plan, t), plant: false };
    }
    const e = states.current(t) ?? { t: -1e9, state: "waiting" };
    if (e.state === "decide" || e.hold) {
      const de = e.hold ?? e;
      const pose = decidePose(de, e.hold ? Math.max(t, de.t + 3 * (de.times?.scale ?? dScale)) : t, {}, depth);
      overlay(pose, t);
      return { pose, pos: place.post.clone(), yaw: place.deskYaw, phase: null, plant: true };
    }
    const yawT = yawOf(e);
    const target = live(e.state, t, {}, yawT, e.t);
    if (e.t === -1e9) {
      overlay(target, t);
      return { pose: target, pos: place.post.clone(), yaw: yawT, phase: null, plant: true };
    }
    const from = snapshot(e, depth);
    const u = smooth((t - e.t) / BLEND);
    const pose = u >= 1 ? target : mixPose(from.pose, target, u, {});
    overlay(pose, t);
    // facing: a turn on the spot with small steps
    const dlt = turnDelta(from.yaw, yawT), T = turnDur(dlt);
    let yaw = yawT, steps = null;
    if (T > 0 && t - e.t < T) {
      const v = (t - e.t) / T;
      yaw = from.yaw + dlt * inOut3(v);
      const n = Math.max(2, Math.round(Math.abs(dlt) / 0.9));
      steps = stepPose({ ...ZERO }, v * n * Math.PI, 0.4 * Math.sin(Math.PI * v) ** 0.5, 0.75);
    }
    return { pose, pos: place.post.clone(), yaw, phase: null, plant: true, steps };
  }
  // gestures: additive, eased in and out
  function overlay(pose, t) {
    const b = beats.current(t);
    if (!b || b.kind !== "gesture" || t > b.end || !spec.gesture) return;
    const dur = b.end - b.t, u = (t - b.t) / dur;
    const g = spec.gesture(u, pose);
    // the arms a gesture moves first return to the relaxed pose (and leave the desk), so the gesture
    // reads the same from any state instead of stacking on the speaking pose's raised hands
    const w = pulse(t, b.t, b.end, Math.min(0.5, dur * 0.25)), rest = looks.waiting;
    const sides = new Set();
    for (const k in g) {
      if (!/^(sh[LR][xz]|el[LR]|tw[LR]|wf[LR]|fg[LR])$/.test(k)) continue;
      sides.add(k[2]);
      pose[k] = lerp(pose[k], rest[k], w);
    }
    for (const s of sides) pose["ik" + s] = lerp(pose["ik" + s], 0, w);
    addPose(pose, g, 1);
  }
  // the pose just before an event, computed once
  function snapshot(e, depth) {
    if (!e.snap) {
      const prev = depth > 40 ? null : evaluate(e.t - 1e-4, depth + 1);
      e.snap = prev ? { pose: { ...prev.pose }, yaw: prev.yaw } : { pose: live("waiting", e.t, {}, place.deskYaw), yaw: place.deskYaw };
    }
    return e.snap;
  }
  const invalidate = (t) => {
    for (const e of states.ev) if (e.t >= t) delete e.snap;
    for (const e of trips.ev) if (e.t >= t) delete e.snap;
  };
  function phaseOf(p, t) {
    if (t < p.T1) return "turn";
    if (t < p.T2) return "to-urn";
    if (t < p.T3) return "drop";
    if (t < p.T5) return "back";
    return "settle";
  }

  // ---- IK
  const v1 = new THREE.Vector3(), v2 = new THREE.Vector3(), m1 = new THREE.Matrix4(), q1 = new THREE.Quaternion();
  /** Two bones a, b from a joint to a target direction (joint frame, bones along -y): [pitch, side, bend]. */
  function twoBone(T, a, b, bendSign) {
    const D = Math.min(T.length(), (a + b) * 0.9995);
    const ux = T.x / (T.length() || 1), uy = T.y / (T.length() || 1), uz = T.z / (T.length() || 1);
    const side = Math.asin(Math.max(-1, Math.min(1, ux)));
    const pitch = Math.atan2(-uz, -uy);
    const cosK = (a * a + b * b - D * D) / (2 * a * b);
    const k = Math.PI - Math.acos(Math.max(-1, Math.min(1, cosK)));
    const alpha = Math.atan2(b * Math.sin(k), a + b * Math.cos(k));
    return [pitch - bendSign * alpha, side, bendSign * k];
  }
  // standing: the feet stay where they stand; the pelvis carries lift, roll and shift
  function plantLegs(P) {
    if (!sk.legs.L) return;
    for (const [k, s] of [["L", 1], ["R", -1]]) {
      const stance = (d.stance ?? 1.08) * d.hipW, zf = (d.stagger ?? 0.03) * s;
      // the hip in root space, then the foot target in the pelvis frame
      const c = Math.cos(P.roll), sn = Math.sin(P.roll);
      const hx = P.shift + c * s * d.hipW, hy = d.hipY + P.lift + sn * s * d.hipW;
      const dx = s * stance - hx, dy = ankleH - hy, dz = zf;
      v1.set(c * dx + sn * dy, -sn * dx + c * dy, dz);
      const [pitch, side, bend] = twoBone(v1, d.thigh, d.shin, 1);
      P["th" + k] = pitch;
      P["kn" + k] = bend;
      P["an" + k] = -(pitch + bend);
      P["hz" + k] = side;
      P["az" + k] = -(side + P.roll);
    }
  }
  // at the ballot box: the right hand takes the token to its place over the slot (place.slot, world),
  // the wrist short of it by the grip (the palm's length along the arm) and the token's lift
  const v3 = new THREE.Vector3();
  function reachSlot(P) {
    const w = P.reachR;
    if (w <= 0.001 || !place.slot) return;
    const A = sk.arms.R;
    sk.root.updateMatrixWorld(true);
    m1.copy(sk.spine.matrixWorld).invert();
    const tgt = v1.copy(place.slot);
    tgt.y -= place.lift ?? 0;
    A.shoulder.getWorldPosition(v3);
    v3.subVectors(tgt, v3).normalize().multiplyScalar((d.palm ?? 0.09) * 1.05 + (place.gripIn ?? 0));
    tgt.sub(v3).applyMatrix4(m1).sub(A.shoulder.position);
    const [pitch, side, bend] = twoBone(tgt, d.upper, d.fore, -1);
    P.shRx = lerp(P.shRx, pitch, w);
    P.shRz = lerp(P.shRz, side, w);
    P.elR = lerp(P.elR, bend, w);
    P.wfR = lerp(P.wfR, 0, w);
  }
  const DESK = { L: new THREE.Vector3(0.17, DESK_TOP + 0.075, DESK_EDGE + 0.1), R: new THREE.Vector3(-0.15, DESK_TOP + 0.075, DESK_EDGE + 0.12) };
  // at the desk: the wrists go to the desk top (in root space, the robot facing the desk)
  function reachDesk(P, k) {
    const w = P["ik" + k];
    if (w <= 0.001) return;
    const A = sk.arms[k];
    sk.root.updateMatrixWorld(true);
    // the target, from root space into the spine's frame, relative to the shoulder joint
    const tgt = v1.copy(DESK[k]);
    if (spec.deskReach) tgt.add(spec.deskReach[k] ?? new THREE.Vector3());
    tgt.applyMatrix4(sk.root.matrixWorld);
    m1.copy(sk.spine.matrixWorld).invert();
    tgt.applyMatrix4(m1).sub(A.shoulder.position);
    const [pitch, side, bend] = twoBone(tgt, d.upper, d.fore, -1);
    const key = k === "L" ? ["shLx", "shLz", "elL"] : ["shRx", "shRz", "elR"];
    P[key[0]] = lerp(P[key[0]], pitch, w);
    P[key[1]] = lerp(P[key[1]], side, w);
    P[key[2]] = lerp(P[key[2]], bend, w);
  }

  // ---- walk-interact: react(kind) -------------------------------------------------------------
  // The Walk (spec §7.7 «Прогулка», owner 2026-10-28): the Host clicks a Judge and the Judge answers
  // without words: its head and chest turn toward the Host, it nods ("nod") or makes a small gesture of
  // its own ("gesture": the character's gesture at REACT.gestureK), and its face light warms; "speak"
  // holds the turn while the robot says its own published reason, the face light on level(t). An
  // overlay like a gesture: added to whatever pose the state machine gives (never a state, so the
  // show's own states and turns go on under it), eased in and out (smoother ramps of 0.8 s at tempo 1,
  // so no jerk; test/walk-interact-check.mjs measures the head's angular speed), and a
  // trip (the vote) owns the body and hides it.
  const REACT = { ramp: 0.8, nodS: 2.8, gestureK: 0.55, chest: 0.35, head: 0.8, warm: 0.32 };
  const reacts = new Track(); // { kind, end, r (ramp), toward: {x, y, z} | null, level, gestureEnd }
  const smoother01 = (u) => ((u = clamp01(u)), u * u * u * (u * (u * 6 - 15) + 10));
  const weightOf = (e, t) => smoother01((t - e.t) / e.r) * (1 - smoother01((t - (e.end - e.r)) / e.r));
  function reactOn(P, t, yaw, pos) {
    // the reactions still on at t, the newest first. A new one may start while the last eases out: the
    // turn's weight is 1 - Π(1 - w) (smooth, where a max would kink as the two cross) and its aim the
    // weighted mean of theirs, so the head never snaps between two clicks
    const on = [];
    for (let k = reacts.index(t); k >= 0 && on.length < 3; k--) if (t < reacts.ev[k].end) on.push(reacts.ev[k]);
    if (!on.length) return;
    const ws = on.map((e) => weightOf(e, t));
    const turn = 1 - ws.reduce((a, w) => a * (1 - w), 1);
    let sw = 0, sd = 0, st = 0;
    on.forEach((e, i) => {
      if (!e.toward || ws[i] <= 0) return;
      // the turn: the chest takes a share, the head the rest, both clamped (a look over the shoulder
      // when the Host is behind); the head tips toward the Host's height
      const dx = e.toward.x - pos.x, dz = e.toward.z - pos.z;
      const eye = (spec.height ?? 1.8) * 0.92;
      sw += ws[i];
      sd += ws[i] * wrap(Math.atan2(dx, dz) - yaw);
      st += ws[i] * Math.max(-0.2, Math.min(0.32, Math.atan2(eye - e.toward.y, Math.hypot(dx, dz) || 1)));
    });
    if (sw > 0 && turn > 0) {
      const dlt = sd / sw;
      const chest = Math.max(-REACT.chest, Math.min(REACT.chest, dlt * 0.35));
      const head = Math.max(-REACT.head, Math.min(REACT.head, dlt - chest));
      // the look at the Host takes the place of the idle glance (added, the two could double the speed)
      P.twist = lerp(P.twist, 0, turn) + chest * turn;
      P.hdY = lerp(P.hdY, 0, turn) + head * turn;
      P.hdP += 0.8 * (st / sw) * turn;
    }
    const face0 = P.face;
    let lit = face0;
    on.forEach((e, i) => {
      const w = ws[i];
      if (w <= 0) return;
      if (e.kind === "nod" || e.kind === "speak") {
        // one nod, after the turn has settled
        const n = (t - e.t - e.r) / 0.7;
        if (n > 0 && n < 1) P.hdP += 0.14 * Math.sin(Math.PI * n) ** 2;
      } else if (e.kind === "gesture" && spec.gesture) {
        // the character's own gesture, small, inside the reaction (the arms first ease to rest, as overlay)
        const g0 = e.t + e.r * 0.5, g1 = e.gestureEnd;
        if (t > g0 && t < g1) {
          const gw = smoother01((t - g0) / 0.4) * (1 - smoother01((t - (g1 - 0.4)) / 0.4));
          const g = spec.gesture((t - g0) / (g1 - g0), P), rest = looks.waiting;
          const sides = new Set();
          for (const k in g) {
            if (!/^(sh[LR][xz]|el[LR]|tw[LR]|wf[LR]|fg[LR])$/.test(k)) continue;
            sides.add(k[2]);
            P[k] = lerp(P[k], rest[k], gw);
          }
          for (const s of sides) P["ik" + s] = lerp(P["ik" + s], 0, gw);
          addPose(P, g, REACT.gestureK * gw);
        }
      }
      // the face light warms; speaking, it follows the voice as a speaking robot's does
      lit = Math.max(lit, e.kind === "speak" && e.level ? looks.speaking.face + 0.75 * clamp01(e.level(t)) : face0 + REACT.warm);
    });
    P.face = lerp(face0, lit, turn);
  }
  /**
   * react(kind, t, { toward, dur, level }): "nod" | "gesture" | "speak" (dur: the line's length + tail;
   * level(t) → 0..1 the voice). toward: a world point (the Host's head) or null. Returns
   * { t0, end, release(t), cancel() } or null when the robot cannot react (offline, on its vote walk).
   * release(t) eases it out from t; cancel() removes it (a jump of the show clock back before it).
   */
  function react(kind, t = lastT, { toward = null, dur = null, level = null } = {}) {
    if (!["nod", "gesture", "speak"].includes(kind)) throw new Error(`unknown reaction ${kind}; reactions: nod, gesture, speak`);
    const st = robot.stateAt(t);
    if (st === "offline" || st === "walking") return null;
    const gDur = (spec.gestureDur ?? 2) / Math.sqrt(tempo);
    const len = dur ?? (kind === "gesture" ? gDur + 2 * REACT.ramp / Math.sqrt(tempo) : REACT.nodS / Math.sqrt(tempo));
    const end = t + Math.max(len, 1.2);
    const e = reacts.add(t, { kind, end, r: Math.min(REACT.ramp / Math.sqrt(tempo), (end - t) / 3), toward: toward ? { x: toward.x, y: toward.y, z: toward.z } : null, level, gestureEnd: t + (REACT.ramp / Math.sqrt(tempo)) * 0.5 + gDur });
    return {
      t0: t,
      get end() {
        return e.end;
      },
      release(at = lastT) {
        if (at < e.end - e.r) e.end = Math.max(at, e.t + e.r) + e.r; // the ramp out from at (after the ramp in)
      },
      cancel() {
        const i = reacts.ev.indexOf(e);
        if (i >= 0) reacts.ev.splice(i, 1);
      },
    };
  }
  // ---- end walk-interact

  // ---- apply a pose to the joints
  function apply(r, t) {
    const P = r.pose;
    if (!r.phase) reactOn(P, t, r.yaw, r.pos); // walk-interact
    if (r.plant) {
      plantLegs(P);
      if (r.steps) for (const k of ["thL", "knL", "anL", "thR", "knR", "anR"]) P[k] += r.steps[k];
      if (r.steps) P.lift += r.steps.lift;
    } else P.hzL = P.hzR = 0, P.azL = -P.roll, P.azR = -P.roll;
    sk.root.position.set(r.pos.x, 0, r.pos.z);
    sk.root.rotation.set(0, r.yaw, 0);
    sk.pelvis.position.set(P.shift, d.hipY + P.lift, 0);
    sk.pelvis.rotation.set(0, 0, P.roll);
    sk.spine.position.y = 0.003 * P.breath;
    sk.spine.rotation.set(P.lean, P.twist, -P.roll * 0.7, "YXZ");
    if (sk.legs.L) {
      sk.legs.L.hip.rotation.set(P.thL, 0, P.hzL ?? 0);
      sk.legs.L.knee.rotation.set(P.knL, 0, 0);
      sk.legs.L.ankle.rotation.set(P.anL, 0, P.azL ?? -P.roll);
      sk.legs.R.hip.rotation.set(P.thR, 0, P.hzR ?? 0);
      sk.legs.R.knee.rotation.set(P.knR, 0, 0);
      sk.legs.R.ankle.rotation.set(P.anR, 0, P.azR ?? -P.roll);
    }
    reachDesk(P, "L");
    reachDesk(P, "R");
    reachSlot(P);
    const L = sk.arms.L, R = sk.arms.R;
    L.shoulder.rotation.set(P.shLx, 0, P.shLz);
    L.elbow.rotation.set(P.elL, P.twL, 0);
    L.hand.rotation.set(0, 0, -P.wfL);
    L.fingers.rotation.set(0, 0, -1.25 * P.fgL + 0.3);
    R.shoulder.rotation.set(P.shRx, 0, P.shRz);
    R.elbow.rotation.set(P.elR, -P.twR, 0);
    R.hand.rotation.set(0, 0, P.wfR);
    R.fingers.rotation.set(0, 0, 1.25 * P.fgR - 0.3);
    sk.neck.rotation.set(P.hdP * 0.35, P.hdY * 0.4, P.hdR * 0.4, "YXZ");
    sk.head.rotation.set(P.hdP * 0.65, P.hdY * 0.6, P.hdR * 0.6, "YXZ");
    spec.face?.userData.setLight?.(P.face, t);
    spec.after?.(P, t, r);
  }

  // walk-core: an outside driver moves the robot (ui/walk.js, the Walk). steer(fn): fn(t) -> null (the
  // robot as the show has it) or { pos, yaw, phi, amp, lean }: where it stands and faces, its step
  // phase (one step = PI) and stride (0 standing .. 1 full), a forward lean (rad). The show's pose stays
  // (speaking, its face light, gestures); the walk's arms and sway blend in by the stride. A robot
  // without legs (the Host rolls on its base) only sways a quarter as much and does not bob.
  let steerFn = null;
  const STEER_ARMS = ["shLx", "shLz", "elL", "twL", "fgL", "shRx", "shRz", "elR", "twR", "fgR"];
  function steered(r, t) {
    const s = steerFn?.(t);
    if (!s) return r;
    const P = r.pose, amp = clamp01(s.amp ?? 0), w = smooth(amp / 0.35);
    if (amp > 1e-3) {
      const st = stepPose({ ...ZERO }, s.phi ?? 0, amp);
      for (const k of STEER_ARMS) P[k] = lerp(P[k], st[k], w);
      P.ikL *= 1 - w;
      P.ikR *= 1 - w;
      const g = d.legs === false ? 0.25 : 1;
      P.lift += st.lift * (d.legs === false ? 0 : 1);
      P.roll += st.roll * g;
      P.twist += st.twist * g;
      P.lean += WALK.lean * w;
    }
    P.lean += s.lean ?? 0;
    return { ...r, pose: P, pos: s.pos.clone(), yaw: s.yaw, steps: null };
  }

  let lastT = 0, lastEval = null;
  const robot = {
    id,
    info: { id, ...info, height: spec.height },
    object3d: sk.root,
    anchors,
    /** Where the robot stands and where it turns: set by the stage. */
    place(p) {
      place = { ...place, ...p };
      invalidate(-1e9);
    },
    setState(state, t = lastT, opts = {}) {
      if (!STATES.includes(state)) throw new Error(`unknown state ${state}`);
      invalidate(t);
      const cur = states.current(t);
      const e = states.add(t, { state, facing: opts.facing });
      // a Judge that has decided keeps its token at the chest until it walks
      const held = cur && (cur.state === "decide" ? cur : cur.hold);
      if (held && (state === "waiting" || state === "working")) e.hold = held;
    },
    setVoice(fn) {
      voice = fn || (() => 0);
    },
    onTrip(fn) {
      onTrip = fn;
    },
    onBeat(fn) {
      onBeat = fn;
    },
    /** walk-core: an outside driver (fn(t) -> null | { pos, yaw, phi, amp, lean }); null: none. */
    steer(fn) {
      steerFn = fn || null;
    },
    /**
     * A beat at t: "decide" (at the desk: stop reading, straighten, take the sealed token; returns
     * { t0, dimAt, tokenAt, end }) or "gesture" (a speaking gesture of its own; returns { t0, end }).
     */
    beat(kind, t = lastT) {
      invalidate(t);
      let times;
      if (kind === "decide") {
        times = decideTimes(t);
        states.add(t, { state: "decide", times });
      } else if (kind === "gesture") {
        const dur = (spec.gestureDur ?? 2) / Math.sqrt(tempo);
        times = { t0: t, end: t + dur };
        beats.add(t, { kind, end: times.end });
      } else throw new Error(`unknown beat ${kind}; beats: decide, gesture`);
      onBeat?.(id, kind, times);
      return times;
    },
    /**
     * The camera lands on the robot at t (world/stage.js, on every cut or move to its shot; `from`: the
     * robot the shot before showed, if any). A speaking robot answers with one gesture of its own;
     * returns its { t0, end }, or null when it holds still.
     */
    land(t = lastT, { from = null } = {}) {
      const e = states.current(t);
      if (!spec.gesture || robot.stateAt(t) !== "speaking" || !e || t - e.t < LAND.settle) return null;
      const b = beats.current(t);
      const quiet = Math.min(t - e.t, b ? t - (b.end ?? b.t) : Infinity);
      if (quiet < (from === id ? LAND.sameGap : LAND.gap)) return null;
      return robot.beat("gesture", t);
    },
    /** walk-interact: a reaction without words to the Host (the Walk): react(kind, t, { toward, dur, level }) above. */
    react,
    /** The ballot's pace from t: k > 1 decides and walks k times faster (a brisk wave), 1 its own pace. */
    setPace(k, t = lastT) {
      invalidate(t);
      paces.add(t, { k });
    },
    /** The vote on foot from time t. Returns { t0, arriveAt, dropAt, leaveAt, backAt, end }. */
    vote(t = lastT) {
      invalidate(t);
      const from = evaluate(t - 1e-4);
      const plan = planTrip(t, { yaw: from.yaw });
      trips.add(t, { plan });
      states.add(plan.end, { state: "waiting", facing: "room" });
      // after a decide beat the token is already in the hand: the ballot shows it from then
      const cur = states.current(t - 1e-4);
      const de = cur && (cur.state === "decide" ? cur : cur.hold);
      onTrip?.(id, de ? { ...plan, t0: de.times.tokenAt - 0.25 } : plan);
      return tripTimes(plan);
    },
    /** The times a decide beat from t would have, without making it (ui/show.js staggers a brisk wave). */
    previewDecide(t = lastT) {
      return decideTimes(t);
    },
    /** The times a vote from t would have, without making it (the stage queues robots at the box). */
    previewVote(t = lastT) {
      return tripTimes(planTrip(t, { yaw: evaluate(t - 1e-4).yaw }));
    },
    stateAt(t) {
      const trip = trips.current(t);
      if (trip && t < trip.plan.end) return "walking";
      const e = states.current(t) ?? { state: "waiting" };
      return e.state === "decide" || e.hold ? "deciding" : e.state;
    },
    phaseAt(t) {
      const trip = trips.current(t);
      return trip && t < trip.plan.end ? phaseOf(trip.plan, t) : null;
    },
    get state() {
      return robot.stateAt(lastT);
    },
    /** The face light level last applied (0..~1.3), for the stage's speaker light. */
    get faceLevel() {
      return lastEval?.pose.face ?? 0;
    },
    update(t) {
      lastT = t;
      lastEval = steerFn ? steered(evaluate(t), t) : evaluate(t); // walk-core
      apply(lastEval, t);
    },
  };
  return robot;
}

export { BALLOT };
