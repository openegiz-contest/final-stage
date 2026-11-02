// The broadcast's live background (idle.html): the control room of show.html with nobody driving it.
// A slow camera loop through the hall (LOOP_S, a closed spline: no seam at the wrap), the robots in
// their idle life (world/stage.js robots: breath, weight shifts, glances) plus a few calm beats per
// loop (two Judges look at each other, a Judge turns to the room and back), the pit's trucks and the
// dispatch wall's live plan, the consoles on standby with their Judge's name. No voice, no audio
// element, no operator UI. Nothing here comes from the engine: the page reads only, at most, the
// programme (/program/program.json) for the Finalists' names.
//
// Modes (OBS builds against these URLs; do not rename):
//   soon   ?at=<ISO>            «Финал начнётся через MM:SS» (HH:MM:SS from an hour), «Начинаем» after zero
//   host   ?name=&role=         the live host's camera rect (CAM_RECT) stays calm; a name plaque under it;
//                               the title and the room in the right column (the camera's view shifted right)
//   break                       «Технический перерыв» · «Скоро вернёмся»
//   end                         «Спасибо!» · the results' address; nothing under the cams' circles (ui/safe.js)
// Checks: ?t= freezes a frame (lib/clock.js), ?now=<ISO> sets the wall clock at t=0 (the countdown then
// runs on the page clock), ?gfx=lite, ?program=<url> (default /program/program.json; 0: none, no request). window.__idle is the checks' hook (test/idle-check.mjs).
import * as THREE from "three";
import { now, frozenAt, gfx, installStageHook } from "/lib/clock.js";
import { createStage } from "/world/stage.js";
import { fitFrame, hitsCams, FRAME } from "/ui/safe.js";
import { ROSTER, JUDGE_IDS } from "/robots/roster.js";
import { DESKS, HOST_POST } from "/world/layout.js";
import { BOARD_W, BOARD_H } from "/world/props/board.js";
import { smooth } from "/world/timeline.js";

export const LOOP_S = 120; // the camera's loop, s
export const MODES = ["soon", "host", "break", "end"];
// OBS puts the live host's camera here on the 1920×1080 canvas (rounded corners r=24)
export const CAM_RECT = { x: 100, y: 170, w: 1120, h: 630, r: 24 };
const HOST_SHIFT = 600; // px the host mode's view moves right: the room's centre in the right column
const FPS = 30; // live frames are capped at this rate (OBS composites at 30)

// The words on screen. The title is show.html's (ui/program.js LABELS.title / titleKicker); the
// mode lines are the brief's (OBS scenes, 2026-10-30).
export const TEXT = {
  title: "Цифровой рудник на OpenEgiz",
  kicker: "Финал",
  soonLabel: "Финал начнётся через",
  started: "Начинаем",
  breakMain: "Технический перерыв",
  breakSub: "Скоро вернёмся",
  endMain: "Спасибо!",
  endSub: "Итоги — ",
  endUrl: "openegiz-contest.github.io",
  finalists: "Финалисты",
  hostName: "Алихан Амирханов",
  hostRole: "Соведущий",
  foot: (n) => [n ? `${n} Финалистов` : null, "5 Судей"].filter(Boolean).join(" · "),
};
// An ISO time from the query. OBS URLs carry the offset unescaped («…15:00:00+05:00»), which a query
// string reads as a space: the plus is put back.
const isoParam = (q, k) => (q.get(k) ?? "").trim().replace(/ (\d\d:?\d\d)$/, "+$1");
const MONTHS = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];

// ---- the camera loop: keys at equal time steps on a closed uniform Catmull-Rom spline (C1 everywhere,
// the wrap included); each key: position, target, fov, exposure (the grade's iris, world/camera.js
// EXPOSURE), aperture (depth of field; 0 off), focus (m; null: the distance to the target).
const KEYS = [
  // the opening: high over the back of the room toward the glass and the pit (ui/program.js FRAMES.open)
  { pos: [4.6, 4.1, 8.0], target: [-1.2, 1.0, -6.5], fov: 46, exposure: 2.3 },
  // the room from the back, drifting left
  { pos: [0.8, 3.5, 7.2], target: [-0.8, 1.3, -4.6], fov: 40, exposure: 2.3 },
  // down to the left of the row: Fable and sol from behind, their consoles beyond them
  { pos: [-2.3, 2.15, 1.7], target: [-2.2, 1.35, -4.8], fov: 36, exposure: 2.4, aperture: 0.06 },
  // behind Opus: over the row to the glass
  { pos: [-0.9, 2.1, -1.5], target: [0.3, 1.45, -7.5], fov: 40, exposure: 2.3, aperture: 0.05 },
  // across to the right, past the ballot box
  { pos: [3.2, 2.6, -0.8], target: [3.0, 1.35, -6.0], fov: 38, exposure: 2.3, aperture: 0.05 },
  // beside the glass on the right: the row in profile, Sonnet nearest
  { pos: [7.3, 2.0, -3.6], target: [-1.5, 1.35, -5.4], fov: 38, exposure: 2.2, aperture: 0.08 },
  // the reverse: high behind the consoles, over the monitors, the Judges' faces lit by their screens
  { pos: [0.6, 2.9, -8.5], target: [0.0, 1.45, -4.4], fov: 58, exposure: 2.5 },
  // back across the room toward the Host and the dispatch wall
  { pos: [1.4, 2.2, 2.4], target: [-4.6, 1.3, 0.4], fov: 36, exposure: 2.9 },
  // the Host in front, the wall behind it (ui/program.js FRAMES.two)
  { pos: [-1.3, 1.6, 2.9], target: [-6.0, 1.35, 0.45], fov: 32, exposure: 3.2, aperture: 0.12, focus: 3.5 },
  // the dispatch wall
  { pos: [-3.0, 1.9, 4.0], target: [-9.4, 1.7, 0.6], fov: 36, exposure: 2.2 },
  // up and back over the room
  { pos: [-1.6, 3.8, 7.7], target: [0.6, 1.2, -5.2], fov: 44, exposure: 2.3 },
];

const cr = (p0, p1, p2, p3, f) => {
  const f2 = f * f, f3 = f2 * f;
  return 0.5 * (2 * p1 + (-p0 + p2) * f + (2 * p0 - 5 * p1 + 4 * p2 - p3) * f2 + (-p0 + 3 * p1 - 3 * p2 + p3) * f3);
};
/** The camera of the loop at t: { pos, target, fov, exposure, aperture, focus }; periodic in LOOP_S. */
export function loopCamera(t, keys = KEYS) {
  const n = keys.length, u = (((t / LOOP_S) % 1) + 1) % 1, x = u * n, i = Math.floor(x), f = x - i;
  const k = (j) => keys[(((i + j) % n) + n) % n];
  const val = (get) => cr(get(k(-1)), get(k(0)), get(k(1)), get(k(2)), f);
  const vec = (key) => [0, 1, 2].map((c) => val((e) => e[key][c]));
  const pos = vec("pos"), target = vec("target");
  const dist = Math.hypot(pos[0] - target[0], pos[1] - target[1], pos[2] - target[2]);
  return {
    pos, target,
    fov: val((e) => e.fov),
    exposure: Math.max(0.5, val((e) => e.exposure)),
    aperture: Math.max(0, val((e) => e.aperture ?? 0)),
    focus: val((e) => e.focus ?? Math.hypot(e.pos[0] - e.target[0], e.pos[1] - e.target[1], e.pos[2] - e.target[2])) || dist,
  };
}

// ---- the robots' calm beats, per loop (s from the loop's start). Every beat ends well before the
// loop does, so each loop starts from the same state (all Judges at their consoles) and a still at
// any t is the same frame live and frozen.
const LIFE = [
  { at: 4, look: "gpt-6-astra", to: "opus-5.5", dur: 4.2 },
  { at: 4.7, look: "opus-5.5", to: "gpt-6-astra", dur: 3.6 },
  { at: 14, turn: "fable-5.1", room: true },
  { at: 19, look: "gpt-6.1-sol", to: "fable-5.1", dur: 3.8 },
  { at: 30, turn: "fable-5.1", room: false },
  { at: 34, look: "opus-5.5", to: "gpt-6.1-sol", dur: 3.8 },
  { at: 34.6, look: "gpt-6.1-sol", to: "opus-5.5", dur: 3.4 },
  { at: 44, turn: "sonnet-5.5", room: true },
  { at: 50, look: "gpt-6-astra", to: "sonnet-5.5", dur: 4.0 },
  { at: 50.8, look: "sonnet-5.5", to: "gpt-6-astra", dur: 3.4 },
  { at: 66, turn: "sonnet-5.5", room: false },
  { at: 74, look: "host", to: "opus-5.5", dur: 5.0 },
  { at: 82, look: "host", to: "fable-5.1", dur: 4.0 },
  { at: 90, turn: "opus-5.5", room: true },
  { at: 98, look: "fable-5.1", to: "gpt-6.1-sol", dur: 3.6 },
  { at: 98.7, look: "gpt-6.1-sol", to: "fable-5.1", dur: 3.2 },
  { at: 104, turn: "opus-5.5", room: false },
].sort((a, b) => a.at - b.at);

// a robot's eye point, for a look toward it
function headOf(id, robots) {
  const p = id === "host" ? HOST_POST.pos : DESKS[id].post;
  return new THREE.Vector3(p.x, (robots[id].info.height ?? 1.7) * 0.92, p.z);
}

function createLife(stage) {
  const { robots, desks } = stage;
  let upTo = null; // the last loop scheduled
  for (const id of JUDGE_IDS) {
    robots[id].setState("waiting", -1e3);
    desks[id].setPower(0.42, -1e3);
  }
  robots.host.setState("waiting", -1e3);
  function schedule(k) {
    const t0 = k * LOOP_S;
    for (const b of LIFE) {
      const t = t0 + b.at;
      if (b.turn) robots[b.turn].setState("waiting", t, b.room ? { facing: "room" } : {});
      else robots[b.look].react("nod", t, { toward: headOf(b.to, robots), dur: b.dur });
    }
  }
  return {
    /** Every loop that can touch t is scheduled, in time order. */
    ensure(t) {
      const k = Math.floor(t / LOOP_S);
      if (upTo === null) upTo = Math.max(-1, k - 2);
      while (upTo < k + 1) schedule(++upTo);
    },
  };
}

// ---- the consoles on standby: the Judge's model name and CLI on a dark screen (in-world text names
// only what stands there, robots/README.md)
const SCREEN_PX = [1600, 808];
function standbyScreen(id) {
  const c = document.createElement("canvas");
  [c.width, c.height] = SCREEN_PX;
  const g = c.getContext("2d");
  g.fillStyle = "#0d0f12";
  g.fillRect(0, 0, c.width, c.height);
  const r = ROSTER[id];
  g.textAlign = "center";
  g.fillStyle = "#ded9d0";
  g.font = `600 132px ${SANS}`;
  g.fillText(r.model, c.width / 2, c.height / 2 + 20);
  g.fillStyle = "#6f767f";
  g.font = `400 54px ${MONO}`;
  g.fillText(r.cli, c.width / 2, c.height / 2 + 120);
  return c;
}

// ---- the dispatch wall: its live plan of the pit, and the contest's title page (ui/program.js
// drawTitle: the same page) while the loop passes the Host and the wall
const SANS = '"Inter", system-ui, sans-serif', MONO = '"IBM Plex Mono", ui-monospace, monospace';
const WK = { bg: "#070b11", text: "#b8c4d2", bright: "#eef1f5", bezel: "#020203", brass: "#c9a46a" };
const WPX = 2400, WPY = Math.round((WPX * BOARD_H) / BOARD_W), WPW = WPX / 3, WPH = WPY / 2;
// the title page shows from..to s of each loop (the plan the rest of it; host: always the plan); the switch dips the panels
const WALL_TITLE = [62, 116];
const DIP = 0.3;

function createWall(stage, foot, { title = true } = {}) {
  const board = stage.scene.getObjectByName("dispatch-board");
  const screen = board?.children.find((c) => c.isMesh && c.material?.map);
  if (!screen) return { update() {}, textBoxes: () => [] };
  const markers = board.children.filter((c) => c.isMesh && c !== screen && c.geometry?.type === "ShapeGeometry");
  const plan = screen.material.map, level = screen.material.color.r;
  const canvas = document.createElement("canvas");
  canvas.width = WPX;
  canvas.height = WPY;
  const g = canvas.getContext("2d");
  const ink = []; // the title page's text boxes (canvas px), for the cams' check
  const text = (s, x, y, font, color, spacing = 0) => {
    g.font = font;
    g.fillStyle = color;
    g.textAlign = "center";
    if (spacing) g.letterSpacing = `${spacing}px`;
    const w = g.measureText(s).width, px = Number(/(\d+)px/.exec(font)[1]);
    ink.push({ text: s, x0: x - w / 2, x1: x + w / 2, y0: y - px * 0.8, y1: y + px * 0.22 });
    g.fillText(s, x, y);
    if (spacing) g.letterSpacing = "0px";
  };
  g.fillStyle = WK.bg;
  g.fillRect(0, 0, WPX, WPY);
  text(TEXT.kicker.toUpperCase(), WPX / 2, 150, `600 54px ${SANS}`, WK.brass, 10);
  let px = 150;
  for (; px > 90; px -= 4) {
    g.font = `700 ${px}px ${SANS}`;
    if (g.measureText(TEXT.title).width <= WPX - 260) break;
  }
  text(TEXT.title, WPX / 2, 330, `700 ${px}px ${SANS}`, WK.bright);
  text(foot, WPX / 2, WPH + 250, `500 60px ${SANS}`, WK.text);
  g.fillStyle = WK.bezel;
  for (let i = 1; i < 3; i++) g.fillRect(WPW * i - 3, 0, 6, WPY);
  g.fillRect(0, WPH - 3, WPX, 6);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;

  let shown = null;
  const corner = new THREE.Vector3();
  const phase = (t) => (((t % LOOP_S) + LOOP_S) % LOOP_S);
  const titleAt = (t) => title && phase(t) >= WALL_TITLE[0] && phase(t) < WALL_TITLE[1];
  return {
    update(t) {
      const on = titleAt(t);
      if (on !== shown) {
        shown = on;
        screen.material.map = on ? tex : plan;
        for (const m of markers) m.visible = !on;
      }
      // a short dip of the panels at each switch, as a video wall does when its source changes
      const p = phase(t);
      const d = title ? Math.min(...WALL_TITLE.map((s) => Math.abs(p - s))) : Infinity;
      screen.material.color.setScalar(level * (d < DIP ? 0.15 + 0.85 * smooth(d / DIP) : 1));
    },
    /** The title page's text as boxes in frame px (after a render at t), when it is on the wall. */
    textBoxes(t) {
      if (!titleAt(t)) return [];
      return ink.map((b) => {
        let behind = false;
        const ps = [[b.x0, b.y0], [b.x1, b.y0], [b.x0, b.y1], [b.x1, b.y1]].map(([x, y]) => {
          corner.set(-BOARD_W / 2 + (x / WPX) * BOARD_W, BOARD_H / 2 - (y / WPY) * BOARD_H, 0);
          screen.localToWorld(corner);
          if (corner.clone().applyMatrix4(stage.three.matrixWorldInverse).z > -0.05) behind = true;
          return stage.project(corner);
        });
        const box = { text: b.text, left: Math.min(...ps.map((q) => q.x)), right: Math.max(...ps.map((q) => q.x)), top: Math.min(...ps.map((q) => q.y)), bottom: Math.max(...ps.map((q) => q.y)) };
        const onFrame = !behind && box.right > 0 && box.left < FRAME.W && box.bottom > 0 && box.top < FRAME.H;
        return { ...box, visible: onFrame };
      });
    },
  };
}

// ---- the 2D layer
const el = (tag, cls, txt) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (txt != null) e.textContent = txt;
  return e;
};

/** «31 октября · 15:00 Астана» from an ISO time with its own offset (the offset +05:00 is Astana's). */
export function whenLine(iso) {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  const m = /([+-])(\d\d):?(\d\d)$/.exec(iso);
  const off = m ? (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : -new Date(ms).getTimezoneOffset();
  const d = new Date(ms + off * 60000);
  const hm = `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} · ${hm}${off === 300 ? " Астана" : ""}`;
}

/** The countdown's text for `left` ms: MM:SS, HH:MM:SS from an hour; null at zero and after. */
export function countdown(left) {
  const s = Math.ceil(left / 1000);
  if (!(s > 0)) return null;
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const p = (x) => String(x).padStart(2, "0");
  return h > 0 ? `${p(h)}:${p(m)}:${p(sec)}` : `${p(m)}:${p(sec)}`;
}

function buildOverlay(root, { mode, q, finalists }) {
  const layer = el("div", `id-layer id-${mode}`);
  root.appendChild(layer);
  const out = { layer, update() {} };
  const titleBlock = (kicker) => {
    const b = el("div", "id-block");
    if (kicker) b.append(el("div", "id-kicker", kicker));
    return b;
  };
  const title = () => {
    const t = el("div", "id-title");
    const [a, b] = TEXT.title.split(" на ");
    if (b) t.append(el("span", "id-line", a), el("span", "id-line", `на ${b}`));
    else t.textContent = TEXT.title;
    return t;
  };
  const list = () => {
    if (!finalists.length) return null;
    const box = el("div", "id-finalists");
    box.append(el("div", "id-kicker", TEXT.finalists));
    const cols = el("div", "id-cols");
    for (const name of finalists) cols.append(el("div", "id-name", name));
    box.append(cols);
    return box;
  };

  if (mode === "soon") {
    layer.append(el("div", "id-scrim id-scrim-low"));
    const at = Date.parse(isoParam(q, "at"));
    const b = titleBlock(whenLine(isoParam(q, "at")) ?? TEXT.kicker);
    b.append(title());
    const cd = el("div", "id-count");
    const label = el("div", "id-count-label", TEXT.soonLabel);
    const digits = el("div", "id-count-digits");
    cd.append(label, digits);
    if (Number.isFinite(at)) b.append(cd);
    layer.append(b);
    const fl = list();
    if (fl) layer.append(fl);
    let last = null;
    out.update = (wall) => {
      if (!Number.isFinite(at)) return;
      const s = countdown(at - wall);
      const key = s ?? "started";
      if (key === last) return;
      last = key;
      label.style.display = s ? "" : "none";
      digits.textContent = s ?? TEXT.started;
      digits.classList.toggle("id-started", !s);
    };
  } else if (mode === "host") {
    layer.append(el("div", "id-scrim id-scrim-host"));
    const slot = el("div", "id-slot");
    Object.assign(slot.style, { left: `${CAM_RECT.x}px`, top: `${CAM_RECT.y}px`, width: `${CAM_RECT.w}px`, height: `${CAM_RECT.h}px`, borderRadius: `${CAM_RECT.r}px` });
    const plaque = el("div", "id-plaque");
    plaque.style.left = `${CAM_RECT.x}px`;
    plaque.style.top = `${CAM_RECT.y + CAM_RECT.h + 30}px`;
    plaque.append(el("div", "id-plaque-name", q.get("name") || TEXT.hostName), el("div", "id-plaque-role", q.get("role") || TEXT.hostRole));
    const side = el("div", "id-side");
    side.style.top = `${CAM_RECT.y}px`;
    side.append(el("div", "id-kicker", TEXT.kicker), title(), el("div", "id-foot", TEXT.foot(finalists.length)));
    layer.append(slot, plaque, side);
  } else if (mode === "break") {
    layer.append(el("div", "id-scrim id-scrim-low"));
    const b = titleBlock(`${TEXT.title} · ${TEXT.kicker}`);
    b.append(el("div", "id-main", TEXT.breakMain), el("div", "id-sub", TEXT.breakSub));
    layer.append(b);
    const fl = list();
    if (fl) layer.append(fl);
  } else {
    layer.append(el("div", "id-scrim id-scrim-low"));
    const b = titleBlock(`${TEXT.title} · ${TEXT.kicker}`);
    const sub = el("div", "id-sub");
    sub.append(TEXT.endSub, el("span", "id-url", TEXT.endUrl));
    b.append(el("div", "id-main id-thanks", TEXT.endMain), sub);
    layer.append(b);
  }
  return out;
}

/** Every text node of the 2D layer as a box in frame px: [{ text, left, top, right, bottom }]. */
function overlayBoxes(root) {
  const fit = Number(getComputedStyle(document.documentElement).getPropertyValue("--fit")) || 1;
  const o = root.getBoundingClientRect();
  const out = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!n.textContent.trim()) continue;
    const p = n.parentElement;
    if (!p || getComputedStyle(p).display === "none" || p.offsetParent === null) continue;
    range.selectNodeContents(n);
    for (const r of range.getClientRects()) {
      if (!r.width || !r.height) continue;
      out.push({ text: n.textContent.trim(), left: (r.left - o.left) / fit, top: (r.top - o.top) / fit, right: (r.right - o.left) / fit, bottom: (r.bottom - o.top) / fit });
    }
  }
  return out;
}

/** The Finalists' names from the programme, alphabetical as in the announcement; [] without one. */
async function finalistNames(url) {
  try {
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) return [];
    const p = await r.json();
    return (p.finalists ?? []).map((f) => String(f.name ?? "").trim()).filter(Boolean)
      .sort((a, b) => a.localeCompare(b, "ru", { sensitivity: "base", numeric: true }));
  } catch {
    return [];
  }
}

export async function startIdle({ canvas, overlay }) {
  const q = new URLSearchParams(location.search);
  const mode = MODES.includes(q.get("mode")) ? q.get("mode") : "soon";
  document.documentElement.classList.add(`idle-${mode}`);
  fitFrame(); // the 1920×1080 frame, letterboxed (ui/safe.js)
  await Promise.all(['400 30px "Inter"', '500 46px "Inter"', '600 42px "Inter"', '700 104px "Inter"', '400 54px "IBM Plex Mono"', '500 40px "IBM Plex Mono"']
    .map((f) => document.fonts.load(f)));
  const [stage, finalists] = await Promise.all([
    createStage({ canvas, gfx }),
    q.get("program") === "0" ? [] : finalistNames(q.get("program") || "/program/program.json"),
  ]);

  // the camera: the loop instead of the director's track (renderAt asks stage.camera.update(t) for the lens)
  const lens = stage.three;
  if (mode === "host") lens.setViewOffset(FRAME.W, FRAME.H, -HOST_SHIFT, 0, FRAME.W, FRAME.H);
  const look = new THREE.Vector3();
  stage.camera.update = (t) => {
    const c = loopCamera(t);
    lens.position.set(...c.pos);
    lens.fov = c.fov;
    lens.lookAt(look.set(...c.target));
    lens.updateProjectionMatrix();
    lens.updateMatrixWorld();
    return { focus: c.focus, aperture: gfx === "lite" ? 0 : c.aperture, exposure: c.exposure };
  };

  const life = createLife(stage);
  for (const id of JUDGE_IDS) stage.desks[id].show({ kind: "image", label: "", path: "", img: standbyScreen(id) }, -1e3);
  // host: the right column carries the title in 2D; the wall's own title page behind it read as a double
  const wall = createWall(stage, TEXT.foot(finalists.length), { title: mode !== "host" });
  const ui = buildOverlay(overlay, { mode, q, finalists });
  await stage.ready();

  // the wall clock: ?now= pins it to the page clock (checks), else the machine's
  const nowParam = Date.parse(isoParam(q, "now"));
  const wallAt = (t) => (Number.isFinite(nowParam) ? nowParam + t * 1000 : Date.now());

  let lastT = 0;
  function renderAt(t) {
    lastT = t;
    life.ensure(t);
    wall.update(t);
    stage.renderAt(t);
    ui.update(wallAt(t));
  }
  const hook = installStageHook({ renderAt, renderer: stage.renderer });
  window.__idle = {
    mode, LOOP_S, CAM_RECT, finalists,
    frames: 0, // live frames drawn (the 30 fps cap's check)
    camera: (t) => loopCamera(t),
    /** the text on screen at the last frame: the 2D layer's and the wall's, in frame px */
    textBoxes: () => [...overlayBoxes(overlay).map((b) => ({ ...b, src: "2d" })), ...wall.textBoxes(lastT).filter((b) => b.visible).map((b) => ({ ...b, src: "wall" }))],
    hitsCams: (boxes) => boxes.filter((b) => hitsCams(b)),
  };
  if (frozenAt !== null) {
    await hook.seek(frozenAt);
    hook.ready = true;
    return;
  }
  // live: at most FPS frames a second
  let lastFrame = -Infinity;
  const tick = (ms) => {
    requestAnimationFrame(tick);
    if (ms - lastFrame < 1000 / FPS - 2) return;
    lastFrame = ms;
    renderAt(now());
    window.__idle.frames++;
    hook.ready = true;
  };
  requestAnimationFrame(tick);
}
