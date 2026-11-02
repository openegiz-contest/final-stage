// The open pit at night, seen through the glass. The control room stands on a dump above the near
// rim, so the whole far wall is in view: twelve 15 m benches stepping down to the floor (references
// 05, 07, 10), a two-lane haul road climbing the far wall in four legs with three hairpins, haul
// trucks on it (loaded up, empty down; reference 11), a shovel loading at the face on the floor, and
// the night's light where a pit really has it: three floodlight masts throwing warm pools on the
// bench faces, mobile light plants at the hairpins, headlights moving on the road, the crusher on
// the far rim. A low moon gives the benches their shape. No glow sprites: a lamp is a few pixels.
// Its own scene (own lights and fog), drawn before the hall with its own near plane.
import * as THREE from "three";
import { makeMaterials, makeHaulTruck, makeExcavator, makeCrusher, makeLightTower } from "/vendor/mine/mine.js";
import { bakeByMaterial } from "./bake.js";
import { rng } from "./timeline.js";
import { C, H0, N, BH, D, RUN, CREST, FACE, FAR, rim, wallXZ, terraceY, roadNear, roadAt, ROAD, ROAD_HALF, FLEET, truckAt, WORK, WORK_D, MASTS } from "./props/pitgeo.js";
import { clock } from "./props/shared.js";

const MAX_LIGHTS = 24;
const TRUCK_SCALE = 5.2; // mine.js trucks are ~2.6 long: ~13.5 m by 8.7 m, a 220 t hauler

/**
 * Night lights as uniforms in the terrain's shading: warm pools without shadows. Each light is a
 * position and reach, a colour, and an aim (xyz) with the cosine of its half-angle (w; < -1: all round).
 */
function nightLit(mat, L) {
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uNL = L.pos;
    sh.uniforms.uNC = L.col;
    sh.uniforms.uND = L.dir;
    sh.vertexShader = sh.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vNightPos;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvNightPos = (modelMatrix * vec4(transformed, 1.0)).xyz;");
    sh.fragmentShader = sh.fragmentShader
      .replace("#include <common>", `#include <common>\nvarying vec3 vNightPos;\nuniform vec4 uNL[${MAX_LIGHTS}];\nuniform vec3 uNC[${MAX_LIGHTS}];\nuniform vec4 uND[${MAX_LIGHTS}];`)
      .replace(
        "#include <emissivemap_fragment>",
        `#include <emissivemap_fragment>
        vec3 nN = normalize(cross(dFdx(vNightPos), dFdy(vNightPos)));
        for (int i = 0; i < ${MAX_LIGHTS}; i++) {
          vec3 d = uNL[i].xyz - vNightPos;
          float r2 = dot(d, d) / (uNL[i].w * uNL[i].w);
          vec3 l = normalize(d);
          float lam = 0.12 + 0.88 * max(dot(nN, l), 0.0);
          float cone = uND[i].w < -1.0 ? 1.0 : smoothstep(uND[i].w - 0.12, uND[i].w + 0.04, dot(-l, uND[i].xyz));
          totalEmissiveRadiance += diffuseColor.rgb * uNC[i] * lam * cone * (1.0 / (1.0 + 6.0 * r2)) * (1.0 - smoothstep(0.3, 1.0, r2));
        }`,
      );
  };
  mat.customProgramCacheKey = () => "nightLit3";
  return mat;
}

/** A small round lamp point: sharp core, a one-pixel soft edge. */
function dotTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 16;
  const g = c.getContext("2d");
  const r = g.createRadialGradient(8, 8, 0, 8, 8, 8);
  r.addColorStop(0, "rgba(255,255,255,1)");
  r.addColorStop(0.45, "rgba(255,255,255,0.9)");
  r.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = r;
  g.fillRect(0, 0, 16, 16);
  return new THREE.CanvasTexture(c);
}

export function createPit({ lite = false } = {}) {
  const scene = new THREE.Scene();
  const FOG = new THREE.Color("#0a0d14");
  scene.fog = new THREE.FogExp2(FOG, 0.00024);
  const r0 = rng(3);

  // ---- the night sky: dark overhead, a faint lift at the horizon (the town and the plant), stars
  scene.add(new THREE.Mesh(new THREE.SphereGeometry(5200, 48, 24), new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    vertexShader: `varying vec3 vD; void main(){ vD = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: `varying vec3 vD;
      void main(){
        float h = vD.y;
        vec3 night = vec3(0.0016, 0.0022, 0.0050), band = vec3(0.010, 0.012, 0.020);
        vec3 c = mix(band, night, smoothstep(-0.01, 0.16, h));
        float toward = smoothstep(-0.2, 1.0, -vD.z);
        c += vec3(0.020, 0.013, 0.007) * exp(-pow(max(h, 0.0) * 30.0, 2.0)) * (0.35 + 0.65 * toward);
        gl_FragColor = vec4(c, 1.0);
      }`,
  })));
  {
    const n = lite ? 260 : 480, p = new Float32Array(n * 3), r = rng(7);
    for (let i = 0; i < n; i++) {
      const a = r() * Math.PI * 2, y = 0.08 + Math.pow(r(), 0.7) * 0.92, k = Math.sqrt(1 - y * y);
      p.set([Math.cos(a) * k * 5000, y * 5000, Math.sin(a) * k * 5000], i * 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(p, 3));
    scene.add(new THREE.Points(g, new THREE.PointsMaterial({ color: "#8f9bb4", size: 1.0, sizeAttenuation: false, fog: false, transparent: true, opacity: 0.5, depthWrite: false })));
  }
  // low hills on the horizon: a dark line against the lifted sky
  {
    const M = 360, R = 4600, pos = [], idx = [], r = rng(23);
    const bumps = Array.from({ length: 9 }, () => [r() * 6.28, 1 + r() * 5, r()]);
    for (let i = 0; i <= M; i++) {
      const a = (i / M) * Math.PI * 2;
      let h = 12;
      for (const [ph, f, w] of bumps) h += 16 * w * Math.max(0, Math.sin(a * f + ph));
      h += 8 * Math.sin(a * 37 + 1.3);
      const x = Math.sin(a) * R, z = -Math.cos(a) * R;
      pos.push(x, C.y - 80, z, x, C.y + h, z);
      if (i < M) idx.push(i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 1, i * 2 + 3, i * 2 + 2);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    scene.add(new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: new THREE.Color(0.0042, 0.0046, 0.0068), side: THREE.DoubleSide, fog: false })));
  }

  // ---- light: a low moon from behind the hall, to the left; a faint sky fill
  scene.add(new THREE.HemisphereLight("#3a4868", "#0d0b09", 0.45));
  const moon = new THREE.DirectionalLight("#a4b6dc", 1.0);
  moon.position.set(-0.8, 0.72, 0.45);
  scene.add(moon);

  // the night lights in the terrain's shading
  const L = {
    pos: { value: Array.from({ length: MAX_LIGHTS }, () => new THREE.Vector4(0, -1e5, 0, 1)) },
    col: { value: Array.from({ length: MAX_LIGHTS }, () => new THREE.Color(0)) },
    dir: { value: Array.from({ length: MAX_LIGHTS }, () => new THREE.Vector4(0, -1, 0, -2)) },
  };
  let nL = 0;
  /** A pool of light: at p, reaching `reach` m, colour × gain, aimed along `aim` within `half` rad. */
  const addLight = (p, reach, color, gain, aim = null, half = Math.PI) => {
    if (nL >= MAX_LIGHTS) throw new Error("pit: too many lights");
    const i = nL++;
    L.pos.value[i].set(p.x, p.y, p.z, reach);
    L.col.value[i].set(color).multiplyScalar(gain);
    if (aim) L.dir.value[i].set(aim.x, aim.y, aim.z, Math.cos(half));
    return i;
  };

  // ---- the ground: one polar mesh, rings at every crest and toe so each bench edge stays crisp,
  // the haul road cut and filled into the wall
  {
    const ds = [-4200, -2600, -1600, -1000, -620, -380, -230, -140, -80, -40, -16, -5, -1];
    for (let k = 0; k < N; k++) {
      const c = CREST[k], b = CREST[k + 1] - c - FACE;
      ds.push(c, c + 0.7, c + FACE * 0.35, c + FACE * 0.7, c + FACE - 0.5, c + FACE, c + FACE + 1.2, c + FACE + b * 0.5);
    }
    const FLOOR = [0.0, 0.04, 0.12, 0.3, 0.55, 0.8, 0.97]; // the floor: fractions of the way to the centre
    const S = lite ? 640 : 1100;
    const rows = ds.length + FLOOR.length;
    const pos = new Float32Array(rows * (S + 1) * 3), col = new Float32Array(rows * (S + 1) * 3);
    const BERM = new THREE.Color("#9a8a76"), FACEC = new THREE.Color("#6a5747"), FACE2 = new THREE.Color("#7f6853"), FLOORC = new THREE.Color("#756656");
    const PLAIN = new THREE.Color("#7c7062"), ROADC = new THREE.Color("#b3a58f"), TOE = new THREE.Color("#4f4339");
    const c = new THREE.Color();
    let v = 0;
    const thLo = FAR - 0.6, thHi = FAR + 1.35; // where the road can be
    for (let i = 0; i < rows; i++) {
      for (let j = 0; j <= S; j++) {
        const th = -Math.PI + (j / S) * Math.PI * 2;
        const R = rim(th).r;
        const d = i < ds.length ? ds[i] : RUN + (R - RUN) * FLOOR[i - ds.length];
        // the crest lines wander a few metres, bench by bench
        const kb = d > 0 && d < RUN ? CREST.findIndex((c) => c > d) - 1 : -1;
        const p = wallXZ(th, kb < 0 ? d : d + 2.6 * Math.sin(th * (7 + (kb % 5)) + kb * 1.9) + 1.6 * Math.sin(th * (19 + kb) + kb * 0.7));
        let y = terraceY(d);
        // the rock is not machined: a little noise on faces and berms, more on the plain
        const n1 = Math.sin(th * 41 + d * 0.31) * 0.5 + Math.sin(th * 97 - d * 0.13) * 0.35 + Math.sin(th * 13 + d * 0.05) * 0.4;
        if (d < 0) y += Math.min(1, -d / 300) * (6 * Math.sin(th * 5 + 1.1) + 4 * Math.sin(th * 11 - d * 0.004)) + n1 * 0.8;
        else y += n1 * 0.45;
        // the road: level across its width, cut into the wall and filled on its outer side
        let onRoad = 0;
        if (th > thLo && th < thHi && d > -120 && d < RUN + 90) {
          const rn = roadNear(p.x, p.z);
          if (rn.dist < ROAD_HALF + 14) {
            const w = rn.dist < ROAD_HALF ? 1 : 1 - (rn.dist - ROAD_HALF) / 14;
            const s = w * w * (3 - 2 * w);
            y = y + (rn.y - y) * s;
            onRoad = rn.dist < ROAD_HALF - 1.5 ? 1 : rn.dist < ROAD_HALF + 1.5 ? 0.5 : 0;
          }
        }
        pos[v * 3] = p.x;
        pos[v * 3 + 1] = C.y + y;
        pos[v * 3 + 2] = p.z;
        // colour: dusty berms, darker faces with strata, a dark band at each toe, the lighter road
        if (onRoad === 1) c.copy(ROADC);
        else if (onRoad === 0.5) c.copy(TOE).lerp(ROADC, 0.35); // the windrow along the edge
        else if (d < 0) c.copy(PLAIN).lerp(FACE2, 0.25 + 0.25 * Math.sin(th * 7 + d * 0.01));
        else if (d >= RUN) c.copy(FLOORC);
        else {
          let k = 0;
          while (k < N - 1 && d >= CREST[k + 1]) k++;
          const f = (d - CREST[k]) / FACE;
          // a face: a hard light edge at the crest (it catches the sky), even rock below, dark talus at the toe
          if (f < 1) c.copy(FACEC).lerp(FACE2, 0.5 + 0.5 * Math.sin(y * 0.6 + th * 4 + k)).multiplyScalar(f < 0.14 ? 1.55 : 0.95 - 0.15 * f);
          else if (f < 1.25) c.copy(TOE).multiplyScalar(0.7);
          else c.copy(BERM).lerp(FACE2, 0.2 + 0.2 * Math.sin(th * 9 + k * 1.7));
        }
        // patches of different rock along the wall
        const patch = d > 0 ? 0.8 + 0.4 * (0.5 + 0.5 * Math.sin(th * 3.3 + kb * 0.9 + 0.8 * Math.sin(th * 8.1 + kb))) : 1;
        // deeper is darker: the walls shade the lower benches from the sky
        const deep = d > 0 ? 1 - 0.5 * Math.min(1, d / RUN) : 1;
        c.multiplyScalar((0.88 + 0.22 * r0()) * patch * deep);
        col[v * 3] = c.r;
        col[v * 3 + 1] = c.g;
        col[v * 3 + 2] = c.b;
        v++;
      }
    }
    const idx = [], W = S + 1;
    for (let i = 0; i < rows - 1; i++)
      for (let j = 0; j < S; j++) {
        const a = i * W + j, b = a + 1, d = a + W, e = d + 1;
        idx.push(a, d, b, b, d, e);
      }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("color", new THREE.BufferAttribute(col, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    const mat = nightLit(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.97, metalness: 0, side: THREE.DoubleSide, flatShading: true }), L);
    scene.add(new THREE.Mesh(g, mat));
  }

  // ---- machines, masts, lamps
  const mats = makeMaterials();
  mats.lamp.emissiveIntensity = 2.2;
  mats.lampDim.emissiveIntensity = 2.0;
  mats.tail.emissiveIntensity = 1.5;
  for (const m of Object.values(mats)) if (m.isMeshStandardMaterial) m.envMapIntensity = 0;
  // every lamp is one point of a few pixels: [x, y, z, r, g, b, size px]; trucks' are rewritten each frame
  const lamps = [];
  const lamp = (p, color, k, size = 2.2) => {
    const c = new THREE.Color(color).multiplyScalar(k);
    lamps.push({ p: new THREE.Vector3().copy(p), c, base: c.clone(), size });
    return lamps[lamps.length - 1];
  };
  const groundAt = (th, d) => {
    const p = wallXZ(th, d);
    return new THREE.Vector3(p.x, C.y + terraceY(d), p.z);
  };
  const toCentre = (p) => new THREE.Vector3(C.x - p.x, 0, C.z - p.z).normalize();

  // floodlight masts: 30 m, a head of six lamps aimed down at the wall; warm high-pressure sodium
  const mastMat = new THREE.MeshStandardMaterial({ color: "#5a5d61", roughness: 0.6, metalness: 0.6 });
  const headMat = new THREE.MeshStandardMaterial({ color: "#2a2c30", roughness: 0.6, metalness: 0.4 });
  for (const [th, d, aimD, reach] of MASTS) {
    const base = groundAt(th, d);
    const m = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.9, 30, 8, 1), mastMat);
    m.position.copy(base).add(new THREE.Vector3(0, 15, 0));
    scene.add(m);
    const head = new THREE.Mesh(new THREE.BoxGeometry(5, 2.2, 1), headMat);
    const out = toCentre(base).negate(); // the wall is outward from the centre
    const aimAt = groundAt(th, aimD).add(new THREE.Vector3(0, -BH * 0.4, 0));
    const top = base.clone().add(new THREE.Vector3(0, 30, 0));
    head.position.copy(top);
    head.lookAt(aimAt);
    scene.add(head);
    const aim = aimAt.clone().sub(top).normalize();
    for (let i = 0; i < 3; i++) lamp(top.clone().addScaledVector(aim, 0.8).add(new THREE.Vector3((i - 1) * 1.6 * out.z, 0.4, -(i - 1) * 1.6 * out.x)), "#ffc27a", 3.2, 2.0);
    addLight(top.clone().lerp(aimAt, 0.15), reach * 1.3, "#ffcf96", 2.0, aim, 0.95);
  }

  // mobile light plants (mine.js light towers at 3.6 m per unit: a 9 m mast) at the hairpins
  const tower = bakeByMaterial(makeLightTower(mats));
  for (const sRoad of [0.3, 0.55, 0.78]) {
    // the hairpins are where the road turns back: find the sharpest turn near each fraction
    const s = ROAD.length * sRoad;
    const p = roadAt(s), side = new THREE.Vector3(p.dz, 0, -p.dx);
    const base = new THREE.Vector3(p.x, p.y, p.z).addScaledVector(side, ROAD_HALF + 4);
    const t = tower.clone();
    t.position.copy(base);
    t.scale.setScalar(3.6);
    t.rotation.y = Math.atan2(-side.x, -side.z);
    scene.add(t);
    const top = base.clone().add(new THREE.Vector3(0, 9, 0));
    lamp(top, "#fff0d6", 2.6, 1.8);
    addLight(top, 95, "#ffe2b8", 1.5);
  }

  // the shovel loading at the face on the floor, under its work lights; a truck under it
  {
    const ex = makeExcavator(mats);
    ex.pose({ slew: 0.0, boom: 0.42, stick: 1.05, bucket: 0.8 });
    const e = bakeByMaterial(ex.group);
    const th = ROAD.pts[0].th, p = groundAt(th - 0.01, CREST[WORK] + FACE + 7);
    e.position.copy(p);
    e.scale.setScalar(3.4);
    const out = toCentre(p).negate();
    e.rotation.y = Math.atan2(out.x, out.z) - 0.5;
    scene.add(e);
    lamp(p.clone().add(new THREE.Vector3(0, 9, 0)).addScaledVector(out, 2), "#fff3df", 2.6, 2.0);
    lamp(p.clone().add(new THREE.Vector3(-2, 6, 0)).addScaledVector(out, 4), "#fff3df", 2.2, 1.6);
    addLight(p.clone().add(new THREE.Vector3(0, 10, 0)).addScaledVector(out, 8), 60, "#fff0d8", 2.4);
  }

  // the night shift's other work points: a blast-hole drill on an upper bench (its mast up, a lamp
  // on it), a dozer cleaning a berm, a water truck parked at a bench's end; each with its own pool
  {
    const yellow = mats.paint, dark = mats.graphite;
    const put = (obj, th, d, yaw) => {
      const p = groundAt(th, d);
      obj.position.copy(p);
      obj.rotation.y = yaw ?? Math.atan2(C.x - p.x, C.z - p.z);
      scene.add(obj);
      return p;
    };
    const work = [
      // [angle, bench, kind]
      [FAR - 0.62, 2, "drill"], [FAR - 0.42, 6, "dozer"], [FAR - 0.12, 3, "drill"], [FAR - 0.8, 10, "dozer"],
    ];
    for (const [th, k, kind] of work) {
      const g = new THREE.Group();
      if (kind === "drill") {
        { const b = new THREE.Mesh(new THREE.BoxGeometry(5, 3, 9), yellow); b.position.set(0, 2, 0); g.add(b); }
        const mast = new THREE.Mesh(new THREE.BoxGeometry(0.9, 18, 0.9), yellow);
        mast.position.set(0, 12, 3.5);
        g.add(mast);
      } else {
        { const b = new THREE.Mesh(new THREE.BoxGeometry(4.5, 2.8, 6.5), yellow); b.position.set(0, 1.9, 0); g.add(b); }
        { const b = new THREE.Mesh(new THREE.BoxGeometry(5.6, 1.8, 0.6), dark); b.position.set(0, 1.0, 4.1); g.add(b); }
      }
      const d = CREST[k] + FACE + 5;
      const p = put(g, th, d);
      const up = new THREE.Vector3(0, kind === "drill" ? 20 : 4.5, 0);
      lamp(p.clone().add(up), "#fff1dc", 2.4, 2.4);
      addLight(p.clone().add(new THREE.Vector3(0, 12, 0)), kind === "drill" ? 95 : 75, "#ffe6c4", 1.7);
    }
  }

  // the primary crusher at the road's end on the far rim, and the plant behind it
  {
    const end = ROAD.pts.at(-1);
    const p = new THREE.Vector3(end.x, C.y + 0.4, end.z);
    const cr = bakeByMaterial(makeCrusher(mats, { side: 1 }));
    cr.position.copy(p);
    cr.scale.setScalar(11);
    cr.rotation.y = Math.atan2(p.x - roadAt(ROAD.length - 60).x, p.z - roadAt(ROAD.length - 60).z) + Math.PI;
    scene.add(cr);
    addLight(p.clone().add(new THREE.Vector3(0, 18, 0)), 120, "#ffc98c", 1.8);
    // the concentrator: long clad halls, a stack with obstruction lights, rows of lit windows
    const clad = new THREE.MeshStandardMaterial({ color: "#3a3d42", roughness: 0.7, metalness: 0.3 });
    const back = toCentre(p).negate();
    const side = new THREE.Vector3(back.z, 0, -back.x);
    const r = rng(17);
    for (const [u, w, h, dd] of [[-160, 120, 34, 160], [-20, 90, 46, 210], [110, 140, 28, 180], [240, 70, 22, 140]]) {
      const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, 50), clad);
      const at = p.clone().addScaledVector(side, u).addScaledVector(back, dd);
      b.position.copy(at).setY(C.y + h / 2);
      b.rotation.y = Math.atan2(side.x, side.z) + Math.PI / 2;
      scene.add(b);
      for (let i = 0; i < 6; i++) lamp(at.clone().addScaledVector(side, (r() - 0.5) * w * 0.9).addScaledVector(back, -26).setY(C.y + h * (0.3 + 0.5 * r())), "#ffd9a8", 1.4, 1.6);
    }
    const stack = p.clone().addScaledVector(side, -40).addScaledVector(back, 230);
    const st = new THREE.Mesh(new THREE.CylinderGeometry(3.5, 5, 90, 12), clad);
    st.position.copy(stack).setY(C.y + 45);
    scene.add(st);
    const red1 = lamp(stack.clone().setY(C.y + 91), "#ff2a1a", 2.4, 2.2);
    const red2 = lamp(stack.clone().setY(C.y + 50), "#ff2a1a", 2.0, 1.8);
    red1.blink = red2.blink = true;
  }

  // waste dumps beyond the rim on both sides: flat-topped, terraced, dark against the sky
  {
    const dumpMat = new THREE.MeshStandardMaterial({ color: "#6d6255", roughness: 1 });
    dumpMat.side = THREE.DoubleSide;
    for (const [th, d, rad, h] of [[FAR + 0.95, -520, 420, 60], [FAR - 1.15, -460, 380, 48], [FAR + 0.3, -900, 300, 40]]) {
      const t3 = h / 3;
      const pts = [[rad, -4], [rad - 40, t3], [rad - 65, t3], [rad - 105, 2 * t3], [rad - 130, 2 * t3], [rad - 170, h], [0, h]].map(([x, y]) => new THREE.Vector2(x, y));
      const m = new THREE.Mesh(new THREE.LatheGeometry(pts, 48), dumpMat);
      const p = wallXZ(th, d);
      m.position.set(p.x, C.y - 2, p.z);
      m.scale.set(1.6, 1, 1);
      m.rotation.y = th;
      scene.add(m);
    }
  }

  // the haul trucks: bodies (loaded and empty), headlights, tail lights, the cab's beacon, deck light
  const trucks = [];
  for (const f of FLEET) {
    const g = new THREE.Group();
    const loaded = bakeByMaterial(makeHaulTruck(mats, { loaded: true, seed: f.seed }));
    const empty = bakeByMaterial(makeHaulTruck(mats, { loaded: false, seed: f.seed }));
    g.add(loaded, empty);
    g.scale.setScalar(TRUCK_SCALE);
    scene.add(g);
    const tr = {
      f, g, loaded, empty,
      head: [lamp(new THREE.Vector3(), "#fff4e0", 1, 4.6), lamp(new THREE.Vector3(), "#fff4e0", 1, 4.6)],
      tail: [lamp(new THREE.Vector3(), "#ff3020", 1, 1.6), lamp(new THREE.Vector3(), "#ff3020", 1, 1.6)],
      beacon: lamp(new THREE.Vector3(), "#ff8a1f", 1, 4.2),
      deck: lamp(new THREE.Vector3(), "#ffe9c6", 1.0, 1.5),
      pool: addLight(new THREE.Vector3(), 55, "#fff0d8", 3.0, new THREE.Vector3(0, 0, 1), 0.55),
    };
    trucks.push(tr);
  }

  // one draw call for every lamp in the pit
  const LP = new Float32Array(lamps.length * 3), LC = new Float32Array(lamps.length * 3), LS = new Float32Array(lamps.length);
  const lampGeo = new THREE.BufferGeometry();
  lampGeo.setAttribute("position", new THREE.BufferAttribute(LP, 3));
  lampGeo.setAttribute("color", new THREE.BufferAttribute(LC, 3));
  lampGeo.setAttribute("size", new THREE.BufferAttribute(LS, 1));
  const lampMat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
    uniforms: { uMap: { value: dotTexture() } },
    vertexShader: `attribute vec3 color; attribute float size; varying vec3 vC;
      void main(){ vC = color; vec4 mv = modelViewMatrix * vec4(position, 1.0); gl_Position = projectionMatrix * mv; gl_PointSize = size; }`,
    fragmentShader: `uniform sampler2D uMap; varying vec3 vC; void main(){ float a = texture2D(uMap, gl_PointCoord).a; gl_FragColor = vec4(vC * a, 1.0); }`,
  });
  const lampPoints = new THREE.Points(lampGeo, lampMat);
  lampPoints.frustumCulled = false;
  lampPoints.renderOrder = 10;
  scene.add(lampPoints);
  const writeLamps = () => {
    lamps.forEach((l, i) => {
      LP.set([l.p.x, l.p.y, l.p.z], i * 3);
      LC.set([l.c.r, l.c.g, l.c.b], i * 3);
      LS[i] = l.size;
    });
    lampGeo.attributes.position.needsUpdate = lampGeo.attributes.color.needsUpdate = lampGeo.attributes.size.needsUpdate = true;
  };

  // the pit is drawn with its own near and far planes: it starts 70 m out, so depth precision goes to it
  let saved = null;
  const eye = new THREE.Vector3();
  scene.onBeforeRender = (renderer, sc, camera) => {
    saved = [camera.near, camera.far];
    camera.near = 20;
    camera.far = 9000;
    camera.updateProjectionMatrix();
    eye.setFromMatrixPosition(camera.matrixWorld);
    aimLamps(eye);
  };
  scene.onAfterRender = (renderer, sc, camera) => {
    [camera.near, camera.far] = saved;
    camera.updateProjectionMatrix();
  };

  const fwd = new THREE.Vector3(), toEye = new THREE.Vector3(), local = new THREE.Vector3();
  /** Headlights read bright only from in front, tail lights from behind: set from the eye each frame. */
  function aimLamps(eye) {
    for (const tr of trucks) {
      fwd.set(Math.sin(tr.g.rotation.y), 0, Math.cos(tr.g.rotation.y));
      toEye.subVectors(eye, tr.g.position).normalize();
      const k = fwd.dot(toEye);
      const front = 1.1 + 3.0 * Math.pow(Math.max(0, k), 3), rear = 0.15 + 1.6 * Math.max(0, -k);
      for (const h of tr.head) h.c.copy(h.base).multiplyScalar(front);
      for (const h of tr.tail) h.c.copy(h.base).multiplyScalar(rear);
    }
    writeLamps();
  }

  function update(t) {
    clock.t = t;
    for (const f of clock.hooks) f(t);
    for (const tr of trucks) {
      const s = truckAt(tr.f, t);
      tr.g.position.set(s.x, s.y + 0.3, s.z);
      tr.g.rotation.set(0, s.yaw, 0);
      tr.loaded.visible = s.loaded;
      tr.empty.visible = !s.loaded;
      tr.g.updateMatrixWorld(true);
      const w = (x, y, z) => local.set(x, y, z).applyMatrix4(tr.g.matrixWorld);
      tr.head[0].p.copy(w(-0.56, 0.87, 1.3));
      tr.head[1].p.copy(w(0.56, 0.87, 1.3));
      tr.tail[0].p.copy(w(-0.5, 0.63, -1.06));
      tr.tail[1].p.copy(w(0.5, 0.63, -1.06));
      tr.beacon.p.copy(w(-0.62, 1.66, 1.1));
      tr.deck.p.copy(w(0.3, 1.05, 1.0));
      // the beacon turns: a flash about once a second
      const f = Math.pow(Math.max(0, Math.sin(t * 5.8 + tr.f.seed * 1.7)), 8);
      tr.beacon.c.copy(tr.beacon.base).multiplyScalar(0.35 + 3.2 * f);
      // the pool of the headlights on the road ahead (none while parked at the shovel or the crusher)
      const i = tr.pool;
      const ahead = w(0, 1.2, 2.2);
      L.pos.value[i].set(ahead.x, ahead.y + 4, ahead.z, s.moving ? 95 : 30);
      const dir = new THREE.Vector3(Math.sin(s.yaw), -0.16, Math.cos(s.yaw)).normalize();
      L.dir.value[i].set(dir.x, dir.y, dir.z, s.moving ? Math.cos(0.5) : -2);
      L.col.value[i].set("#fff0d8").multiplyScalar(s.moving ? 5.0 : 0.8);
    }
    for (const l of lamps) if (l.blink) l.c.copy(l.base).multiplyScalar(((t * 0.75) % 1) < 0.5 ? 1 : 0.08);
  }
  update(0);
  writeLamps();
  return { scene, update };
}
