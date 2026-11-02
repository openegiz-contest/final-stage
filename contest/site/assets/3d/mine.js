// Example Mine, modelled procedurally (no third-party models): a diorama tile with a
// terraced open pit, a spiral haul ramp and a surface road, plus a hydraulic excavator,
// two haul trucks, a primary crusher with conveyor and stockpile, light towers and rocks.
// Pure geometry: nothing here depends on time; poses are set by the composition.
// Copied from kz-video-factory videos/007-openegiz-minute/assets/mine.js; only the imports differ.
import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";

/** Seeded PRNG (mulberry32), as in the video's three-kit: the same seeds give the same mine. */
function rng(seed = 1) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let x = Math.imul(a ^ (a >>> 15), 1 | a);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------- materials

export function makeMaterials() {
  const std = (o) => new THREE.MeshStandardMaterial(o);
  const phys = (o) => new THREE.MeshPhysicalMaterial(o);
  return {
    paint: phys({ color: "#f2b234", roughness: 0.42, metalness: 0.05, clearcoat: 0.35, clearcoatRoughness: 0.35 }),
    paintDark: phys({ color: "#c98a1c", roughness: 0.5, metalness: 0.05, clearcoat: 0.2 }),
    white: phys({ color: "#e9ecef", roughness: 0.45, metalness: 0.05, clearcoat: 0.3 }),
    graphite: std({ color: "#2a2e35", roughness: 0.6, metalness: 0.35 }),
    black: std({ color: "#15171b", roughness: 0.75, metalness: 0.2 }),
    tire: std({ color: "#1b1c1f", roughness: 0.92, metalness: 0.0 }),
    steel: std({ color: "#a4adb8", roughness: 0.32, metalness: 0.85 }),
    chrome: std({ color: "#dfe6ee", roughness: 0.12, metalness: 1.0 }),
    glass: phys({ color: "#0e1a28", roughness: 0.06, metalness: 0.1, clearcoat: 1, clearcoatRoughness: 0.05 }),
    concrete: std({ color: "#b9b4ab", roughness: 0.88, metalness: 0.0 }),
    cladding: std({ color: "#dfe3e8", roughness: 0.55, metalness: 0.25 }),
    belt: std({ color: "#202226", roughness: 0.8 }),
    ore: std({ color: "#8a6450", roughness: 0.95, flatShading: true }),
    oreBase: std({ color: "#5e4a3f", roughness: 1.0 }),
    rock: std({ color: "#ffffff", roughness: 0.9, flatShading: true }),
    oreLight: std({ color: "#9c7d68", roughness: 0.97 }),
    lamp: std({ color: "#000000", emissive: "#ffe2b0", emissiveIntensity: 5 }),
    lampDim: std({ color: "#000000", emissive: "#ffe7c2", emissiveIntensity: 2.2 }),
    tail: std({ color: "#000000", emissive: "#ff4a3a", emissiveIntensity: 3 }),
    beacon: std({ color: "#000000", emissive: "#2fe8ce", emissiveIntensity: 7 }),
    terrain: std({ vertexColors: true, roughness: 0.96, metalness: 0.0 }),
  };
}

// ---------------------------------------------------------------- helpers

const rbox = (w, h, d, r, mat, seg = 3) => new THREE.Mesh(new RoundedBoxGeometry(w, h, d, seg, Math.min(r, w / 2, h / 2, d / 2)), mat);
const at = (mesh, x, y, z) => (mesh.position.set(x, y, z), mesh);

/** Extrude a side profile [[z, y], ...] across the X axis (width w, centred), with a bevel. */
function profileX(points, w, bevel = 0.03) {
  const shape = new THREE.Shape(points.map(([z, y]) => new THREE.Vector2(z, y)));
  const depth = Math.max(0.001, w - 2 * bevel);
  const g = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: bevel > 0, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 3, curveSegments: 12 });
  g.rotateY(-Math.PI / 2); // shape x -> world z, extrusion -> world -x
  g.translate(depth / 2, 0, 0);
  g.computeVertexNormals();
  return g;
}

/** A tyre with a rounded section and tread lugs, axis along X, centred at the origin. */
function makeTyre(R, W, mats, lugs = 26) {
  const g = new THREE.Group();
  const rin = R * 0.58, r = W * 0.22;
  const pts = [];
  // rounded-rect section in (radius, axial) space, revolved around Y
  const arc = (cx, cy, a0, a1) => {
    for (let i = 0; i <= 6; i++) {
      const a = a0 + ((a1 - a0) * i) / 6;
      pts.push(new THREE.Vector2(cx + Math.cos(a) * r, cy + Math.sin(a) * r));
    }
  };
  pts.push(new THREE.Vector2(rin, -W / 2 + 0.01));
  arc(R - r, -W / 2 + r, -Math.PI / 2, 0);
  arc(R - r, W / 2 - r, 0, Math.PI / 2);
  pts.push(new THREE.Vector2(rin, W / 2 - 0.01));
  const lathe = new THREE.LatheGeometry(pts, 48);
  lathe.rotateZ(Math.PI / 2);
  g.add(new THREE.Mesh(lathe, mats.tire));
  // tread lugs: chevron pairs
  const lug = new THREE.BoxGeometry(W * 0.42, R * 0.07, R * 0.16);
  const inst = new THREE.InstancedMesh(lug, mats.tire, lugs * 2);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler();
  for (let i = 0; i < lugs; i++) {
    for (let k = 0; k < 2; k++) {
      const a = (i / lugs) * Math.PI * 2 + (k ? Math.PI / lugs : 0);
      e.set(a, k ? 0.35 : -0.35, 0);
      q.setFromEuler(e);
      const p = new THREE.Vector3((k ? 1 : -1) * W * 0.22, Math.sin(a) * (R + 0.005), Math.cos(a) * (R + 0.005));
      m.compose(p, q, new THREE.Vector3(1, 1, 1));
      inst.setMatrixAt(i * 2 + k, m);
    }
  }
  g.add(inst);
  // rim + hub
  const rim = new THREE.Mesh(new THREE.CylinderGeometry(rin * 0.98, rin * 0.98, W * 0.8, 32), mats.graphite);
  rim.rotation.z = Math.PI / 2;
  g.add(rim);
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(rin * 0.45, rin * 0.55, W * 0.9, 20), mats.steel);
  hub.rotation.z = Math.PI / 2;
  g.add(hub);
  return g;
}

/** Faceted ore heap: a displaced half-sphere scaled to (sx, sy, sz). */
function oreHeap(sx, sy, sz, mat, seed = 3, detail = 3) {
  const g = new THREE.IcosahedronGeometry(1, detail);
  const pos = g.attributes.position, v = new THREE.Vector3(), rand = rng(seed);
  const bumps = Array.from({ length: 14 }, () => [new THREE.Vector3(rand() - 0.5, rand(), rand() - 0.5).normalize(), 0.08 + rand() * 0.14]);
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    let d = 1;
    for (const [b, s] of bumps) d += s * Math.max(0, v.dot(b) - 0.75) * 4;
    d += (Math.sin(v.x * 9.1 + v.z * 5.3) + Math.sin(v.z * 11.7 - v.y * 6.1)) * 0.03;
    d += (Math.sin(v.x * 23.0 + v.y * 17.0) * Math.sin(v.z * 19.0 - v.x * 13.0)) * 0.05;
    v.multiplyScalar(d);
    v.y = Math.max(v.y, -0.05);
    pos.setXYZ(i, v.x * sx, v.y * sy, v.z * sz);
  }
  g.computeVertexNormals();
  return new THREE.Mesh(g, mat);
}

/** Ore load: a low mound covered in instanced rock chunks of varied size and tone. */
function rockHeap(sx, sy, sz, mats, seed = 3, count = 110) {
  const g = new THREE.Group();
  const base = oreHeap(sx * 0.92, sy * 0.62, sz * 0.92, mats.oreBase, seed, 4);
  g.add(base);
  const rand = rng(seed * 7 + 1);
  const inst = new THREE.InstancedMesh(new THREE.DodecahedronGeometry(1, 0), mats.rock, count);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), sc = new THREE.Vector3(), p = new THREE.Vector3();
  const tones = ["#6b5a50", "#7a685c", "#5a4f49", "#8d7866", "#4a4441", "#77705f", "#966f55"].map((c) => new THREE.Color(c));
  for (let i = 0; i < count; i++) {
    // uniform point on the unit disc, lifted onto the mound's dome
    const a = rand() * Math.PI * 2, r = Math.sqrt(rand()) * 0.95;
    const h = Math.sqrt(Math.max(0, 1 - r * r));
    p.set(Math.cos(a) * r * sx * 0.92, h * sy * 0.62, Math.sin(a) * r * sz * 0.92);
    const size = 0.055 + Math.pow(rand(), 2.0) * 0.1;
    e.set(rand() * 3, rand() * 3, rand() * 3);
    q.setFromEuler(e);
    sc.set(size, size * (0.65 + rand() * 0.35), size * (0.8 + rand() * 0.3));
    m.compose(p, q, sc);
    inst.setMatrixAt(i, m);
    inst.setColorAt(i, tones[Math.floor(rand() * tones.length)]);
  }
  g.add(inst);
  return g;
}

/** Conical stockpile with a slightly irregular surface (smooth shaded). */
function conePile(radius, height, mat, seed = 1) {
  const g = new THREE.ConeGeometry(radius, height, 96, 24, true);
  g.translate(0, height / 2, 0);
  const pos = g.attributes.position, v = new THREE.Vector3();
  const ph = rng(seed)() * 6;
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const a = Math.atan2(v.z, v.x), h = v.y / height;
    const r = Math.hypot(v.x, v.z);
    const n = 1 + 0.045 * Math.sin(a * 3 + ph) * (1 - h) + 0.025 * Math.sin(a * 7 + v.y * 2.5 + ph) * (1 - h) + 0.05 * Math.max(0, 0.25 - h) * Math.sin(a * 2);
    const top = h > 0.92 ? 0.92 + (h - 0.92) * 0.5 : h; // rounded peak
    pos.setXYZ(i, v.x * n, top * height, v.z * n);
    if (r < 1e-4) pos.setY(i, height * 0.96);
  }
  g.computeVertexNormals();
  const m = new THREE.Mesh(g, mat);
  return m;
}

// ---------------------------------------------------------------- haul truck

/** Rigid-frame haul truck, ~2.5 long, forward +Z, wheels on y = 0. */
export function makeHaulTruck(mats, { loaded = true, beacon = false, seed = 1 } = {}) {
  const root = new THREE.Group();
  const R = 0.45, W = 0.32;
  const g = new THREE.Group(); // everything above the axles, lifted for the larger tyres
  g.position.y = R - 0.37;
  root.add(g);
  // frame and axles
  g.add(at(rbox(0.56, 0.26, 2.15, 0.05, mats.graphite), 0, 0.44, 0.05));
  root.add(at(rbox(1.0, 0.16, 0.22, 0.04, mats.graphite), 0, R, 0.78));
  root.add(at(rbox(1.15, 0.22, 0.4, 0.05, mats.graphite), 0, R, -0.62));
  // tyres: single front, dual rear
  const wheels = [];
  for (const [x, z] of [[0.64, 0.78], [-0.64, 0.78], [0.68, -0.62], [-0.68, -0.62], [0.35, -0.62], [-0.35, -0.62]]) {
    const t = makeTyre(R, W, mats);
    t.position.set(x, R, z);
    if (x < 0) t.rotation.y = Math.PI;
    wheels.push(t);
    root.add(t);
  }
  // front deck, bumper, radiator, ladder
  g.add(at(rbox(1.62, 0.07, 0.62, 0.025, mats.paint), 0, 0.86, 0.92));
  g.add(at(rbox(1.5, 0.16, 0.12, 0.03, mats.paintDark), 0, 0.62, 1.24));
  const rad = at(rbox(0.74, 0.46, 0.56, 0.05, mats.graphite), 0, 0.62, 0.92);
  g.add(rad);
  for (let i = 0; i < 6; i++) g.add(at(new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.025, 0.02), mats.black), 0, 0.45 + i * 0.06, 1.205));
  for (const x of [-0.56, 0.56]) g.add(at(new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.05, 0.05), mats.lamp), x, 0.79, 1.26));
  // cab (left), glass band, roll-over frame
  const cab = new THREE.Group();
  cab.add(at(rbox(0.5, 0.42, 0.46, 0.05, mats.paint), 0, 0, 0));
  cab.add(at(rbox(0.52, 0.18, 0.4, 0.02, mats.glass), 0, 0.06, 0.04));
  cab.add(at(rbox(0.4, 0.17, 0.05, 0.02, mats.glass), 0, 0.06, 0.225));
  cab.position.set(-0.47, 1.11, 0.92);
  g.add(cab);
  // handrail along the deck front
  const rail = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 1.0, 8), mats.paint);
  rail.rotation.z = Math.PI / 2;
  g.add(at(rail, 0.22, 1.14, 1.2));
  // dump body: side plates (classic silhouette), floor, front wall, canopy over the cab
  const side = [[-1.36, 1.0], [-1.18, 0.74], [0.46, 0.7], [0.46, 1.38], [-1.36, 1.3]];
  for (const x of [-0.76, 0.76]) g.add(at(new THREE.Mesh(profileX(side, 0.09, 0.02), mats.paint), x, 0, 0));
  const floor = at(rbox(1.5, 0.1, 1.72, 0.03, mats.paint), 0, 0.77, -0.38);
  floor.rotation.x = 0.03;
  g.add(floor);
  g.add(at(rbox(1.6, 0.74, 0.1, 0.03, mats.paint), 0, 1.08, 0.46));
  g.add(at(rbox(1.66, 0.07, 0.9, 0.03, mats.paint), 0, 1.47, 0.88));
  g.add(at(rbox(1.66, 0.06, 0.12, 0.02, mats.paintDark), 0, 1.4, 1.28));
  // body ribs (outside the side plates) and top rail
  for (const x of [-0.82, 0.82]) {
    for (const z of [-1.0, -0.55, -0.1, 0.32]) g.add(at(rbox(0.05, 0.6, 0.07, 0.015, mats.paintDark), x, 1.02, z));
    g.add(at(rbox(0.07, 0.08, 1.85, 0.02, mats.paintDark), x, 1.32, -0.45));
  }
  // tail lights
  for (const x of [-0.5, 0.5]) g.add(at(new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.05, 0.03), mats.tail), x, 0.55, -1.03));
  // load
  if (loaded) {
    const heap = rockHeap(0.68, 0.26, 0.88, mats, seed);
    heap.position.set(0, 1.18, -0.42);
    g.add(heap);
  }
  // data beacon (only on the truck that streams to the twin)
  let beaconMesh = null;
  if (beacon) {
    g.add(at(new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.32, 8), mats.steel), 0.62, 1.66, 1.12));
    beaconMesh = at(new THREE.Mesh(new THREE.SphereGeometry(0.06, 20, 12), mats.beacon), 0.62, 1.84, 1.12);
    g.add(beaconMesh);
  }
  root.userData = { wheels, beacon: beaconMesh };
  return root;
}

// ---------------------------------------------------------------- excavator

/** Large hydraulic excavator (backhoe), forward +Z. Returns { group, upper, boom, stick, bucket }. */
export function makeExcavator(mats) {
  const g = new THREE.Group();
  // crawler tracks with shoe ribs
  for (const x of [-0.82, 0.82]) {
    const tr = new THREE.Group();
    tr.add(rbox(0.56, 0.5, 3.0, 0.22, mats.black, 4));
    const shoes = new THREE.InstancedMesh(new THREE.BoxGeometry(0.6, 0.05, 0.07), mats.graphite, 34);
    const m = new THREE.Matrix4();
    for (let i = 0; i < 17; i++) {
      m.makeTranslation(0, 0.26, -1.36 + i * 0.17);
      shoes.setMatrixAt(i, m);
      m.makeTranslation(0, -0.26, -1.36 + i * 0.17);
      shoes.setMatrixAt(17 + i, m);
    }
    tr.add(shoes);
    for (let i = 0; i < 5; i++) {
      const roller = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.11, 0.6, 16), mats.steel);
      roller.rotation.z = Math.PI / 2;
      tr.add(at(roller, 0, -0.05, -1.0 + i * 0.5));
    }
    tr.position.set(x, 0.25, 0);
    g.add(tr);
  }
  g.add(at(rbox(1.3, 0.34, 1.6, 0.08, mats.graphite), 0, 0.52, 0));
  // upper structure (slews about Y)
  const upper = new THREE.Group();
  upper.position.y = 0.72;
  g.add(upper);
  upper.add(at(new THREE.Mesh(new THREE.CylinderGeometry(0.62, 0.66, 0.16, 32), mats.graphite), 0, 0.06, 0));
  upper.add(at(rbox(2.1, 0.8, 2.3, 0.1, mats.paint), 0, 0.55, -0.2));
  upper.add(at(rbox(2.14, 0.62, 0.62, 0.22, mats.paintDark), 0, 0.5, -1.38)); // counterweight
  upper.add(at(rbox(1.3, 0.2, 1.2, 0.06, mats.graphite), 0.25, 1.02, -0.55)); // engine hood
  for (let i = 0; i < 7; i++) upper.add(at(new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.02, 0.05), mats.black), 0.25, 1.13, -0.98 + i * 0.14));
  // cab front-left with big glazing
  const cab = new THREE.Group();
  cab.add(rbox(0.72, 0.78, 0.86, 0.07, mats.paint));
  cab.add(at(rbox(0.74, 0.42, 0.7, 0.03, mats.glass), 0, 0.1, 0.05));
  cab.add(at(rbox(0.6, 0.48, 0.06, 0.03, mats.glass), 0, 0.08, 0.42));
  cab.position.set(-0.62, 1.32, 0.52);
  upper.add(cab);
  // handrails on the deck
  for (const [x, z, len, rotY] of [[0.98, -0.2, 2.0, 0], [0.3, -1.25, 1.4, Math.PI / 2]]) {
    const r = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.014, len, 8), mats.paint);
    r.rotation.x = Math.PI / 2;
    r.rotation.y = rotY;
    upper.add(at(r, x, 1.25, z));
    for (let i = 0; i <= 3; i++) {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.3, 6), mats.paint);
      const u = -len / 2 + (i * len) / 3;
      upper.add(at(post, rotY ? x + u : x, 1.1, rotY ? z : z + u));
    }
  }
  // boom: banana-shaped box section from the front pivot
  const boom = new THREE.Group();
  boom.position.set(0.25, 0.85, 0.85);
  upper.add(boom);
  const boomShape = [[0, -0.22], [1.1, 0.42], [2.75, 0.32], [2.95, 0.06], [2.75, -0.14], [1.15, 0.1], [0.05, 0.22]];
  boom.add(new THREE.Mesh(profileX(boomShape, 0.42, 0.04), mats.paint));
  const stick = new THREE.Group();
  stick.position.set(0, 0.1, 2.85);
  boom.add(stick);
  const stickShape = [[-0.35, 0.18], [0.0, 0.22], [1.75, 0.08], [1.85, -0.06], [0.0, -0.18], [-0.35, -0.08]];
  stick.add(new THREE.Mesh(profileX(stickShape, 0.32, 0.03), mats.paint));
  const bucket = new THREE.Group();
  bucket.position.set(0, 0, 1.82);
  stick.add(bucket);
  const bucketShape = [[0, 0.12], [0.18, 0.2], [0.78, -0.05], [0.88, -0.55], [0.55, -0.62], [0.12, -0.3]];
  bucket.add(new THREE.Mesh(profileX(bucketShape, 0.82, 0.03), mats.paintDark));
  for (let i = 0; i < 5; i++) bucket.add(at(rbox(0.09, 0.07, 0.2, 0.02, mats.steel), -0.32 + i * 0.16, -0.6, 0.62));
  // hydraulic cylinders (barrel + chrome rod), re-aimed on every pose
  const rams = [];
  const ram = (parentA, a, parentB, b, rr = 0.06) => {
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(rr, rr, 1, 16), mats.graphite);
    const rod = new THREE.Mesh(new THREE.CylinderGeometry(rr * 0.55, rr * 0.55, 1, 12), mats.chrome);
    upper.add(barrel, rod);
    rams.push({ parentA, a: new THREE.Vector3(...a), parentB, b: new THREE.Vector3(...b), barrel, rod });
  };
  for (const x of [-0.24, 0.24]) ram(upper, [x, 0.45, 1.05], boom, [x, 0.0, 1.2], 0.07);
  ram(boom, [0, 0.45, 1.5], stick, [0, 0.24, -0.3], 0.065);
  ram(stick, [0, 0.24, 0.1], bucket, [0, 0.16, 0.12], 0.055);
  const A = new THREE.Vector3(), B = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0), dir = new THREE.Vector3();
  const inv = new THREE.Matrix4();

  /** Pose angles in radians: slew (about Y), boom raise, stick, bucket curl. */
  function pose({ slew = 0, boom: b = 0.5, stick: s = 1.2, bucket: k = 0.6 } = {}) {
    upper.rotation.y = slew;
    boom.rotation.x = -b;
    stick.rotation.x = s;
    bucket.rotation.x = k;
    g.updateMatrixWorld(true);
    inv.copy(upper.matrixWorld).invert();
    for (const r of rams) {
      A.copy(r.a).applyMatrix4(r.parentA.matrixWorld).applyMatrix4(inv);
      B.copy(r.b).applyMatrix4(r.parentB.matrixWorld).applyMatrix4(inv);
      const len = A.distanceTo(B);
      dir.subVectors(B, A).normalize();
      const q = new THREE.Quaternion().setFromUnitVectors(up, dir);
      r.barrel.scale.set(1, len * 0.58, 1);
      r.barrel.position.copy(A).addScaledVector(dir, len * 0.29);
      r.barrel.quaternion.copy(q);
      r.rod.scale.set(1, len * 0.5, 1);
      r.rod.position.copy(A).addScaledVector(dir, len * 0.72);
      r.rod.quaternion.copy(q);
    }
  }
  pose();
  return { group: g, upper, boom, stick, bucket, pose };
}

// ---------------------------------------------------------------- crusher station

/** Primary crusher: dump pocket, hopper, clad building, inclined conveyor, stockpile. Faces +Z (trucks back in from +Z). */
export function makeCrusher(mats, { side = -1 } = {}) {
  const g = new THREE.Group();
  // concrete dump platform and retaining wall
  g.add(at(rbox(4.0, 0.22, 2.6, 0.05, mats.concrete), 0, 0.08, 0.6));
  g.add(at(rbox(2.0, 0.16, 0.2, 0.04, mats.concrete), 0, 0.27, 1.05)); // wheel stop
  // hopper (inverted frustum) with a rim
  const hop = new THREE.Mesh(new THREE.CylinderGeometry(1.15, 0.4, 0.9, 4, 1, true), mats.steel.clone());
  hop.rotation.y = Math.PI / 4;
  hop.material.side = THREE.DoubleSide;
  hop.material.color.set("#6d7680");
  g.add(at(hop, 0, -0.22, 0.0));
  // hopper rim flush with the pad, with a dark throat
  for (const [w, d, x, z] of [[1.75, 0.12, 0, 0.82], [1.75, 0.12, 0, -0.82], [0.12, 1.75, 0.82, 0], [0.12, 1.75, -0.82, 0]]) g.add(at(rbox(w, 0.1, d, 0.02, mats.paint), x, 0.24, z));
  const throat = new THREE.Mesh(new THREE.PlaneGeometry(1.5, 1.5), mats.black);
  throat.rotation.x = -Math.PI / 2;
  g.add(at(throat, 0, 0.2, 0));
  // guard rails on the pad edges
  for (const x of [-1.95, 1.95]) {
    g.add(at(rbox(0.04, 0.04, 2.4, 0.01, mats.paint), x, 0.62, 0.6));
    for (let i = 0; i < 4; i++) g.add(at(rbox(0.035, 0.42, 0.035, 0.01, mats.paint), x, 0.4, -0.5 + i * 0.75));
  }
  // crusher building: clad box with standing-seam ribs, roof, lit window bands, steel frame
  const BW = 2.5, BH = 1.95, BD = 1.9, bx = 0, bz = -1.75;
  g.add(at(rbox(BW, BH, BD, 0.05, mats.cladding), bx, BH / 2, bz));
  const ribs = new THREE.InstancedMesh(new THREE.BoxGeometry(0.03, BH - 0.1, 0.03), mats.steel, 64);
  const m = new THREE.Matrix4();
  let n = 0;
  for (let i = 1; i < 14; i++) {
    const x = -BW / 2 + (i * BW) / 14;
    for (const z of [bz + BD / 2 + 0.015, bz - BD / 2 - 0.015]) (m.makeTranslation(x, BH / 2, z), ribs.setMatrixAt(n++, m));
  }
  for (let i = 1; i < 11; i++) {
    const z = bz - BD / 2 + (i * BD) / 11;
    for (const x of [BW / 2 + 0.015, -BW / 2 - 0.015]) (m.makeTranslation(x, BH / 2, z), ribs.setMatrixAt(n++, m));
  }
  ribs.count = n;
  g.add(ribs);
  g.add(at(rbox(BW + 0.2, 0.12, BD + 0.2, 0.03, mats.graphite), bx, BH + 0.03, bz));
  g.add(at(rbox(1.0, 0.55, 0.85, 0.04, mats.cladding), bx + side * 0.55, BH + 0.36, bz - 0.15)); // head house
  g.add(at(rbox(1.04, 0.07, 0.89, 0.02, mats.graphite), bx + side * 0.55, BH + 0.66, bz - 0.15));
  // window bands on every face
  for (const z of [bz + BD / 2 + 0.03, bz - BD / 2 - 0.03]) g.add(at(new THREE.Mesh(new THREE.BoxGeometry(BW * 0.78, 0.14, 0.02), mats.lamp), bx, BH * 0.72, z));
  for (const x of [BW / 2 + 0.03, -BW / 2 - 0.03]) g.add(at(new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.14, BD * 0.7), mats.lamp), x, BH * 0.72, bz));
  // roller door on the side facing away from the pad
  g.add(at(rbox(0.8, 1.0, 0.04, 0.01, mats.graphite), bx - side * 0.5, 0.5, bz - BD / 2 - 0.03));
  // yellow structural frame at the corners
  for (const [x, z] of [[-1, 1], [1, 1], [1, -1], [-1, -1]]) g.add(at(rbox(0.1, BH + 0.1, 0.1, 0.02, mats.paint), (x * (BW + 0.06)) / 2, (BH + 0.1) / 2, bz + (z * (BD + 0.06)) / 2));
  // conveyor gallery from the building to the stockpile (rises toward -X)
  const conv = new THREE.Group();
  const len = 5.6;
  conv.add(at(rbox(0.5, 0.08, len, 0.02, mats.belt), 0, 0, len / 2));
  for (const x of [-0.3, 0.3]) conv.add(at(rbox(0.06, 0.22, len, 0.02, mats.paint), x, -0.08, len / 2));
  for (let i = 0; i < 12; i++) conv.add(at(rbox(0.66, 0.05, 0.05, 0.01, mats.paint), 0, -0.2, 0.25 + i * 0.47));
  for (let i = 0; i < 11; i++) conv.add(at(oreHeap(0.16, 0.08, 0.2, mats.ore, 20 + i), 0, 0.04, 0.4 + i * 0.5));
  conv.position.set(bx + side * (BW / 2 + 0.05), 1.0, bz);
  conv.rotation.y = (side * Math.PI) / 2;
  conv.rotation.order = "YXZ"; // slew first, then tilt up along its length
  conv.rotation.x = -0.36;
  g.add(conv);
  // trestle legs under the conveyor
  for (const d of [1.6, 3.4]) {
    const h = 1.0 + Math.sin(0.36) * d - 0.1;
    g.add(at(rbox(0.1, h, 0.1, 0.02, mats.paint), bx + side * (BW / 2 + 0.05 + d * Math.cos(0.36)), h / 2, bz));
  }
  // stockpile cone under the head pulley
  const pileX = bx + side * (BW / 2 + 0.05 + len * Math.cos(0.36));
  const pile = conePile(2.2, 1.75, mats.oreLight, 11);
  pile.position.set(pileX, 0, bz);
  g.add(pile);
  return g;
}

// ---------------------------------------------------------------- light tower

export function makeLightTower(mats) {
  const g = new THREE.Group();
  g.add(at(rbox(0.5, 0.25, 0.8, 0.04, mats.paint), 0, 0.13, 0));
  g.add(at(new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.05, 2.2, 10), mats.steel), 0, 1.35, 0));
  const head = new THREE.Group();
  head.position.y = 2.5;
  head.add(rbox(0.62, 0.36, 0.1, 0.02, mats.graphite));
  for (let i = 0; i < 4; i++) head.add(at(new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.12, 0.02), mats.lampDim), i % 2 ? 0.13 : -0.13, i < 2 ? 0.08 : -0.08, 0.055));
  head.rotation.x = 0.35;
  g.add(head);
  return g;
}

// ---------------------------------------------------------------- terrain

/**
 * Diorama tile with a terraced open pit and a haul road. Returns meshes and the sampling
 * functions the composition uses to place machines on the road.
 */
export function makeTerrain(mats, o = {}) {
  const HS = o.half ?? 7.0; // tile half-size
  const BASE = o.base ?? -3.0; // slab bottom
  const C = new THREE.Vector2(...(o.pit ?? [-1.95, -1.95])); // pit centre (x, z)
  const PA = o.pitA ?? 4.4, PB = o.pitB ?? 3.95, P = 2.4; // superellipse half-axes and exponent
  const D = o.depth ?? 2.2, R0 = 0.5, STEPS = 3;
  const TH_END = o.exitAngle ?? 0.0, SPAN = Math.PI * 1.32; // ramp: s=1 exits the rim at TH_END, counter-clockwise
  const WR = 0.17; // road half-width in normalised pit radius
  const rand = rng(o.seed ?? 5);

  const smooth = (a, b, x) => {
    const u = Math.min(1, Math.max(0, (x - a) / (b - a)));
    return u * u * (3 - 2 * u);
  };
  const noise2 = (x, z) =>
    Math.sin(x * 0.9 + 1.3) * Math.sin(z * 0.7 + 0.4) * 0.5 + Math.sin(x * 2.3 - z * 1.7) * 0.25 + Math.sin(x * 5.1 + z * 4.3) * 0.08;

  const sup = (th) => Math.pow(Math.pow(Math.abs(Math.cos(th)), P) + Math.pow(Math.abs(Math.sin(th)), P), 1 / P);
  /** Normalised pit radius and angle of a world point. */
  function polar(x, z) {
    const nx = (x - C.x) / PA, nz = (z - C.y) / PB;
    return { r: Math.pow(Math.pow(Math.abs(nx), P) + Math.pow(Math.abs(nz), P), 1 / P), th: Math.atan2(nz, nx) };
  }
  /** World point at normalised radius r and angle th. */
  function fromPolar(r, th) {
    const n = sup(th);
    return new THREE.Vector2(C.x + (PA * r * Math.cos(th)) / n, C.y + (PB * r * Math.sin(th)) / n);
  }
  const terrace = (u) => {
    const x = u * STEPS, k = Math.floor(x), f = x - k;
    return Math.min(1, (k + smooth(0.6, 1.0, f)) / STEPS);
  };
  const rampTh = (s) => TH_END - SPAN * (1 - s);
  const rampR = (s) => R0 + (1 - R0) * s;
  const rampY = (s) => -D * (1 - s);

  // surface road: from the rim exit along the ramp's tangent to the crusher dump point
  const exit = fromPolar(1.0, TH_END);
  const exit2 = fromPolar(1.0, TH_END + 0.08);
  const tan = new THREE.Vector2().subVectors(exit2, exit).normalize();
  const dump = new THREE.Vector2(...(o.dump ?? [4.25, 1.75]));
  const surf = new THREE.CatmullRomCurve3(
    [
      new THREE.Vector3(exit.x, 0, exit.y),
      new THREE.Vector3(exit.x + tan.x * 1.6, 0, exit.y + tan.y * 1.6),
      new THREE.Vector3(dump.x, 0, dump.y - 1.6),
      new THREE.Vector3(dump.x, 0, dump.y),
    ],
    false,
    "centripetal",
  );
  const surfPts = surf.getSpacedPoints(160).map((p) => new THREE.Vector2(p.x, p.z));
  const roadHalfW = 0.85;
  function surfDist(x, z) {
    let best = 1e9;
    for (let i = 0; i < surfPts.length - 1; i++) {
      const a = surfPts[i], b = surfPts[i + 1];
      const abx = b.x - a.x, abz = b.y - a.y;
      const u = Math.min(1, Math.max(0, ((x - a.x) * abx + (z - a.y) * abz) / (abx * abx + abz * abz)));
      const dx = x - (a.x + abx * u), dz = z - (a.y + abz * u);
      best = Math.min(best, dx * dx + dz * dz);
    }
    return Math.sqrt(best);
  }

  // height + material class at a point (class: 0 plateau, 1 bench, 2 face, 3 road, 4 berm)
  function sample(x, z) {
    const { r, th } = polar(x, z);
    let y = 0.06 * noise2(x, z);
    let cls = 0, road = 0;
    if (r < 1.0) {
      const u = Math.max(0, (r - R0) / (1 - R0));
      y = r <= R0 ? -D : -D * (1 - terrace(u));
      y += 0.03 * noise2(x * 2, z * 2);
      cls = 1;
    }
    // ramp shelf
    let d = ((th - rampTh(0)) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI); // angle travelled from s=0
    const s = d / SPAN;
    if (s <= 1.04 && r < 1.08) {
      const sc = Math.min(1, Math.max(0, s));
      const dist = Math.abs(r - rampR(sc));
      const w = 1 - smooth(WR * 0.8, WR * 1.45, dist);
      if (w > 0) {
        y = y * (1 - w) + rampY(sc) * w;
        road = Math.max(road, smooth(WR * 0.95, WR * 0.6, dist));
        // safety berm on the open (inner) side
        const berm = Math.exp(-Math.pow((r - (rampR(sc) - WR * 0.92)) / 0.018, 2));
        y += 0.09 * berm * (sc > 0.04 ? 1 : 0);
        if (berm > 0.4) cls = 4;
      }
    }
    // surface road
    if (r > 0.95) {
      const sd = surfDist(x, z);
      const w = 1 - smooth(roadHalfW * 0.85, roadHalfW * 1.5, sd);
      if (w > 0) {
        y = y * (1 - w) + 0.005 * w;
        road = Math.max(road, smooth(roadHalfW, roadHalfW * 0.7, sd));
      }
      const berm = Math.exp(-Math.pow((sd - roadHalfW * 1.05) / 0.08, 2));
      y += 0.08 * berm;
    }
    if (road > 0.5) cls = 3;
    return { y, cls, road };
  }

  // ---- top surface (heightfield with vertex colours)
  const N = o.res ?? 260;
  const geo = new THREE.PlaneGeometry(HS * 2, HS * 2, N, N);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  const col = new Float32Array(pos.count * 3);
  const hgt = new Float32Array(pos.count);
  const roadW = new Float32Array(pos.count);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getZ(i);
    const s = sample(x, z);
    pos.setY(i, s.y);
    hgt[i] = s.y;
    roadW[i] = s.road;
  }
  geo.computeVertexNormals();
  const nrm = geo.attributes.normal;
  // cavity occlusion: darken vertices that sit below their neighbourhood (bench toes, road cuts)
  const ao = new Float32Array(pos.count);
  const K = 4, row = N + 1;
  for (let j = 0; j <= N; j++)
    for (let i = 0; i <= N; i++) {
      let sum = 0, cnt = 0;
      for (let dj = -K; dj <= K; dj += 2)
        for (let di = -K; di <= K; di += 2) {
          const ii = i + di, jj = j + dj;
          if (ii < 0 || jj < 0 || ii > N || jj > N) continue;
          sum += hgt[jj * row + ii];
          cnt++;
        }
      ao[j * row + i] = Math.min(1, Math.max(0, (sum / cnt - hgt[j * row + i]) * 2.2));
    }
  const c = new THREE.Color(), cA = new THREE.Color(), cB = new THREE.Color();
  const PLATEAU = new THREE.Color("#c4ab8c"), PLATEAU2 = new THREE.Color("#b39776");
  const BENCH = new THREE.Color("#b49a7e"), FACE = new THREE.Color("#7e5f4c"), FACE2 = new THREE.Color("#93715a");
  const FLOOR = new THREE.Color("#8a705c"), ROAD = new THREE.Color("#a99a87"), TRACK = new THREE.Color("#bfb19b");
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getZ(i), y = hgt[i];
    const slope = 1 - nrm.getY(i);
    const n = 0.5 + 0.5 * Math.sin(x * 3.1 + Math.sin(z * 1.7) * 2) * Math.sin(z * 2.6 - x * 0.8);
    if (polar(x, z).r < 1.0 && y < -0.01) {
      cA.copy(y < -D + 0.05 ? FLOOR : BENCH).lerp(PLATEAU2, 0.15 * n);
      cB.copy(FACE).lerp(FACE2, n);
      // strata streaks on the faces
      cB.multiplyScalar(0.9 + 0.12 * Math.sin(y * 9.0 + n));
      c.copy(cA).lerp(cB, smooth(0.08, 0.35, slope));
    } else {
      c.copy(PLATEAU).lerp(PLATEAU2, n * 0.7);
      c.lerp(FACE2, smooth(0.15, 0.5, slope) * 0.6);
    }
    if (roadW[i] > 0) {
      cA.copy(ROAD);
      c.lerp(cA, roadW[i] * 0.85);
    }
    c.multiplyScalar(0.94 + 0.08 * Math.sin(x * 17.3 + z * 13.1) * Math.sin(x * 7.7 - z * 11.9));
    c.multiplyScalar(1 - 0.45 * ao[i]);
    col.set([c.r, c.g, c.b], i * 3);
  }
  geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
  const top = new THREE.Mesh(geo, mats.terrain);
  top.receiveShadow = true;
  top.castShadow = true;

  // ---- side walls with soil strata
  const BANDS = [
    [0.0, "#5a4536"],
    [0.2, "#b49a7c"],
    [0.8, "#a07a5c"],
    [1.45, "#87695a"],
    [2.1, "#6b6265"],
    [2.7, "#4f4b55"],
  ];
  const bandCol = (depth, wob) => {
    const d = depth + wob;
    let k = 0;
    for (let i = 0; i < BANDS.length; i++) if (d >= BANDS[i][0]) k = i;
    const c = new THREE.Color(BANDS[k][1]);
    if (k + 1 < BANDS.length) c.lerp(new THREE.Color(BANDS[k + 1][1]), smooth(BANDS[k + 1][0] - 0.12, BANDS[k + 1][0], d));
    return c;
  };
  const sides = new THREE.Group();
  const ROWS = 90;
  const edges = [
    (u) => [u, HS, 0, 1], // +Z edge (x varies), outward normal +Z
    (u) => [HS, -u, 1, 0], // +X edge
    (u) => [-u, -HS, 0, -1],
    (u) => [-HS, u, -1, 0],
  ];
  for (const edge of edges) {
    const verts = [], cols = [], idx = [];
    const cols1 = N;
    for (let i = 0; i <= cols1; i++) {
      const u = -HS + (2 * HS * i) / cols1;
      const [x, z] = edge(u);
      const yTop = sample(x, z).y;
      for (let j = 0; j <= ROWS; j++) {
        const y = yTop + ((BASE - yTop) * j) / ROWS;
        verts.push(x, y, z);
        const wob = 0.12 * Math.sin(u * 1.3 + j) + 0.08 * Math.sin(u * 4.1);
        const cc = bandCol(-y, wob);
        cc.multiplyScalar(0.9 + 0.1 * Math.sin(u * 23.1 + y * 7.0));
        cols.push(cc.r, cc.g, cc.b);
      }
    }
    for (let i = 0; i < cols1; i++)
      for (let j = 0; j < ROWS; j++) {
        const a = i * (ROWS + 1) + j, b = (i + 1) * (ROWS + 1) + j;
        idx.push(a, a + 1, b, b, a + 1, b + 1);
      }
    const sg = new THREE.BufferGeometry();
    sg.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3));
    sg.setAttribute("color", new THREE.Float32BufferAttribute(cols, 3));
    sg.setIndex(idx);
    sg.computeVertexNormals();
    // make sure the wall faces outward
    const [, , ox, oz] = edge(0);
    const nn = sg.attributes.normal;
    if (nn.getX(0) * ox + nn.getZ(0) * oz < 0) {
      for (let k = 0; k < idx.length; k += 3) [idx[k + 1], idx[k + 2]] = [idx[k + 2], idx[k + 1]];
      sg.setIndex(idx);
      sg.computeVertexNormals();
    }
    const mesh = new THREE.Mesh(sg, mats.terrain);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    sides.add(mesh);
  }
  const bottom = new THREE.Mesh(new THREE.PlaneGeometry(HS * 2, HS * 2), new THREE.MeshStandardMaterial({ color: "#3a3438", roughness: 1 }));
  bottom.rotation.x = Math.PI / 2;
  bottom.position.y = BASE;
  sides.add(bottom);

  // ---- scattered rocks on benches and plateau
  const rockGeo = new THREE.DodecahedronGeometry(1, 0);
  const rocks = new THREE.InstancedMesh(rockGeo, mats.ore, 520);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), sc = new THREE.Vector3();
  let k = 0;
  for (let tries = 0; tries < 9000 && k < 520; tries++) {
    const x = (rand() * 2 - 1) * (HS - 0.5), z = (rand() * 2 - 1) * (HS - 0.5);
    const s = sample(x, z);
    if (s.road > 0.05 || s.cls === 4) continue;
    const pr = polar(x, z).r;
    if (pr > 1.15 && rand() > 0.25) continue; // rocks gather in and around the pit
    if (Math.hypot(x - dump.x, z - dump.y) < 3.2) continue;
    const size = 0.025 + Math.pow(rand(), 4) * 0.14;
    e.set(rand() * 3, rand() * 3, rand() * 3);
    q.setFromEuler(e);
    sc.set(size, size * (0.6 + rand() * 0.4), size);
    m.compose(new THREE.Vector3(x, s.y + size * 0.3, z), q, sc);
    rocks.setMatrixAt(k++, m);
  }
  rocks.count = k;
  rocks.castShadow = true;
  rocks.receiveShadow = true;

  // ---- road sampling for vehicles: s in [0,1] spans ramp (0..0.55) then surface road (0.55..1)
  const rampPts = [];
  for (let i = 0; i <= 200; i++) {
    const s = i / 200;
    const p = fromPolar(rampR(s), rampTh(s));
    rampPts.push(new THREE.Vector3(p.x, rampY(s), p.y));
  }
  const surfPts3 = surf.getSpacedPoints(120).slice(1);
  const haul = new THREE.CatmullRomCurve3([...rampPts, ...surfPts3], false, "centripetal");
  const heightAt = (x, z) => sample(x, z).y;

  return { group: new THREE.Group().add(top, sides, rocks), top, heightAt, haul, polar, fromPolar, dump, exit, center: C, depth: D, half: HS, base: BASE };
}

/** Place an object on the haul road at parameter s (0 = pit floor, 1 = crusher), facing forward. */
export function placeOnRoad(obj, terrain, s, { reverse = false, lateral = 0 } = {}) {
  const c = terrain.haul;
  const p = c.getPointAt(Math.min(1, Math.max(0, s)));
  const ahead = c.getPointAt(Math.min(1, Math.max(0, s + 0.01)));
  const behind = c.getPointAt(Math.min(1, Math.max(0, s - 0.01)));
  const dir = new THREE.Vector3().subVectors(ahead, behind);
  const yaw = Math.atan2(dir.x, dir.z) + (reverse ? Math.PI : 0);
  const pitch = -Math.atan2(dir.y, Math.hypot(dir.x, dir.z)) * (reverse ? -1 : 1);
  const side = new THREE.Vector3(dir.z, 0, -dir.x).normalize();
  obj.position.copy(p).addScaledVector(side, lateral);
  obj.position.y = terrain.heightAt(obj.position.x, obj.position.z);
  obj.rotation.set(0, 0, 0);
  obj.rotation.order = "YXZ";
  obj.rotation.y = yaw;
  obj.rotation.x = pitch;
  return obj;
}

// ---------------------------------------------------------------- "your thing" (Beat `yours`)

/** Data beacon on a short mast: the same teal sphere the streaming truck carries. */
function beaconMast(mats, x, y, z) {
  const g = new THREE.Group();
  g.add(at(new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.32, 8), mats.steel), x, y + 0.16, z));
  const b = at(new THREE.Mesh(new THREE.SphereGeometry(0.06, 20, 12), mats.beacon), x, y + 0.34, z);
  g.add(b);
  return { g, b };
}

/** Bakery oven on legs, door facing +Z, glowing window. ~1.7 wide. */
export function makeOven(mats) {
  const root = new THREE.Group();
  const glow = new THREE.MeshStandardMaterial({ color: "#000000", emissive: "#ff8a3d", emissiveIntensity: 2.6 });
  for (const [x, z] of [[-0.7, -0.5], [0.7, -0.5], [-0.7, 0.5], [0.7, 0.5]]) root.add(at(rbox(0.1, 0.32, 0.1, 0.02, mats.graphite), x, 0.16, z));
  root.add(at(rbox(1.7, 1.3, 1.3, 0.12, mats.white), 0, 0.95, 0));
  root.add(at(rbox(1.24, 0.74, 0.06, 0.05, mats.graphite), 0, 0.82, 0.66));
  root.add(at(new THREE.Mesh(new THREE.BoxGeometry(1.04, 0.54, 0.02), glow), 0, 0.82, 0.69));
  const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.9, 10), mats.chrome);
  handle.rotation.z = Math.PI / 2;
  root.add(at(handle, 0, 1.28, 0.74));
  root.add(at(rbox(1.5, 0.16, 0.04, 0.02, mats.graphite), 0, 1.45, 0.66));
  for (let i = 0; i < 3; i++) {
    const k = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.05, 16), mats.chrome);
    k.rotation.x = Math.PI / 2;
    root.add(at(k, -0.45 + i * 0.3, 1.45, 0.7));
  }
  const m = beaconMast(mats, 0.62, 1.6, -0.3);
  root.add(m.g);
  root.userData = { beacon: m.b };
  return root;
}

/** Solar panel on a post, 6 x 4 cells, tilted toward +Z. ~2.4 wide. */
export function makeSolarPanel(mats) {
  const root = new THREE.Group();
  const cellMat = new THREE.MeshPhysicalMaterial({ color: "#1d3f8f", roughness: 0.22, metalness: 0.35, clearcoat: 1, clearcoatRoughness: 0.08 });
  root.add(at(rbox(0.5, 0.12, 0.5, 0.03, mats.concrete), 0, 0.06, 0));
  root.add(at(new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.07, 1.0, 12), mats.steel), 0, 0.6, 0));
  const panel = new THREE.Group();
  panel.position.set(0, 1.12, 0);
  panel.rotation.x = 0.62; // the face tilts up and toward +Z
  panel.add(rbox(2.4, 0.07, 1.56, 0.025, mats.steel));
  const cells = new THREE.InstancedMesh(new THREE.BoxGeometry(0.36, 0.03, 0.35), cellMat, 24);
  const mm = new THREE.Matrix4();
  for (let i = 0; i < 6; i++) for (let j = 0; j < 4; j++) (mm.makeTranslation(-0.95 + i * 0.38, 0.045, -0.555 + j * 0.37), cells.setMatrixAt(i * 4 + j, mm));
  panel.add(cells);
  root.add(panel);
  const m = beaconMast(mats, 1.05, 1.57, -0.63); // on the panel's top back corner
  root.add(m.g);
  root.userData = { beacon: m.b };
  return root;
}
