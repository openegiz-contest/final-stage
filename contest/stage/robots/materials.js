// Robot materials, by the slot names the models carry (tools/blender/robots.py). Real surfaces lit by
// the room:
//   Anthropic  matte cream bisque (roughness ~0.65), glaze only on panels (Fable's tiles fade from cream
//              glaze into the clay), matte terracotta, dark clay
//   OpenAI     black glass (obsidian: a sharp mirror over black, lit by three narrow strip softboxes that
//              travel with the camera, so a few crisp highlights on a solid black body at every
//              distance, sol's warm and astra's cold; a thin Fresnel rim; point-light highlights
//              clamped below the bloom), astra's chamfered edges a thin line of light, dark satin
//              titanium at the joints
//   Host       graphite powder coat, safety amber, a retroreflective strip, rubber, aluminium
// The light a robot gives is its face light: two warm eyes behind a dark visor (Opus, Sonnet), a warm
// projector lens (Fable), a light bar behind smoked glass (sol warm ~3300 K, astra cold ~7500 K) with
// a status light on the back in the same colour, a cap lamp (Host). Every face is lit in every state
// but offline and blinks or scans every few seconds.
// The two families read equally well on screen without the black glass being as bright as the cream
// (robots/check/luma.html in the wide shots, ?ts=0.5,26.5,61: each GPT Judge's mean silhouette luma
// 0.65-0.85 of Opus's, full and lite). The glass gets there by a few highlights (the strips below,
// a little wider afar, where a facet is a pixel), astra's chamfer lines and the room's reflection,
// never by grey facets (v4.1's chrome) or a glowing outline (v4's white outline figure at 640x360).
// Body materials are shared per family; each robot owns its face material. Lite keeps every
// reflection (the environment map), the rim and the face lights, and drops clear coat and sheen.
import * as THREE from "three";
import { gfx } from "/lib/clock.js";
import { GLASS, HOUSE } from "/world/palette.js";
import { rng } from "/world/timeline.js";

const LITE = gfx === "lite";

// the robots' own surface colours (sRGB); the room's palette (world/palette.js) gives the rest
const BODY = {
  cream: "#c4b192",      // bisque: unglazed cream stoneware (reference 20), a shade deeper than paper white
  glaze: "#d9cbb2",      // the glazed panels: the same cream under glass
  terracotta: "#a9583a", // fired red clay (references 21, 22), muted
  terracottaDark: "#6f3824",
  clay: "#2e211c",       // the dark clay body at the joints and hands
  obsidian: "#0a0b0d",
  titanium: "#565a62",   // the OpenAI joints: dark satin titanium
};
const RIM = "#b4bccb"; // the night glass and the room's back light, seen at grazing angles
// astra's chamfers: the edge line's own light (up close `near` of it, see NEAR), and their reflection's gain
const CUT_EDGE = { k: 0.22, near: 0.55, env: 0.5 };
// The black glass is lit by strip softboxes that travel with the camera (view space, z toward the eye):
// what a product photographer hangs over black glass. Each is a hard-edged rectangle of light hung
// BOX_DIST metres from the part it lights, so its reflection slides across a flat facet and its edge
// cuts the facet as a crisp line. `dir` is the centre of its reflection, `up` its long axis, `half`
// its half-size [across, along] as tangents, `k` its radiance at the bright end (linear; about the
// bloom threshold at a grazing angle, so the visor stays the brightest thing), the far end `fall` of
// it. Narrow on purpose: v4.1's three discs (cos 0.66-0.78) covered ~86 % of the mirror's view, and on
// flat facets (one reflected direction per facet) nearly every facet became one flat grey panel: the
// body read as polished chrome. Strips covering a few percent of it leave most facets mirroring the
// dark room (black) and make the few that catch one read as highlights (robots/check/luma.html).
const SOFTBOX = [
  { dir: [-0.62, 0.3, 0.72], up: [0.12, 1, 0], half: [0.13, 0.62], k: 2.6, fall: 0.85 }, // key: a tall strip left of the camera
  { dir: [0.8, 0.22, 0.55], up: [-0.1, 1, 0], half: [0.09, 0.6], k: 1.9, fall: 0.85 },   // kicker: a narrow strip on the right
  { dir: [0.05, 0.93, 0.36], up: [1, 0, 0], half: [0.09, 0.55], k: 1.8, fall: 0.85 },    // overhead: a bar across the shoulders and the head
];
const BOX_DIST = 0.6; // metres from a part to the boxes: the parallax that lets a strip's edge cross a facet
// the dark room's own reflection on the whole body: a cool near-black that lifts astra off the room
// (sol, the warmer, keeps a trace of it)
const FLOOR = { glass: 0.002, cut: 0.007 };
// Each Judge's strips: in its own light (sol warmer, astra colder, spec 7.7) and their width (× `half`
// across) up close and afar (NEAR). Afar a facet is a pixel or two and a strip's reflection a speck,
// so the strips widen with distance: the share of lit facets stays small (the body stays black) and
// the figure keeps the cream's readability. astra's planar facets catch fewer strips than sol's
// rounded chamfers, so its strips are wider.
const BOX = { glass: { k: 1, w: [0.58, 1.15], tint: "#ffe9d0" }, cut: { k: 1, w: [0.7, 2.5], tint: "#dce8ff" } };
// "up close" and "afar": metres from the eye over which the strips widen and astra's chamfer lines rise
const NEAR = { dist: [3, 8] };
const SPEC_MAX = 0.55; // the most a punctual light's highlight adds on black glass (linear; bloom starts at 1.2)

/** Fine speckle and grain, near white: multiplies a base colour; doubles as a bump map. */
function speckle(seed, { size = 512, dots = 2600, dark = 0.16, grain = 0.06, base = 255 } = {}) {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d");
  g.fillStyle = `rgb(${base},${base},${base})`;
  g.fillRect(0, 0, size, size);
  const img = g.getImageData(0, 0, size, size), d = img.data, r = rng(seed);
  for (let i = 0; i < d.length; i += 4) {
    const v = base * (1 - grain * r());
    d[i] = d[i + 1] = d[i + 2] = v;
  }
  g.putImageData(img, 0, 0);
  for (let i = 0; i < dots; i++) {
    const x = r() * size, y = r() * size, rad = 0.4 + Math.pow(r(), 3) * 1.8;
    const k = Math.round(base * (1 - dark * (0.4 + 0.6 * r())));
    g.fillStyle = `rgb(${k},${k - 4},${k - 8})`;
    g.beginPath();
    g.arc(x, y, rad, 0, Math.PI * 2);
    g.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

const phys = (o) => {
  if (LITE) return new THREE.MeshStandardMaterial(strip(o));
  const { liteRoughness, liteMetalness, ...full } = o;
  return new THREE.MeshPhysicalMaterial(full);
};
function strip(o) {
  const { clearcoat, clearcoatRoughness, sheen, sheenColor, sheenRoughness, ior, specularIntensity, specularColor, liteRoughness, liteMetalness, ...rest } = o;
  if (liteRoughness !== undefined) rest.roughness = liteRoughness;
  if (liteMetalness !== undefined) rest.metalness = liteMetalness;
  return rest;
}
const std = (o) => new THREE.MeshStandardMaterial(o);
const tag = (m, env) => ((m.userData.env = env), m); // the stage sets the environment map at this level

/**
 * The black glass's lighting, as emitted light on top of the standard shading: a thin Fresnel rim (k at
 * the very edge, falling as (1 - N.V)^p, stronger on the upward-facing edges), a cool near-black floor
 * (the dark room's own reflection) and the strip softboxes' reflections (SOFTBOX) in the box's tint,
 * box.w [near, far] their width (NEAR). Uniforms live in m.userData.rim.
 */
function rim(m, color, k, p = 3, { specMax = SPEC_MAX, edge = null, floor = 0, box = { k: 1, w: [1, 1], tint: "#ffffff" } } = {}) {
  const u = { rimColor: { value: new THREE.Color(color) }, rimK: { value: k }, rimP: { value: p }, specMax: { value: specMax }, floorK: { value: floor },
    boxK: { value: box.k }, boxW: { value: new THREE.Vector2(...(box.w ?? [1, 1])) }, boxTint: { value: new THREE.Color(box.tint) } };
  if (edge) Object.assign(u, { edgeK: { value: edge.k }, edgeEnv: { value: edge.env } });
  m.userData.rim = u;
  if (edge) m.defines = { ...(m.defines || {}), USE_UV: "" };
  const f = (x) => x.toFixed(4), v3 = (a) => `vec3(${a.map(f).join(", ")})`;
  // each box's frame in view space: its centre, its long axis, its cross axis
  const frames = SOFTBOX.map((b) => {
    const d = new THREE.Vector3(...b.dir).normalize(), up = new THREE.Vector3(...b.up);
    up.addScaledVector(d, -up.dot(d)).normalize();
    return { ...b, d: d.toArray(), up: up.toArray(), across: new THREE.Vector3().crossVectors(up, d).normalize().toArray() };
  });
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, u);
    // the fragment's offset from its part's origin (view space): where on the part the reflection leaves from
    sh.vertexShader = sh.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vSbRel;")
      .replace("#include <project_vertex>", "#include <project_vertex>\nvSbRel = mvPosition.xyz - (modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;");
    sh.fragmentShader = sh.fragmentShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vSbRel;\nuniform vec3 rimColor, boxTint;\nuniform float rimK, rimP, specMax, floorK, boxK;\nuniform vec2 boxW;" + (edge ? "\nuniform float edgeK, edgeEnv;" : ""))
      .replace("#include <emissivemap_fragment>",
        "#include <emissivemap_fragment>\nfloat rimF = pow(1.0 - saturate(dot(normal, normalize(vViewPosition))), rimP);\n" +
        "totalEmissiveRadiance += rimColor * rimK * (0.45 + 0.55 * smoothstep(-0.6, 0.8, normal.y)) * rimF;\n" +
        "float sbFar = smoothstep(" + NEAR.dist.map((x) => x.toFixed(2)).join(", ") + ", length(vViewPosition)), sbWide = mix(boxW.x, boxW.y, sbFar);\n" +
        "totalEmissiveRadiance += vec3(0.7, 0.85, 1.15) * floorK * (0.75 + 0.25 * smoothstep(-0.5, 0.8, normal.y));\n" +
        // the strips' reflection: the mirror ray leaves the fragment and the box hangs BOX_DIST from the
        // part, so the ray's direction seen from the part's origin is vSbRel + R * BOX_DIST; against a
        // rectangle in the box's tangent plane, its edge one pixel wide (fwidth), weighted by Fresnel
        `vec3 sbR = reflect(-normalize(vViewPosition), normal);\nvec3 sbL = vSbRel + sbR * ${f(BOX_DIST)};\nfloat sbF = 0.6 + 0.4 * rimF;\nfloat sbSum = 0.0;\n` +
        frames.map((b, i) => {
          const c = `sbC${i}`, x = `sbX${i}`, y = `sbY${i}`;
          return `float ${c} = dot(sbL, ${v3(b.d)});\n` +
            `float ${x} = dot(sbL, ${v3(b.across)}) / max(${c}, 1e-4), ${y} = dot(sbL, ${v3(b.up)}) / max(${c}, 1e-4);\n` +
            `sbSum += step(0.0, ${c}) * ${f(b.k)} * mix(${f(b.fall)}, 1.0, saturate(0.5 + 0.5 * ${y} / ${f(b.half[1])}))` +
            ` * smoothstep(-1.0, 1.0, (${f(b.half[0])} * sbWide - abs(${x})) / max(fwidth(${x}), 1e-4))` +
            ` * smoothstep(-1.0, 1.0, (${f(b.half[1])} - abs(${y})) / max(fwidth(${y}), 1e-4));`;
        }).join("\n") +
        "\ntotalEmissiveRadiance += boxTint * rimColor * boxK * sbF * sbSum;" +
        // a chamfer (vUv.x = 1, tools/blender/robots.py cut_bevel) is a polished edge: it carries a thin
        // line of the room's back light whatever its angle, brighter where it faces up (and afar, where
        // it is under a pixel wide)
        (edge ? "\ntotalEmissiveRadiance += rimColor * edgeK * mix(" + f(edge.near) + ", 1.0, sbFar) * vUv.x * (0.35 + 0.65 * smoothstep(-0.5, 0.9, normal.y)) * (0.4 + 0.6 * rimF);" : ""))
      // a point light's highlight on a near-mirror is a tiny disc far above the bloom threshold
      // (world/post.js): clamped, it stays a hard glint and never blooms into a flare
      .replace("#include <lights_fragment_end>",
        "#include <lights_fragment_end>\nreflectedLight.directSpecular = min(reflectedLight.directSpecular, vec3(specMax));\n" +
        "#ifdef USE_CLEARCOAT\nclearcoatSpecularDirect = min(clearcoatSpecularDirect, vec3(specMax));\n#endif" +
        (edge ? "\nreflectedLight.indirectSpecular *= 1.0 + edgeEnv * vUv.x;" : ""));
  };
  m.customProgramCacheKey = () => (edge ? "robot-rim-cut" : "robot-rim");
  return m;
}

/**
 * The glaze fade on Fable's tiles (front-projected UV, v up): cream glaze over the upper part, thinning
 * into the terracotta over the lower ~45 % with a slow, soft unevenness along the line (a real glaze
 * breaks unevenly; a ruler-straight gradient reads as airbrush), and a faint speckle. No runs.
 */
function glazeFadeMap() {
  const W = 128, H = 256, c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const g = c.getContext("2d"), img = g.createImageData(W, H), d = img.data, r = rng(23);
  const A = new THREE.Color(BODY.glaze), B = new THREE.Color(BODY.terracotta); // linear components
  const sm = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  const srgb = (l) => (l <= 0.0031308 ? 12.92 * l : 1.055 * Math.pow(l, 1 / 2.4) - 0.055);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const u = x / (W - 1), v = 1 - y / (H - 1); // v: 1 at the tile top (the canvas top, flipY off)
      const wob = 0.035 * Math.sin(u * Math.PI * 2 * 1.2 + 0.7) + 0.018 * Math.sin(u * Math.PI * 2 * 2.7 + 2.1);
      const k = sm(0.62, 0.12, v + wob), n = 1 - 0.035 * r();
      const i = (y * W + x) * 4;
      d[i] = 255 * srgb(A.r + (B.r - A.r) * k) * n;
      d[i + 1] = 255 * srgb(A.g + (B.g - A.g) * k) * n;
      d[i + 2] = 255 * srgb(A.b + (B.b - A.b) * k) * n;
      d[i + 3] = 255;
    }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.flipY = false; // glTF UVs: v runs down (the exporter flips it), so the canvas top is the tile top
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

let anthropic = null, openai = null, house = null;

/** Shared body materials of the Anthropic family. */
export function anthropicKit() {
  if (anthropic) return anthropic;
  // the models carry no UVs on bodies: the speckle is for the token and the glaze panels' grain
  const sp = speckle(11, { dots: 900, dark: 0.1, grain: 0.05 });
  // bisque: unglazed, matte, a soft sheen at grazing angles (reference 20's lower half)
  // lite has no sheen and a plain F0, which reads a touch lighter: its cream is a touch deeper
  const ceramic = tag(phys({ color: LITE ? new THREE.Color(BODY.cream).multiplyScalar(0.94) : BODY.cream, roughness: 0.64, liteRoughness: 0.62, metalness: 0, specularIntensity: 0.55,
    sheen: 0.25, sheenRoughness: 0.7, sheenColor: new THREE.Color("#ffe6cc") }), 0.45);
  // glaze: a glass skin over the same cream, only on panels
  const glaze = tag(phys({ color: BODY.glaze, roughness: 0.3, liteRoughness: 0.2, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.08 }), 0.85);
  // Fable's tiles: the same glaze thinning smoothly into the red clay toward the tile's foot
  const glazeFade = tag(phys({ color: "#ffffff", map: glazeFadeMap(), roughness: 0.3, liteRoughness: 0.22, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.1 }), 0.8);
  const terracotta = tag(std({ color: BODY.terracotta, roughness: 0.8, metalness: 0 }), 0.35);
  const terracottaDark = tag(std({ color: BODY.terracottaDark, roughness: 0.84, metalness: 0 }), 0.3);
  const core = tag(std({ color: BODY.clay, roughness: 0.7, metalness: 0 }), 0.3);
  // the token's face keeps the speckled bisque
  const token = tag(phys({ color: BODY.cream, map: sp, roughness: 0.6, liteRoughness: 0.58, metalness: 0 }), 0.5);
  anthropic = { ceramic: token, bisque: ceramic, glaze, glazeFade, terracotta, terracottaDark, core, porcelain: glaze };
  return anthropic;
}

/** Shared body materials of the OpenAI family. */
export function openaiKit() {
  if (openai) return openai;
  // obsidian: black under a sharp dark mirror (F0 ~0.1 from ior 1.9, plus a clear coat in full), so each
  // facet carries one hard image of a room light (reference 23); physical in both presets. Sharp
  // (roughness 0.06): a rougher mirror spreads the ceiling's rows of fixtures (world/env.js) into a grey
  // sheen over every upward facet. The room's reflection is kept low on sol (the strips light it) and
  // stronger on astra, whose planar facets catch fewer strips.
  const glassOpts = { color: BODY.obsidian, roughness: 0.06, metalness: 0, ior: 1.9, specularIntensity: 1 };
  const glass = tag(LITE ? new THREE.MeshPhysicalMaterial(glassOpts) : new THREE.MeshPhysicalMaterial({ ...glassOpts, clearcoat: 1, clearcoatRoughness: 0.03 }), LITE ? 1.45 : 1.2); // lite: no clear coat, a stronger mirror
  // the rim at a steep falloff (p 7): only the edges that really graze the eye, not every oblique facet
  rim(glass, RIM, LITE ? 0.45 : 0.315, 7, { floor: FLOOR.glass, box: BOX.glass }); // lite: no clear coat, so the edges carry more
  // astra's cut glass: the same obsidian, its flat chamfers polished edges (a line of light each)
  const cut = tag(LITE ? new THREE.MeshPhysicalMaterial(glassOpts) : new THREE.MeshPhysicalMaterial({ ...glassOpts, clearcoat: 1, clearcoatRoughness: 0.03 }), LITE ? 2.9 : 2.4);
  rim(cut, RIM, LITE ? 0.75 : 0.525, 7, { edge: CUT_EDGE, floor: FLOOR.cut, box: BOX.cut });
  const satin = tag(std({ color: BODY.titanium, roughness: 0.32, metalness: 0.9 }), 1.3);
  openai = { glass, cut, satin };
  return openai;
}

/** The Host's materials: graphite powder coat, safety amber, a retroreflective strip. */
export function houseKit() {
  if (house) return house;
  house = {
    body: tag(std({ color: HOUSE.graphite, roughness: 0.55, metalness: 0.2 }), 0.6),
    amber: tag(phys({ color: HOUSE.amber, roughness: 0.38, liteRoughness: 0.34, metalness: 0, clearcoat: 0.6, clearcoatRoughness: 0.2 }), 0.6),
    reflect: tag(std({ color: "#b9bcbd", roughness: 0.42, metalness: 0.55 }), 0.8),
    rubber: tag(std({ color: "#141414", roughness: 0.9, metalness: 0 }), 0.2),
    metal: tag(std({ color: HOUSE.alu, roughness: 0.34, metalness: 0.92 }), 1.0),
    smoke: tag(std({ color: "#0a0b0d", roughness: 0.08, metalness: 0 }), 1.4), // camera eyes: dark glass
  };
  return house;
}

// ---- face lights ------------------------------------------------------------------------------

/**
 * A face map: the shape of the light behind the face surface, drawn in metres so the eyes stay round on
 * any visor. size = [w, h] of the UV rectangle (metres); kind:
 *   "eyes"  { eyes: [[x, y, r]...] } soft warm eyes (x, y from the centre)
 *   "lens"  concentric rings of a projector lens, a bright core
 *   "bar"   { bar: h } a bar of light the width of the visor, h its core height
 *   "lamp"  a cap lamp's oval
 */
function faceMap(kind, size, o = {}) {
  const [W, H] = size, px = 512 / Math.max(W, H);
  const c = document.createElement("canvas");
  c.width = Math.max(16, Math.round(W * px));
  c.height = Math.max(16, Math.round(H * px));
  const g = c.getContext("2d");
  g.fillStyle = "#000";
  g.fillRect(0, 0, c.width, c.height);
  const X = (x) => (x / W + 0.5) * c.width, Y = (y) => (0.5 - y / H) * c.height, R = (r) => r * px;
  if (kind === "eyes") {
    for (const [x, y, r] of o.eyes) {
      const gr = g.createRadialGradient(X(x), Y(y), 1, X(x), Y(y), R(r * 1.5));
      gr.addColorStop(0, "rgba(255,255,255,1)");
      gr.addColorStop(0.45, "rgba(255,255,255,0.9)");
      gr.addColorStop(0.66, "rgba(255,255,255,0.28)");
      gr.addColorStop(1, "rgba(255,255,255,0)");
      g.fillStyle = gr;
      g.fillRect(0, 0, c.width, c.height);
    }
  } else if (kind === "lens") {
    const cx = X(0), cy = Y(0), rr = R(Math.min(W, H) / 2);
    const gr = g.createRadialGradient(cx, cy, 0, cx, cy, rr);
    gr.addColorStop(0, "rgba(255,255,255,1)");
    gr.addColorStop(0.22, "rgba(255,255,255,0.95)");
    gr.addColorStop(0.32, "rgba(255,255,255,0.35)");
    gr.addColorStop(0.5, "rgba(255,255,255,0.22)");
    gr.addColorStop(0.62, "rgba(255,255,255,0.08)");
    gr.addColorStop(0.8, "rgba(255,255,255,0.16)");
    gr.addColorStop(0.9, "rgba(255,255,255,0.04)");
    gr.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = gr;
    g.fillRect(0, 0, c.width, c.height);
  } else if (kind === "bar") {
    // a crisp core line with a soft glow round it, the rest of the visor dark: like the eyes, a light
    // that reads against its own dark glass (a bar filling the visor reads as a grey reflection)
    const h = o.bar, cy = Y(0);
    const v = g.createLinearGradient(0, cy - R(h * 1.6), 0, cy + R(h * 1.6));
    v.addColorStop(0, "rgba(255,255,255,0)");
    v.addColorStop(0.2, "rgba(255,255,255,0.05)");
    v.addColorStop(0.34, "rgba(255,255,255,0.32)");
    v.addColorStop(0.42, "rgba(255,255,255,1)");
    v.addColorStop(0.58, "rgba(255,255,255,1)");
    v.addColorStop(0.66, "rgba(255,255,255,0.32)");
    v.addColorStop(0.8, "rgba(255,255,255,0.05)");
    v.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = v;
    g.fillRect(0, cy - R(h * 1.6), c.width, R(h * 3.2));
    g.globalCompositeOperation = "destination-in";
    const e = g.createLinearGradient(0, 0, c.width, 0);
    e.addColorStop(0, "rgba(0,0,0,0)");
    e.addColorStop(0.08, "rgba(0,0,0,1)");
    e.addColorStop(0.92, "rgba(0,0,0,1)");
    e.addColorStop(1, "rgba(0,0,0,0)");
    g.fillStyle = e;
    g.fillRect(0, 0, c.width, c.height);
  } else {
    const gr = g.createRadialGradient(X(0), Y(0), 1, X(0), Y(0), R(Math.min(W, H) / 2));
    gr.addColorStop(0, "rgba(255,255,255,1)");
    gr.addColorStop(0.55, "rgba(255,255,255,0.75)");
    gr.addColorStop(0.85, "rgba(255,255,255,0.2)");
    gr.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = gr;
    g.fillRect(0, 0, c.width, c.height);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/**
 * A robot's face: the surface it is made of with a light behind it. `material.userData.setLight(level)`
 * sets the light (0 = off; 1 = a speaking peak). Emissive, so it reads in both presets.
 * spec: { kind, size, surface, light, gain, ...map options }
 */
export function faceMaterial(spec) {
  const glassy = spec.kind !== "lamp", bar = spec.kind === "bar";
  // a light bar's visor glass reflects less than the eyes' visor, so the bar has a dark frame to read against
  const m = tag(std({ color: spec.surface, roughness: glassy ? (bar ? 0.16 : 0.1) : 0.4, metalness: 0, emissive: spec.light, emissiveMap: faceMap(spec.kind, spec.size, spec),
    emissiveIntensity: 0 }), glassy ? (bar ? 0.55 : 1.3) : 0.5);
  const gain = spec.gain ?? 2.4;
  // a status light elsewhere on the body (the OpenAI Judges' backs) follows the face, never fully dark
  const status = spec.status ? tag(std({ color: "#101010", roughness: 0.2, metalness: 0, emissive: spec.light, emissiveIntensity: 0 }), 1.0) : null;
  m.userData.status = status;
  // attention: every face is alive in the same measure. Eyes and the lens blink (a 0.2 s dip) every
  // 4-7 s; a bar scans instead: a brighter spot runs along it in 0.8 s, as often. Pure functions of the
  // show clock, seeded per robot, so stills and the clip agree; none of it while the face is off.
  const seed = spec.seed ?? 0, every = spec.every ?? 5.2;
  const scan = bar ? { x: { value: -9 }, k: { value: 1.6 } } : null;
  if (scan) {
    m.onBeforeCompile = (sh) => {
      sh.uniforms.scanX = scan.x;
      sh.uniforms.scanK = scan.k;
      sh.fragmentShader = sh.fragmentShader
        .replace("#include <common>", "#include <common>\nuniform float scanX, scanK;")
        .replace("#include <emissivemap_fragment>", "#include <emissivemap_fragment>\ntotalEmissiveRadiance *= 1.0 + scanK * exp(-pow((vEmissiveMapUv.x - scanX) / 0.08, 2.0));");
    };
    m.customProgramCacheKey = () => "robot-face-scan";
  }
  // the beat of attention at t: [index, seconds into it], each beat 4-7 s long (seeded)
  const beatAt = (t) => {
    const k = Math.floor((t + seed * 3.1) / every), u = t + seed * 3.1 - k * every;
    const jit = ((Math.sin(k * 12.9898 + seed * 78.233) * 43758.5453) % 1 + 1) % 1;
    return u - (0.6 + jit * (every - 1.6)); // < 0: before this beat's moment
  };
  m.userData.attention = (t) => {
    const s = beatAt(t);
    if (bar) return s >= 0 && s < 0.8 ? -0.15 + 1.3 * (s / 0.8) : -9; // the scan spot's u
    return s >= 0 && s < 0.2 ? 1 - 0.88 * Math.sin((s / 0.2) * Math.PI) : 1; // the blink's light
  };
  // a bar's level is compressed (level^0.6, equal at the speaking peak 1.25): eyes read against their
  // dark visor and the matte cream round it, a bar against mirror-black glass whose facets carry the
  // room's highlights, so at the dim levels (waiting 0.1, working 0.17) a linear bar sank to the
  // highlights' grey and read as unlit; compressed, each state still steps up from the one below
  const curve = bar ? (l) => Math.pow(l, 0.6) * Math.pow(1.25, 0.4) : (l) => l;
  m.userData.setLight = (level, t = null) => {
    const a = t === null || level <= 0 ? null : m.userData.attention(t);
    m.emissiveIntensity = curve(Math.max(0, level)) * gain * (!bar && a !== null ? a : 1);
    if (scan) scan.x.value = bar && a !== null ? a : -9;
    if (status) status.emissiveIntensity = level > 0 ? spec.status * (0.55 + 0.45 * Math.min(1, level * 2)) : 0;
  };
  return m;
}

/** The body material for a slot name in a model. */
export function slotMaterial(name) {
  const A = anthropicKit(), O = openaiKit(), Hs = houseKit();
  const map = {
    ceramic: A.bisque, glaze: A.glaze, terracotta: A.terracotta, terracotta_dark: A.terracottaDark, core: A.core,
    glass: O.glass, glass_cut: O.cut, satin: O.satin, glaze_fade: A.glazeFade,
    host_body: Hs.body, host_amber: Hs.amber, host_reflect: Hs.reflect, host_rubber: Hs.rubber, host_metal: Hs.metal, visor: Hs.smoke,
  };
  return map[name] ?? null;
}

export { speckle, GLASS };
