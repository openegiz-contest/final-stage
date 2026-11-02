// The director camera. A shot is a function of time (so it can follow a walking robot); the show
// calls cut(shot, t) or move(shot, t, dur), and the camera at any t is a pure function of those
// calls. Moves ease in and out from whatever the camera shows at that moment; a held shot pushes in
// slowly (a dolly, not a float). Close shots carry a focus distance for the depth of field.
import * as THREE from "three";
import { Track, inOut3, clamp01, smooth } from "./timeline.js";
import { DESKS, BALLOT, HOST_POST, SLOT_Y, URN_ROW, ROOM_FOCUS, urnSpots } from "./layout.js";

const V = (x, y, z) => new THREE.Vector3(x, y, z);
const UP = V(0, 1, 0);
const TALL = 1.95; // Opus, the tallest Judge (info.height): the over-the-shoulder camera rises for the shorter ones
const OTS_LIFT = -0.8;
const OTS_SHIFT = -0.45;

export const WIDE = { pos: V(0, 3.6, 8.3), target: V(0, 1.25, -3.9), fov: 38 };
// the room from its right-hand corner: the dispatch board on the left wall, the consoles and the glass
export const BOARD_WIDE = { pos: V(-2.6, 2.3, 4.4), target: V(-8.0, 1.45, -1.9), fov: 54 };
// Exposure per shot (a camera operator's iris) and white balance. Grade only (post.js multiplies the
// HDR frame by exposure × white before the tone curve): the same cost in lite.
//   - The wides open up so the room reads on a phone (mean luma ≈ 50–55 at 640×360).
//   - Close shots are exposed for their subject, so a body reads the same in every shot. Cream is
//     metered: in each close kind its lit ceramic sits at the cards' level (median ≈ 125–145 sRGB
//     over the warm, lit pixels of the frame), so the kinds differ only where the light on the
//     subject differs (the pendant over the slot is brighter than the room).
//   - Black glass mirrors the dark room: at the cream's exposure its shots sit ≈ 10 luma lower, so
//     the iris opens for a black-glass subject (GLASS_OPEN), never for cream.
//   - White balance: at its desk a Judge is lit by its console (6500 K) under a warm downlight;
//     the cards, walks and slot are lit by the room's tungsten. A cream Judge in a desk shot is
//     balanced warm (WHITE.desk) so the ceramic keeps the cards' hue instead of reading white;
//     Opus's white face plate sits nearest its console, so its gains also stop it down (× 0.75).
export const EXPOSURE = {
  wide: 2.3, board: 3.2, tally: 2.4, host: 3.8, box: 2.2, tube: 1.9, dark: 3.2, front: 1.6, card: 1.4,
  medium: 1.5, close: 1.4, ots: 1.85, screen: 1.5, decide: 1.2, slot: 0.8, walk: 1.4, token: 1.0,
};
// v4.1 glass carries its own softbox light (robots/materials.js); the v4 lift doubled it. A speaking
// GPT Judge still metered 25–35 % darker than a Claude one (red team, mean luma of the speaking shots):
// the iris opens for it in the speaker's shots, so the two families read as lit alike (within ~10 %)
// sol's rounded glass is a solid black with a few strips, so the iris opens wide for it; astra's planar
// facets mirror the room as grey panels, which an iris as wide turns to chrome (v4.1's rejected look),
// so it opens less (the frame's mean luma then sits ~10 % under the Claude shots', its body stays black)
export const GLASS_OPEN = { card: 1, decide: 1, walk: 1, slot: 1, medium: 1.9, close: 1.9 };
const GLASS_JUDGE = { "gpt-6-astra": { medium: 0.8, close: 0.8 } };
// linear RGB gains (× exposure), for cream subjects in desk-lit shots
export const WHITE = { desk: { "opus-5.5": [1.3, 1.0, 0.62].map((g) => g * 0.75), "sonnet-5.5": [1.32, 1.0, 0.64] }, neutral: [1, 1, 1] };
const DESK_LIT = new Set(["decide", "ots"]);
const DIM_RIDE = 0.68; // a decide shot's exposure while the console is still at full (× its own)
const VENDOR = {
  "opus-5.5": "anthropic", "sonnet-5.5": "anthropic", "fable-5.1": "anthropic", "gpt-6.1-sol": "openai", "gpt-6-astra": "openai",
}; // robots/roster.js vendors (the camera does not import the roster)

/** A shot's exposure and white balance: { exposure, white: [r, g, b] }. */
export function gradeOf(shot) {
  const v = VENDOR[shot.id];
  let exposure = shot.exposure ?? EXPOSURE[shot.kind] ?? EXPOSURE.close;
  if (v === "openai" && shot.exposure === undefined) exposure *= (GLASS_OPEN[shot.kind] ?? 1) * (GLASS_JUDGE[shot.id]?.[shot.kind] ?? 1);
  const white = shot.white ?? ((DESK_LIT.has(shot.kind) && WHITE.desk[shot.id]) || WHITE.neutral);
  return { exposure, white };
}

// The reveal card's composition (stage.js cardOf: distance, span of the robot's height in frame, the
// token's depth and frame position) and the Judges framed from their own angle. astra's front is a
// thin bar over a dark faceted chin: square on at eye level its ridge reads as a spine and the
// figure as its back (red team v4); from under the chest and 22° round away from the token's side
// (the other way Opus, its neighbour, comes into frame) the visor sits over the chin and neck and
// the chest facets catch the room.
const CARD = { dist: 2.5, span: 0.56, depth: 1.3, aim: 0.36, lift: 0.06, ndc: [-0.6, -0.2] };
export const CARD_ANGLE = { "gpt-6-astra": { orbit: -22, eye: 0.74 } };
// the show's header box (ui/cards.js, top left) as fractions of the frame, with a margin: up to three lines
export const HUD_RECT = [0, 0, 0.42, 0.19];
{
  // dev only: ?cam=x,y,z&look=x,y,z&fov=n overrides the wide shot while framing it;
  const q = new URLSearchParams(typeof location !== "undefined" ? location.search : ""), v = (k) => q.get(k)?.split(",").map(Number);
  if (v("cam")) WIDE.pos.set(...v("cam"));
  if (v("look")) WIDE.target.set(...v("look"));
  if (q.get("fov")) WIDE.fov = Number(q.get("fov"));
  // ?cardangle=id,orbit,eye overrides a Judge's card angle (degrees round toward the token's side, eye height / robot height)
  if (q.get("cardangle")) { const [id, orbit, eye] = q.get("cardangle").split(","); CARD_ANGLE[id] = { orbit: Number(orbit), eye: Number(eye) }; }
}

/**
 * world: { robotAt(id) -> { pos, yaw, head: Vector3 }, monitor(id) -> { center, normal, width, height },
 *          urn(team) -> Vector3 | null, tripOf(id, t) -> { from, to } | null }
 */
export function createCamera(camera, world) {
  const track = new Track(); // { shot, kind: "cut" | "move", dur }

  // a frame: pos, target, fov, focus (m), aperture (0..1)
  const frame = (pos, target, fov, focus = 0, aperture = 0) => ({ pos, target, fov, focus, aperture });
  const push = (f, t, t0, rate = 0.035, max = 0.45) => {
    const k = Math.min(max, Math.max(0, t - t0) * rate);
    const dir = f.target.clone().sub(f.pos).normalize();
    f.pos.addScaledVector(dir, k);
    return f;
  };
  const deskFrame = (id) => {
    const D = DESKS[id];
    const inward = V(-Math.sin(D.angle), 0, Math.cos(D.angle)); // toward the room
    const side = V(inward.z, 0, -inward.x); // the robot's right when it faces the desk... (screen right from the room)
    return { D, inward, side };
  };

  // a point in a desk's own frame (the Judge stands at +Z, the monitors face +Z) in world space
  const deskPoint = (id, x, y, z) => {
    const D = DESKS[id], c = Math.cos(D.yaw), sn = Math.sin(D.yaw);
    return V(D.pos.x + x * c + z * sn, y, D.pos.z - x * sn + z * c);
  };
  // the direction a Judge faces when it turns to the room, and the side axis seen from the room
  const roomAxes = (id) => {
    const P = DESKS[id].post, f = ROOM_FOCUS.clone().sub(P).setY(0).normalize();
    return { P, f, sd: V(f.z, 0, -f.x) };
  };
  const rowZ = BALLOT.z + URN_ROW;

  // The reveal's card frame: stage.card's (world.card), or for a Judge in CARD_ANGLE the same
  // composition from its own angle, with the token's spot derived from that frame the same way.
  const cards = new Map();
  function cardFrame(id, side) {
    const base = world.card(id, side), a = CARD_ANGLE[id];
    if (!a) return base;
    const key = `${id}:${base.side}`;
    if (cards.has(key)) return cards.get(key);
    const k = base.side, h = world.robotAt(id, 0).height, P = DESKS[id].post;
    const f = ROOM_FOCUS.clone().sub(P).setY(0).normalize().applyAxisAngle(UP, THREE.MathUtils.degToRad(a.orbit ?? 0) * k);
    const sd = V(f.z, 0, -f.x);
    const span = CARD.span * h, fov = THREE.MathUtils.radToDeg(2 * Math.atan(span / 2 / CARD.dist));
    const pos = P.clone().addScaledVector(f, CARD.dist).addScaledVector(sd, -k * 0.12).setY((a.eye ?? 0.93) * h - CARD.lift);
    const target = P.clone().addScaledVector(sd, -k * CARD.aim * h / 1.8).setY(0.93 * h - 0.17 * span);
    const fwd = target.clone().sub(pos).normalize();
    const right = V(0, 0, 0).crossVectors(fwd, UP).normalize();
    const up = V(0, 0, 0).crossVectors(right, fwd);
    const tv = Math.tan(THREE.MathUtils.degToRad(fov) / 2), th = tv * camera.aspect;
    const dir = fwd.clone().addScaledVector(right, k * CARD.ndc[0] * th).addScaledVector(up, CARD.ndc[1] * tv);
    const c = { pos, target, fov, spot: pos.clone().addScaledVector(dir, CARD.depth), eye: pos.clone(), side: k, focus: CARD.depth };
    cards.set(key, c);
    return c;
  }

  const SHOTS = {
    wide: (s, t, t0) => push(frame(WIDE.pos.clone(), WIDE.target.clone(), WIDE.fov), t, t0, 0.04, 0.5),
    board: (s, t, t0) => push(frame(BOARD_WIDE.pos.clone(), BOARD_WIDE.target.clone(), BOARD_WIDE.fov), t, t0, 0.05, 0.4),
    card: (s, t, t0) => {
      // the reveal: the Judge who cast the token from the front, its open token in the foreground
      // (card(): the token's spot is derived from this frame)
      const c = cardFrame(s.id, s.side);
      // `portrait` (a card on screen beside the Judge, no token: the verdict's reasons): the lens on the
      // Judge and open, so the consoles' text behind the 2D card melts into the dark instead of
      // showing through it (a monitor's «3:05» beside a reason's name)
      if (s.portrait) return push(frame(c.pos.clone(), c.target.clone(), c.fov, c.pos.distanceTo(DESKS[s.id].post) - 0.1, 0.7), t, t0, 0.012, 0.04);
      return push(frame(c.pos.clone(), c.target.clone(), c.fov, c.focus, 0.18), t, t0, 0.012, 0.04);
    },
    medium: (s, t, t0) => {
      // a speaker from the room side, framed on its own height (info.height): the head with room above
      // it, the eyes near the upper third, the hands hanging in frame. The lens widens for a tall
      // Judge so the camera stays at the same distance and the shot reads as one lens language.
      const { P, f, sd } = roomAxes(s.id);
      const r = world.robotAt(s.id, t);
      const k = s.side ?? 1, h = r.height;
      const span = s.span ?? 0.8 * h; // metres of the robot in frame, top to bottom
      const dist = s.dist ?? 2.0;
      const fov = s.fov ?? THREE.MathUtils.radToDeg(2 * Math.atan(span / 2 / dist));
      const cy = 0.93 * h + 0.3 * span - span / 2; // eyes (0.93 h) a third from the top of the frame
      const pos = P.clone().addScaledVector(f, dist).addScaledVector(sd, 0.55 * k).setY(cy + (s.low ? -0.08 : 0.08) * h);
      const target = P.clone().addScaledVector(sd, 0.12 * k).setY(cy);
      return push(frame(pos, target, fov, pos.distanceTo(target), 0.5), t, t0, 0.02, 0.18);
    },
    close: (s, t, t0) => {
      // the reveal: a Judge at its post facing the room, head and shoulders
      const { P, f, sd } = roomAxes(s.id);
      const r = world.robotAt(s.id, t);
      const k = s.side ?? 1;
      const pos = P.clone().addScaledVector(f, s.dist ?? 1.6).addScaledVector(sd, 0.5 * k).setY(r.top - (s.low ? 0.42 : 0.12));
      const target = P.clone().addScaledVector(sd, 0.06 * k).setY(r.top - 0.36);
      return push(frame(pos, target, s.fov ?? 27, pos.distanceTo(target), 0.5), t, t0, 0.025, 0.15);
    },
    ots: (s, t, t0) => {
      // over the shoulder onto the main monitor, from above and beside the head, so the head is a
      // dark corner of the frame and the text (path line included) stays clear of it
      const { side } = deskFrame(s.id);
      const m = world.monitor(s.id);
      const r = world.robotAt(s.id, t);
      const k = s.side ?? -1;
      const nrm = m.normal.clone().setY(0).normalize();
      const pos = m.center.clone().addScaledVector(nrm, 1.9).addScaledVector(side, 2.0 * k).setY(r.top + 0.3 + OTS_LIFT * (TALL - r.height));
      const target = m.center.clone().addScaledVector(side, (0.1 + OTS_SHIFT * (TALL - r.height)) * k).add(V(0, -0.1, 0));
      return push(frame(pos, target, 21, pos.distanceTo(m.center), 0.35), t, t0, 0.025, 0.16);
    },
    screen: (s, t, t0) => {
      // an insert of a Judge's main monitor, square on, between the Judge's back and the screen
      const m = world.monitor(s.id);
      const nrm = m.normal.clone();
      const { side } = deskFrame(s.id);
      const pos = m.center.clone().addScaledVector(nrm, s.dist ?? 0.66).addScaledVector(side, 0.06);
      const target = m.center.clone().addScaledVector(side, s.dx ?? 0).add(V(0, s.dy ?? 0, 0));
      return push(frame(pos, target, s.fov ?? 44, 0.66, 0), t, t0, 0.02, 0.08);
    },
    decide: (s, t, t0) => {
      // a Judge at its desk seen from its own monitor, the lens at its eye level: reading, it looks
      // down past the lens; deciding, the screen dims (its light leaves the face) and the head comes
      // up level with the lens; then the hand takes the token from the desk edge (in the frame's
      // lower corner). Framed on the robot's height, not on its moving head.
      const h = world.robotAt(s.id, t0).height;
      const k = s.side ?? -1;
      const eyeY = 0.93 * h;
      const pos = deskPoint(s.id, 0.3 * k, eyeY - 0.04, -0.12);
      const target = deskPoint(s.id, -0.06 * k, eyeY - 0.17, 0.78);
      return push(frame(pos, target, s.fov ?? 46, pos.distanceTo(target), 0.3), t, t0, 0.02, 0.06);
    },
    front: (s, t, t0) => {
      // an unavailable Judge's face: it stands at its desk with its back to the room, so the camera
      // stands between it and its monitors and sees it from the front: the head, its dark lens, the
      // other Judges behind
      const r = world.robotAt(s.id, t);
      const k = s.side ?? -1;
      // The camera hangs just over the desk's front edge (z 0.2; the Judge stands at 0.8), 0.3 m
      // aside and a little under the head, so the lens is seen within ~30° of its axis; from the
      // desk's end (x 0.75, z 0.45) it is ~65° off, a profile in which the lens sits on the edge.
      const pos = deskPoint(s.id, (s.x ?? 0.3) * k, r.head.y - (s.dy ?? 0.2), s.z ?? 0.2);
      const target = r.head.clone().add(V(0, s.ty ?? -0.18, 0));
      return push(frame(pos, target, s.fov ?? 38, pos.distanceTo(target), 0.35), t, t0, 0.02, 0.08);
    },
    dark: (s, t, t0) => {
      // an unavailable Judge: from behind and above, its dark screens, the slumped body, its token
      // untouched on the desk
      const k = s.side ?? 1;
      const pos = deskPoint(s.id, 0.95 * k, 1.95, 2.35);
      const target = deskPoint(s.id, 0.1 * k, 1.05, 0.35);
      return push(frame(pos, target, 36, pos.distanceTo(target), 0.3), t, t0, 0.03, 0.15);
    },
    walk: (s, t, t0) => {
      // the walker's front three-quarter: the camera stands beyond the box on the room side of the
      // path and turns with the walker; the box stays beside the walker, never in front of it
      const r = world.robotAt(s.id, t);
      const trip = world.tripOf(s.id, t);
      const dir = trip.to.clone().sub(trip.from).setY(0).normalize();
      const sd = V(dir.z, 0, -dir.x);
      if (sd.z < -1e-3 || (Math.abs(sd.z) < 1e-3 && (s.side ?? 1) < 0)) sd.negate();
      // (1.2 m past the drop spot, 2.2 m to the side: the walker 30–50° off its heading, the box
      // outside the frame until the cut to the slot)
      const pos = trip.to.clone().addScaledVector(dir, 1.2).addScaledVector(sd, 2.2).setY(1.55);
      const target = r.pos.clone().lerp(trip.to, 0.15).setY(Math.max(1.1, r.top - 0.6));
      return frame(pos, target, 27, pos.distanceTo(r.pos), 0.25);
    },
    slot: (s, t, t0) => {
      // an insert: the slot in the cap from above the room side, the walker's hand and token coming
      // in over the far edge, the token going in edge first (on the side away from the walker's
      // post, so its arm crosses the far half). Steep, so the floor behind the box is the
      // background and a Judge leaving the box (or the next one coming) stays out of frame.
      const slot = BALLOT.clone().setY(SLOT_Y);
      const px = s.id ? DESKS[s.id].post.x - BALLOT.x : 0;
      const k = Math.abs(px) > 0.3 ? -Math.sign(px) : (s.side ?? 1);
      const pos = slot.clone().add(V(0.18 * k, 0.8, 0.42));
      const target = slot.clone().add(V(0.02 * k, -0.02, -0.08));
      return frame(pos, target, 26, pos.distanceTo(slot), 0.45);
    },
    box: (s, t, t0) => {
      // the box from the room side, between it and the tube row: the Judges walking to it from their
      // consoles, tokens in hand
      const pos = BALLOT.clone().add(V(-0.25 * (s.side ?? 1), 1.42, 1.95));
      const target = BALLOT.clone().add(V(0.1 * (s.side ?? 1), 1.05, -0.9));
      return push(frame(pos, target, s.fov ?? 44, pos.distanceTo(BALLOT), 0.15), t, t0, 0.04, 0.2);
    },
    token: (s, t, t0) => {
      // an insert: the token over the box, opening to the room
      const h = world.hover;
      const pos = h.clone().add(V(-0.005, 0.025, 0.6));
      return push(frame(pos, h.clone().add(V(-0.015, -0.005, 0)), 27, 0.6, 0.6), t, t0, 0.02, 0.06);
    },
    tube: (s, t, t0) => {
      // a team's tube from the front and above: the plaque, the stack, the collar; `tight` for the
      // majority moment
      const u = world.urn(s.team) ?? BALLOT;
      const pos = s.tight ? u.clone().add(V(0.1, 0.98, 1.3)) : u.clone().add(V(0.22 * (s.side ?? 1), 1.3, 1.8));
      const target = u.clone().add(V(0, s.tight ? 0.52 : 0.6, 0));
      return push(frame(pos, target, s.tight ? 32 : 34, pos.distanceTo(target), 0.3), t, t0, 0.03, 0.12);
    },
    tally: (s, t, t0) => {
      // the whole row as a bar chart, from the room side and a little above
      // (high enough that the tubes stand below every Judge's feet in the frame)
      const pos = V(0.36, 2.3, rowZ + 3.6);
      const target = V(0.36, 0.6, rowZ);
      return push(frame(pos, target, 47, pos.distanceTo(target), 0), t, t0, 0.03, 0.2);
    },
    look: (s, t, t0) => {
      // a fixed frame the shot carries itself (pos and target as [x, y, z]; fov, focus, aperture,
      // the push rate and its limit): the program's views of the room and the dispatch board
      // (ui/program.js); exposure as any shot (s.exposure)
      const pos = V(...s.pos), target = V(...s.target);
      return push(frame(pos, target, s.fov ?? 35, s.focus ?? pos.distanceTo(target), s.aperture ?? 0), t, t0, s.rate ?? 0.02, s.max ?? 0.2);
    },
    host: (s, t, t0) => {
      // three-quarter front from the room's middle: behind the Host the side glass, no Judge
      const p = HOST_POST.pos;
      const pos = p.clone().add(V(1.95, 1.45, 0.5));
      return push(frame(pos, p.clone().add(V(0.2, 1.2, 0.05)), 34, 2.0, 0.45), t, t0, 0.03, 0.3);
    },
  };

  function evalShot(e, t) {
    const fn = SHOTS[e.shot.kind];
    if (!fn) throw new Error(`unknown shot ${e.shot.kind}`);
    const f = fn(e.shot, t, e.t);
    const g = gradeOf(e.shot);
    // the iris rides a console that dims in shot: closed a little while the screen still lights the
    // face (so cream is not burnt white), open again as the light leaves (the dim stays visible)
    const ride = e.shot.dimAt === undefined ? 1 : DIM_RIDE + (1 - DIM_RIDE) * smooth((t - e.shot.dimAt) / 0.35);
    f.exposure = g.exposure * ride;
    f.white = g.white;
    return f;
  }
  function evaluate(t, i = track.index(t)) {
    if (i < 0) return { ...SHOTS.wide({}, t, -1e9), exposure: EXPOSURE.wide, white: WHITE.neutral };
    const e = track.ev[i];
    const to = evalShot(e, t);
    if (e.kind !== "move" || t >= e.t + e.dur) return to;
    const from = evaluate(t, i - 1);
    const u = inOut3((t - e.t) / e.dur);
    const dist = from.pos.distanceTo(to.pos);
    const pos = from.pos.clone().lerp(to.pos, u).addScaledVector(UP, Math.sin(Math.PI * u) * Math.min(0.6, dist * 0.06));
    return {
      pos,
      target: from.target.clone().lerp(to.target, u),
      fov: from.fov + (to.fov - from.fov) * u,
      focus: from.focus + (to.focus - from.focus) * u,
      exposure: from.exposure + (to.exposure - from.exposure) * u,
      white: from.white.map((w, k) => w + (to.white[k] - w) * u),
      // the lens opens only once a move has landed on a close shot
      aperture: Math.min(from.aperture, to.aperture) * (1 - u) + to.aperture * clamp01((u - 0.6) / 0.4) * u,
    };
  }

  // ---- what a shot puts behind the show's header (the cards' box in the top-left corner): the
  // consoles' main monitors carry text that clashes with the box's own (red team 2:30, 7:24)
  const scratch = new THREE.PerspectiveCamera(40, camera.aspect, 0.05, 200);
  const cv = new THREE.Vector3(), nr = new THREE.Vector3(), rr = new THREE.Vector3(), uu = new THREE.Vector3();
  /** The share (0..1) of `rect` ([x0, y0, x1, y1] as fractions of the frame) that the monitors cover in `shot` at t. */
  function clash(shot, t, rect = HUD_RECT) {
    const fn = SHOTS[shot.kind];
    if (!fn || !world.monitor) return 0;
    const f = fn(shot, t, t);
    scratch.position.copy(f.pos);
    scratch.fov = f.fov;
    scratch.aspect = camera.aspect;
    scratch.lookAt(f.target);
    scratch.updateProjectionMatrix();
    scratch.updateMatrixWorld();
    const area = (rect[2] - rect[0]) * (rect[3] - rect[1]);
    let worst = 0;
    for (const id of Object.keys(DESKS)) {
      const m = world.monitor(id);
      nr.copy(m.normal);
      rr.crossVectors(UP, nr).normalize();
      uu.crossVectors(nr, rr).normalize();
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, behind = false;
      for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        cv.copy(m.center).addScaledVector(rr, a * m.width / 2).addScaledVector(uu, b * m.height / 2);
        if (cv.clone().applyMatrix4(scratch.matrixWorldInverse).z > -0.05) behind = true;
        cv.project(scratch);
        const x = (cv.x + 1) / 2, y = (1 - cv.y) / 2;
        x0 = Math.min(x0, x), y0 = Math.min(y0, y), x1 = Math.max(x1, x), y1 = Math.max(y1, y);
      }
      if (behind) continue;
      const w = Math.min(x1, rect[2]) - Math.max(x0, rect[0]), h = Math.min(y1, rect[3]) - Math.max(y0, rect[1]);
      if (w > 0 && h > 0) worst = Math.max(worst, (w * h) / area);
    }
    return worst;
  }

  let last = null;
  const gain = new THREE.Vector3();
  return {
    clash,
    cut(shot, t) {
      track.add(t, { shot, kind: "cut", dur: 0 });
    },
    move(shot, t, dur = 2) {
      track.add(t, { shot, kind: "move", dur });
    },
    /** The reveal's card frame of a Judge ({ pos, target, fov, spot, eye, side, focus }): give its
     *  spot to ballot.reveal, so the token opens where this camera frames it. */
    card: cardFrame,
    /** The shot list so far: [{ t, kind, id?, team?, move? }] in time order (for checks and reports). */
    list() {
      return track.ev.map((e) => ({ t: Math.round(e.t * 100) / 100, kind: e.shot.kind, ...(e.shot.id ? { id: e.shot.id } : {}), ...(e.shot.team ? { team: e.shot.team } : {}), ...(e.shot.name ? { name: e.shot.name } : {}), ...(e.kind === "move" ? { move: e.dur } : {}) }));
    },
    shotAt(t) {
      return track.current(t)?.shot ?? { kind: "wide" };
    },
    get lens() {
      return last;
    },
    update(t) {
      last = evaluate(t);
      camera.position.copy(last.pos);
      camera.fov = last.fov;
      camera.lookAt(last.target);
      camera.updateProjectionMatrix();
      camera.updateMatrixWorld();
      // what the grade multiplies the frame by (post.js): exposure × white balance, per channel
      return { ...last, exposure: gain.set(...last.white).multiplyScalar(last.exposure), iso: last.exposure };
    },
  };
}

export { urnSpots };
