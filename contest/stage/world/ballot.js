// The ballot station: a square opaque ballot box with a steel frame and a slotted steel lid on a
// solid plinth, and, further toward the room, one glass tube per Finalist of the round on a dark
// pedestal with the team's plaque. Each Judge's sealed token lies on its own desk from the start of
// the round; on its decision the Judge picks it up, walks it to the box and drops it in the slot.
// A sealed token hides the choice, not the voter: its body is the Judge's family material (cream
// ceramic or black glass) and both faces carry a seal (a padlock and the Judge's model name in the
// family's second colour). At the reveal the token rises out of the slot and flies to a spot in
// front of the Judge who cast it (the stage's card frame), faces the camera and opens like a
// locket: the lid swings toward the lens and folds back behind the token on the frame's outer side,
// so it never covers the Judge; the open face names the team, with the Judge's model name under it.
// The lid closes, the token flies to that team's tube and drops onto the stack. The tubes are a bar
// chart: tokens lie flat, one pitch each, and a brass collar on every tube marks the majority line
// (`line` tokens); the winner's collar lights with the result, after the last token. Between rounds the tubes are emptied
// (reset): every token flies back from its tube to its Judge's desk for the next vote. A decided
// place lights its winner's tube from inside (highlight) and dims the other plaques. Everything is a
// function of the show clock: a reset starts a new epoch, and a token's take, trip and reveal are
// read from the epoch of the frame, so calls for a later round never change an earlier frame.
import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { BALLOT, SLOT_Y, URN_ROW, urnSpots } from "./layout.js";
import { ROOM, LIGHT, CERAMIC, GLASS } from "./palette.js";
import { Track, clamp01, smooth, inOut3, lerp } from "./timeline.js";

const std = (o, env = 0.5) => Object.assign(new THREE.MeshStandardMaterial(o), { userData: { env } });
const at = (o, x, y, z) => (o.position.set(x, y, z), o);
const SANS = '"Inter", system-ui, sans-serif', MONO = '"IBM Plex Mono", ui-monospace, monospace';

export const TOKEN_R = 0.085, TOKEN_T = 0.042, PITCH = 0.048;
const LID_T = 0.008;
const Y_UP = new THREE.Vector3(0, 1, 0);
const LET_GO = 0.32; // s the token takes from the fingers to over the slot
// a held token sits this much higher than handOf's point: the fingers close on its lower rim, under the
// Judge's name on the seal (the name sits 0.5 R under the centre), and do not pass through the disc
// (red team: GPT's longer fingers covered the name and clipped the token in the slot insert)
const HELD_UP = { anthropic: 0.034, openai: 0.05 }; // GPT's fingers are longer
// the lid shuts while the token flies to its tube, after the cut away from the card: the card shot
// never ends on the sealed face (red team: a 0.2 s flip back to the padlock read as the vote hidden again)
const LID_SHUT_S = 0.3;
// the box on its plinth: plinth top, the glass box's floor and top (the lid sits on it up to SLOT_Y)
const PLINTH_Y = 0.86, BOX_Y0 = 0.87, BOX_Y1 = 1.2, BOX_W = 0.44, BOX_D = 0.34;
// a tube: pedestal top, glass height, radius
export const TUBE_Y0 = 0.62, TUBE_H = 0.36, TUBE_R = 0.112;
// the tube's glass base: lifted off the pedestal, its top 1 mm under the stack's first token
const BASE_LIFT = 0.002, BASE_H = 0.021, STACK_Y = TUBE_Y0 + 0.024 + 0.001;
const PED_W = 0.46, PED_D = 0.3;
// where a token is shown when no card frame is given: over the slot, a little toward the room
export const HOVER = new THREE.Vector3(BALLOT.x, SLOT_Y + 0.4, BALLOT.z + 0.06);
// the reveal's phases (s after reveal()): out of the slot, to its card spot, open, opened (the card
// reads), close (the card's reading ends), shut (it leaves the spot; the lid shuts in flight, LID_SHUT_S),
// fly to the tube, land. The card is readable from ≈ open + 0.25 until the token leaves at shut.
export const REVEAL = { up: 0.3, arrive: 0.85, open: 0.9, opened: 1.25, close: 3.7, shut: 3.95, fly: 4.5, land: 4.68 };
// reset(): each token flies from its tube (or the box) back to its desk; each stack leaves top first
export const RETURN = { stagger: 0.14, fly: 1.3 };
const HL_RISE = 0.6; // s a highlighted tube takes to light
const LID_OPEN = 1.5 * Math.PI; // toward the lens, past flat, folded back against the token's edge

const FAMILY = {
  anthropic: { ring: CERAMIC.terracotta, ink: "#f3e6d4", bg: CERAMIC.cream, seal: CERAMIC.terracotta, sealInk: CERAMIC.terracottaDeep },
  openai: { ring: "#e9ecef", ink: "#f4f6f8", bg: "#0b0c0e", seal: "#dcdfe2", sealInk: "#f4f6f8" },
};

/** Glass: nearly clear face-on, brighter and more opaque toward the silhouette (Fresnel), so a tube
 *  reads as a glass wall with bright edges, not as the rings that hold it. */
function glassMat({ color = "#d4dce2", opacity = 0.06, edge = 0.55, rim = "#d8e2ea", rimK = 0.22, env = 1.6, roughness = 0.04 } = {}) {
  const m = std({ color, roughness, metalness: 0, transparent: true, opacity, depthWrite: false, side: THREE.DoubleSide }, env);
  const uniforms = { uEdge: { value: edge }, uRim: { value: new THREE.Color(rim).multiplyScalar(rimK) } };
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms);
    sh.fragmentShader = sh.fragmentShader
      .replace("#include <common>", "#include <common>\nuniform float uEdge; uniform vec3 uRim;")
      .replace("#include <opaque_fragment>", `
        float frn = 1.0 - abs(dot(normalize(normal), normalize(vViewPosition)));
        frn = frn * frn * frn;
        outgoingLight += uRim * frn;
        diffuseColor.a = clamp(diffuseColor.a + uEdge * frn, 0.0, 1.0);
        #include <opaque_fragment>`);
  };
  m.customProgramCacheKey = () => "stage-glass";
  m.userData.glass = uniforms;
  return m;
}

// a tube's plaque: the team id, then the name as large as the plaque allows (one line, or two for a
// long name), so it reads at 640×360 in the tally shot (cap height ≥ 20 px at 1080p)
const PLATE_W = 0.44, PLATE_H = 0.344;
function plateCanvas(team, name, note) {
  const c = document.createElement("canvas");
  c.width = 512;
  c.height = 400;
  const g = c.getContext("2d");
  g.fillStyle = "#141414";
  g.fillRect(0, 0, 512, 400);
  g.textAlign = "center";
  g.textBaseline = "alphabetic";
  g.fillStyle = note ? "#6e6e6e" : "#bdb8af";
  g.font = `500 44px ${MONO}`;
  g.fillText(team, 256, 62);
  g.fillStyle = note ? "#8a8a8a" : "#f6f1e8";
  const fit = (lines, size) => {
    g.font = `650 ${size}px ${SANS}`;
    return Math.max(...lines.map((l) => g.measureText(l).width)) <= 496;
  };
  const words = String(name).split(/\s+/);
  let lines = [name], size = 124;
  if (!fit(lines, 116) && words.length > 1) lines = [words.slice(0, Math.ceil(words.length / 2)).join(" "), words.slice(Math.ceil(words.length / 2)).join(" ")];
  while (!fit(lines, size) && size > 44) size -= 4;
  g.font = `650 ${size}px ${SANS}`;
  const top = note ? 150 : 170, step = size * 1.0;
  lines.forEach((l, i) => g.fillText(l, 256, top + (lines.length === 1 ? 40 : 0) + i * step));
  if (note) {
    g.fillStyle = "#9a9a9a";
    g.font = `500 36px ${SANS}`;
    g.fillText(note, 256, 372);
  }
  return tex(c);
}

const tex = (c) => {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
};
const disc = (g, color, r = 256) => {
  g.fillStyle = color;
  g.beginPath();
  g.arc(256, 256, r, 0, Math.PI * 2);
  g.fill();
};
const fitFont = (g, text, weight, size, maxW, min = 28) => {
  g.font = `${weight} ${size}px ${SANS}`;
  while (g.measureText(text).width > maxW && size > min) g.font = `${weight} ${(size -= 2)}px ${SANS}`;
  return size;
};

/** The open face of a token: the team it names in the family's ring, the Judge's model name under it. */
function faceCanvas(team, name, vendor, judge) {
  const F = FAMILY[vendor] ?? FAMILY.openai;
  const c = document.createElement("canvas");
  c.width = c.height = 512;
  const g = c.getContext("2d");
  disc(g, "#0f0f10");
  g.strokeStyle = F.ring;
  g.lineWidth = 24;
  g.beginPath();
  g.arc(256, 256, 238, 0, Math.PI * 2);
  g.stroke();
  g.textAlign = "center";
  g.textBaseline = "middle";
  if (team) {
    g.fillStyle = "#b9b4ac";
    g.font = `500 40px ${MONO}`;
    g.fillText(team, 256, 128);
    // the name on one or two lines, as large as fits inside the ring
    const words = String(name || team).split(/\s+/);
    const lines = words.length > 1 ? [words.slice(0, Math.ceil(words.length / 2)).join(" "), words.slice(Math.ceil(words.length / 2)).join(" ")] : words;
    let size = lines.length > 1 ? 96 : 110;
    g.font = `700 ${size}px ${SANS}`;
    while (Math.max(...lines.map((l) => g.measureText(l).width)) > 380 && size > 40) g.font = `700 ${(size -= 4)}px ${SANS}`;
    g.fillStyle = F.ink;
    lines.forEach((l, i) => g.fillText(l, 256, 250 + (i - (lines.length - 1) / 2) * size * 1.02));
  } else {
    g.fillStyle = "#8a8a8a";
    g.font = `600 64px ${SANS}`;
    g.fillText("—", 256, 250);
  }
  // who cast it: the Judge's model name (never the vendor's name next to a team)
  g.fillStyle = F.ring;
  fitFont(g, judge, 600, 40, 300);
  g.fillText(judge, 256, 392);
  return tex(c);
}

/** The sealed face: a padlock and the Judge's model name inside the seal ring. No team. */
function sealCanvas(vendor, judge) {
  const F = FAMILY[vendor] ?? FAMILY.openai;
  const c = document.createElement("canvas");
  c.width = c.height = 512;
  const g = c.getContext("2d");
  disc(g, F.bg);
  g.strokeStyle = F.seal;
  g.lineWidth = 22;
  g.beginPath();
  g.arc(256, 256, 226, 0, Math.PI * 2);
  g.stroke();
  // the Judge's name over the padlock: a hand carries the token by its lower rim, so its fingers
  // cross the lower part of the face, never the name (red team: the fingers hid «GPT 6 astra»)
  g.fillStyle = F.sealInk;
  g.textAlign = "center";
  g.textBaseline = "middle";
  fitFont(g, judge, 650, 62, 330);
  g.fillText(judge, 256, 132);
  // the padlock: a shackle over a body with a keyhole
  const dy = 66;
  g.lineWidth = 24;
  g.lineCap = "butt";
  g.beginPath();
  g.moveTo(206, 214 + dy);
  g.lineTo(206, 172 + dy);
  g.arc(256, 172 + dy, 50, Math.PI, 0);
  g.lineTo(306, 214 + dy);
  g.stroke();
  g.fillStyle = F.seal;
  g.beginPath();
  g.roundRect(176, 206 + dy, 160, 116, 18);
  g.fill();
  g.fillStyle = F.bg;
  g.beginPath();
  g.arc(256, 252 + dy, 15, 0, Math.PI * 2);
  g.fill();
  g.beginPath();
  g.moveTo(248, 258 + dy);
  g.lineTo(264, 258 + dy);
  g.lineTo(268, 296 + dy);
  g.lineTo(244, 296 + dy);
  g.closePath();
  g.fill();
  return tex(c);
}

function labelCanvas(text) {
  const c = document.createElement("canvas");
  c.width = 512;
  c.height = 192;
  const x = c.getContext("2d");
  x.fillStyle = "#141414";
  x.fillRect(0, 0, 512, 192);
  x.fillStyle = "#c9a46a";
  x.fillRect(0, 0, 512, 10);
  x.fillStyle = "#f6f1e8";
  x.font = `700 104px ${SANS}`;
  x.textAlign = "center";
  x.textBaseline = "middle";
  x.fillText(text, 256, 104);
  return tex(c);
}

/**
 * handOf(id, out) -> out: the world position of a Judge's right hand this frame (robots update first).
 * vendorOf(id): "anthropic" | "openai". nameOf(id): the model name. restOf(id) -> { pos: Vector3, yaw }:
 * where its token lies on its desk.
 */
export function createBallot({ lite, handOf, vendorOf, nameOf = (id) => id, restOf }) {
  const g = new THREE.Group();
  const steel = std({ color: ROOM.steel, roughness: 0.3, metalness: 0.95 }, 1.0);
  const dark = std({ color: "#151516", roughness: 0.55, metalness: 0.4 }, 0.6);
  const plinthMat = std({ color: "#1f2023", roughness: 0.5, metalness: 0.3 }, 0.7);
  const brass = std({ color: "#b48a52", roughness: 0.32, metalness: 0.9, emissive: LIGHT.tungsten, emissiveIntensity: 0 }, 1.0);

  // ---- the box: a solid plinth, a square glass box in a steel frame, a steel lid with the slot
  const box = new THREE.Group();
  box.position.copy(BALLOT);
  const plinth = new THREE.Mesh(new RoundedBoxGeometry(0.34, PLINTH_Y, 0.28, 2, 0.02), plinthMat);
  plinth.position.y = PLINTH_Y / 2;
  plinth.castShadow = plinth.receiveShadow = true;
  box.add(plinth);
  box.add(at(new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.05, 0.3), steel), 0, 0.025, 0)); // kick plate
  box.add(at(new THREE.Mesh(new THREE.BoxGeometry(BOX_W + 0.02, 0.014, BOX_D + 0.02), steel), 0, PLINTH_Y + 0.007, 0)); // the box's floor frame
  // the box is opaque (a sealed vote is not seen before the reveal): smoked graphite walls inside the
  // steel corner posts, a hair inside the posts' faces and above the floor frame (no coplanar faces)
  const wallMat = std({ color: "#202226", roughness: 0.38, metalness: 0.6 }, 0.9);
  const walls = new THREE.Mesh(new THREE.BoxGeometry(BOX_W - 0.004, BOX_Y1 - BOX_Y0 - 0.006, BOX_D - 0.004), wallMat);
  walls.position.y = (BOX_Y0 + BOX_Y1) / 2 + 0.002;
  walls.castShadow = walls.receiveShadow = true;
  box.add(walls);
  const postH = BOX_Y1 - BOX_Y0;
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) box.add(at(new THREE.Mesh(new THREE.BoxGeometry(0.014, postH, 0.014), steel), sx * BOX_W / 2, (BOX_Y0 + BOX_Y1) / 2, sz * BOX_D / 2));
  const lidMat = std({ color: "#34373c", roughness: 0.42, metalness: 0.85 }, 0.8); // satin graphite: no white sheet under the pendant
  const lid = new THREE.Mesh(new RoundedBoxGeometry(BOX_W + 0.03, SLOT_Y - BOX_Y1, BOX_D + 0.03, 2, 0.008), lidMat);
  lid.position.y = (BOX_Y1 + SLOT_Y) / 2;
  lid.castShadow = true;
  box.add(lid);
  // the slot runs along X, so a token held face to the room goes in edge first
  box.add(at(new THREE.Mesh(new THREE.BoxGeometry(2 * TOKEN_R + 0.03, 0.004, 0.02), new THREE.MeshBasicMaterial({ color: 0x020202 })), 0, SLOT_Y + 0.001, 0));
  g.add(box);
  box.userData.walkTarget = { kind: "urn", id: "urn" }; // walk-core: the Walk can click the box (ui/walk.js)

  // a soft key on the tube row (no shadows): the plaques and the stacks read in every shot
  const rowLight = new THREE.SpotLight(LIGHT.tungsten, lite ? 9 : 7, 6.5, 0.72, 0.85, 1.6);
  const rowZ = BALLOT.z + URN_ROW;
  rowLight.position.set(0, 3.6, rowZ + 1.6);
  rowLight.target.position.set(0, 0.6, rowZ);
  g.add(rowLight, rowLight.target);

  // ---- tubes, built per round
  const urnGroup = new THREE.Group();
  g.add(urnGroup);
  urnGroup.userData.walkTarget = { kind: "urn", id: "urn" }; // walk-core: and the tubes; rebuilt per round,
  urnGroup.userData.walkDynamic = true; // so not in the Walk's floor plan (ui/walk.js asks for the tubes each frame)
  const tubeMat = glassMat();
  const lipMat = glassMat({ opacity: 0.32, edge: 0.5, rimK: 0.35 });
  const baseGlass = glassMat({ color: "#aeb8be", opacity: 0.38, edge: 0.4, rimK: 0.2 });
  let urns = []; // { team, name, pos, ceiling, collar, plate, glow }
  const rounds = new Track(); // { info }
  const tokens = {}; // id -> token
  const reveals = []; // { t, id, team, landAt, card }
  const resets = []; // times the tubes were emptied, ascending
  const lit = new Track(); // { team }: the highlighted tube
  // the epoch of t: [the last reset at or before t, the next one)
  const epochOf = (t) => {
    let a = -Infinity, b = Infinity;
    for (const r of resets) if (r <= t + 1e-9) a = r; else { b = r; break; }
    return [a, b];
  };
  const inEpoch = (x, [a, b]) => x >= a - 1e-9 && x < b - 1e-9;
  const takeIn = (k, ep) => k.takes.filter((x) => inEpoch(x, ep)).sort((a, b) => a - b)[0] ?? null;
  const carryIn = (k, ep) => k.carries.filter((c) => inEpoch(c.t0, ep)).sort((a, b) => a.dropAt - b.dropAt)[0] ?? null;
  const revealsIn = (ep) => reveals.filter((r) => inEpoch(r.t, ep));
  // the light column: brightest at the bottom of the stack, fading up the glass
  const glowGeo = new THREE.CylinderGeometry(TUBE_R * 0.86, TUBE_R * 0.86, TUBE_H, 32, 1, true);
  const glowMat = (() => {
    const c = document.createElement("canvas");
    c.width = 4;
    c.height = 128;
    const x = c.getContext("2d"), gr = x.createLinearGradient(0, 0, 0, 128);
    gr.addColorStop(0, "rgba(255,255,255,0)");
    gr.addColorStop(0.55, "rgba(255,255,255,0.35)");
    gr.addColorStop(1, "rgba(255,255,255,1)");
    x.fillStyle = gr;
    x.fillRect(0, 0, 4, 128);
    return new THREE.MeshBasicMaterial({ color: new THREE.Color(LIGHT.tungsten).multiplyScalar(0.9), map: tex(c), transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false });
  })();

  function buildUrns(info) {
    urnGroup.clear();
    urns = [];
    const spots = urnSpots(info.contenders.length);
    const lineY = TUBE_Y0 + 0.012 + info.line * PITCH;
    info.contenders.forEach((f, i) => {
      const p = spots[i];
      const u = new THREE.Group();
      u.position.copy(p);
      const capped = !!(f.ceiling && info.place === 1);
      const ped = new THREE.Mesh(new RoundedBoxGeometry(PED_W, TUBE_Y0, PED_D, 2, 0.018), dark);
      ped.position.y = TUBE_Y0 / 2;
      ped.castShadow = ped.receiveShadow = true;
      u.add(ped);
      const map = plateCanvas(f.team, f.name ?? f.team, capped ? "не может занять 1-е место" : "");
      const plate = new THREE.Mesh(new THREE.PlaneGeometry(PLATE_W, PLATE_H), Object.assign(new THREE.MeshStandardMaterial({ map, emissiveMap: map, emissive: "#ffffff", emissiveIntensity: 0.32, roughness: 0.55, metalness: 0.1 }), { userData: { env: 0.3 } }));
      plate.position.set(0, TUBE_Y0 - 0.035 - PLATE_H / 2, PED_D / 2 + 0.002);
      u.add(plate);
      // the glass: a thick clear base, the wall, a rounded glass lip (no steel rings to read as wire)
      // (2 mm clear of the pedestal top: a coplanar bottom cap z-fought with it, a shimmering fan
      // through the glass in the tube close-ups)
      u.add(at(new THREE.Mesh(new THREE.CylinderGeometry(TUBE_R + 0.004, TUBE_R + 0.004, BASE_H, 40), baseGlass), 0, TUBE_Y0 + BASE_LIFT + BASE_H / 2, 0));
      const tube = new THREE.Mesh(new THREE.CylinderGeometry(TUBE_R, TUBE_R, TUBE_H, 48, 1, true), tubeMat);
      tube.position.y = TUBE_Y0 + 0.024 + TUBE_H / 2;
      tube.renderOrder = 4;
      u.add(tube);
      const lipM = new THREE.Mesh(new THREE.TorusGeometry(TUBE_R, 0.006, 8, 48), lipMat);
      lipM.rotation.x = Math.PI / 2;
      lipM.position.y = TUBE_Y0 + 0.024 + TUBE_H;
      lipM.renderOrder = 5;
      u.add(lipM);
      if (capped) u.add(at(new THREE.Mesh(new THREE.CylinderGeometry(TUBE_R + 0.02, TUBE_R + 0.02, 0.03, 40), dark), 0, TUBE_Y0 + 0.024 + TUBE_H + 0.015, 0));
      // the majority mark: a brass collar round the tube at `line` tokens; it lights when reached
      const collar = new THREE.Mesh(new THREE.CylinderGeometry(TUBE_R + 0.01, TUBE_R + 0.01, 0.022, 40, 1, true), brass.clone());
      collar.material.side = THREE.DoubleSide;
      collar.position.y = lineY + 0.011;
      u.add(collar);
      // the winner's light: a warm column inside the glass, off until highlight()
      const glow = new THREE.Mesh(glowGeo, glowMat.clone());
      glow.position.y = TUBE_Y0 + 0.024 + TUBE_H / 2;
      glow.renderOrder = 3;
      glow.visible = false;
      u.add(glow);
      urnGroup.add(u);
      urns.push({ team: f.team, name: f.name ?? f.team, pos: p.clone(), ceiling: capped, collar, plate, glow });
    });
    // «3 из 4» on a post at the row's right end, centred on the collars' height (below the Judges' feet in the wide)
    if (urns.length) {
      const last = urns[urns.length - 1].pos;
      const t = labelCanvas(`${info.line} из ${info.voted}`);
      const post = new THREE.Group();
      post.position.copy(last).add(new THREE.Vector3(0.52, 0, 0));
      post.add(at(new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.016, lineY - 0.075, 10), steel), 0, (lineY - 0.075) / 2, 0));
      post.add(at(new THREE.Mesh(new THREE.PlaneGeometry(0.4, 0.15), Object.assign(new THREE.MeshStandardMaterial({ map: t, emissiveMap: t, emissive: "#ffffff", emissiveIntensity: 0.42, roughness: 0.5 }), { userData: { env: 0.3 } })), 0, lineY, 0.016)); // centred on the line
      urnGroup.add(post);
    }
  }

  // ---- tokens: a puck of the family material with an edge band; a lid on the front face hinged at
  // one edge (the frame's outer side at the reveal), the sealed face on the lid and on the back, the
  // open face under the lid
  const bodyGeo = new THREE.CylinderGeometry(TOKEN_R, TOKEN_R, TOKEN_T - LID_T, 48);
  bodyGeo.rotateX(Math.PI / 2); // axis on Z: a coin seen face-on from the front
  const bandGeo = new THREE.CylinderGeometry(TOKEN_R + 0.0015, TOKEN_R + 0.0015, (TOKEN_T - LID_T) * 0.62, 48, 1, true);
  bandGeo.rotateX(Math.PI / 2);
  const lidGeo = (s) => {
    const geo = new THREE.CylinderGeometry(TOKEN_R, TOKEN_R, LID_T, 48);
    geo.rotateX(Math.PI / 2);
    geo.translate(s * TOKEN_R, 0, LID_T / 2); // the hinge at the lid's edge is the group's origin
    return geo;
  };
  const lidGeos = { 1: lidGeo(1), [-1]: lidGeo(-1) };
  const sealGeo = new THREE.CircleGeometry(TOKEN_R * 0.97, 48);
  const faceGeo = new THREE.CircleGeometry(TOKEN_R * 0.96, 48);
  const mats = {
    anthropic: { body: std({ color: CERAMIC.cream, roughness: 0.62, metalness: 0 }, 0.5), band: std({ color: CERAMIC.terracotta, roughness: 0.7, metalness: 0 }, 0.3) },
    openai: { body: std({ color: GLASS.black, roughness: 0.12, metalness: 0.2 }, 1.2), band: std({ color: "#dcdfe2", roughness: 0.38, metalness: 0 }, 0.6) },
  };
  function tokenOf(id) {
    if (tokens[id]) return tokens[id];
    const vendor = vendorOf(id) === "anthropic" ? "anthropic" : "openai";
    const M = mats[vendor];
    const judge = nameOf(id);
    const sealMap = sealCanvas(vendor, judge);
    const sealMat = std({ map: sealMap, roughness: vendor === "openai" ? 0.22 : 0.6, metalness: 0, emissive: "#ffffff", emissiveMap: sealMap, emissiveIntensity: vendor === "openai" ? 0.22 : 0.08 }, vendor === "openai" ? 0.9 : 0.4);
    const grp = new THREE.Group();
    const body = new THREE.Mesh(bodyGeo, M.body);
    body.position.z = -LID_T / 2;
    body.castShadow = true;
    grp.add(body);
    grp.add(at(new THREE.Mesh(bandGeo, M.band), 0, 0, -LID_T / 2));
    const back = new THREE.Mesh(sealGeo, sealMat);
    back.position.z = -TOKEN_T / 2 - 0.0008;
    back.rotation.y = Math.PI;
    grp.add(back);
    const faceMat = new THREE.MeshStandardMaterial({ color: "#ffffff", roughness: 0.45, metalness: 0, emissive: "#ffffff", emissiveIntensity: 0.6 });
    faceMat.userData.env = 0.25;
    const face = new THREE.Mesh(faceGeo, faceMat);
    face.position.z = TOKEN_T / 2 - LID_T + 0.0006;
    grp.add(face);
    const hinge = new THREE.Group();
    const lid = new THREE.Mesh(lidGeos[1], M.body);
    lid.castShadow = true;
    hinge.add(lid);
    const seal = new THREE.Mesh(sealGeo, sealMat);
    hinge.add(seal);
    grp.add(hinge);
    grp.visible = false;
    g.add(grp);
    const k = { id, vendor, judge, grp, hinge, lid, seal, face, faceMat, side: 0, take: null, carry: null, takes: [], carries: [], faces: new Map() };
    hingeSide(k, 1);
    return (tokens[id] = k);
  }
  // s = 1: the hinge on the token's left edge (the token on the frame's left), -1: on its right
  function hingeSide(k, s) {
    if (k.side === s) return;
    k.side = s;
    k.hinge.position.set(-s * TOKEN_R, 0, TOKEN_T / 2 - LID_T);
    k.lid.geometry = lidGeos[s];
    k.seal.position.set(s * TOKEN_R, 0, LID_T + 0.0008);
  }

  const hand = new THREE.Vector3(), tmp = new THREE.Vector3(), tmp2 = new THREE.Vector3(), from = new THREE.Vector3(), above = new THREE.Vector3();
  const qa = new THREE.Quaternion(), qb = new THREE.Quaternion(), qFlat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
  const m4 = new THREE.Matrix4();
  const held = []; // [token group, let-go 0..1] of this frame
  const slot = new THREE.Vector3(BALLOT.x, SLOT_Y, BALLOT.z);
  // a token in the box lies flat on its floor; they spread across it in the order they came
  const inBox = (i, out) => out.set(BALLOT.x + ((i % 3) - 1) * 0.12, BOX_Y0 + 0.006 + TOKEN_T / 2 + Math.floor(i / 3) * (TOKEN_T + 0.004), BALLOT.z + ((i % 2) ? 0.05 : -0.04));
  /** the rotation that turns a token's face (+Z) from p toward eye */
  const facing = (p, eye, out) => out.setFromRotationMatrix(m4.lookAt(eye, p, Y_UP));

  // After the reset at r0: where a token lay just before it (in a tube or the box) and its place in
  // the line home (the top of each stack first, stacks left to right); null when it lay on its desk.
  const from2 = new THREE.Vector3();
  function homeFrom(k, r0, prev, out) {
    const c = carryIn(k, prev);
    if (!c || c.dropAt > r0 + 1e-6) return null;
    const pr = revealsIn(prev);
    const rv = pr.find((r) => r.id === k.id && r.landAt <= r0 + 1e-6);
    const urn = rv?.team ? urns.find((x) => x.team === rv.team) : null;
    if (urn) {
      const below = pr.filter((x) => x.team === rv.team && x.landAt < rv.landAt).length;
      const stack = pr.filter((x) => x.team === rv.team && x.landAt <= r0 + 1e-6).length;
      out?.set(urn.pos.x, STACK_Y + TOKEN_T / 2 + below * PITCH, urn.pos.z);
      return stack - 1 - below + urns.indexOf(urn) * 0.35;
    }
    const inbox = Object.values(tokens).filter((x) => carryIn(x, prev)).sort((a, b) => carryIn(a, prev).dropAt - carryIn(b, prev).dropAt);
    if (out) inBox(inbox.indexOf(k), out);
    return inbox.indexOf(k);
  }
  const homeOrder = (k, r0, prev) => homeFrom(k, r0, prev, null);
  /** How far home a token is at t after the reset at r0: { from, u }, or null (it lay on its desk, or is home). */
  function homeward(k, r0, t) {
    const order = homeFrom(k, r0, epochOf(r0 - 1e-6), from2);
    if (order === null) return null;
    const u = smooth((t - r0 - order * RETURN.stagger) / RETURN.fly);
    return u >= 1 ? null : { from: from2, u };
  }

  const api = {
    group: g,
    /** Lay every voter's token on its desk (the round begins). */
    setRound(info, t) {
      rounds.add(t, { info: { ...info, contenders: info.contenders.slice(0, 10) } });
    },
    /** A token on a desk from the start, so the decision has something to pick up. */
    place(id) {
      tokenOf(id);
    },
    /** The decision: the Judge takes its token from the desk into its hand at takeAt (0.35 s). */
    take(id, takeAt) {
      tokenOf(id).takes.push(takeAt);
    },
    /** From robot.vote(): the token is in its hand during the trip and goes into the slot at dropAt. */
    carry(id, plan) {
      const k = tokenOf(id), ep = epochOf(plan.t0);
      k.carries.push({ t0: plan.t0, dropAt: plan.dropAt });
      if (takeIn(k, ep) === null) k.takes.push(plan.t0 - 0.35);
    },
    drop(id, t) {
      const k = tokenOf(id), ep = epochOf(t - 0.3);
      if (!carryIn(k, ep)) k.carries.push({ t0: t - 0.3, dropAt: t });
      if (takeIn(k, ep) === null) k.takes.push(t - 0.65);
    },
    /**
     * That Judge's token out of the slot to its card spot, opened to the camera, closed, into
     * `team`'s tube. card: { spot: Vector3, eye: Vector3, side: ±1 } (the stage's card frame; without
     * it the token opens over the box, facing the room). Returns its times.
     */
    reveal(id, team, t, card = null) {
      tokenOf(id);
      const c = card ?? { spot: HOVER.clone(), eye: HOVER.clone().add(new THREE.Vector3(0, 0, 2)), side: 1 };
      const P = REVEAL;
      const r = { t, id, team, card: c, openAt: t + P.open, openedAt: t + P.opened, readFrom: t + P.open + 0.25, closeAt: t + P.close, flyAt: t + P.shut, landAt: t + P.land };
      reveals.push(r);
      reveals.sort((a, b) => a.t - b.t);
      return r;
    },
    clear(t) {
      for (const k of Object.values(tokens)) (k.carry = null), (k.take = null), (k.takes.length = 0), (k.carries.length = 0);
      reveals.length = 0;
      resets.length = 0;
    },
    /**
     * Empty the tubes at t for the next round: every token in a tube (or the box) flies back to its
     * Judge's desk, the top of each stack first (RETURN), and lies there for the next vote. Takes,
     * trips and reveals from t on belong to the new round. Returns { end }: the last token is home.
     */
    reset(t) {
      const prev = epochOf(t - 1e-6);
      resets.push(t);
      resets.sort((a, b) => a - b);
      let end = t;
      for (const k of Object.values(tokens)) {
        const h = homeOrder(k, t, prev);
        if (h !== null) end = Math.max(end, t + h * RETURN.stagger + RETURN.fly);
      }
      return { end };
    },
    /**
     * Sealed envelopes (owner 2026-10-28): an envelope opened after the debate puts its round's
     * tokens back in the box at t, already lying in it (the box is opaque), in the order the Judges
     * reached the urn (`ids`), so reveal() takes them out as after a wave. A new epoch, like reset():
     * every other token stays on its desk. Returns { end: t }.
     */
    seal(ids, t) {
      resets.push(t);
      resets.sort((a, b) => a - b);
      ids.forEach((id, i) => {
        const k = tokenOf(id);
        k.takes.push(t);
        k.carries.push({ t0: t, dropAt: t - 1 + i * 1e-3 }); // dropped before t: in the box from the first frame
      });
      return { end: t };
    },
    /** Light `team`'s tube from t (its place is decided); null puts it out. A reset or the next round's tubes end it. */
    highlight(team, t) {
      lit.add(t, { team: team ?? null });
    },
    count(team, t) {
      const ep = epochOf(t);
      return reveals.filter((r) => r.team === team && r.landAt <= t && inEpoch(r.t, ep)).length;
    },
    anchors: {
      slot,
      box: BALLOT,
      hover: HOVER,
      urn: (team) => urns.find((u) => u.team === team)?.pos ?? null,
      /** the height of the majority collar (world y) */
      lineY: () => (rounds.ev.length ? TUBE_Y0 + 0.012 + rounds.ev.at(-1).info.line * PITCH : TUBE_Y0 + 0.15),
      teams: () => urns.map((u) => u.team),
    },
    /** After the camera of t is in place: tokens in hand show their sealed face to it. */
    face(eye) {
      for (const [grp, u] of held) grp.rotation.set(0, lerp(Math.atan2(eye.x - grp.position.x, eye.z - grp.position.z), 0, u), 0);
    },
    update(t) {
      held.length = 0;
      const R = rounds.current(t);
      if (R && R.built !== true) {
        for (const e of rounds.ev) e.built = false;
        buildUrns(R.info);
        R.built = true;
      }
      const info = R?.info;
      // a highlight lasts until the next reset or the next round's tubes
      const hlE = lit.current(t);
      const hl = hlE && hlE.team && hlE.t >= Math.max(epochOf(t)[0], R?.t ?? -Infinity) - 1e-9 ? hlE : null;
      const ep = epochOf(t);
      const epReveals = revealsIn(ep);
      for (const k of Object.values(tokens)) (k.take = takeIn(k, ep)), (k.carry = carryIn(k, ep));
      const dropped = Object.values(tokens).filter((k) => k.carry).sort((a, b) => a.carry.dropAt - b.carry.dropAt);
      for (const k of Object.values(tokens)) {
        const grp = k.grp;
        grp.visible = !!R;
        k.hinge.rotation.set(0, 0, 0);
        const rv = epReveals.find((r) => r.id === k.id && r.t <= t + 1e-6) ?? null;
        hingeSide(k, rv ? rv.card.side : 1);
        // on the desk, lying flat, seal up (after a reset: on its way back from the tube first)
        if (k.take === null || t < k.take) {
          const rest = restOf(k.id);
          const back = Number.isFinite(ep[0]) ? homeward(k, ep[0], t) : null;
          if (back) {
            grp.position.lerpVectors(back.from, rest.pos, back.u);
            grp.position.y += Math.sin(Math.PI * back.u) * 0.55;
          } else grp.position.copy(rest.pos);
          grp.rotation.set(-Math.PI / 2, 0, 0);
          grp.rotateOnWorldAxis(Y_UP, rest.yaw);
          continue;
        }
        const dropAt = k.carry?.dropAt ?? Infinity;
        if (t < dropAt) {
          // from the desk into the hand, then held upright, its seal turned to the lens (face());
          // in the last moment, out of the fingers to just over the slot, edge first
          handOf(k.id, hand);
          hand.y += HELD_UP[k.vendor] * smooth((t - k.take) / 0.35);
          const up = smooth((t - k.take) / 0.35);
          if (up < 1) {
            const rest = restOf(k.id);
            grp.position.lerpVectors(rest.pos, hand, up);
            grp.position.y += Math.sin(Math.PI * up) * 0.06;
          } else grp.position.copy(hand);
          const u = smooth(clamp01((t - (dropAt - LET_GO)) / LET_GO));
          if (u > 0) grp.position.lerp(tmp.set(slot.x, SLOT_Y + 0.1, slot.z), u);
          held.push([grp, u]);
          continue;
        }
        inBox(dropped.indexOf(k), tmp);
        if (!rv) {
          // through the slot and down into the box, where it lies flat
          const u = clamp01((t - dropAt) / 0.32);
          grp.position.set(slot.x, lerp(SLOT_Y + 0.1, tmp.y, u * u), slot.z);
          grp.rotation.set(0, 0, 0);
          if (u >= 1) grp.position.copy(tmp), grp.rotation.set(-Math.PI / 2, 0, 0);
          continue;
        }
        // the reveal
        const r = t - rv.t, P = REVEAL, C = rv.card;
        const urn = rv.team ? urns.find((x) => x.team === rv.team) : null;
        const stackIndex = urn ? epReveals.filter((x) => x.team === rv.team && x.landAt < rv.landAt).length : 0;
        const dest = urn ? tmp2.set(urn.pos.x, STACK_Y + TOKEN_T / 2 + stackIndex * PITCH, urn.pos.z) : tmp2.copy(tmp);
        above.copy(dest).setY(TUBE_Y0 + 0.024 + TUBE_H + 0.24);
        // the lid: toward the lens and folded back behind the token's outer edge, then shut again
        const lidA = smooth((r - P.open) / (P.opened - P.open)) * (1 - smooth((r - P.shut) / LID_SHUT_S));
        k.hinge.rotation.y = -k.side * LID_OPEN * lidA;
        facing(C.spot, C.eye, qb);
        if (r < P.up) {
          // upright, edge first out of the slot
          const u = smooth(r / P.up);
          grp.position.set(slot.x, lerp(tmp.y, SLOT_Y + 0.2, u), slot.z);
          grp.rotation.set(0, 0, 0);
        } else if (r < P.arrive) {
          // to the card spot in an arc, turning its face to the camera
          const u = inOut3((r - P.up) / (P.arrive - P.up));
          from.set(slot.x, SLOT_Y + 0.2, slot.z);
          grp.position.lerpVectors(from, C.spot, u);
          grp.position.y += Math.sin(Math.PI * u) * 0.2;
          qa.identity();
          grp.quaternion.slerpQuaternions(qa, qb, smooth(u * 1.3));
        } else if (r < P.shut) {
          grp.position.copy(C.spot);
          grp.position.y += 0.005 * Math.sin((r - P.arrive) * 2.6);
          grp.quaternion.copy(qb);
        } else if (r < P.fly) {
          const u = inOut3((r - P.shut) / (P.fly - P.shut));
          grp.position.lerpVectors(C.spot, above, u);
          grp.position.y += Math.sin(Math.PI * u) * 0.35;
          grp.quaternion.slerpQuaternions(qb, qFlat, smooth(u));
        } else {
          const u = clamp01((r - P.fly) / (P.land - P.fly));
          grp.position.lerpVectors(above, dest, u * u);
          grp.quaternion.copy(qFlat);
        }
        const key = rv.team ?? "";
        if (!k.faces.has(key)) k.faces.set(key, faceCanvas(rv.team, urns.find((x) => x.team === rv.team)?.name, k.vendor, k.judge));
        const ft = k.faces.get(key);
        if (k.faceMat.map !== ft) (k.faceMat.map = k.faceMat.emissiveMap = ft), (k.faceMat.needsUpdate = true);
      }
      // tubes: the collar lights once a tube reaches the line, the plaque brightens while it fills
      for (const u of urns) {
        const n = api.count(u.team, t);
        const reached = info && n >= info.line;
        const firstAt = reached ? epReveals.filter((x) => x.team === u.team).map((x) => x.landAt).sort((a, b) => a - b)[info.line - 1] : null;
        // the collar lights with the result (highlight, after the last token), never mid-reveal (owner 2026-10-21)
        const glow = reached && hl && hl.team === u.team ? smooth((t - Math.max(firstAt, hl.t)) / 0.5) : 0;
        // the decided place: its tube lit from inside, the other plaques dimmed
        const won = hl && hl.team === u.team ? smooth((t - hl.t) / HL_RISE) : 0;
        const lose = hl && hl.team !== u.team ? smooth((t - hl.t) / HL_RISE) : 0;
        u.collar.material.emissiveIntensity = 1.8 * glow + 1.6 * won;
        u.plate.material.emissiveIntensity = (0.32 + (n > 0 ? 0.1 : 0) + 0.3 * glow + 0.3 * won) * (1 - 0.6 * lose);
        u.glow.visible = won > 0;
        u.glow.material.opacity = 0.32 * won;
      }
    },
  };
  return api;
}
