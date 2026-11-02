// The mine's dispatch room at night (references 01-04): a raised floor of dark tiles, the panoramic
// glass arc (steel mullions, a low sill, a bulkhead with a downlight in every bay) with the pit
// behind it, a 600 mm grid ceiling with dimmed slot fixtures and cable trays, a downlight over each
// console and a recessed luminaire over the ballot station. The room's own kit: the dispatch board
// with the pit's plan on the left wall, the shift board on the right, the dispatcher's radio desk
// and the hard-hat stand at the ends of the glass, equipment cabinets toward the back. The light is
// the screens', the downlights', the moon's through the glass and a dim fill from the back.
import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { ROOM, LIGHT } from "./palette.js";
import { GLASS_R, GLASS_SPAN, SILL, HEADER, CEILING, BACK_Z, SIDE_X, DESKS, BALLOT } from "./layout.js";
import { rng } from "./timeline.js";
import { createBoard } from "./props/board.js";
import { createRadioDesk, createPPEStand, createShiftBoard } from "./props/kit.js";

const DEG = Math.PI / 180;
const CEIL_SPAN = 20; // the ceiling texture covers 20 × 20 m centred on the room

/** The ceiling: acoustic tiles in a T-bar grid, slot fixtures. Colour, and emissive (fixtures plus the
 *  soft light they leave on the tiles next to them). World-mapped, one texture for the whole room. */
function ceilingMaps() {
  const N = 2048, ppm = N / CEIL_SPAN, tile = 0.6 * ppm;
  const px = (m) => (m + CEIL_SPAN / 2) * ppm; // metres (x, or z) -> pixels
  const c = document.createElement("canvas");
  c.width = c.height = N;
  const g = c.getContext("2d"), r = rng(13);
  g.fillStyle = "rgb(150,148,143)";
  g.fillRect(0, 0, N, N);
  for (let i = 0; i < N / tile; i++)
    for (let j = 0; j < N / tile; j++) {
      const v = 140 + Math.round(r() * 18);
      g.fillStyle = `rgb(${v},${v - 1},${v - 4})`;
      g.fillRect(i * tile + 2, j * tile + 2, tile - 4, tile - 4);
    }
  g.fillStyle = "rgb(205,205,200)"; // the T-bar
  for (let k = 0; k <= N / tile; k++) {
    g.fillRect(k * tile - 1.5, 0, 3, N);
    g.fillRect(0, k * tile - 1.5, N, 3);
  }
  const e = document.createElement("canvas");
  e.width = e.height = N;
  const h = e.getContext("2d");
  h.fillStyle = "rgb(30,28,26)"; // the room's bounce on the tiles: the grid reads, the ceiling is not a black band
  h.fillRect(0, 0, N, N);
  // slot fixtures, 1.2 × 0.15 m, in rows across the room (inside the D, clear of the bulkhead)
  const slots = [];
  for (const z of [-6.0, -3.6, -1.2, 1.2, 3.6, 6.0])
    for (let x = -7.2; x <= 7.21; x += 2.4) {
      if (z < 0 && Math.hypot(x + 0.6, z) > GLASS_R - 1.4) continue;
      if (Math.hypot(x - BALLOT.x, z - BALLOT.z) < 1.0) continue;
      slots.push([x, z]);
    }
  for (const [x, z] of slots) {
    const X = px(x), Z = px(-z); // canvas rows run against world z (the texture is flipped in v)
    const halo = h.createRadialGradient(X, Z, 0, X, Z, 1.5 * ppm);
    halo.addColorStop(0, "rgba(255,226,190,0.32)");
    halo.addColorStop(1, "rgba(255,226,190,0)");
    h.fillStyle = halo;
    h.fillRect(X - 1.5 * ppm, Z - 1.5 * ppm, 3 * ppm, 3 * ppm);
    g.fillStyle = "rgb(60,60,62)"; // the slot's housing
    g.fillRect(X - 0.62 * ppm, Z - 0.09 * ppm, 1.24 * ppm, 0.18 * ppm);
    h.fillStyle = "rgb(214,196,170)";
    h.fillRect(X - 0.6 * ppm, Z - 0.07 * ppm, 1.2 * ppm, 0.14 * ppm);
  }
  const mk = (cv, srgb) => {
    const t = new THREE.CanvasTexture(cv);
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 16;
    return t;
  };
  return { color: mk(c, true), glow: mk(e, true), slots };
}

const std = (o, env = 0.5) => Object.assign(new THREE.MeshStandardMaterial(o), { userData: { env } });
const at = (o, x, y, z) => (o.position.set(x, y, z), o);
const shadowy = (m) => ((m.castShadow = m.receiveShadow = true), m);

/** Raised-floor tiles: 0.6 m squares, faint seams, a little wear. Colour and roughness maps. */
function floorMaps() {
  const N = 1024, tiles = 4; // the texture covers 4 × 4 tiles (2.4 m)
  const c = document.createElement("canvas");
  c.width = c.height = N;
  const g = c.getContext("2d"), r = rng(5);
  const step = N / tiles;
  for (let i = 0; i < tiles; i++)
    for (let j = 0; j < tiles; j++) {
      const v = 200 + Math.round(r() * 26);
      g.fillStyle = `rgb(${v},${v},${v - 3})`;
      g.fillRect(i * step, j * step, step, step);
    }
  for (let k = 0; k < 9000; k++) {
    const v = 170 + Math.round(r() * 70);
    g.fillStyle = `rgba(${v},${v},${v},0.18)`;
    g.fillRect(r() * N, r() * N, 1 + r() * 2, 1 + r() * 2);
  }
  g.fillStyle = "rgb(70,70,70)";
  for (let i = 0; i <= tiles; i++) {
    g.fillRect(i * step - 2, 0, 4, N);
    g.fillRect(0, i * step - 2, N, 4);
  }
  const color = new THREE.CanvasTexture(c);
  color.colorSpace = THREE.SRGBColorSpace;
  color.wrapS = color.wrapT = THREE.RepeatWrapping;
  color.anisotropy = 8;
  // roughness: seams rough, tiles satin with soft scuffs
  const c2 = document.createElement("canvas");
  c2.width = c2.height = 512;
  const h = c2.getContext("2d");
  h.fillStyle = "rgb(120,120,120)";
  h.fillRect(0, 0, 512, 512);
  for (let k = 0; k < 160; k++) {
    const x = r() * 512, y = r() * 512, rad = 10 + r() * 50;
    const gr = h.createRadialGradient(x, y, 0, x, y, rad), v = Math.round(170 + r() * 50);
    gr.addColorStop(0, `rgba(${v},${v},${v},0.25)`);
    gr.addColorStop(1, "rgba(120,120,120,0)");
    h.fillStyle = gr;
    h.fillRect(x - rad, y - rad, rad * 2, rad * 2);
  }
  h.fillStyle = "rgb(235,235,235)";
  const s2 = 512 / tiles;
  for (let i = 0; i <= tiles; i++) {
    h.fillRect(i * s2 - 1, 0, 2, 512);
    h.fillRect(0, i * s2 - 1, 512, 2);
  }
  const rough = new THREE.CanvasTexture(c2);
  rough.wrapS = rough.wrapT = THREE.RepeatWrapping;
  return { color, rough };
}

export function createHall({ lite = false } = {}) {
  const g = new THREE.Group();
  const lights = {};

  // ---- floor: the D of the room
  {
    const { color, rough } = floorMaps();
    const shape = new THREE.Shape();
    const N = 96;
    for (let i = 0; i <= N; i++) {
      const a = -GLASS_SPAN + (2 * GLASS_SPAN * i) / N;
      const x = (GLASS_R + 0.3) * Math.sin(a), y = (GLASS_R + 0.3) * Math.cos(a); // shape y = -world z
      i ? shape.lineTo(x, y) : shape.moveTo(x, y);
    }
    shape.lineTo(SIDE_X + 0.3, -BACK_Z - 0.3);
    shape.lineTo(-SIDE_X - 0.3, -BACK_Z - 0.3);
    const geo = new THREE.ShapeGeometry(shape, 24);
    geo.rotateX(-Math.PI / 2);
    // uv in metres / 2.4 (one texture = 4 × 4 tiles)
    const p = geo.attributes.position, uv = geo.attributes.uv;
    for (let i = 0; i < p.count; i++) uv.setXY(i, p.getX(i) / 2.4, p.getZ(i) / 2.4);
    const mat = std({ color: ROOM.floor, map: color, roughness: 0.62, roughnessMap: rough, metalness: 0.05 }, 0.55);
    const floor = new THREE.Mesh(geo, mat);
    floor.receiveShadow = true;
    g.add(floor);
  }

  // ---- the glass arc: sill, mullions, header, the pane (a faint tint plus real reflections)
  const frameMat = std({ color: "#2b2d30", roughness: 0.42, metalness: 0.8 }, 0.8);
  const sillMat = std({ color: ROOM.panel, roughness: 0.7, metalness: 0.2 }, 0.4);
  const arc = (r, y0, y1, mat, segs = 128, open = true) => {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, y1 - y0, segs, 1, open, Math.PI - GLASS_SPAN, 2 * GLASS_SPAN), mat);
    m.position.y = (y0 + y1) / 2;
    return m;
  };
  sillMat.side = THREE.DoubleSide;
  g.add(shadowy(arc(GLASS_R - 0.12, 0, SILL, sillMat)));
  {
    // the sill's top ledge
    const ledge = new THREE.Mesh(new THREE.RingGeometry(GLASS_R - 0.36, GLASS_R + 0.02, 128, 1, Math.PI / 2 - GLASS_SPAN, 2 * GLASS_SPAN), std({ color: "#3a3936", roughness: 0.4, metalness: 0.6 }, 0.8));
    // RingGeometry spans its XY plane from +X counter-clockwise: laid flat, the span is centred on -Z
    ledge.rotation.set(-Math.PI / 2, 0, 0);
    ledge.position.y = SILL;
    g.add(ledge);
  }
  const headerMat = std({ color: "#1a1918", roughness: 0.75, metalness: 0.15 }, 0.3);
  headerMat.side = THREE.DoubleSide;
  g.add(arc(GLASS_R - 0.05, HEADER, CEILING, headerMat));
  const MULL = 19;
  const mull = new THREE.InstancedMesh(new RoundedBoxGeometry(0.09, HEADER - SILL, 0.22, 2, 0.015), frameMat, MULL);
  mull.castShadow = true;
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), Y = new THREE.Vector3(0, 1, 0), one = new THREE.Vector3(1, 1, 1);
  for (let i = 0; i < MULL; i++) {
    const a = -GLASS_SPAN + (2 * GLASS_SPAN * i) / (MULL - 1);
    q.setFromAxisAngle(Y, -a);
    m4.compose(new THREE.Vector3(GLASS_R * Math.sin(a), (SILL + HEADER) / 2, -GLASS_R * Math.cos(a)), q, one);
    mull.setMatrixAt(i, m4);
  }
  g.add(mull);
  for (const [y, h] of [[SILL + 0.03, 0.06], [HEADER - 0.04, 0.08]]) {
    const t = new THREE.Mesh(new THREE.TorusGeometry(GLASS_R, h / 2, 6, 160, 2 * GLASS_SPAN), frameMat);
    t.rotation.set(Math.PI / 2, 0, -Math.PI / 2 - GLASS_SPAN);
    t.position.y = y;
    g.add(t);
  }
  const tint = new THREE.MeshBasicMaterial({ color: "#05070a", transparent: true, opacity: 0.16, depthWrite: false, side: THREE.DoubleSide });
  const reflect = std({ color: "#000000", roughness: 0.035, metalness: 0.0, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.FrontSide }, 0.9);
  const pane = arc(GLASS_R, SILL, HEADER, tint);
  pane.renderOrder = 5;
  const paneR = arc(GLASS_R - 0.01, SILL, HEADER, reflect);
  paneR.material.side = THREE.BackSide; // seen from inside
  paneR.renderOrder = 6;
  g.add(pane, paneR);

  // ---- walls and ceiling
  const wallMat = std({ color: ROOM.wall, roughness: 0.82, metalness: 0.05 }, 0.3);
  const ends = [-1, 1].map((s) => new THREE.Vector3(s * SIDE_X, 0, -GLASS_R * Math.cos(GLASS_SPAN)));
  for (const e of ends) {
    const len = BACK_Z - e.z;
    const w = shadowy(new THREE.Mesh(new THREE.BoxGeometry(0.2, CEILING, len), wallMat));
    w.position.set(e.x + Math.sign(e.x) * 0.1, CEILING / 2, e.z + len / 2);
    g.add(w);
  }
  g.add(at(new THREE.Mesh(new THREE.BoxGeometry(2 * SIDE_X + 0.4, CEILING, 0.2), wallMat), 0, CEILING / 2, BACK_Z + 0.1));
  // the ceiling: a 600 mm acoustic grid with recessed slot fixtures, dimmed for the night shift.
  // One texture over the whole room (20 × 20 m): colour, and an emissive map with the fixtures and
  // the light they leave on the tiles around them.
  {
    const { color, glow } = ceilingMaps();
    const ceilMat = std({ color: "#8d8b86", map: color, roughness: 0.92, metalness: 0, emissive: "#ffffff", emissiveMap: glow, emissiveIntensity: 1 }, 0.15);
    const geo = new THREE.PlaneGeometry(CEIL_SPAN, CEIL_SPAN);
    geo.rotateX(Math.PI / 2);
    const ceil = new THREE.Mesh(geo, ceilMat);
    ceil.position.y = CEILING;
    g.add(ceil);
  }
  // a bulkhead along the glass: the soffit over the windows with a small downlight in every bay
  {
    const soffitMat = std({ color: "#3b3a37", roughness: 0.85, metalness: 0.05 }, 0.2);
    soffitMat.side = THREE.DoubleSide;
    const R0 = GLASS_R - 0.65;
    const soffit = new THREE.Mesh(new THREE.RingGeometry(R0, GLASS_R - 0.04, 128, 1, Math.PI / 2 - GLASS_SPAN, 2 * GLASS_SPAN), soffitMat);
    soffit.rotation.x = -Math.PI / 2;
    soffit.position.y = HEADER;
    g.add(soffit);
    const fascia = new THREE.Mesh(new THREE.CylinderGeometry(R0, R0, CEILING - HEADER, 128, 1, true, Math.PI - GLASS_SPAN, 2 * GLASS_SPAN), soffitMat);
    fascia.position.y = (CEILING + HEADER) / 2;
    g.add(fascia);
    const lensMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(LIGHT.warm).multiplyScalar(1.15), toneMapped: false });
    const ring = new THREE.MeshBasicMaterial({ color: "#5c5a55" });
    const BAYS = 18, lensGeo = new THREE.CircleGeometry(0.045, 20).rotateX(Math.PI / 2), trimGeo = new THREE.RingGeometry(0.045, 0.065, 20).rotateX(Math.PI / 2);
    const lensI = new THREE.InstancedMesh(lensGeo, lensMat, BAYS), trimI = new THREE.InstancedMesh(trimGeo, ring, BAYS);
    const m = new THREE.Matrix4();
    for (let i = 0; i < BAYS; i++) {
      const a = -GLASS_SPAN + (2 * GLASS_SPAN * (i + 0.5)) / BAYS, r = GLASS_R - 0.33;
      m.makeTranslation(r * Math.sin(a), HEADER - 0.002, -r * Math.cos(a));
      lensI.setMatrixAt(i, m);
      trimI.setMatrixAt(i, m);
    }
    g.add(lensI, trimI);
  }
  // cable trays under the ceiling, following the glass, and two across the room
  {
    const trayMat = std({ color: "#4a4b4d", roughness: 0.5, metalness: 0.85 }, 0.7);
    const t = new THREE.Mesh(new THREE.TorusGeometry(GLASS_R - 1.1, 0.04, 4, 120, 2 * GLASS_SPAN * 0.95), trayMat);
    t.rotation.set(Math.PI / 2, 0, -Math.PI / 2 - GLASS_SPAN * 0.95);
    t.scale.set(1, 1, 1.8);
    t.position.y = CEILING - 0.35;
    g.add(t);
    for (const z of [-2.6, 1.2]) g.add(at(new THREE.Mesh(new THREE.BoxGeometry(2 * SIDE_X - 0.6, 0.06, 0.3), trayMat), 0, CEILING - 0.3, z));
  }
  // equipment cabinets toward the back of both side walls: dark steel, perforated doors, steel handles,
  // a status LED on each
  {
    const cab = std({ color: "#1e1f21", roughness: 0.55, metalness: 0.55 }, 0.6);
    const perf = std({ color: "#121314", roughness: 0.75, metalness: 0.4 }, 0.4);
    const handle = std({ color: ROOM.steel, roughness: 0.3, metalness: 1 }, 1);
    const ledOn = new THREE.MeshBasicMaterial({ color: new THREE.Color("#5dff8a").multiplyScalar(0.8), toneMapped: false });
    for (const s of [-1, 1]) {
      for (let i = 0; i < 6; i++) {
        const z = 3.0 + i * 0.66;
        const x = s * (SIDE_X - 0.45);
        g.add(shadowy(at(new THREE.Mesh(new RoundedBoxGeometry(0.8, 2.1, 0.62, 2, 0.02), cab), x, 1.05, z)));
        g.add(at(new THREE.Mesh(new THREE.BoxGeometry(0.02, 1.9, 0.56), perf), x - s * 0.41, 1.05, z));
        g.add(at(new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.3, 0.025), handle), x - s * 0.43, 1.1, z + 0.22));
        g.add(at(new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.012, 0.012), ledOn), x - s * 0.425, 1.92, z - 0.2));
      }
    }
  }
  // the dispatch board on the left wall: the pit as a plan with its trucks (props/board.js)
  const board = createBoard();
  board.object3d.position.set(-SIDE_X + 0.07, 1.78, 0.6);
  board.object3d.rotation.y = Math.PI / 2;
  g.add(board.object3d);
  {
    // its spill: a cool, soft light on the floor and the wall in front of it
    const l = new THREE.PointLight(LIGHT.screen, lite ? 0.9 : 1.2, 6, 2);
    l.position.set(-SIDE_X + 1.1, 1.8, 0.6);
    g.add(l);
    lights.board = l;
  }
  // the shift board on the right wall, the PPE stand and the radio desk at the ends of the glass
  {
    const sb = createShiftBoard();
    sb.position.set(SIDE_X - 0.03, 1.55, 0.7);
    sb.rotation.y = -Math.PI / 2;
    g.add(sb);
    const along = (a, r, obj) => {
      obj.position.set(r * Math.sin(a), 0, -r * Math.cos(a));
      obj.rotation.y = -a; // its front toward the room's centre
      g.add(obj);
      return obj;
    };
    const route = board.screen.material.map.clone();
    route.repeat.set(1 / 3, 1 / 2);
    route.offset.set(2 / 3, 1 / 2);
    route.needsUpdate = true;
    along(55 * DEG, GLASS_R - 0.75, createRadioDesk({ monitorTex: route }));
    along(-57 * DEG, GLASS_R - 0.6, createPPEStand());
  }

  // ---- lights
  // downlights over the consoles: warm pools, the hall's shadows
  lights.down = {};
  const can = std({ color: "#18181a", roughness: 0.4, metalness: 0.7 }, 0.6);
  const lens = new THREE.MeshBasicMaterial({ color: new THREE.Color(LIGHT.warm).multiplyScalar(3.0), toneMapped: false });
  for (const [id, d] of Object.entries(DESKS)) {
    const p = d.post.clone().lerp(d.pos, 0.35);
    const s = new THREE.SpotLight(LIGHT.warm, 26, 9, 0.42, 0.75, 2);
    s.position.set(p.x, CEILING - 0.08, p.z);
    s.target.position.set(p.x, 0, p.z);
    if (!lite) {
      s.castShadow = true;
      s.shadow.mapSize.setScalar(1024);
      s.shadow.bias = -0.0004;
      s.shadow.normalBias = 0.02;
      s.shadow.radius = 4;
      s.shadow.camera.near = 1;
      s.shadow.camera.far = 6;
    }
    g.add(s, s.target);
    lights.down[id] = s;
    g.add(at(new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.11, 0.12, 24), can), p.x, CEILING - 0.06, p.z));
    g.add(at(new THREE.Mesh(new THREE.CircleGeometry(0.08, 24).rotateX(Math.PI / 2), lens), p.x, CEILING - 0.121, p.z));
  }
  // over the ballot station: a recessed square luminaire in the ceiling grid (out of the view of the
  // pit), a narrow warm beam onto the box, the brightest pool in the room
  {
    const trim = std({ color: "#2c2c2e", roughness: 0.4, metalness: 0.6 }, 0.6);
    const box = new THREE.Mesh(new THREE.BoxGeometry(0.66, 0.06, 0.66), trim);
    box.position.set(BALLOT.x, CEILING - 0.03, BALLOT.z);
    g.add(box);
    const louvre = new THREE.Mesh(new THREE.PlaneGeometry(0.56, 0.56).rotateX(Math.PI / 2), new THREE.MeshBasicMaterial({ color: new THREE.Color(LIGHT.tungsten).multiplyScalar(1.6), toneMapped: false }));
    louvre.position.set(BALLOT.x, CEILING - 0.061, BALLOT.z);
    g.add(louvre);
    const s = new THREE.SpotLight(LIGHT.tungsten, 70, 10, 0.42, 0.6, 2);
    s.position.set(BALLOT.x, CEILING - 0.1, BALLOT.z);
    s.target.position.set(BALLOT.x, 0, BALLOT.z + 0.4);
    if (!lite) {
      s.castShadow = true;
      s.shadow.mapSize.setScalar(1024);
      s.shadow.bias = -0.0004;
      s.shadow.normalBias = 0.02;
      s.shadow.radius = 5;
      s.shadow.camera.near = 1.5;
      s.shadow.camera.far = 6;
    }
    g.add(s, s.target);
    lights.pendant = s;
  }
  // moonlight through the glass: the mullions' shadows fall across the floor
  {
    const moon = new THREE.DirectionalLight(LIGHT.moon, 0.55);
    moon.position.set(-6, 9, -16);
    moon.target.position.set(0, 0, -2);
    if (!lite) {
      moon.castShadow = true;
      moon.shadow.mapSize.setScalar(2048);
      Object.assign(moon.shadow.camera, { left: -11, right: 11, top: 10, bottom: -8, near: 4, far: 40 });
      moon.shadow.bias = -0.0006;
      moon.shadow.normalBias = 0.03;
      moon.shadow.radius = 3;
    }
    g.add(moon, moon.target);
    lights.moon = moon;
  }
  // a soft fill from the back of the room and the night sky
  const back = new THREE.DirectionalLight(LIGHT.warm, 0.32);
  back.position.set(2, 4, 10);
  g.add(back);
  g.add(new THREE.HemisphereLight("#262a33", "#1f1b17", 0.55)); // the ground colour: the floor's bounce on the ceiling
  if (typeof location !== "undefined" && new URLSearchParams(location.search).get("hall") === "0") g.visible = false; // dev only: the pit alone
  return { group: g, lights };
}
