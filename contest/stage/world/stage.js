// createStage({ canvas, gfx }): the whole 3D picture of the Final, ready to be driven
// (robots/README.md). Two scenes drawn into one HDR target: the night pit outside (own lights and
// fog), then the hall; bloom, depth of field on close shots and the grade on top (post.js).
import * as THREE from "three";
import { createRobot, JUDGE_IDS, ROBOT_IDS, ROSTER } from "/robots/index.js";
import { createEnvironment } from "./env.js";
import { createHall } from "./hall.js";
import { createDesk } from "./desk.js";
import { createBallot, TOKEN_R } from "./ballot.js";
import { createPit } from "./pit.js";
import { createCamera } from "./camera.js";
import { createPost } from "./post.js";
import { BALLOT, DESKS, HOST_POST, ROOM_FOCUS, SLOT_Y, dropSpot } from "./layout.js";
import { CERAMIC, GLASS, HOUSE, LIGHT } from "./palette.js";
import { Track } from "./timeline.js";

const ENV = 1.0; // the room's reflections; each material scales it (userData.env)
// the token in a hand: its centre this far above the grip point, so the fingers close on its lower rim
const TOKEN_LIFT = TOKEN_R * 1.0;
const FACE_LIGHT = { anthropic: CERAMIC.glow, openai: null, house: HOUSE.lamp };

export async function createStage({ canvas, gfx = "full", roster = null }) {
  const lite = gfx === "lite";
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: "high-performance", stencil: false });
  renderer.setPixelRatio(1);
  renderer.setSize(canvas.clientWidth || innerWidth, canvas.clientHeight || innerHeight, false);
  renderer.toneMapping = THREE.NoToneMapping; // post.js grades
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace; // post.js writes sRGB itself
  renderer.shadowMap.enabled = !lite;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  const W = renderer.domElement.width, H = renderer.domElement.height;
  if (roster) for (const [id, r] of Object.entries(roster)) Object.assign(ROSTER[id], r);

  const camera = new THREE.PerspectiveCamera(35, W / H, 0.05, 6000);
  const pit = createPit({ lite });
  const scene = new THREE.Scene();
  const envTex = createEnvironment(renderer);
  const hall = createHall({ lite });
  scene.add(hall.group);

  // ---- robots and consoles
  const robots = {}, desks = {};
  for (const id of ROBOT_IDS) robots[id] = createRobot(id);
  for (const id of JUDGE_IDS) {
    const D = DESKS[id], r = robots[id];
    // slot: where the token goes over the box's slot (ballot.js lets it go to this point); the hand follows
    r.place({ post: D.post, deskYaw: D.deskYaw, roomYaw: D.roomYaw, spot: dropSpot(id), slot: new THREE.Vector3(BALLOT.x, SLOT_Y + 0.1, BALLOT.z), lift: TOKEN_LIFT });
    scene.add(r.object3d);
    const d = createDesk(id, { lite });
    d.object3d.position.copy(D.pos);
    d.object3d.rotation.y = D.yaw;
    scene.add(d.object3d);
    desks[id] = d;
  }
  robots.host.place({ post: HOST_POST.pos, deskYaw: HOST_POST.yaw, roomYaw: HOST_POST.yaw, spot: HOST_POST.pos });
  scene.add(robots.host.object3d);
  // walk-core: what the Walk can click (ui/walk.js raycasts to the nearest tagged ancestor): the Judges,
  // their consoles, the dispatch wall; the ballot box and the tubes are tagged in ballot.js
  for (const id of JUDGE_IDS) {
    robots[id].object3d.userData.walkTarget = { kind: "judge", id };
    desks[id].object3d.userData.walkTarget = { kind: "console", id };
  }
  {
    const wall = hall.group.getObjectByName("dispatch-board");
    if (wall) wall.userData.walkTarget = { kind: "wall", id: "wall" };
  }

  // ---- the ballot station; robots hand their tokens to it. Each token lies on its Judge's desk at
  // the front edge on the side of its right hand, so the decision is a short reach.
  const rests = {};
  const restOf = (id) => {
    if (!rests[id]) {
      const D = DESKS[id], d = desks[id].object3d, r = robots[id];
      r.update(-1000);
      d.updateMatrixWorld(true);
      r.object3d.updateMatrixWorld(true);
      const hl = d.worldToLocal(r.anchors.hand.getWorldPosition(new THREE.Vector3()));
      const sx = Math.sign(hl.x) || 1;
      rests[id] = { pos: d.localToWorld(new THREE.Vector3(sx * 0.4, 0.98 + 0.021, 0.3)), yaw: D.yaw };
    }
    return rests[id];
  };
  for (const id of JUDGE_IDS) restOf(id); // before any frame: it poses the robot at rest
  const ballot = createBallot({
    lite,
    handOf: (id, out) => { robots[id].anchors.hand.localToWorld(out.set(0, -0.15, 0)); out.y += TOKEN_LIFT; return out; }, // in the fingers, below the wrist joint
    vendorOf: (id) => ROSTER[id].vendor,
    nameOf: (id) => ROSTER[id].model,
    restOf,
  });
  scene.add(ballot.group);
  for (const id of JUDGE_IDS) {
    ballot.place(id);
    robots[id].onTrip((rid, plan) => ballot.carry(rid, plan));
    robots[id].onBeat((rid, kind, times) => {
      if (kind !== "decide") return;
      desks[rid]?.setPower(0.16, times.dimAt); // the console dims as the Judge stops reading
      ballot.take(rid, times.tokenAt - 0.35); // the token is in its hand at tokenAt
    });
  }

  // the consoles' spill on the robots: two pooled lights lent each frame to the two brightest screens
  // (more than two lit consoles happen only on vote turns, when the robots lean into them anyway)
  const spills = [0, 1].map(() => {
    const l = new THREE.SpotLight(LIGHT.screen, 0, 4.2, 1.05, 1.0, 2);
    scene.add(l, l.target);
    return l;
  });

  // the speaker's face light reaches its chest and hands: one light, moved to whoever speaks
  const voiceLight = new THREE.PointLight("#ffffff", 0, 2.6, 2);
  scene.add(voiceLight);
  const faceColor = (id) => (ROSTER[id].vendor === "anthropic" ? CERAMIC.glow : ROSTER[id].vendor === "house" ? HOUSE.lamp : id === "gpt-6.1-sol" ? GLASS.solLight : GLASS.astraLight);

  // every standard material gets the room's reflections at its own level
  const seen = new Set();
  scene.traverse((o) => {
    for (const m of Array.isArray(o.material) ? o.material : o.material ? [o.material] : []) {
      if (seen.has(m) || !m.isMeshStandardMaterial) continue;
      seen.add(m);
      m.envMap = envTex;
      m.envMapIntensity = (m.userData.env ?? 0.5) * ENV;
    }
  });
  const fixMaterials = (root) => root.traverse((o) => {
    const m = o.material;
    if (m && m.isMeshStandardMaterial && !m.envMap) {
      m.envMap = envTex;
      m.envMapIntensity = (m.userData.env ?? 0.5) * ENV;
    }
  });

  // ---- camera, post
  // the height of each head above its joint (for framing): the top of its meshes in head space
  const headTop = {};
  for (const id of ROBOT_IDS) {
    const h = robots[id].anchors.head, box = new THREE.Box3(), b = new THREE.Box3();
    h.updateMatrixWorld(true);
    const inv = h.matrixWorld.clone().invert();
    h.traverse((o) => {
      if (!o.isMesh) return;
      o.geometry.computeBoundingBox();
      box.union(b.copy(o.geometry.boundingBox).applyMatrix4(inv.clone().multiply(o.matrixWorld)));
    });
    headTop[id] = box.isEmpty() ? 0.3 : box.max.y;
  }
  const world = {
    robotAt(id, t) {
      const r = robots[id];
      const joint = r.anchors.head.getWorldPosition(new THREE.Vector3());
      const head = joint.clone();
      head.y += 0.25;
      const height = r.info.height ?? joint.y + headTop[id];
      return { pos: r.object3d.position.clone(), yaw: r.object3d.rotation.y, head, top: joint.y + headTop[id], height };
    },
    monitor: (id) => desks[id].monitor(),
    urn: (team) => ballot.anchors.urn(team),
    teams: () => ballot.anchors.teams(),
    lineY: () => ballot.anchors.lineY(),
    hover: ballot.anchors.hover,
    tripOf: (id) => ({ from: DESKS[id].post, to: dropSpot(id) }),
    card: (id, side) => cardOf(id, side),
  };
  // The reveal's card frame: the Judge who cast the token at its post, facing the room, from the
  // front, its face on one side of the frame; its open token in the foreground on the other side,
  // low, the lid folding out toward the frame's edge. The token's spot is derived from the frame
  // (a point on the ray through the frame position CARD.ndc), so the composition holds for every
  // Judge's height and post. side 1: the token on the frame's left, the face on the right.
  const CARD = { dist: 2.5, span: 0.56, depth: 1.3, aim: 0.36, lift: 0.06, ndc: [-0.6, -0.2] };
  const cards = new Map();
  // By default the token takes the side of the frame the box is on, so it flies in from that side.
  function cardOf(id, side) {
    const P = DESKS[id].post, h = robots[id].info.height ?? 1.8;
    const f = ROOM_FOCUS.clone().sub(P).setY(0).normalize();
    const sd = new THREE.Vector3(f.z, 0, -f.x); // screen right, seen from the room
    side ??= ballot.anchors.box.clone().sub(P).dot(sd) > 0 ? -1 : 1;
    const key = `${id}:${side}`;
    if (cards.has(key)) return cards.get(key);
    const eyeY = 0.93 * h, span = CARD.span * h;
    const fov = THREE.MathUtils.radToDeg(2 * Math.atan(span / 2 / CARD.dist));
    const pos = P.clone().addScaledVector(f, CARD.dist).addScaledVector(sd, -side * 0.12).setY(eyeY - CARD.lift);
    const target = P.clone().addScaledVector(sd, -side * CARD.aim * h / 1.8).setY(eyeY - 0.17 * span);
    const fwd = target.clone().sub(pos).normalize();
    const right = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0)).normalize();
    const up = new THREE.Vector3().crossVectors(right, fwd);
    const tv = Math.tan(THREE.MathUtils.degToRad(fov) / 2), th = tv * (W / H);
    const dir = fwd.clone().addScaledVector(right, side * CARD.ndc[0] * th).addScaledVector(up, CARD.ndc[1] * tv);
    const spot = pos.clone().addScaledVector(dir, CARD.depth);
    const c = { pos, target, fov, spot, eye: pos.clone(), side, focus: CARD.depth };
    cards.set(key, c);
    return c;
  }
  const director = createCamera(camera, world);
  // a cut or a move to a robot's shot is its cue (robots/rig.js land): a speaking robot gestures once
  // as the camera lands on it, then holds still; its voice shows in its face light
  for (const k of ["cut", "move"]) {
    const f = director[k];
    director[k] = (shot, t, ...rest) => {
      const prev = director.shotAt(t - 1e-4);
      f(shot, t, ...rest);
      const id = shot.id ?? (shot.kind === "host" ? "host" : null);
      robots[id]?.land?.(t, { from: prev.id ?? (prev.kind === "host" ? "host" : null) });
    };
  }
  const post = createPost(renderer, { W, H, lite });

  // ---- the director's live layer in one call (robots/README.md)
  const sheets = new Track();
  const lastStatus = {};
  function judge(id, p, t) {
    const r = robots[id], d = desks[id];
    if (!r || !d) return;
    const st = p.status, prev = lastStatus[id];
    lastStatus[id] = st;
    if (st === "недоступен") {
      r.setState("offline", t);
      d.setPower(0, t);
      return;
    }
    if (st === "пишет" || st === "голосует") {
      r.setState("working", t);
      d.setPower(1, t);
      d.setLog(p.activity ?? [], t);
      d.setTimer(p.since ?? null, t);
      if (st === "голосует") d.show(sheets.current(t)?.sheet ?? null, t);
      else {
        const item = [...(p.activity ?? [])].reverse().find((a) => a.content);
        if (item) d.show(contentOf(item), t);
      }
      return;
    }
    r.setState("waiting", t, { facing: p.facing });
    // a finished vote turn: the console stays lit, stage.vote dims it as the Judge stops reading
    const voted = prev === "голосует" && p.turn?.kind === "vote" && !p.turn.running && p.turn.outcome !== "error";
    if (!voted) d.setPower(0.16, t);
  }
  const contentOf = (a) => (a.content?.image
    ? { kind: "image", label: a.label, path: a.path, src: a.content.image }
    : { kind: "text", label: a.label, path: a.path, text: a.content.text, from: a.content.from, to: a.content.to });

  // The vote on foot. At the end of its vote turn (t) the Judge decides at its desk
  // (robot.beat("decide"): it stops reading, its screen dims, it straightens up and takes its sealed
  // token) and sets off when the beat ends. Paths are straight lines from each post to its own side
  // of the box, so they never cross; a walker whose drop spot is near another's (neighbouring posts)
  // arrives only once that one has turned away from the box (+0.25 s); far-apart spots (Opus and
  // Sonnet) may be used at once.
  const NEAR_SPOT = 0.75; // m between drop spots under which two Judges cannot stand at the box together
  const SLOT_GAP = 1.5; // s between two drops in a wave's full choreography (the show's first); a brisk wave passes less
  // m between two Judges' centres at any moment of a vote. Neighbouring posts have drop spots only
  // 0.26-0.4 m apart, and a walker who has just turned back moves off slowly (the speed ramps up over
  // 0.5 s), so a fixed margin after the leaver's leaveAt let the next one arrive inside its body
  const CLEAR = 0.42;
  const atBox = []; // { id, post, spot, len, plan, leaveAt, dropAt }
  let boxFree = -Infinity; // the last walker's leaveAt
  const walkStart = (r, t0, t1) => {
    // the first moment of the "to-urn" phase (the walk after the turn on the spot)
    let lo = t0, hi = t1;
    for (let i = 0; i < 24; i++) {
      const m = (lo + hi) / 2;
      if (r.phaseAt(m) === "turn") lo = m;
      else hi = m;
    }
    return hi;
  };
  // Where a planned trip has its Judge at time t: on the line post -> spot, the same trapezoid speed
  // profile as robots/rig.js (planTrip, tripPose): out from arriveAt - walkT, back from leaveAt.
  const RAMP = 0.5;
  const along = (len, T, u) => {
    u = Math.min(Math.max(u, 0), T);
    const k = len / (T - RAMP);
    if (u < RAMP) return (0.5 * k * u * u) / RAMP;
    if (u > T - RAMP) return len - (0.5 * k * (T - u) * (T - u)) / RAMP;
    return 0.5 * k * RAMP + k * (u - RAMP);
  };
  const tripAt = ({ post, spot, len, plan }, t, out) => {
    const walkT = plan.backAt - plan.leaveAt, goAt = plan.arriveAt - walkT;
    if (t <= goAt || t >= plan.backAt) return out.copy(post);
    if (t < plan.arriveAt) return out.lerpVectors(post, spot, along(len, walkT, t - goAt) / len);
    if (t < plan.leaveAt) return out.copy(spot);
    return out.lerpVectors(spot, post, along(len, walkT, t - plan.leaveAt) / len);
  };
  const pa = new THREE.Vector3(), pb = new THREE.Vector3();
  /** The closest the walker `mine` comes to any of `others` (every 0.05 s of its trip). */
  const closest = (mine, others) => {
    let min = Infinity;
    for (let t = mine.plan.t0; t <= mine.plan.end; t += 0.05) {
      tripAt(mine, t, pa);
      for (const b of others) min = Math.min(min, pa.distanceTo(tripAt(b, t, pb)));
    }
    return min;
  };
  function vote(id, t, { gap = SLOT_GAP } = {}) {
    const r = robots[id];
    const beat = r.beat("decide", t); // onBeat dims the console and lifts the token
    const pv = r.previewVote(beat.end);
    const lead = pv.arriveAt - pv.t0, toDrop = pv.dropAt - pv.t0, spot = dropSpot(id), post = DESKS[id].post;
    const others = atBox.filter((b) => b.id !== id);
    const free = Math.max(-Infinity, ...others.filter((b) => b.spot.distanceTo(spot) < NEAR_SPOT).map((b) => b.leaveAt));
    const lastDrop = Math.max(-Infinity, ...atBox.map((b) => b.dropAt));
    // one slot: one token at a time (`gap` s apart; free + 0.25 keeps neighbours off each other either way)
    const start = Math.max(beat.end, free + 0.25 - lead, lastDrop + gap - toDrop);
    // then as much later as it takes for the walk to keep CLEAR from every other Judge's
    const len = post.distanceTo(spot), recent = others.filter((b) => b.plan.end > start - 1);
    let best = { at: start, min: -Infinity };
    for (let i = 0; i < 400 && best.min < CLEAR; i++) {
      const at = start + i * 0.05, min = closest({ post, spot, len, plan: r.previewVote(at) }, recent);
      if (min > best.min) best = { at, min };
    }
    const plan = r.vote(best.at);
    atBox.push({ id, post, spot, len, plan, leaveAt: plan.leaveAt, dropAt: plan.dropAt });
    boxFree = Math.max(boxFree, plan.leaveAt);
    return { ...plan, decideAt: t, dimAt: beat.dimAt, takeAt: beat.tokenAt, walkAt: walkStart(r, plan.t0, plan.arriveAt) };
  }
  /** When the next walk could start at the earliest (for a planner). */
  const boxFreeAt = () => boxFree;

  const v = new THREE.Vector3();
  function renderAt(t) {
    pit.update(t);
    for (const r of Object.values(robots)) r.update(t);
    scene.updateMatrixWorld();
    for (const d of Object.values(desks)) d.update(t);
    ballot.update(t);
    // the voice light on the brightest speaking face
    let best = null, lv = 0;
    for (const id of ROBOT_IDS) {
      const r = robots[id];
      if (r.stateAt(t) === "speaking" && r.faceLevel > lv) (best = id), (lv = r.faceLevel);
    }
    if (best) {
      robots[best].anchors.face.getWorldPosition(v);
      const f = new THREE.Vector3(0, 0, 1).applyQuaternion(robots[best].anchors.face.getWorldQuaternion(new THREE.Quaternion()));
      // far enough out to light the chest, not burn the chin. Black glass only mirrors it: in front
      // of the face its reflection is a hot point in the middle of the head and chest (a flare in a
      // close shot), so for glass it sits higher and further out, where it lights the upper planes
      const glass = ROSTER[best].vendor === "openai";
      voiceLight.position.copy(v).addScaledVector(f, glass ? 0.9 : 0.42);
      if (glass) voiceLight.position.y += 0.55;
      voiceLight.color.set(faceColor(best));
      voiceLight.intensity = (glass ? 0.35 : 0.3) * lv;
    } else voiceLight.intensity = 0;
    const lens = director.update(t);
    ballot.face(camera.position);
    // the pooled spills: brightest screens first, the nearer to the camera on a tie
    // a console lights the Judge that faces it; behind a Judge turned to the room its spill would
    // only leave a hot point on the black glass of the neck and chest, so it fades as the Judge turns
    const facingDesk = (id) => {
      const r = robots[id].object3d;
      const d = Math.cos(r.rotation.y - DESKS[id].deskYaw);
      return Math.min(1, Math.max(0, (d - 0.2) / 0.6));
    };
    const lit = JUDGE_IDS.map((id) => [desks[id].spill, desks[id].spill.intensity * facingDesk(id), camera.position.distanceToSquared(DESKS[id].pos)])
      .sort((a, b) => b[1] - a[1] || a[2] - b[2]);
    spills.forEach((l, i) => {
      const [sp, k] = lit[i];
      l.intensity = k;
      sp.from.getWorldPosition(l.position);
      sp.to.getWorldPosition(l.target.position);
      l.target.updateMatrixWorld();
    });
    post.lens.focus = lens.focus;
    post.lens.aperture = lens.aperture;
    post.lens.exposure = lens.exposure ?? 1;
    post.render([pit.scene, scene], camera, t);
  }

  function project(target) {
    if (target.isObject3D) target.getWorldPosition(v);
    else v.copy(target);
    const z = v.clone().applyMatrix4(camera.matrixWorldInverse).z;
    v.project(camera);
    return { x: ((v.x + 1) / 2) * (canvas.clientWidth || W), y: ((1 - v.y) / 2) * (canvas.clientHeight || H), visible: z < 0 && Math.abs(v.x) < 1.1 && Math.abs(v.y) < 1.1 };
  }

  // compile every program before the first timed frame
  director.update(0);
  renderer.compile(scene, camera);
  renderer.compile(pit.scene, camera);

  return {
    renderer, scene, outside: pit.scene, robots, desks, ballot, camera: director, lens: camera, post, judge, vote, boxFreeAt, renderAt, project, size: { W, H },
    /** the reveal's card frame of a Judge: { pos, target, fov, spot, eye, side, focus } (camera "card", ballot.reveal) */
    card: cardOf,
    /** the round's ballot sheet for the consoles on vote turns */
    setSheet(sheet, t) {
      sheets.add(t, { sheet });
    },
    fixMaterials,
    async ready() {
      await Promise.all(Object.values(desks).map((d) => d.ready()));
    },
    three: camera,
  };
}
