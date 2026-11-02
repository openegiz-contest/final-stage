// The dispatch board: a dim video wall, the kind every mine dispatch room has (references 02, 03): one
// 110" display on the left (the size of 2 × 2 55" panels, 16:9) and a column of two 55" panels on the
// right (stage-tv, owner 2026-10-28: «видео на телевизоре», «целый экран, а не четыре»: the Finalists'
// minutes play on the big one, ui/program.js). It shows the pit outside as a plan, not as numbers: bench crests, the haul
// road, the shovel, the masts and the crusher, and the haul trucks as live markers that move where
// the trucks outside move (props/pitgeo.js); a route strip of the same fleet; a legend. Every word
// on it names a thing on the map; there are no readings, no counts, nothing from the show.
// Local frame: the screen faces +Z, its centre at the origin.
import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { C, RA, RB, N, CREST, RUN, FAR, wallXZ, ROAD, roadAt, FLEET, truckAt, MASTS } from "./pitgeo.js";
import { onFrame } from "./shared.js";

const PW = 1.21, PH = 0.68, COLS = 3, ROWS = 2;   // a 55" panel, metres
export const BOARD_W = PW * COLS, BOARD_H = PH * ROWS;
// stage-tv: the big screen in the board's local frame (its centre, metres) and the bezel between it and
// the column (canvas px of the wall's 2400-wide picture, ui/program.js paints the same seams)
export const TV = { x: -BOARD_W / 2 + PW, y: 0, w: 2 * PW, h: 2 * PH };
export const SEAM = { tv: 10, panel: 6 };
// ---- end stage-tv
const PX = 2400, PY = Math.round((PX * BOARD_H) / BOARD_W);
const SANS = '"Inter", system-ui, sans-serif', MONO = '"IBM Plex Mono", ui-monospace, monospace';
const K = { bg: "#070b11", panel: "#0b1119", grid: "#111a25", bench: "#28405a", rim: "#5d7d9c", floor: "#0e1824", road: "#c7954a", text: "#b8c4d2", dim: "#5f6e80", rule: "#1b2634", bezel: "#020203" };

// the plan's window onto the pit (metres, the far side up)
const PLAN = { x0: C.x - 980, x1: C.x + 980, z0: C.z - RB - 300, z1: 80 }; // from the plant beyond the far rim to the control room
const planW = (PX * 2) / 3, head = 64; // the plan fills the left two columns under a title bar
const toPlan = (x, z) => {
  const s = Math.min(planW / (PLAN.x1 - PLAN.x0), (PY - head - 20) / (PLAN.z1 - PLAN.z0));
  const ox = (planW - s * (PLAN.x1 - PLAN.x0)) / 2, oy = head + 10;
  return [ox + (x - PLAN.x0) * s, oy + (z - PLAN.z0) * s, s];
};
// the route strip (right column, top panel): the road unrolled, shovel at the left, crusher at the right
const ROUTE = { x0: planW + 70, x1: PX - 70, y: PY * 0.25 + 22 };

function drawBoard() {
  const c = document.createElement("canvas");
  c.width = PX;
  c.height = PY;
  const g = c.getContext("2d");
  g.fillStyle = K.bg;
  g.fillRect(0, 0, PX, PY);

  // ---- the plan
  g.save();
  g.beginPath();
  g.rect(0, head, planW, PY - head);
  g.clip();
  g.strokeStyle = K.grid;
  g.lineWidth = 1;
  const [, , s] = toPlan(0, 0);
  for (let x = Math.ceil(PLAN.x0 / 100) * 100; x < PLAN.x1; x += 100) {
    const [px] = toPlan(x, 0);
    g.beginPath(), g.moveTo(px, head), g.lineTo(px, PY), g.stroke();
  }
  for (let z = Math.ceil(PLAN.z0 / 100) * 100; z < PLAN.z1; z += 100) {
    const [, py] = toPlan(0, z);
    g.beginPath(), g.moveTo(0, py), g.lineTo(planW, py), g.stroke();
  }
  const ring = (d) => {
    g.beginPath();
    for (let i = 0; i <= 256; i++) {
      const th = (i / 256) * Math.PI * 2, p = wallXZ(th, d), [x, y] = toPlan(p.x, p.z);
      i ? g.lineTo(x, y) : g.moveTo(x, y);
    }
    g.closePath();
  };
  ring(RUN);
  g.fillStyle = K.floor;
  g.fill();
  for (let k = N; k >= 0; k--) {
    ring(CREST[k]);
    g.strokeStyle = k === 0 ? K.rim : K.bench;
    g.lineWidth = k === 0 ? 3 : 1.6;
    g.stroke();
  }
  // the dumps beyond the rim, dashed
  g.setLineDash([10, 8]);
  g.strokeStyle = K.dim;
  g.lineWidth = 1.5;
  for (const [th, d, rad] of [[FAR + 0.95, -520, 420], [FAR - 1.15, -460, 380], [FAR + 0.3, -900, 300]]) {
    const p = wallXZ(th, d), [x, y] = toPlan(p.x, p.z);
    g.beginPath();
    g.ellipse(x, y, rad * 1.6 * s * 0.5, rad * s * 0.5, -th, 0, Math.PI * 2);
    g.stroke();
  }
  g.setLineDash([]);
  // the haul road
  g.strokeStyle = K.road;
  g.lineWidth = 6;
  g.lineJoin = "round";
  g.beginPath();
  ROAD.pts.forEach((p, i) => {
    const [x, y] = toPlan(p.x, p.z);
    i ? g.lineTo(x, y) : g.moveTo(x, y);
  });
  g.stroke();
  // the shovel (a square with its boom), the crusher (a filled square), the masts (rings)
  const sym = (kind, x, y) => {
    g.strokeStyle = g.fillStyle = K.text;
    g.lineWidth = 2.5;
    if (kind === "shovel") {
      g.strokeRect(x - 9, y - 9, 18, 18);
      g.beginPath(), g.moveTo(x, y - 9), g.lineTo(x, y - 24), g.stroke();
    } else if (kind === "crusher") g.fillRect(x - 11, y - 11, 22, 22);
    else if (kind === "mast") {
      g.beginPath(), g.arc(x, y, 7, 0, Math.PI * 2), g.stroke();
      g.beginPath(), g.arc(x, y, 2, 0, Math.PI * 2), g.fill();
    }
  };
  {
    const p0 = ROAD.pts[0], [x0, y0] = toPlan(p0.x, p0.z);
    sym("shovel", x0, y0);
    const e = ROAD.pts.at(-1), [x1, y1] = toPlan(e.x, e.z);
    sym("crusher", x1, y1);
    for (const [th, d] of MASTS) {
      const p = wallXZ(th, d), [x, y] = toPlan(p.x, p.z);
      sym("mast", x, y);
    }
  }
  // the control room on the near rim
  {
    const [x, y] = toPlan(0, 0);
    g.fillStyle = K.text;
    g.beginPath(), g.moveTo(x, y - 12), g.lineTo(x + 10, y + 6), g.lineTo(x - 10, y + 6), g.closePath(), g.fill();
    g.font = `500 22px ${SANS}`;
    g.fillStyle = K.dim;
    g.textAlign = "left";
    g.fillText("диспетчерская", x + 18, y + 8);
  }
  // north and a scale bar
  {
    const x = planW - 60, y = head + 50;
    g.strokeStyle = g.fillStyle = K.dim;
    g.lineWidth = 2;
    g.beginPath(), g.moveTo(x, y + 30), g.lineTo(x, y - 18), g.stroke();
    g.beginPath(), g.moveTo(x, y - 26), g.lineTo(x + 8, y - 12), g.lineTo(x - 8, y - 12), g.closePath(), g.fill();
    g.font = `600 22px ${SANS}`;
    g.textAlign = "center";
    g.fillText("С", x, y + 56);
    const L = 200 * s, bx = planW - 60 - L, by = PY - 40;
    g.fillRect(bx, by, L, 3);
    g.fillRect(bx, by - 8, 2, 11), g.fillRect(bx + L - 2, by - 8, 2, 11);
    g.font = `500 22px ${SANS}`;
    g.fillText("200 м", bx + L / 2, by - 12);
  }
  g.restore();

  // ---- title bars, one per region
  const bar = (x, w, title, tag) => {
    g.fillStyle = K.panel;
    g.fillRect(x, 0, w, head);
    g.fillStyle = K.rule;
    g.fillRect(x, head - 2, w, 2);
    g.fillStyle = K.text;
    g.font = `600 30px ${SANS}`;
    g.textAlign = "left";
    g.fillText(title, x + 26, 42);
    if (tag) {
      g.fillStyle = K.dim;
      g.font = `500 22px ${SANS}`;
      g.textAlign = "right";
      g.fillText(tag, x + w - 26, 40);
    }
  };
  bar(0, planW, "КАРЬЕР · ПЛАН ГОРНЫХ РАБОТ", "схема");
  bar(planW, PX - planW, "ТРАНСПОРТ НА ЛИНИИ", "маршрут");

  // ---- the route strip
  {
    const { x0, x1, y } = ROUTE;
    g.strokeStyle = K.road;
    g.lineWidth = 5;
    g.beginPath(), g.moveTo(x0, y), g.lineTo(x1, y), g.stroke();
    // the hairpins as ticks
    g.strokeStyle = K.dim;
    g.lineWidth = 2;
    for (const f of [0.08, 0.3, 0.52, 0.74, 0.92]) {
      const x = x0 + (x1 - x0) * f;
      g.beginPath(), g.moveTo(x, y - 10), g.lineTo(x, y + 10), g.stroke();
    }
    sym("shovel", x0, y);
    sym("crusher", x1, y);
    g.font = `500 22px ${SANS}`;
    g.fillStyle = K.dim;
    g.textAlign = "left";
    g.fillText("забой", x0 - 12, y + 52);
    g.textAlign = "center";
    g.fillText("съезд", (x0 + x1) / 2, y + 52);
    g.textAlign = "right";
    g.fillText("дробилка", x1 + 12, y + 52);
    g.textAlign = "left";
    g.fillText("гружёные →", x0 - 12, y - 46);
    g.textAlign = "right";
    g.fillText("← порожние", x1 + 12, y + 92);
  }

  // ---- the legend (right column, bottom panel)
  {
    const x = planW + 60, y0 = PY / 2 + 70, dy = 52;
    g.font = `600 24px ${SANS}`;
    g.fillStyle = K.dim;
    g.textAlign = "left";
    g.fillText("УСЛОВНЫЕ ОБОЗНАЧЕНИЯ", x - 10, y0 - 22);
    const rows = [
      ["truck-l", "самосвал гружёный"], ["truck-e", "самосвал порожний"], ["shovel", "экскаватор"],
      ["mast", "мачта освещения"], ["crusher", "дробилка"], ["road", "автодорога"], ["bench", "бровка уступа"],
    ];
    rows.forEach(([kind, label], i) => {
      const yy = y0 + 18 + i * dy, xx = x + 20;
      if (kind === "truck-l" || kind === "truck-e") {
        g.beginPath(), g.moveTo(xx + 14, yy), g.lineTo(xx - 10, yy - 11), g.lineTo(xx - 10, yy + 11), g.closePath();
        if (kind === "truck-l") (g.fillStyle = K.road), g.fill();
        else (g.strokeStyle = "#d6dde6"), (g.lineWidth = 2.5), g.stroke();
      } else if (kind === "road") (g.fillStyle = K.road), g.fillRect(xx - 16, yy - 3, 32, 6);
      else if (kind === "bench") (g.fillStyle = K.bench), g.fillRect(xx - 16, yy - 1, 32, 3);
      else sym(kind, xx, yy);
      g.fillStyle = K.text;
      g.font = `500 26px ${SANS}`;
      g.fillText(label, x + 60, yy + 9);
    });
  }

  // ---- the seams: the big screen's edge and the column's two panels (3.5 mm bezels; stage-tv)
  g.fillStyle = K.bezel;
  g.fillRect((PX * 2) / COLS - SEAM.tv / 2, 0, SEAM.tv, PY);
  g.fillRect((PX * 2) / COLS, PY / 2 - SEAM.panel / 2, PX / COLS, SEAM.panel);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

/** The board on its frame. level: the panels' brightness (dim: a night-mode video wall). */
export function createBoard({ level = 0.72 } = {}) {
  const g = new THREE.Group();
  g.name = "dispatch-board";
  const frame = new THREE.Mesh(new RoundedBoxGeometry(BOARD_W + 0.06, BOARD_H + 0.06, 0.09, 2, 0.01),
    Object.assign(new THREE.MeshStandardMaterial({ color: "#0c0c0d", roughness: 0.4, metalness: 0.3 }), { userData: { env: 0.6 } }));
  frame.position.z = -0.05;
  g.add(frame);
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(BOARD_W, BOARD_H), new THREE.MeshBasicMaterial({ map: drawBoard(), toneMapped: false }));
  screen.material.color.setScalar(level);
  g.add(screen);

  // live truck markers: on the plan and on the route strip
  const W = BOARD_W / PX, H = BOARD_H / PY; // metres per canvas pixel
  const tri = new THREE.ShapeGeometry(new THREE.Shape([new THREE.Vector2(14, 0), new THREE.Vector2(-10, -11), new THREE.Vector2(-10, 11)]));
  tri.scale(W, W, 1);
  const loadedMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(K.road).multiplyScalar(level * 1.5), toneMapped: false });
  const emptyMat = new THREE.MeshBasicMaterial({ color: new THREE.Color("#d6dde6").multiplyScalar(level * 1.1), toneMapped: false });
  const markers = FLEET.map(() => {
    const plan = new THREE.Mesh(tri, loadedMat), route = new THREE.Mesh(tri, loadedMat);
    plan.position.z = route.position.z = 0.002;
    plan.userData.marker = "plan"; // stage-tv: the route strip's trucks stay on while the big screen plays
    route.userData.marker = "route";
    g.add(plan, route);
    return { plan, route };
  });
  const at = (m, px, py) => m.position.set(-BOARD_W / 2 + px * W, BOARD_H / 2 - py * H, 0.002);
  onFrame((t) => {
    FLEET.forEach((f, i) => {
      const s = truckAt(f, t), m = markers[i];
      const [x, y] = toPlan(s.x, s.z);
      at(m.plan, x, y);
      m.plan.rotation.z = Math.atan2(-Math.cos(s.yaw), Math.sin(s.yaw)); // heading on the plan (world z runs down the canvas)
      const u = s.s / ROAD.length;
      at(m.route, ROUTE.x0 + (ROUTE.x1 - ROUTE.x0) * u, ROUTE.y + (s.loaded ? -22 : 22));
      m.route.rotation.z = s.loaded ? 0 : Math.PI;
      m.plan.material = m.route.material = s.loaded ? loadedMat : emptyMat;
    });
  });
  // ---- stage-tv: the big screen's own picture over the wall's (a Stand video, a screenshot): two layers,
  // added light over the wall's black, so one fades in as the other fades out; ui/program.js sets their
  // maps, sizes (letterboxed inside TV) and opacities. Hidden while the wall shows its own page.
  const tv = new THREE.Group();
  tv.name = "dispatch-tv";
  tv.position.set(TV.x, TV.y, 0.003);
  tv.visible = false;
  const layers = [0, 1].map((i) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({
      color: 0xffffff, toneMapped: false, transparent: true, opacity: 1, depthWrite: false, blending: THREE.AdditiveBlending,
    }));
    m.position.z = i * 0.001;
    m.renderOrder = 2 + i;
    m.visible = false;
    tv.add(m);
    return m;
  });
  g.add(tv);
  // ---- end stage-tv
  return { object3d: g, screen, tv: { object3d: tv, layers } };
}
