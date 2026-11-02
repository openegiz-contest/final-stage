// The working kit of a mine dispatch room: the dispatcher's radio desk (a base station, a gooseneck
// desk microphone, a handheld in its charger, a phone, the shift log, a small monitor), a stand with
// hard hats and hi-vis vests by the door, a fire extinguisher, and the shift board (a whiteboard
// with the shift's work order in marker, deliberately not legible). Plain shapes, real proportions.
import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { ROOM } from "../palette.js";
import { rng } from "../timeline.js";

const std = (o, env = 0.5) => Object.assign(new THREE.MeshStandardMaterial(o), { userData: { env } });
const at = (o, x, y, z) => (o.position.set(x, y, z), o);
const rb = (w, h, d, r, mat) => {
  const m = new THREE.Mesh(new RoundedBoxGeometry(w, h, d, 2, Math.min(r, w / 2, h / 2, d / 2)), mat);
  m.castShadow = m.receiveShadow = true;
  return m;
};
let M = null;
function mats() {
  if (M) return M;
  M = {
    black: std({ color: "#121214", roughness: 0.55, metalness: 0.2 }, 0.5),
    plastic: std({ color: "#1d1e21", roughness: 0.45, metalness: 0.05 }, 0.5),
    steel: std({ color: ROOM.steel, roughness: 0.35, metalness: 0.9 }, 0.9),
    top: std({ color: ROOM.laminate, roughness: 0.5, metalness: 0.05 }, 0.5),
    graphite: std({ color: ROOM.graphite, roughness: 0.62, metalness: 0.35 }, 0.4),
    white: std({ color: "#dedbd2", roughness: 0.38, metalness: 0.0 }, 0.6),   // ABS hard hat
    orange: std({ color: "#d9631f", roughness: 0.42, metalness: 0.0 }, 0.6),
    vest: std({ color: "#e0611c", roughness: 0.85, metalness: 0.0 }, 0.3),     // hi-vis polyester
    stripe: std({ color: "#b9bcbf", roughness: 0.3, metalness: 0.6 }, 1.0),    // retroreflective tape
    red: std({ color: "#a3170f", roughness: 0.4, metalness: 0.1 }, 0.6),
    paper: std({ color: "#c9c5bb", roughness: 0.9, metalness: 0 }, 0.2),
    green: std({ color: "#2e4a3a", roughness: 0.8, metalness: 0 }, 0.2),
  };
  return M;
}

function hardHat(mat) {
  const g = new THREE.Group();
  const shell = new THREE.Mesh(new THREE.SphereGeometry(0.12, 28, 12, 0, Math.PI * 2, 0, Math.PI / 2), mat);
  shell.scale.set(1, 0.95, 1.18);
  g.add(shell);
  const brim = new THREE.Mesh(new THREE.CylinderGeometry(0.135, 0.14, 0.01, 32), mat);
  brim.scale.set(1, 1, 1.22);
  brim.position.z = 0.012;
  g.add(brim);
  const peak = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.008, 20, 1, false, -Math.PI / 2, Math.PI), mat);
  peak.scale.set(1.3, 1, 0.9);
  peak.position.set(0, 0.002, 0.15);
  g.add(peak);
  g.add(at(new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.02, 0.24), mat), 0, 0.112, 0)); // the ridge
  g.traverse((o) => o.isMesh && (o.castShadow = true));
  return g;
}

function vest(M) {
  const s = new THREE.Shape();
  // a vest seen from the front, hanging by its shoulders: V neck, armholes
  s.moveTo(-0.27, -0.62);
  s.lineTo(0.27, -0.62);
  s.lineTo(0.28, -0.2);
  s.quadraticCurveTo(0.17, -0.12, 0.17, 0.02);
  s.lineTo(0.14, 0.04);
  s.lineTo(0.03, -0.18);
  s.lineTo(-0.03, -0.18);
  s.lineTo(-0.14, 0.04);
  s.lineTo(-0.17, 0.02);
  s.quadraticCurveTo(-0.17, -0.12, -0.28, -0.2);
  s.closePath();
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.ExtrudeGeometry(s, { depth: 0.03, bevelEnabled: true, bevelThickness: 0.008, bevelSize: 0.008, bevelSegments: 2 }), M.vest);
  body.castShadow = true;
  g.add(body);
  for (const y of [-0.5, -0.38]) g.add(at(new THREE.Mesh(new THREE.BoxGeometry(0.56, 0.035, 0.05), M.stripe), 0, y, 0.016));
  return g;
}

/** The dispatcher's radio desk, 1.6 m wide, its front at +Z. monitorTex: what the small monitor shows. */
export function createRadioDesk({ monitorTex = null } = {}) {
  const M = mats(), g = new THREE.Group();
  g.name = "radio-desk";
  g.add(at(rb(1.6, 0.04, 0.7, 0.012, M.top), 0, 0.74, 0));
  for (const x of [-0.76, 0.76]) g.add(at(rb(0.04, 0.72, 0.62, 0.01, M.graphite), x, 0.36, -0.02));
  g.add(at(rb(0.46, 0.66, 0.6, 0.01, M.graphite), 0.5, 0.36, -0.03)); // a drawer pedestal
  // the base station: a black box with a dim amber display and a volume knob
  const radio = new THREE.Group();
  radio.add(rb(0.28, 0.075, 0.22, 0.008, M.black));
  const lcd = new THREE.Mesh(new THREE.PlaneGeometry(0.075, 0.022), new THREE.MeshBasicMaterial({ color: new THREE.Color("#ffb55e").multiplyScalar(0.55), toneMapped: false }));
  radio.add(at(lcd, -0.05, 0.008, 0.111));
  const knob = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.016, 0.018, 16), M.steel);
  knob.rotation.x = Math.PI / 2;
  radio.add(at(knob, 0.09, 0.006, 0.115));
  const led = new THREE.Mesh(new THREE.CircleGeometry(0.004, 10), new THREE.MeshBasicMaterial({ color: new THREE.Color("#46ff7a").multiplyScalar(0.9), toneMapped: false }));
  radio.add(at(led, 0.035, 0.012, 0.1115));
  g.add(at(radio, -0.35, 0.8, -0.12));
  // the gooseneck desk microphone
  {
    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.07, 0.025, 24), M.black);
    g.add(at(base, -0.05, 0.775, 0.08));
    const curve = new THREE.CatmullRomCurve3([new THREE.Vector3(-0.05, 0.78, 0.08), new THREE.Vector3(-0.05, 0.95, 0.07), new THREE.Vector3(-0.06, 1.05, 0.13), new THREE.Vector3(-0.07, 1.07, 0.2)]);
    g.add(new THREE.Mesh(new THREE.TubeGeometry(curve, 24, 0.006, 8), M.black));
    const head = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.012, 0.06, 12), M.black);
    head.rotation.x = Math.PI / 2 - 0.4;
    g.add(at(head, -0.07, 1.065, 0.225));
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.014, 0.002, 6, 16), new THREE.MeshBasicMaterial({ color: new THREE.Color("#ff4b3a").multiplyScalar(0.25), toneMapped: false }));
    ring.rotation.x = -0.4;
    g.add(at(ring, -0.07, 1.077, 0.252));
  }
  // a handheld in its desktop charger, the antenna up
  {
    g.add(at(rb(0.09, 0.05, 0.08, 0.01, M.black), 0.12, 0.785, -0.15));
    g.add(at(rb(0.06, 0.16, 0.035, 0.01, M.plastic), 0.12, 0.88, -0.15));
    g.add(at(new THREE.Mesh(new THREE.CylinderGeometry(0.005, 0.007, 0.11, 8), M.black), 0.135, 1.01, -0.15));
  }
  // a corded desk phone and the shift log (a green hardback, open)
  g.add(at(rb(0.2, 0.05, 0.18, 0.02, M.plastic), 0.5, 0.785, 0.12));
  g.add(at(rb(0.06, 0.035, 0.2, 0.015, M.plastic), 0.45, 0.82, 0.12));
  {
    const log = new THREE.Group();
    log.add(at(rb(0.42, 0.012, 0.3, 0.004, M.green), 0, 0, 0));
    log.add(at(new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.012, 0.28), M.paper), 0, 0.01, 0));
    log.rotation.y = 0.12;
    g.add(at(log, -0.32, 0.765, 0.17));
  }
  // a small monitor on a foot, angled to the chair
  {
    const mon = new THREE.Group();
    mon.add(at(rb(0.56, 0.34, 0.03, 0.008, M.black), 0, 0, -0.01));
    if (monitorTex) {
      const scr = new THREE.Mesh(new THREE.PlaneGeometry(0.53, 0.3), new THREE.MeshBasicMaterial({ map: monitorTex, toneMapped: false }));
      scr.material.color.setScalar(0.7);
      mon.add(at(scr, 0, 0, 0.006));
    }
    mon.rotation.set(-0.08, 0.3, 0);
    g.add(at(mon, 0.42, 1.0, -0.22));
    g.add(at(rb(0.04, 0.2, 0.03, 0.008, M.steel), 0.42, 0.85, -0.25));
    g.add(at(rb(0.2, 0.012, 0.16, 0.004, M.steel), 0.42, 0.765, -0.24));
  }
  // the chair, pushed in
  {
    const seat = at(rb(0.48, 0.07, 0.46, 0.03, M.plastic), -0.1, 0.48, 0.55);
    g.add(seat);
    g.add(at(rb(0.46, 0.5, 0.06, 0.03, M.plastic), -0.1, 0.8, 0.8));
    g.add(at(new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.38, 10), M.steel), -0.1, 0.27, 0.55));
    g.add(at(new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 0.03, 5), M.black), -0.1, 0.06, 0.55));
  }
  return g;
}

/** A floor stand by the door with hard hats on its pegs and hi-vis vests on its hooks. */
export function createPPEStand() {
  const M = mats(), g = new THREE.Group();
  g.name = "ppe-stand";
  g.add(at(rb(0.5, 0.03, 0.35, 0.01, M.graphite), 0, 0.015, 0));
  for (const x of [-0.22, 0.22]) g.add(at(rb(0.035, 1.8, 0.035, 0.008, M.steel), x, 0.9, 0));
  g.add(at(rb(0.52, 0.03, 0.04, 0.008, M.steel), 0, 1.78, 0));
  g.add(at(rb(0.52, 0.03, 0.04, 0.008, M.steel), 0, 1.32, 0));
  [M.white, M.white, M.orange].forEach((m, i) => {
    const h = hardHat(m);
    h.position.set(-0.18 + i * 0.18, 1.8, 0.02);
    h.rotation.y = (i - 1) * 0.3;
    g.add(h);
  });
  for (const [x, ry] of [[-0.12, 0.08], [0.13, -0.1]]) {
    const v = vest(M);
    v.position.set(x, 1.3, 0.05 + (x > 0 ? 0.04 : 0));
    v.rotation.y = ry;
    v.scale.setScalar(0.92);
    g.add(v);
  }
  // a fire extinguisher beside it
  const ext = new THREE.Group();
  ext.add(at(new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 0.5, 20), M.red), 0, 0.25, 0));
  ext.add(at(new THREE.Mesh(new THREE.SphereGeometry(0.08, 20, 8, 0, Math.PI * 2, 0, Math.PI / 2), M.red), 0, 0.5, 0));
  ext.add(at(rb(0.05, 0.08, 0.06, 0.01, M.black), 0, 0.6, 0));
  ext.add(at(rb(0.14, 0.012, 0.03, 0.005, M.black), 0.04, 0.65, 0));
  ext.traverse((o) => o.isMesh && (o.castShadow = true));
  g.add(at(ext, 0.45, 0, 0.05));
  return g;
}

/** The shift board: a 1.8 × 1.2 m whiteboard with the shift's work order in marker (not legible). */
export function createShiftBoard() {
  const M = mats(), g = new THREE.Group();
  g.name = "shift-board";
  const W = 1.8, H = 1.2, px = 1440, py = 960;
  const c = document.createElement("canvas");
  c.width = px;
  c.height = py;
  const x = c.getContext("2d"), r = rng(29);
  x.fillStyle = "#e7e7e2";
  x.fillRect(0, 0, px, py);
  // ghosts of old marker
  x.strokeStyle = "rgba(120,130,150,0.12)";
  x.lineWidth = 9;
  for (let i = 0; i < 16; i++) {
    x.beginPath();
    x.moveTo(r() * px, r() * py);
    x.bezierCurveTo(r() * px, r() * py, r() * px, r() * py, r() * px, r() * py);
    x.stroke();
  }
  // the printed head and the ruled grid (tape lines)
  x.fillStyle = "#1d3f73";
  x.font = `700 64px "Inter", system-ui, sans-serif`;
  x.fillText("НАРЯД НА СМЕНУ", 48, 92);
  x.fillStyle = "#30343b";
  const cols = [48, 330, 720, 1080, px - 48], rows = 9, top = 150, rh = (py - top - 40) / rows;
  for (let i = 0; i <= rows; i++) x.fillRect(48, top + i * rh, px - 96, i === 0 || i === 1 ? 4 : 2);
  for (const cx of cols) x.fillRect(cx, top, 2, rows * rh);
  x.font = `600 34px "Inter", system-ui, sans-serif`;
  ["участок", "техника", "задание", "ответственный"].forEach((h, i) => x.fillText(h, cols[i] + 14, top + rh * 0.68));
  // handwriting: marker strokes in rows, blue and black, a few red; scribbles, not words
  const pen = ["#1b2f8a", "#16181c", "#16181c", "#b3261e"];
  for (let i = 1; i < rows; i++)
    for (let j = 0; j < 4; j++) {
      if (r() < 0.18) continue;
      x.strokeStyle = pen[Math.floor(r() * (j === 2 ? 4 : 3))];
      x.lineWidth = 4.5;
      x.lineCap = x.lineJoin = "round";
      let cx = cols[j] + 18;
      const end = cols[j] + 18 + (cols[j + 1] - cols[j] - 40) * (0.4 + 0.55 * r());
      const y = top + i * rh + rh * 0.62;
      x.beginPath();
      x.moveTo(cx, y);
      while (cx < end) {
        const w = 10 + r() * 16, h = 10 + r() * 20;
        x.quadraticCurveTo(cx + w * 0.3, y - h, cx + w * 0.6, y - h * 0.2);
        x.quadraticCurveTo(cx + w * 0.8, y + 4, cx + w, y - r() * 6);
        cx += w;
        if (r() < 0.16) {
          x.stroke();
          cx += 14;
          x.beginPath();
          x.moveTo(cx, y);
        }
      }
      x.stroke();
    }
  // magnets
  for (let i = 0; i < 7; i++) {
    x.fillStyle = ["#c0392b", "#2b6cb0", "#d69e2e", "#2f855a"][i % 4];
    x.beginPath();
    x.arc(px - 90 - (i % 2) * 38, top + rh * (1.6 + i), 14, 0, Math.PI * 2);
    x.fill();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  const face = new THREE.Mesh(new THREE.PlaneGeometry(W, H), std({ map: tex, roughness: 0.22, metalness: 0 }, 0.7));
  face.receiveShadow = true;
  g.add(face);
  const alu = std({ color: "#9ea3a8", roughness: 0.35, metalness: 0.9 }, 0.9);
  for (const [w, h, x0, y0] of [[W + 0.05, 0.025, 0, H / 2], [W + 0.05, 0.025, 0, -H / 2], [0.025, H, W / 2, 0], [0.025, H, -W / 2, 0]]) g.add(at(rb(w, h, 0.025, 0.006, alu), x0, y0, 0.005));
  g.add(at(rb(0.6, 0.02, 0.07, 0.006, alu), 0.3, -H / 2 - 0.02, 0.035)); // the marker tray
  for (let i = 0; i < 3; i++) {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(0.009, 0.009, 0.13, 8), [M.black, M.plastic, M.red][i]);
    m.rotation.z = Math.PI / 2;
    g.add(at(m, 0.12 + i * 0.12, -H / 2 - 0.002, 0.04));
  }
  return g;
}
