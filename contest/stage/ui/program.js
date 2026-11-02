// The whole broadcast from one page (show.html; spec §7.7 «Программа», «Где что работает»): the
// opening, the Host's introduction with the check of the two hashes on the dispatch wall, a minute for
// every Finalist from the 10th place of the Qualifying Round to the 1st, the start of the engine on the
// wall, the debate (the live show: ui/live.js mountDebate), the Host's last words. Nobody touches it
// once it runs.
//
// Segments and their clock. Every segment up to the start of the engine is a pure function of the
// programme (program.json and the timing of its lines): under ?t= the whole broadcast is planned before
// the first frame (stills and clips, tools/clip.mjs show.html), live the same plan runs on the page
// clock. The engine's start is the one thing the plan cannot know: live, the page holds on the wall's
// terminal until /run/state.json answers (the engine's run appears), then the debate starts; virtual,
// the recording (?replay=) is the run and appears TIMES.launchWaitS after the launch begins.
//
//   title        the room at night, the wall with the contest's name                  TIMES.titleS
//   intro        the Host's introduction; the hashes at its first sentence with «хеш»   intro + lead/tail
//   finalist-N   one per Finalist, N = its Qualifying rank, from the last to the 1st     minute + lead/tail
//   launch       the Host's line, the wall's terminal: the command, then the run          open (waits)
//   debate       the director's show (the engine's run on the same clock)               until its final screen
//   outro        the Host's last words under the final screen                          outro + tail
//   end          the final screen holds
//
// Resume. A reload continues in the segment it was in, from that segment's start: ?segment=<id> wins,
// ?from=<n> alone means the debate (the director's beat cursor, director/README.md «Resume»), else the
// segment stored in localStorage («stage.program.<built_at>», written when a segment starts), else the
// title. Mid-debate the director resumes from its own cursor (localStorage «stage.cursor.<run key>»).
//
// program.json (tools/build.py writes it; the contract is fixed):
//   { built_at, publication: {path, sha256}, label,
//     intro: {text, audio?, durationS, words}, finalists: [{team, name, rank, score, ceiling,
//     minute: {text, audio?, durationS, words}, images: [paths], video?, videoDurationS?, beats?}], outro: {...},
//     hashes?: {pipeline?, commit?, materials, checked, match?: {pipeline?, materials?},
//               published?: {pipeline?, materials?}, commands?: {materials}} }
// tools/build.py fills `hashes` from `python -m judge.final hashes --json` of the judge repo: the computed
// values, the published ones and `match` per row (true / false / null when nothing was published; a false
// stops the build). The wall shows «совпадает» for a row only when its match is true (without `match`, an
// older program.json: when checked is true), else «не проверено»; the «опубликовано» column shows the
// published value, empty when none. Without hashes the check is not shown (a warning).
// Paths (audio, images, video) are relative to program.json. `video` (owner 2026-10-28): a ~1-minute
// recording of the Finalist's working Stand (MP4 H.264, 1920×1080, 30 fps, no audio; another session
// records it); with it the minute is that video, muted, under the Host's voice, its picture a pure
// function of the segment clock (seeked, never restarted: ?t= stills and ?segment= resume show the
// right frame). stage-tv (owner 2026-10-28: «видео на телевизоре», «целый экран, а не четыре»): the video
// plays on the dispatch wall's big screen in the room (createTV), and the minute is shot as an edit of four
// shots (ui/minute-shots.js) from `beats` ([{ t, shot: "room" | "tv" | "tv-close" | "host", label }], t from
// the video's first frame; the montage writes them) or a default edit; without a video the screenshots
// play on the same screen one at a time, cross-fading; with neither, the name on the wall and the old
// rotation of the room. On air (owner 2026-10-28 evening, spec §7.7): no Stand videos and no beats, only
// the screenshots, each change of them a push in or a pull out on a sentence start; `video` and `beats`
// still work, dormant, and nothing waits for them. words: [{start_char, end_char, start_s, end_s}]
// as the TTS service gives them; missing words are estimated (145 words/min). A line with audio plays
// it (unless ?voice=estimate); without, it is silent and typed on its words.
//
// What is invented here (PROPOSALS for the owner, like director/host.js): the Host's launch line, the
// wall's page labels (LABELS) and the pipeline's check command shown on the wall.
import * as THREE from "three";
import { now, runLoop, showClock } from "/lib/clock.js";
import { ReplaySource, cursorFromLocation, localStorageStore } from "/director/index.js";
import { toUtf16Words } from "/lib/voice.js";
import { createOperator, withHolds, holdsOn, holdCuts, resumePlan } from "/ui/operator.js"; // operator-controls
import { estimateTiming } from "/director/voice.js";
import { labels as HOST_LABELS } from "/director/host.js";
import { ROSTER, JUDGE_IDS } from "/robots/roster.js";
import { BOARD_W, BOARD_H, TV, SEAM } from "/world/props/board.js";
import { Track, smooth, clamp01 } from "/world/timeline.js";
import { camsOn, SAFE, FRAME } from "/ui/safe.js";
import { HOST_POST } from "/world/layout.js";
import { createWalk } from "/ui/walk.js"; // walk-core
import { planMinute, stillChanges } from "/ui/minute-shots.js"; // stage-tv

export const TIMES = {
  titleS: 18,
  introLead: 0.9, introTail: 2.2,
  minuteLead: 1.6, minuteTail: 2.6,
  videoLead: 0.6, videoFade: 0.4, // a Stand video starts this long before the Host's voice; the screen fades in
  // stage-tv: a montage (a video with beats) is cut to the Host's words: it starts with the voice. The
  // screenshots: each at least stillS on the big screen, cross-fading over stillFade. tvLevel: the big
  // screen's brightness (the wall's panels: props/board.js level 0.72)
  beatsLead: 0, stillS: 7.5, stillFade: 1.6, tvLevel: 0.66,

  launchLead: 0.8, launchWaitS: 9, startHoldS: 5,
  outroLead: 1.4, outroTail: 2.0, endS: 6,
  minCut: 3.2, maxHold: 6.4, // no shot inside a line is shorter or holds longer (ui/planner.js PACE)
};
// The hash check, from its cue (the first sentence with «хеш»): seconds from the cue.
export const HASH = { computed: 1.0, lineStep: 0.45, verdict: 3.2, rowGap: 5.0, insertAt: 1.6 };

// On the wall and in the corner. PROPOSALS for the owner.
export const LABELS = {
  title: () => "Цифровой рудник на OpenEgiz",
  titleKicker: () => "Финал",
  titleFoot: (n) => `${n} Финалистов · 5 Судей`,
  hashTitle: (k) => (k === "pipeline" ? "Хеш пайплайна ИИ-жюри" : "Хеш Материалов Финала"),
  hashWhen: (k) => (k === "pipeline" ? "опубликован до Заморозки" : "опубликован со списком Финалистов"),
  computed: () => "вычислено",
  published: () => "опубликовано",
  computing: () => "вычисляется…",
  match: () => "совпадает",
  unchecked: () => "не проверено",
  pipelineCommand: (commit) => ["$ git archive --format=tar \\", `    ${commit ? commit.slice(0, 12) : "frozen"} | shasum -a 256`],
  rank: (r) => `${r}-е место`,
  rankOf: () => "Отборочного этапа",
  score: () => "Балл Отборочного этапа",
  ceiling: () => HOST_LABELS.ceiling(),
  terminal: () => "Терминал",
  waiting: () => "ожидание запуска",
  started: (time) => `запущен ${time}`,
  settings: (s) => [s.finalists && `Финалистов: ${s.finalists}`, s.places && `мест: ${s.places}`, s.rounds_per_place && `раундов на место: до ${s.rounds_per_place}`].filter(Boolean).join(" · "),
  judges: () => "Судьи",
  launchLine: () => "Все Финалисты представлены. Запускаем Финал: дальше Судьи решают сами.", // the Host, spoken
};

// ---- camera frames of the programme (world/camera.js "look"): the dispatch wall hangs on the left
// wall (props/board.js: centre (-9.43, 1.78, 0.6), facing +X; its left two columns toward +Z)
const BX = -9.43, BY = 1.78, BZ = 0.6;
export const FRAMES = {
  // the whole wall square on, the room's dark around it
  wall: { kind: "look", name: "wall", pos: [BX + 4.15, 1.72, BZ], target: [BX, BY - 0.02, BZ], fov: 32, exposure: 1.5, rate: 0.012, max: 0.18 },
  // the middle and right columns: computed | published, both rows, in the top 3/4 of the picture (clear
  // of the subtitles), square on, the frame's left edge on the bezel between the first column and the
  // second (centred on the two columns it cut the first column's title at the edge: «…а ИИ-жюри»);
  // the room beside the wall fills the frame's right side
  compare: { kind: "look", name: "compare", pos: [BX + 3.2, BY - 0.14, BZ - 0.93], target: [BX, BY - 0.14, BZ - 0.93], fov: 30.5, exposure: 1.5, rate: 0.008, max: 0.06 },
  // the same from lower and to the left: the second hash's row (a new angle, no jump cut)
  compare2: { kind: "look", name: "compare2", pos: [BX + 2.62, BY - 0.42, BZ - 0.38], target: [BX, BY - 0.42, BZ - 0.66], fov: 30.5, exposure: 1.5, rate: 0.008, max: 0.08 },
  // the left two columns: the Finalist's screenshot or name, in the top 3/4 of the picture
  visual: { kind: "look", name: "visual", pos: [BX + 3.63, BY - 0.21, BZ + 0.605], target: [BX, BY - 0.21, BZ + 0.605], fov: 30.5, exposure: 1.5, rate: 0.008, max: 0.08 },
  // the Host in front, the wall behind it
  two: { kind: "look", name: "two", pos: [-0.2, 1.72, 4.25], target: [-5.6, 1.22, 0.55], fov: 33, exposure: 3.2, aperture: 0.12, focus: 5.0, rate: 0.03, max: 0.35 },
  // the opening: high over the back of the room toward the glass and the pit
  open: { kind: "look", name: "open", pos: [4.6, 4.1, 8.0], target: [-1.2, 1.0, -6.5], fov: 46, exposure: 2.3, rate: 0.05, max: 0.6 },
  // the Judges' row from the room, a little left and right of the wide: a slow truck between them while
  // the Host names the Judges (the intro) and while the terminal waits for the engine (the launch)
  rowL: { kind: "look", name: "rowL", pos: [-2.1, 3.1, 7.4], target: [0.35, 1.3, -3.9], fov: 39, exposure: 2.3, rate: 0, max: 0 },
  rowR: { kind: "look", name: "rowR", pos: [2.1, 3.1, 7.4], target: [-0.35, 1.3, -3.9], fov: 39, exposure: 2.3, rate: 0, max: 0 },
  host: { kind: "host" },
  wide: { kind: "wide" },
  board: { kind: "board" },
};
// ?cams=1: the wall's frames widen until what they framed sits in the band between the webcam circles
// (ui/safe.js SAFE.x from either side), around the same centre, and rise by CAMS_LIFT m, so the wall's
// top row (the hash titles) comes down under the circles' level; their slow push stays short so it
// never carries the text back under a circle. The hash lines are then ~35 px high on air
// (test/safe-check.mjs checks every text box drawn on the wall against the circles).
const CAMS_SHRINK = (FRAME.W / 2 - SAFE.x) / (FRAME.W / 2) - 0.04, CAMS_LIFT = 0.26;
if (camsOn) for (const k of ["wall", "compare", "compare2", "visual"]) {
  const f = FRAMES[k], rad = (x) => (x * Math.PI) / 180;
  f.fov = (2 * Math.atan(Math.tan(rad(f.fov) / 2) / CAMS_SHRINK) * 180) / Math.PI;
  f.max = Math.min(f.max, 0.02);
  f.pos = [f.pos[0], f.pos[1] + CAMS_LIFT, f.pos[2]];
  f.target = [f.target[0], f.target[1] + CAMS_LIFT, f.target[2]];
}
// widened, the second row's own frame showed the first row's titles under the left circle: under the
// cams it frames both rows as `compare` does, from lower and further right (a new angle, no jump cut)
if (camsOn) {
  const c = FRAMES.compare;
  Object.assign(FRAMES.compare2, { fov: c.fov, pos: [c.pos[0] - 0.2, c.pos[1] - 0.24, c.pos[2] - 0.7], target: [c.target[0], c.target[1] - 0.04, c.target[2] - 0.05] });
}

// The Host's own shot and the Host with the wall behind it put the wall's left column (a Finalist's
// name, the hash titles, the terminal) in the frame's top-left corner, under the left circle. Under the
// cams the programme's Host shot is world/camera.js "host" as a look frame, and both pan (CAMS_PAN deg,
// round the camera) until the wall starts right of the circle; their push stays short.
export const CAMS_PAN = { host: -7.5, two: -6.5 };
const panned = (f, deg) => {
  const a = (deg * Math.PI) / 180, [px, , pz] = f.pos, dx = f.target[0] - px, dz = f.target[2] - pz;
  return { ...f, target: [px + dx * Math.cos(a) - dz * Math.sin(a), f.target[1], pz + dx * Math.sin(a) + dz * Math.cos(a)] };
};
if (camsOn) {
  const p = HOST_POST.pos;
  FRAMES.host = panned({ kind: "look", name: "host", pos: [p.x + 1.95, p.y + 1.45, p.z + 0.5], target: [p.x + 0.2, p.y + 1.2, p.z + 0.05], fov: 34, focus: 2.0, aperture: 0.45, exposure: 3.8, rate: 0.03, max: 0.06 }, CAMS_PAN.host);
  Object.assign(FRAMES.two, panned(FRAMES.two, CAMS_PAN.two), { max: 0.1 });
}

// ---- stage-tv: the minute's shots of the big screen (props/board.js TV: the left 2 × 2 of the wall, its
// centre (BX, BY, BZ + 0.605), 2.42 × 1.36 m, facing +X), framed on the projected screen (1920 × 1080):
//   room      the Host full length right of centre, the screen left (~510 px wide, top ~270); the room
//             between them. ?cams=1: from further right, the screen clear of the left circle (400–870 px)
//   tv        from the room's side, 18° off its axis: the screen 327–1581 px wide, its top 92–161 (under
//             the minute's caption, top right), its bottom over the subtitles (≤ 898). ?cams=1: 16° and
//             further, 411–1484 × 156–828, inside the band between the circles
//   tvClose   square on, pushed in: the screen 1728 px wide (96–1824 × 96–1067), the subtitles over its
//             lowest 15 %. ?cams=1: 1150 px wide (385–1535 × 165–811), the band's width
// A move between tv and tvClose swings and pushes at once (ui/minute-shots.js EDIT.push). The screens
// are exposed for the picture on them (the wall's frames: 1.5); the room for the room.
Object.assign(FRAMES, camsOn ? {
  room: { kind: "look", name: "room", pos: [2.0, 1.55, 4.5], target: [-6.4, 1.35, 0.8], fov: 26, exposure: 2.4, rate: 0.02, max: 0.2 },
  tv: { kind: "look", name: "tv", pos: [-5.201, 1.73, 2.418], target: [-9.431, 1.68, 1.265], fov: 30, exposure: 1.5, rate: 0.008, max: 0.04 },
  tvClose: { kind: "look", name: "tvClose", pos: [-5.19, 1.671, 1.205], target: [-9.431, 1.671, 1.205], fov: 30, exposure: 1.5, rate: 0.006, max: 0.03 },
} : {
  room: { kind: "look", name: "room", pos: [0.5, 1.55, 5.5], target: [-6.4, 1.35, 0.4], fov: 26, exposure: 2.4, rate: 0.02, max: 0.2 },
  tv: { kind: "look", name: "tv", pos: [-5.864, 1.78, 2.364], target: [-9.431, 1.70, 1.305], fov: 30, exposure: 1.5, rate: 0.008, max: 0.05 },
  tvClose: { kind: "look", name: "tvClose", pos: [-6.608, 1.838, 1.205], target: [-9.431, 1.838, 1.205], fov: 30, exposure: 1.5, rate: 0.006, max: 0.03 },
});
const MINUTE_SHOTS = { room: FRAMES.room, tv: FRAMES.tv, "tv-close": FRAMES.tvClose, host: FRAMES.host };
// ---- end stage-tv

// ---- the programme

/** program.json, its paths made absolute (relative to its own URL). */
export async function loadProgram(url) {
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  const p = await r.json();
  const abs = (x) => (x ? new URL(x, new URL(url, location.href)).href : null);
  const line = (l) => (l?.text ? { ...l, audio: abs(l.audio) } : null);
  return {
    ...p,
    intro: line(p.intro),
    outro: line(p.outro),
    finalists: (p.finalists ?? []).map((f) => ({ ...f, minute: line(f.minute), images: (f.images ?? []).map(abs), video: abs(f.video) })),
  };
}

/** A line of the programme as the voice's `prepared` (lib/voice.js): its audio decoded when there is one. */
async function prepareLine(l, { silent, warn }) {
  const text = String(l.text);
  const words = l.words?.length ? toUtf16Words(text, l.words) : null;
  const est = estimateTiming(text);
  const durationS = Math.max(l.durationS ?? l.duration_s ?? 0, words ? words.at(-1).end_s : est.durationS);
  const prepared = { speaker: "host", text, words: words ?? est.words, durationS, engine: "programme" };
  if (!l.audio || silent) return prepared;
  try {
    const a = await fetch(l.audio);
    if (!a.ok) throw new Error(`${a.status}`);
    const buffer = await new OfflineAudioContext(1, 1, 48000).decodeAudioData(await a.arrayBuffer());
    const data = buffer.numberOfChannels > 1 ? Float32Array.from(buffer.getChannelData(0), (x, i) => (x + buffer.getChannelData(1)[i]) / 2) : buffer.getChannelData(0);
    // audio without word times: the estimate stretched over the audio, so the text ends with the voice
    const k = words || !(est.durationS > 0) ? 1 : buffer.duration / est.durationS;
    const timed = words ?? est.words.map((w) => ({ ...w, start_s: w.start_s * k, end_s: w.end_s * k }));
    return { ...prepared, words: timed, durationS: Math.max(durationS * k, buffer.duration), audioUrl: l.audio, buffer, pcm: { data, sampleRate: buffer.sampleRate } };
  } catch (e) {
    warn(`programme audio ${l.audio}: ${e?.message ?? e}; the line is silent`);
    return prepared;
  }
}

/** The segments' times: [{ id, kind, from, to, ... }] from t0 (the title's start). The launch is open. */
export function planSegments(program, lines, { t0 = 0, launchWaitS = TIMES.launchWaitS } = {}) {
  const segs = [];
  let t = t0;
  const push = (s) => (segs.push(s), (t = s.to), s);
  push({ id: "title", kind: "title", from: t, to: t + TIMES.titleS });
  if (lines.intro) push({ id: "intro", kind: "intro", from: t, to: t + TIMES.introLead + lines.intro.durationS + TIMES.introTail });
  for (const f of order(program)) {
    const l = lines.minutes.get(f.team);
    // a Stand video longer than the line keeps the minute on until it ends
    const body = Math.max(l?.durationS ?? 0, f.video && f.videoDurationS > 0 ? f.videoDurationS - leadOf(f) : 0);
    push({ id: `finalist-${f.rank}`, kind: "finalist", finalist: f, from: t, to: t + TIMES.minuteLead + body + TIMES.minuteTail });
  }
  const launch = { id: "launch", kind: "launch", from: t, to: Infinity };
  launch.lineEnd = t + TIMES.launchLead + lines.launch.durationS;
  launch.appearAt = Math.max(t + launchWaitS, launch.lineEnd + 1.2); // virtual: the recording's run appears
  segs.push(launch);
  return segs;
}
const order = (program) => [...program.finalists].sort((a, b) => b.rank - a.rank);
// stage-tv: how long before the Host's voice a Finalist's video starts (a montage cut to the words: with it)
const leadOf = (f) => (f.beats?.length ? TIMES.beatsLead : TIMES.videoLead);
export const SEGMENT_IDS = (program) => ["title", "intro", ...order(program).map((f) => `finalist-${f.rank}`), "launch", "debate", "outro", "end"];

// ---- the dispatch wall's feed

const PX = 2400, PY = Math.round((PX * BOARD_H) / BOARD_W), PW = PX / 3, PH = PY / 2;
const SANS = '"Inter", system-ui, sans-serif', MONO = '"IBM Plex Mono", ui-monospace, monospace';
// the wall's own palette (props/board.js) and the show's brass
const K = { bg: "#070b11", panel: "#0b1119", rule: "#1b2634", text: "#b8c4d2", bright: "#eef1f5", dim: "#5f6e80", faint: "#2f3b4a", bezel: "#020203", brass: "#c9a46a", amber: "#c7954a" };

/**
 * The wall switches from the pit's plan to the programme's pages and back. Every page is a pure
 * function of its key; update(t) draws the page of t (once per change) and dips the panels' light for
 * a quarter of a second at a switch, as a video wall does when its source changes.
 */
function createFeed(stage) {
  const board = stage.scene.getObjectByName("dispatch-board");
  const screen = board?.children.find((c) => c.isMesh && c.material?.map);
  if (!screen) throw new Error("the dispatch board is not in the scene");
  const markers = board.children.filter((c) => c.isMesh && c !== screen && c.geometry?.type === "ShapeGeometry");
  const plan = screen.material.map, level = screen.material.color.r;
  const canvas = document.createElement("canvas");
  canvas.width = PX;
  canvas.height = PY;
  const g = canvas.getContext("2d");
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  const pages = new Track(); // { key, draw(g) | null (the plan) }
  let shown = null, shownInk = [];
  const corner = new THREE.Vector3();
  return {
    /**
     * The text on the wall at the last update, as boxes in frame px ({ left, top, right, bottom, text }),
     * for checks (?cams=1: nothing under the webcam circles). Call after stage.renderAt(t).
     */
    textBoxes() {
      return shownInk.map((b) => {
        let behind = false;
        const ps = [[b.x0, b.y0], [b.x1, b.y0], [b.x0, b.y1], [b.x1, b.y1]].map(([x, y]) => {
          corner.set(-BOARD_W / 2 + (x / PX) * BOARD_W, BOARD_H / 2 - (y / PY) * BOARD_H, 0);
          screen.localToWorld(corner);
          if (corner.clone().applyMatrix4(stage.three.matrixWorldInverse).z > -0.05) behind = true;
          return stage.project(corner);
        });
        return { text: b.text, behind, visible: !behind && ps.every((p) => p.visible), left: Math.min(...ps.map((p) => p.x)), right: Math.max(...ps.map((p) => p.x)), top: Math.min(...ps.map((p) => p.y)), bottom: Math.max(...ps.map((p) => p.y)) };
      });
    },
    /** From t the wall shows `key` (draw(g) paints it; null: the pit's plan). `route`: the route strip's
     *  trucks stay on (a page that keeps the plan's right column, stage-tv) */
    set(t, key, draw = null, { route = false } = {}) {
      pages.add(t, { key, draw, route });
    },
    planImage: plan.image, // stage-tv: the board's own picture (drawFinalist keeps its right column)
    keyAt: (t) => pages.current(t)?.key ?? "plan",
    update(t) {
      const e = pages.current(t);
      const key = e?.key ?? "plan";
      if (key !== shown) {
        shown = key;
        if (!e?.draw) {
          shownInk = [];
          screen.material.map = plan;
          for (const m of markers) m.visible = true;
        } else {
          g.save();
          ink = [];
          e.draw(g);
          shownInk = ink;
          ink = null;
          g.restore();
          seams(g);
          tex.needsUpdate = true;
          screen.material.map = tex;
          for (const m of markers) m.visible = !!e.route && m.userData.marker === "route";
        }
      }
      // the dip at a switch of page kind (not inside a page's own steps: "hash:1:0" → "hash:1:2")
      let k = 1;
      const i = pages.index(t);
      for (const j of [i, i + 1]) {
        const ev = pages.ev[j], prev = pages.ev[j - 1];
        if (!ev || (prev && kindOf(prev.key) === kindOf(ev.key))) continue;
        const d = Math.abs(t - ev.t);
        if (d < 0.22) k = Math.min(k, 0.08 + 0.92 * smooth(d / 0.22));
      }
      screen.material.color.setScalar(level * k);
    },
  };
}
const kindOf = (key) => String(key).split(":").slice(0, 2).join(":");

function seams(g) {
  // stage-tv: the big screen (the left two columns) and the column's two panels (props/board.js)
  g.fillStyle = K.bezel;
  g.fillRect(2 * PW - SEAM.tv / 2, 0, SEAM.tv, PY);
  g.fillRect(2 * PW, PH - SEAM.panel / 2, PW, SEAM.panel);
}
function clear(g) {
  g.fillStyle = K.bg;
  g.fillRect(0, 0, PX, PY);
}
let ink = null; // the text boxes of the page being drawn (canvas px), for checks
function text(g, s, x, y, { font, color = K.text, align = "left", spacing = 0 }) {
  g.font = font;
  if (ink && String(s).trim()) {
    const w = g.measureText(s).width, px = Number(/(\d+)px/.exec(font)?.[1] ?? 40);
    const x0 = align === "center" ? x - w / 2 : align === "right" ? x - w : x;
    ink.push({ text: String(s), x0, x1: x0 + w, y0: y - px * 0.8, y1: y + px * 0.22 });
  }
  g.fillStyle = color;
  g.textAlign = align;
  g.textBaseline = "alphabetic";
  if (spacing) g.letterSpacing = `${spacing}px`;
  g.fillText(s, x, y);
  if (spacing) g.letterSpacing = "0px";
}
/** Greedy wrap into lines of at most maxW px in the current font. */
function wrapText(g, s, maxW, font) {
  g.font = font;
  const out = [];
  let cur = "";
  for (const w of String(s).split(/\s+/)) {
    const next = cur ? `${cur} ${w}` : w;
    if (cur && g.measureText(next).width > maxW) (out.push(cur), (cur = w));
    else cur = next;
  }
  if (cur) out.push(cur);
  return out;
}
/** The largest size (px) at which s fits maxW in one line, from `max` down to `min`. */
function fitSize(g, s, maxW, weight, max, min) {
  for (let px = max; px > min; px -= 4) {
    g.font = `${weight} ${px}px ${SANS}`;
    if (g.measureText(s).width <= maxW) return px;
  }
  return min;
}

function drawTitle(g, n) {
  clear(g);
  text(g, LABELS.titleKicker().toUpperCase(), PX / 2, 150, { font: `600 54px ${SANS}`, color: K.brass, align: "center", spacing: 10 });
  const px = fitSize(g, LABELS.title(), PX - 260, 700, 150, 90);
  text(g, LABELS.title(), PX / 2, 330, { font: `700 ${px}px ${SANS}`, color: K.bright, align: "center" });
  text(g, LABELS.titleFoot(n), PX / 2, PH + 250, { font: `500 60px ${SANS}`, color: K.text, align: "center" });
}

/** The 64 hex digits as 4 lines of two groups of eight. */
const hashLines = (h) => (String(h ?? "").match(/.{1,16}/g) ?? []).map((l) => `${l.slice(0, 8)} ${l.slice(8)}`);

/**
 * The check of the two hashes. state per row: 0 computing, 1 computed, 2..5 lines 1..4 compared,
 * 6 the verdict. Left column: what is checked, when it was published, the command; middle: computed;
 * right: published and the verdict.
 */
function drawHashes(g, hashes, state) {
  clear(g);
  const rows = [["pipeline", hashes.pipeline], ["materials", hashes.materials]];
  rows.forEach(([k, h], r) => {
    const y0 = r * PH, s = state[r] ?? 0;
    if (!h) {
      text(g, LABELS.hashTitle(k), 60, y0 + 110, { font: `600 46px ${SANS}`, color: K.dim });
      return;
    }
    text(g, LABELS.hashTitle(k), 60, y0 + 104, { font: `650 52px ${SANS}`, color: K.bright });
    text(g, LABELS.hashWhen(k), 60, y0 + 162, { font: `500 38px ${SANS}`, color: K.text });
    const cmd = k === "pipeline" ? LABELS.pipelineCommand(hashes.commit) : (hashes.commands?.materials ? [hashes.commands.materials] : []);
    cmd.forEach((c, i) => text(g, c, 60, y0 + 266 + i * 46, { font: `400 34px ${MONO}`, color: K.dim }));
    const ok = hashes.match ? hashes.match[k] === true : !!hashes.checked;
    const pub = hashes.match ? hashes.published?.[k] ?? null : h; // an older program.json: published = computed
    const confirmed = ok ? Math.max(0, Math.min(4, s - 1)) : 0;
    const col = (x, label, value, on) => {
      text(g, label, x + 56, y0 + 82, { font: `500 38px ${SANS}`, color: K.text });
      hashLines(value).forEach((l, i) => text(g, on ? l : "", x + 56, y0 + 160 + i * 66, { font: `500 56px ${MONO}`, color: i < confirmed ? K.bright : K.text }));
    };
    col(PW, LABELS.computed(), h, s >= 1);
    if (s < 1) text(g, LABELS.computing(), PW + 56, y0 + 160, { font: `400 44px ${MONO}`, color: K.dim });
    col(2 * PW, LABELS.published(), pub, true);
    // the compared lines: a brass tick between the columns' rows
    for (let i = 0; i < confirmed; i++) {
      g.fillStyle = K.brass;
      g.fillRect(2 * PW + 22, y0 + 160 + i * 66 - 34, 8, 30);
    }
    if (s >= 6) {
      const label = ok ? `✓  ${LABELS.match()}` : LABELS.unchecked();
      text(g, label, 2 * PW + 56, y0 + 424, { font: `650 54px ${SANS}`, color: ok ? K.brass : K.dim });
    }
  });
}

/**
 * A Finalist on the wall (stage-tv): the big screen black under its own picture (createTV: the Stand
 * video or the screenshots), or with neither the Finalist's name on it; the right column keeps the pit's
 * route and legend (the room's own wall, `plan`: the board's picture; its text is one box for the
 * checks). Under ?cams=1 no `plan`: the column stays dark, its header would sit under the right circle
 * in the tv shots. Its name, place and the «подготовлено ИИ» note are the 2D caption's alone (owner
 * 2026-10-28: one card, not two).
 */
function drawFinalist(g, f, { name = false, plan = null } = {}) {
  clear(g);
  const x0 = 2 * PW;
  if (!name) (g.fillStyle = "#020305"), g.fillRect(0, 0, x0, PY);
  if (plan) g.drawImage(plan, x0, 0, PX - x0, PY, x0, 0, PX - x0, PY);
  if (plan && ink) ink.push({ text: "ТРАНСПОРТ НА ЛИНИИ … УСЛОВНЫЕ ОБОЗНАЧЕНИЯ", x0, x1: PX, y0: 0, y1: PY });
  // ---- the big screen
  if (name) {
    // the rank and its stage on two lines inside the first column: the bezel seam at x = PW cuts no word
    text(g, LABELS.rank(f.rank), 90, 160, { font: `600 64px ${SANS}`, color: K.brass });
    text(g, LABELS.rankOf(), 92, 228, { font: `500 46px ${SANS}`, color: K.text });
    const name = `«${f.name}»`;
    const px = fitSize(g, name, x0 - 180, 700, 210, 100);
    text(g, name, 90, 228 + 46 + px * 0.86, { font: `700 ${px}px ${SANS}`, color: K.bright });
    text(g, f.team, 92, PY - 120, { font: `500 56px ${MONO}`, color: K.dim });
  }
}

/** The engine's start on the terminal; the Judges from state.json once it runs. */
function drawLaunch(g, program, { state = null, cursor = true } = {}) {
  clear(g);
  const x0 = 2 * PW;
  g.fillStyle = "#0d0f12";
  g.fillRect(0, 0, x0, PY);
  g.fillStyle = "#171a1f";
  g.fillRect(0, 0, x0, 92);
  text(g, LABELS.terminal(), 40, 60, { font: `500 34px ${MONO}`, color: "#8c939c" });
  // the publication's path shortened to its last two folders («…/final-fixture/publication»), and every
  // line kept inside the terminal's two columns (a token too long for a line is cut at characters)
  const path = String(program.publication?.path ?? "…").split("/").filter(Boolean);
  const cmd = `$ python -m judge.final run --qualifying ${path.length > 2 ? `…/${path.slice(-2).join("/")}` : `/${path.join("/")}`}`;
  const font = `500 46px ${MONO}`, maxW = x0 - 100;
  g.font = font;
  const lines = wrapText(g, cmd, maxW, font).flatMap((l) => {
    const out = [];
    let cur = "";
    for (const ch of l) (g.measureText(cur + ch).width > maxW ? (out.push(cur), (cur = ch)) : (cur += ch));
    return [...out, cur];
  });
  let y = 190;
  for (const l of lines) (text(g, l, 50, y, { font: `500 46px ${MONO}`, color: "#ded9d0" }), (y += 62));
  y += 30;
  if (!state) {
    text(g, LABELS.waiting(), 50, y, { font: `400 46px ${MONO}`, color: K.dim });
    if (cursor) {
      g.font = `400 46px ${MONO}`;
      g.fillStyle = "#ded9d0";
      g.fillRect(50 + g.measureText(`${LABELS.waiting()} `).width, y - 38, 26, 46);
    }
  } else {
    const time = state.started_at ? new Date(state.started_at).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "";
    text(g, LABELS.started(time), 50, y, { font: `500 46px ${MONO}`, color: K.brass });
    y += 66;
    const s = LABELS.settings(state.settings ?? {});
    if (s) text(g, s, 50, y, { font: `400 40px ${MONO}`, color: "#ded9d0" });
  }
  // the Judges
  const cx = x0 + 60;
  text(g, LABELS.judges().toUpperCase(), cx, 110, { font: `600 34px ${SANS}`, color: K.brass, spacing: 6 });
  const js = state?.judges ?? [];
  const rows = js.length ? js : JUDGE_IDS.map((id) => ({ name: id }));
  // evenly spaced, 150 apart from 200: the panels' seam (y = PH) falls between the 2nd and the 3rd
  rows.slice(0, 5).forEach((j, i) => {
    const id = ROSTER[j.name] ? j.name : null;
    const yy = 200 + i * 150;
    text(g, id ? ROSTER[id].model : j.name, cx, yy, { font: `650 50px ${SANS}`, color: state ? K.bright : K.dim });
    const cli = j.cli && !/^fake\b/.test(j.cli) ? j.cli : id && ROSTER[id].cli; // a --fake engine: «fake codex»
    if (state && cli) text(g, cli, cx, yy + 44, { font: `400 30px ${MONO}`, color: K.text });
  });
}

// ---- the corner bug (the 2D layer, ui/cards.css): who the minute is about and who wrote it

function createBug(root) {
  const layer = document.createElement("div");
  layer.className = "cd";
  root.appendChild(layer);
  const items = [];
  return {
    /**
     * cls "cd-minute": top right (the wall hangs top left in the Host's shots). stage-tv: `line` puts the
     * note on the head's line, the whole in one small line sized to fit `line` px (the band between the
     * cams' circles under ?cams=1)
     */
    show(from, to, head, sub, note, cls = "cd-minute", { line = 0 } = {}) {
      const el = document.createElement("div");
      el.className = `cd-bug cd-back ${cls}`;
      const h = document.createElement("div");
      h.className = "cd-bug-head";
      h.append(head);
      if (line) {
        const rest = [sub, note].filter(Boolean).map((x) => ` · ${x}`).join("");
        const span = document.createElement("span");
        span.className = "cd-bug-line";
        span.textContent = rest;
        h.append(span);
        el.style.setProperty("--px", `${lineSize(head, rest, line)}px`);
        el.append(h);
        el.style.display = "none";
        layer.appendChild(el);
        items.push({ from, to, el, shown: null });
        return;
      }
      if (sub) {
        const sep = document.createElement("span");
        sep.className = "cd-bug-sep";
        sep.textContent = " · ";
        const r = document.createElement("span");
        r.className = "cd-bug-round";
        r.textContent = sub;
        h.append(sep, r);
      }
      el.append(h);
      if (note) {
        const n = document.createElement("div");
        n.className = "cd-bug-note";
        n.textContent = note;
        el.append(n);
      }
      el.style.display = "none";
      layer.appendChild(el);
      items.push({ from, to, el, shown: null });
    },
    update(t) {
      for (const it of items) {
        const a = t < it.from || t >= it.to ? 0 : Math.min(clamp01((t - it.from) / 0.3), clamp01((it.to - t) / 0.4));
        const key = a > 0 ? a.toFixed(3) : "off";
        if (key === it.shown) continue;
        it.shown = key;
        it.el.style.display = a > 0 ? "" : "none";
        it.el.style.opacity = a.toFixed(3);
      }
    },
  };
}

// stage-tv: the largest size (px, 26 down to 18) at which the minute's caption line fits maxW (its padding
// included: ui/cards.css .cd-minute, 18 px a side); the head is semibold, the rest regular
let lineCtx = null;
function lineSize(head, rest, maxW) {
  lineCtx ??= document.createElement("canvas").getContext("2d");
  const w = (px) => {
    lineCtx.font = `600 ${px}px "Inter"`;
    const a = lineCtx.measureText(head).width;
    lineCtx.font = `400 ${px}px "Inter"`;
    return a + lineCtx.measureText(rest).width + 36;
  };
  let px = 26;
  while (px > 18 && w(px) > maxW) px--;
  return px;
}
// the caption's room: right of the wall in the Host's shots, inside the band between the circles under ?cams=1
const CAPTION_W = camsOn ? FRAME.W - 2 * SAFE.x : 1500;

// ---- the big screen (stage-tv; owner 2026-10-28: «видео на телевизоре, а не просто наклеено на
// экран»): the Stand video, or the screenshots, on the dispatch wall's 110" display in the room

/** Probe a video's length (s) from its metadata; rejects when it does not load. */
function probeVideo(src, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const v = document.createElement("video");
    v.preload = "metadata";
    v.muted = true;
    const done = (fn, x) => (clearTimeout(timer), v.removeAttribute("src"), v.load(), fn(x));
    const timer = setTimeout(() => done(reject, new Error("timeout")), timeoutMs);
    v.onloadedmetadata = () => done(resolve, v.duration);
    v.onerror = () => done(reject, new Error(v.error?.message || `media error ${v.error?.code ?? "?"}`));
    v.src = src;
  });
}

/**
 * createTV(stage, root, { virtual }): the big screen's picture, a pure function of the show clock. Each
 * item fades the screen in from black at `from` and out at `to` (the wall's own page is black there):
 *   video(from, to, start, dur, src): the Stand video as a texture, its frame at t − start (its first
 *     frame before, its last after: a hold keeps it). Live it plays muted and is pulled back when it
 *     drifts, and stands with the show clock's pause; virtual (?t=, clips) it is seeked to each frame,
 *     settle() waits for that frame and says the screen must be drawn again.
 *   stills(from, to, imgs, end, starts): the screenshots one at a time, each at least TIMES.stillS,
 *     cross-fading over TIMES.stillFade, spread over [from, end) with each change on a sentence start
 *     (`starts`, ui/minute-shots.js stillChanges); the last stays until `to`. Returns the changes.
 * Letterboxed: a picture keeps its own aspect inside the 16:9 screen (TV). The <video>s sit hidden in the
 * 2D layer (the operator's Space pauses every <video> of the page).
 */
function createTV(stage, root, { virtual }) {
  const screen = stage.scene.getObjectByName("dispatch-tv");
  if (!screen) throw new Error("the dispatch board has no big screen");
  const layers = screen.children.filter((c) => c.isMesh).slice(0, 2);
  const shelf = document.createElement("div");
  shelf.className = "tv-media";
  root.append(shelf);
  const items = [];
  let lastT = 0;
  const aspectOf = (it, k) => (it.kind === "video" ? (it.video.videoWidth || 16) / (it.video.videoHeight || 9) : it.imgs[k].naturalWidth / it.imgs[k].naturalHeight);
  const fit = (m, aspect) => (aspect > TV.w / TV.h ? m.scale.set(TV.w, TV.w / aspect, 1) : m.scale.set(TV.h * aspect, TV.h, 1));
  function paint(i, tex, aspect, a) {
    const m = layers[i];
    m.visible = !!tex && a > 0.002;
    if (!m.visible) return;
    if (m.material.map !== tex) {
      // a video texture is decoded in the shader (three: decodeVideoTexture): a new program when the kind changes
      if (!m.material.map || !!m.material.map.isVideoTexture !== !!tex.isVideoTexture) m.material.needsUpdate = true;
      m.material.map = tex;
    }
    fit(m, aspect);
    m.material.color.setScalar(TIMES.tvLevel * a); // added light: a cross-fade is a + b = 1
  }
  /** The item on the screen at t and its envelope. */
  const at = (t) => {
    let best = null;
    for (const it of items) if (t >= it.from && t < it.to && (!best || it.from >= best.from)) best = it;
    return best && { it: best, a: Math.min(clamp01((t - best.from) / TIMES.videoFade), clamp01((best.to - t) / TIMES.videoFade)) };
  };
  /** stills: [{ k, a }] at t (one, or two in a cross-fade) */
  const stillsAt = (it, t) => {
    const j = it.changes.filter((c) => c <= t).length; // the picture coming in (or on)
    const u = j ? clamp01((t - it.changes[j - 1]) / TIMES.stillFade) : 1;
    return u < 1 ? [{ k: j - 1, a: 1 - smooth(u) }, { k: j, a: smooth(u) }] : [{ k: j, a: 1 }];
  };
  return {
    video(from, to, start, dur, src) {
      const video = document.createElement("video");
      Object.assign(video, { muted: true, defaultMuted: true, playsInline: true, preload: "auto", disablePictureInPicture: true });
      shelf.append(video);
      const tex = new THREE.VideoTexture(video);
      Object.assign(tex, { colorSpace: THREE.SRGBColorSpace, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter, anisotropy: 8 });
      // drawn: the video's time of the frame last pushed to the texture (-1: none yet)
      const it = { kind: "video", from, to, start, dur, src, video, tex, loaded: false, drawn: -1, vfc: 0, vfcSeen: 0 };
      // a frame presented while it plays (three's VideoTexture uploads it); the fallback below when none comes
      if ("requestVideoFrameCallback" in video) {
        const tick = () => ((it.vfc = performance.now()), video.requestVideoFrameCallback(tick));
        video.requestVideoFrameCallback(tick);
      }
      items.push(it);
    },
    stills(from, to, imgs, end = to, starts = []) {
      if (!imgs.length) return [];
      const n = Math.max(1, Math.min(imgs.length, Math.floor((end - from) / TIMES.stillS)));
      const texs = imgs.slice(0, n).map((img) => Object.assign(new THREE.Texture(img), { colorSpace: THREE.SRGBColorSpace, anisotropy: 8, needsUpdate: true }));
      const changes = stillChanges({ from, end, n, starts, stillS: TIMES.stillS, fade: TIMES.stillFade });
      items.push({ kind: "stills", from, to, imgs: imgs.slice(0, n), texs, n, changes });
      return changes; // the cross-fades' starts
    },
    update(t) {
      lastT = t;
      for (const it of items) {
        if (it.kind !== "video") continue;
        const v = it.video;
        // buffered ahead of its minute, released after it
        if (!it.loaded && t > it.from - 30 && t < it.to) (v.src = it.src), (it.loaded = true), (it.drawn = -1);
        else if (it.loaded && (t > it.to + 2 || t < it.from - 40)) (v.pause(), v.removeAttribute("src"), v.load(), (it.loaded = false));
        if (!(t >= it.from && t < it.to)) continue;
        const target = Math.min(Math.max(t - it.start, 0), Math.max(0, it.dur - 0.05));
        if (virtual || showClock.paused || t < it.start || t >= it.start + it.dur - 0.05) {
          if (!v.paused) v.pause();
          if (Math.abs(v.currentTime - target) > 1e-3) v.currentTime = target;
        } else {
          if (v.paused) v.play().catch(() => {});
          if (v.readyState >= 1 && Math.abs(v.currentTime - target) > 0.25) v.currentTime = target;
        }
      }
      const on = at(t);
      if (!on) {
        screen.visible = false;
        return;
      }
      const { it, a } = on;
      if (it.kind === "video") {
        const v = it.video, ready = it.loaded && v.readyState >= 2 && !v.seeking;
        if (ready && it.vfc > it.vfcSeen) (it.vfcSeen = it.vfc), (it.drawn = v.currentTime); // presented: three's VideoTexture uploads it
        else if (ready && it.drawn !== v.currentTime && (virtual || v.paused || performance.now() - it.vfc > 120)) {
          // a seeked or paused frame, or a playing one no frame callback announced: upload it now
          it.tex.needsUpdate = true;
          it.drawn = v.currentTime;
        }
        paint(0, it.drawn >= 0 ? it.tex : null, aspectOf(it), a);
        paint(1, null, 1, 0);
      } else {
        const st = stillsAt(it, t);
        st.forEach((x, i) => paint(i, it.texs[x.k], aspectOf(it, x.k), a * x.a));
        if (st.length < 2) paint(1, null, 1, 0);
      }
      screen.visible = layers.some((m) => m.visible);
    },
    /** Resolves when every video on the screen shows its frame (or after 8 s): true when it must be drawn again. */
    async settle() {
      const on = at(lastT);
      if (on?.it.kind !== "video" || !on.it.loaded) return false;
      const v = on.it.video;
      await new Promise((resolve) => {
        const evs = ["seeked", "loadeddata", "canplay", "error"];
        const end = () => (evs.forEach((e) => v.removeEventListener(e, check)), clearTimeout(timer), resolve());
        const check = () => (v.error || (v.readyState >= 2 && !v.seeking)) && end();
        const timer = setTimeout(end, 8000);
        evs.forEach((e) => v.addEventListener(e, check));
        check();
      });
      return !v.error && on.it.drawn !== v.currentTime;
    },
    get lastT() {
      return lastT;
    },
    /** What the screen shows at the last update: { kind: "video" | "stills", src?, k?, at? } or null. */
    get onScreen() {
      const on = at(lastT);
      if (!on || !screen.visible) return null;
      return on.it.kind === "video" ? { kind: "video", src: on.it.src, at: on.it.video.currentTime, drawn: on.it.drawn, version: on.it.tex.version, a: on.a } : { kind: "stills", k: stillsAt(on.it, lastT).map((x) => x.k), a: on.a };
    },
    get items() {
      return items.map((it) => (it.kind === "video"
        ? { kind: "video", from: it.from, to: it.to, start: it.start, dur: it.dur, src: it.src, at: it.video.currentTime, ready: it.video.readyState, paused: it.video.paused, muted: it.video.muted }
        : { kind: "stills", from: it.from, to: it.to, n: it.n, changes: it.changes }));
    },
  };
}

// ---- cutting a line

/** The sentences of a spoken line: [{ t, end, from, to, text }] (times from the line's start). */
function sentencesOf(text, timing) {
  const out = [];
  let cur = null;
  timing.words.forEach((w, i) => {
    if (!cur) cur = { t: w.start_s, from: w.start_char };
    // the TTS service's words carry their trailing space («день. »), a closing quote may follow the stop
    const word = text.slice(w.start_char, w.end_char).trimEnd();
    if (/[.!?…][»"”)]*$/.test(word) || i === timing.words.length - 1) {
      out.push({ ...cur, end: w.end_s, to: w.end_char, text: text.slice(cur.from, w.end_char) });
      cur = null;
    }
  });
  return out;
}
/** Seconds into the line at which the word holding char `c` starts. */
const wordAt = (timing, c) => (timing.words.find((w) => w.end_char > c) ?? timing.words.at(-1))?.start_s ?? 0;

/**
 * Cuts over a spoken line from t0 to t1: at sentence starts, none closer than minCut, none holding
 * longer than maxHold (a word near the middle then). `fixed` are cuts and holds booked by cues
 * ({ t, shot, until? }: the shot holds until `until` with no cut of the rotation in between).
 * next(i, t) gives the rotation's shot at a free cut.
 */
const sameShot = (a, b) => !!a && !!b && a.kind === b.kind && a.id === b.id && a.pos === b.pos;
function cutLine(cam, { t0, t1, starts, words, fixed = [], next }) {
  // the booked holds, merged where they touch, clipped to the line
  const books = [];
  for (const b of fixed.map((x) => ({ ...x, until: Math.min(x.until ?? x.t + TIMES.minCut, t1) })).filter((x) => x.until > x.t).sort((p, q) => p.t - q.t)) {
    const last = books.at(-1);
    if (last && sameShot(last.shot, b.shot) && b.t <= last.until + 0.8) {
      // one hold, no jump cut; a cue that would make it too long is left to the rotation
      if (b.until - last.t <= TIMES.maxHold + 0.6) last.until = Math.max(last.until, b.until);
    }
    else if (last && b.t < last.until) (last.until = b.t), books.push(b); // a later cue cuts the earlier hold short
    else books.push(b);
  }
  const cuts = books.map((b) => ({ t: b.t, shot: b.shot, booked: true }));
  // the free stretches between them
  const free = [];
  let a = t0;
  for (const b of books) {
    if (b.t - a > 0.8) free.push([a, b.t]);
    a = Math.max(a, b.until);
  }
  if (t1 - a > 0.8) free.push([a, t1]);
  let i = 0;
  const before = (t) => cuts.filter((c) => c.t < t - 1e-6).sort((p, q) => p.t - q.t).at(-1)?.shot ?? null;
  const pick = (t) => {
    const prev = before(t);
    let shot = next(i++, t);
    for (let k = 0; k < 4 && sameShot(shot, prev); k++) shot = next(i++, t);
    return shot;
  };
  for (const [f0, f1] of free) {
    let c = f0;
    cuts.push({ t: c, shot: pick(c) });
    while (f1 - c > TIMES.maxHold + 0.8) {
      const lim = Math.min(c + TIMES.maxHold, f1 - TIMES.minCut * 0.6);
      let x = starts.filter((s) => s >= c + TIMES.minCut && s <= lim).at(-1);
      x ??= words.filter((w) => w >= c + TIMES.minCut && w <= Math.min(lim, c + TIMES.maxHold - 0.4)).at(-1) ?? Math.min(lim, c + TIMES.maxHold - 0.6);
      cuts.push({ t: x, shot: pick(x) });
      c = x;
    }
  }
  cuts.sort((p, q) => p.t - q.t);
  // no shot twice in a row: a rotation cut next to a booked one of the same framing takes another
  for (let k = 1; k < cuts.length; k++) {
    if (!sameShot(cuts[k - 1].shot, cuts[k].shot)) continue;
    const j = !cuts[k].booked ? k : !cuts[k - 1].booked ? k - 1 : -1;
    if (j < 0) continue;
    for (let n = 0; n < 6; n++) {
      const shot = next(i++, cuts[j].t);
      if (!sameShot(shot, cuts[j - 1]?.shot) && !sameShot(shot, cuts[j + 1]?.shot)) {
        cuts[j].shot = shot;
        break;
      }
    }
  }
  for (const c of cuts) cam.cut(c.shot, c.t);
  return cuts;
}

// ---- the show

/**
 * startShow({ canvas, overlay }): show.html. ?program=<url> (default /program/program.json), the rest
 * as live.html (ui/live.js): ?replay=, ?voice=estimate, ?t=, ?from=, ?gfx=lite, ?check=1; and
 * ?segment=<id> (resume in that segment).
 */
export async function startShow({ canvas, overlay, live }) {
  const { createLiveStage, mountDebate, unlockSound, liveSource } = live;
  const q = new URLSearchParams(location.search);
  const warn = (m) => console.warn(`[show] ${m}`);
  const replayUrl = q.get("replay");
  const { stage, subs, caps, voice, show, virtual, estimate } = await createLiveStage({ canvas, overlay, q });
  await Promise.all(['500 40px "IBM Plex Mono"', '600 40px "IBM Plex Mono"', '650 50px "Inter"', '700 150px "Inter"'].map((f) => document.fonts.load(f)));
  const cam = stage.camera;

  const program = await loadProgram(q.get("program") || "/program/program.json");
  // the Stand videos: each one's length, and a check that it loads (else the minute falls back to the screenshots)
  await Promise.all(program.finalists.filter((f) => f.video).map(async (f) => {
    try {
      const d = await probeVideo(f.video);
      if (!(f.videoDurationS > 0)) f.videoDurationS = d;
    } catch (e) {
      warn(`video ${f.video}: ${e?.message ?? e}; the minute shows the screenshots`);
      f.video = null;
    }
  }));
  const silent = estimate;
  const lines = {
    intro: program.intro ? await prepareLine(program.intro, { silent, warn }) : null,
    outro: program.outro ? await prepareLine(program.outro, { silent, warn }) : null,
    minutes: new Map(),
    launch: await voice.prepare("host", LABELS.launchLine()),
  };
  for (const f of program.finalists) if (f.minute) lines.minutes.set(f.team, await prepareLine(f.minute, { silent, warn }));
  const images = new Map();
  await Promise.all(program.finalists.flatMap((f) => f.images).map(async (src) => {
    const img = new Image();
    img.src = src;
    try {
      await img.decode();
      images.set(src, img);
    } catch {
      warn(`image ${src} did not load`);
    }
  }));
  // live: the sound first (an operator's click when the browser holds it back), then the clock starts:
  // every line of the programme is scheduled on the audio clock from here
  if (!virtual && !estimate) await unlockSound(voice);
  const feed = createFeed(stage);
  const bug = createBug(overlay);
  const vt = createTV(stage, overlay, { virtual }); // stage-tv: the big screen
  const minuteShots = []; // stage-tv: { team, t, shot, move?, label? } of every minute shot as an edit (checks)
  const hashes = program.hashes ?? null;
  if (!hashes?.pipeline && !hashes?.materials) warn("program.json has no hashes: the check is not shown");

  // ---- where the page starts: a reload continues in its segment
  const ids = SEGMENT_IDS(program);
  const storeKey = `stage.program.${program.built_at ?? "?"}${replayUrl ? `|${replayUrl}` : ""}`;
  // operator-controls: a reload or a crash comes back where the show was, whatever ?segment= / ?from= the
  // URL still has; ?restart=1 starts over (ui/operator.js resumePlan)
  const resumed = virtual ? null : await resumePlan({ q, storeKey, replayUrl });
  const fromBeat = resumed?.segment ? null : cursorFromLocation();
  const storedAtLoad = virtual ? null : (() => {
    try {
      return localStorage.getItem(storeKey);
    } catch {
      return null;
    }
  })();
  let startId = "title";
  if (!virtual) {
    const asked = q.get("segment");
    startId = (ids.includes(resumed?.segment) && resumed.segment) || (ids.includes(asked) && asked) || (fromBeat !== null && "debate") || (ids.includes(storedAtLoad) && storedAtLoad) || "title";
  }
  const T0 = virtual ? 0 : now() + 0.6; // live: the start segment begins just after the page is up
  const plan0 = withHolds(planSegments(program, lines, { t0: 0 }), holdsOn({ q, virtual })); // operator-controls: the holds
  if (!plan0.some((s) => s.id === startId) && !["debate", "outro", "end"].includes(startId)) startId = "title"; // a segment this programme has not
  const startIdx = plan0.findIndex((s) => s.id === startId);
  const preDebate = startIdx >= 0; // title … launch
  const shift = preDebate ? T0 - plan0[startIdx].from : 0;
  const segs = withHolds(planSegments(program, lines, { t0: shift }), holdsOn({ q, virtual })); // operator-controls: the holds
  const scheduled = preDebate ? segs.slice(startIdx) : [];
  const marks = []; // { id, from }: when each segment began (the cursor, checks)
  const markAt = (id, t) => marks.push({ id, from: t });

  // ---- the room before the debate: the Judges at their consoles, the Host at its post
  const judgesAt = (t, facing) => {
    for (const id of JUDGE_IDS) {
      stage.robots[id].setState("waiting", t, facing ? { facing } : {});
      stage.desks[id].setPower(0.16, t);
    }
  };
  const lower = (id, t, dur) => caps.introduce(id, t, "lower", { dur });
  // walk-core: the director's own beats before the debate, when the Walk gives it the camera (ui/walk.js):
  // the check of the hashes and the run appearing on the wall. A PROPOSAL for the owner (trust first).
  const walkBeats = [];

  const SEG = {
    title(s) {
      judgesAt(s.from, null);
      feed.set(s.from, "plan");
      cam.cut(FRAMES.open, s.from);
      cam.move(FRAMES.wide, s.from + 1.5, 6.5);
      feed.set(s.from + 8.6, "title", (g) => drawTitle(g, program.finalists.length));
      cam.cut(FRAMES.wall, s.from + 9.6);
      cam.cut(FRAMES.two, s.from + 14.2);
    },
    intro(s) {
      judgesAt(s.from, null);
      feed.set(s.from, "title", (g) => drawTitle(g, program.finalists.length));
      const L = lines.intro, t0 = s.from + TIMES.introLead;
      show.host(L.text, L, { at: t0 });
      const sents = sentencesOf(L.text, L);
      const fixed = [{ t: t0 - 0.5, shot: FRAMES.host, until: t0 + 4.2 }];
      lower("host", t0 + 0.2, 3.6);
      // the Judges as the Host names them: each turns to the room on its name
      const named = new Set();
      const trucks = []; // [from, dur]: cam.move to rowR after the cuts are laid
      for (const sn of sents) {
        const hits = JUDGE_IDS.map((id) => ({ id, c: sn.text.indexOf(ROSTER[id].model) })).filter((h) => h.c >= 0)
          .map((h) => ({ ...h, t: t0 + wordAt(L, sn.from + h.c) })).sort((a, b) => a.t - b.t);
        if (!hits.length) continue;
        hits.forEach((h) => {
          named.add(h.id);
          stage.robots[h.id].setState("waiting", h.t - 0.9, { facing: "room" });
        });
        const quick = hits.length > 2 || hits.some((h, i) => i && h.t - hits[i - 1].t < 1.8);
        if (quick) {
          // the row from the left, then a slow truck to the right through the sentence; a tag over each
          // Judge as it is named, neighbours on the screen on alternate rows (JUDGE_IDS is left to right)
          const at = hits[0].t - 0.6, until = Math.max(t0 + sn.end + 0.4, at + TIMES.minCut);
          fixed.push({ t: at, shot: FRAMES.rowL, until });
          trucks.push([at + 0.5, until - at - 0.5]);
          hits.forEach((h) => caps.introduce(h.id, h.t - 0.2, "tag", { dur: Math.max(2.4, t0 + sn.end + 0.4 - h.t), row: JUDGE_IDS.indexOf(h.id) % 2 }));
        } else {
          hits.forEach((h, i) => {
            const until = i + 1 < hits.length ? hits[i + 1].t - 0.3 : Math.max(t0 + sn.end + 0.3, h.t + 2.4);
            fixed.push({ t: h.t - 0.3, shot: { kind: "medium", id: h.id, side: i % 2 ? -1 : 1 }, until });
            lower(h.id, h.t, until - h.t - 0.3);
          });
        }
      }
      // the hashes: at the first sentence with «хеш» (else 40 % into the line)
      const cue = sents.find((sn) => /хеш/i.test(sn.text));
      if (hashes?.pipeline || hashes?.materials) {
        const h0 = t0 + (cue ? cue.t : 0.4 * L.durationS);
        const mat = sents.find((sn) => sn.t > (cue?.t ?? 0) + 2 && /хеш/i.test(sn.text) && /материал/i.test(sn.text));
        const m0 = Math.max(h0 + HASH.rowGap, mat ? t0 + mat.t : -Infinity);
        const rows = [hashes.pipeline ? h0 : null, hashes.materials ? (hashes.pipeline ? m0 : h0) : null];
        const steps = new Set([h0]);
        const st = (t) => rows.map((r0) => (r0 === null ? 0 : t < r0 + HASH.computed ? 0 : t < r0 + HASH.verdict - 4 * HASH.lineStep ? 1 : t < r0 + HASH.verdict ? 1 + Math.min(4, Math.floor((t - (r0 + HASH.verdict - 4 * HASH.lineStep)) / HASH.lineStep) + 1) : 6));
        for (const r0 of rows) if (r0 !== null) {
          steps.add(r0 + HASH.computed);
          for (let k = 0; k < 4; k++) steps.add(r0 + HASH.verdict - (4 - k) * HASH.lineStep);
          steps.add(r0 + HASH.verdict);
        }
        for (const t of [...steps].sort((a, b) => a - b)) {
          const sv = st(t + 1e-6);
          feed.set(t, `hash:${sv.join(":")}`, (g) => drawHashes(g, hashes, sv));
        }
        // the wall, the first comparison up to its verdict, the Host with the wall while the second
        // row waits for its sentence, the second comparison, the wall with both verdicts
        const both = rows[0] !== null && rows[1] !== null;
        const lastRow = Math.max(...rows.filter((r) => r !== null));
        const back = lastRow + HASH.verdict + 2.4;
        fixed.push({ t: h0 - 0.4, shot: FRAMES.wall, until: h0 + HASH.insertAt });
        const firstEnd = both ? Math.min(h0 + HASH.verdict + 2.2, rows[1] - 0.2) : back;
        fixed.push({ t: h0 + HASH.insertAt, shot: FRAMES.compare, until: firstEnd });
        if (both) {
          if (rows[1] - 0.2 - firstEnd > 2.5) fixed.push({ t: firstEnd, shot: FRAMES.two, until: rows[1] - 0.2 });
          fixed.push({ t: Math.max(firstEnd, rows[1] - 0.2), shot: FRAMES.compare2, until: back });
        }
        fixed.push({ t: back, shot: FRAMES.wall, until: back + 3.2 });
        stage.robots.host.beat("gesture", h0 - 0.2);
        markAt("intro:hashes", h0);
        // walk-core: the wall's two comparisons are the director's (the Host-with-the-wall between them is not)
        if (both) walkBeats.push({ from: h0 - 0.4, to: firstEnd, tag: "hashes" }, { from: Math.max(firstEnd, rows[1] - 0.2), to: back + 3.2, tag: "hashes" });
        else walkBeats.push({ from: h0 - 0.4, to: back + 3.2, tag: "hashes" });
      }
      const rot = [FRAMES.two, FRAMES.wide, FRAMES.host, FRAMES.board, FRAMES.two, FRAMES.host];
      cutLine(cam, { t0: t0 - 0.5, t1: s.to, starts: sents.map((sn) => t0 + sn.t), words: L.words.map((w) => t0 + w.start_s), fixed, next: (i) => rot[i % rot.length] });
      for (const [from, dur] of trucks) cam.move(FRAMES.rowR, from, dur);
      // every Judge faces the room for the Finalists' minutes; the ones not named turn as the line ends
      for (const id of JUDGE_IDS) if (!named.has(id)) stage.robots[id].setState("waiting", s.to - 1.6, { facing: "room" });
    },
    finalist(s) {
      const f = s.finalist, L = lines.minutes.get(f.team);
      judgesAt(s.from, "room");
      const imgs = f.images.map((src) => images.get(src)).filter(Boolean);
      // stage-tv: the screenshots on the big screen (on air: no Stand videos since 2026-10-28 evening; a
      // `video` still plays, dormant), the caption one small line top right; with neither, the
      // Finalist's name on the wall and the room's old rotation
      const video = !!f.video && f.videoDurationS > 0, named = !video && !imgs.length;
      feed.set(s.from, `finalist:${f.team}:${named ? "name" : "tv"}`, (g) => drawFinalist(g, f, { name: named, plan: camsOn ? null : feed.planImage }), { route: !camsOn });
      bug.show(s.from + 0.4, s.to - 0.2, `«${f.name}»`, `${LABELS.rank(f.rank)} ${LABELS.rankOf()}`, program.label ?? "", "cd-minute", { line: CAPTION_W });
      const t0 = s.from + TIMES.minuteLead;
      if (L) show.host(L.text, L, { at: t0 });
      const sents = L ? sentencesOf(L.text, L) : [];
      if (!named) {
        // a hold after the minute keeps the screen's last frame (the operator's → ends it)
        const until = s.hold ? s.hold.to : s.to - 0.2;
        const starts = sents.map((sn) => t0 + sn.t);
        let zero = t0, changes = [];
        if (video) {
          const start = t0 - leadOf(f);
          vt.video(start - TIMES.videoFade, until, start, f.videoDurationS, f.video);
          zero = start; // the beats' zero: the video's first frame
        } else changes = vt.stills(s.from + 0.6, until, imgs, s.to - 0.2, starts);
        // the screenshots: the screen moves in or out as each one cross-fades to the next (on a sentence)
        const plan = planMinute({ from: s.from, to: s.to, zero, beats: f.beats, starts, changes, minCut: TIMES.minCut });
        for (const p of plan) {
          if (p.move) cam.move(MINUTE_SHOTS[p.shot], p.t, p.move);
          else cam.cut(MINUTE_SHOTS[p.shot], p.t);
          minuteShots.push({ team: f.team, rank: f.rank, ...p });
        }
        return;
      }
      const fixed = [{ t: s.from, shot: FRAMES.wall, until: s.from + 4.6 }];
      if (!L) return void cam.cut(FRAMES.wall, s.from);
      // a sentence about the Stand goes to the name on the wall
      for (const sn of sents) if (/скриншот|стенд/i.test(sn.text) && t0 + sn.t > s.from + 6) {
        const at = t0 + sn.t - 0.2;
        fixed.push({ t: at, shot: FRAMES.visual, until: Math.min(at + 5.2, t0 + sn.end + 0.5) });
      }
      // the rotation: the Host and the wall, one Judge listening (a different one every minute), and
      // the name when no sentence called for it
      const j = JUDGE_IDS[(program.finalists.length - f.rank) % JUDGE_IDS.length];
      const cued = fixed.some((b) => b.shot === FRAMES.visual);
      const rot = [FRAMES.two, FRAMES.host, ...(cued ? [] : [FRAMES.visual]), { kind: "medium", id: j, side: f.rank % 2 ? 1 : -1 }, FRAMES.board, FRAMES.host, FRAMES.two, FRAMES.wide];
      cutLine(cam, { t0: s.from, t1: s.to, starts: sents.map((sn) => t0 + sn.t), words: L.words.map((w) => t0 + w.start_s), fixed, next: (i) => rot[i % rot.length] });
    },
    launch(s) {
      judgesAt(s.from, "room");
      feed.set(s.from, "launch:wait:1", (g) => drawLaunch(g, program, { cursor: true }));
      cam.cut(FRAMES.wall, s.from);
      show.host(lines.launch.text, lines.launch, { at: s.from + TIMES.launchLead });
      cam.cut(FRAMES.two, s.from + 3.8);
    },
  };

  for (const s of scheduled) {
    markAt(s.id, s.from);
    SEG[s.kind](s);
  }
  if (virtual) holdCuts({ scheduled, cam, frames: FRAMES }); // ?hold=1 under ?t= (live: createOperator)
  const launch = segs.find((s) => s.id === "launch");

  // the waiting terminal's cursor blinks (1 Hz) and the camera keeps moving until the run appears
  // the waiting room: the row trucked slowly from the left to the right, the terminal, the board, the
  // Host with the wall; every shot holds 7.5 s ({ move }: cut to the first frame, then the slow move)
  const WAIT_SHOTS = [{ shot: FRAMES.rowL, move: FRAMES.rowR }, { shot: FRAMES.wall }, { shot: FRAMES.board }, { shot: FRAMES.two }];
  let waitNext = launch.from + 9, waitI = 0, blinkNext = launch.from + 0.5;
  function holdWaiting(until) {
    while (blinkNext < until) {
      const on = Math.round((blinkNext - launch.from) * 2) % 2 === 0;
      feed.set(blinkNext, `launch:wait:${on ? 1 : 0}`, (g) => drawLaunch(g, program, { cursor: on }));
      blinkNext += 0.5;
    }
    while (waitNext < until) {
      const w = WAIT_SHOTS[waitI++ % WAIT_SHOTS.length];
      cam.cut(w.shot, waitNext);
      if (w.move) cam.move(w.move, waitNext + 0.4, 7.0);
      waitNext += 7.5;
    }
  }
  /** The run appeared at A: the wall shows it; the debate takes the camera at D. */
  function appeared(A, state, { hold = TIMES.startHoldS, resume = false } = {}) {
    if (resume) return (feed.set(A, "plan"), A + hold); // a reload mid-debate: straight back to the room
    holdWaiting(A);
    feed.set(A, "launch:started", (g) => drawLaunch(g, program, { state }));
    cam.cut(FRAMES.wall, A);
    markAt("launch:started", A);
    const D = A + hold;
    walkBeats.push({ from: A, to: D, tag: "launch" }); // walk-core
    feed.set(D, "plan");
    return D;
  }

  let debate = null, D = null, duration = null, outroEnd = null;
  const shifted = (src, d) => ({
    read: (t) => src.read(t - d).map((it) => ({ ...it, t: it.t + d })),
    runKey: () => src.runKey?.(),
    clockOf: (iso) => src.clockOf(iso) + d,
    stateAt: (t) => src.stateAt(t - d),
    get endT() { return src.endT + d; },
    get synthetic() { return src.synthetic; },
  });
  function outro(t) {
    if (!lines.outro) return t;
    markAt("outro", t);
    show.host(lines.outro.text, lines.outro, { at: t + TIMES.outroLead });
    return t + TIMES.outroLead + lines.outro.durationS + TIMES.outroTail;
  }

  if (virtual) {
    // the whole broadcast before the first frame
    if (replayUrl) {
      const rec = await ReplaySource.fromUrl(replayUrl);
      D = appeared(launch.appearAt, rec.stateAt(0) ?? rec.records.find((r) => r.state)?.state ?? null); // the run's first state
      for (let t = 0; t < D; t = Math.round((t + 0.1) * 1000) / 1000) show.flush(t);
      markAt("debate", D);
      debate = await mountDebate({ stage, caps, show, voice, source: shifted(rec, D), virtual, replayUrl, from: fromBeat, startAt: D, warn });
      const { finalEnd, t } = await debate.runVirtual();
      outroEnd = outro((finalEnd ?? t) + 0.5);
      markAt("end", outroEnd);
      duration = Math.ceil(outroEnd + TIMES.endS);
      show.flush(duration + 1);
      debate.planner.commit(duration + 1);
    } else {
      // no recording: the page holds on the waiting terminal
      holdWaiting(launch.from + 60);
      for (let t = 0; t < launch.from + 60; t = Math.round((t + 0.1) * 1000) / 1000) show.flush(t);
      duration = Math.ceil(launch.from + 60);
    }
  }

  // ---- live: the engine's run, the debate, the outro
  let phase = preDebate ? "program" : "await"; // program → await (the launch) → debate → outro → end
  let polling = false, nextPoll = 0;
  const setCursor = (id) => {
    if (virtual) return;
    try {
      localStorage.setItem(storeKey, id);
    } catch {}
  };
  async function pollRun() {
    if (replayUrl) {
      // operator-controls: a recording whose first state comes a moment after 0 (the real ones: t 0.007) starts too
      const rec = await ReplaySource.fromUrl(replayUrl);
      return rec.stateAt(0) ?? rec.records.find((r) => r.state)?.state ?? null;
    }
    try {
      const r = await fetch("/run/state.json", { cache: "no-store" });
      if (!r.ok) return null;
      const s = await r.json();
      return s && s.started_at ? s : null;
    } catch {
      return null;
    }
  }
  async function enterDebate(A, state, hold) {
    D = appeared(A, state, { hold, resume: !preDebate });
    phase = "debate";
    const source = replayUrl ? shifted(await ReplaySource.fromUrl(replayUrl), D) : liveSource(warn);
    debate = await mountDebate({ stage, caps, show, voice, source, virtual: false, replayUrl, from: fromBeat, store: localStorageStore(), startAt: D, warn });
    const wait = () => (now() >= D ? (markAt("debate", D), setCursor("debate"), debate.start()) : setTimeout(wait, 50));
    wait();
    window.__live = debate;
  }
  let lastMark = null;
  function tickLive(t) {
    // the segment cursor: the latest segment begun
    const cur = marks.filter((m) => m.from <= t && !m.id.includes(":")).sort((a, b) => a.from - b.from).at(-1)?.id ?? startId;
    if (cur !== lastMark) (lastMark = cur), setCursor(cur);
    if (phase === "program" && t >= launch.from) phase = "await";
    if (phase === "await" && preDebate && t < launch.from) phase = "program"; // operator-controls: a jump back from the launch
    if (phase === "await") {
      holdWaiting(t + 0.02);
      const ready = !preDebate || t >= (replayUrl ? launch.appearAt : launch.lineEnd + 1.2);
      if (ready && !polling && t >= nextPoll) {
        polling = true;
        nextPoll = t + 1;
        pollRun().then((state) => {
          polling = false;
          if (state && phase === "await") {
            phase = "entering";
            enterDebate(now(), state, preDebate ? TIMES.startHoldS : 0.3);
          }
        });
      }
    }
    if (phase === "debate" && debate?.director.finished && debate.played.finalEnd != null) {
      phase = "outro";
      const resumeEnd = storedAtLoad === "end";
      outroEnd = resumeEnd ? now() : outro(Math.max(now(), debate.played.finalEnd + 0.5));
      marks.push({ id: "end", from: outroEnd });
    }
  }
  if (!virtual && !preDebate) feed.set(T0 - 1, "plan");

  await stage.ready();
  const segmentAt = (t) => [...marks].sort((a, b) => a.from - b.from).filter((m) => m.from <= t).at(-1)?.id ?? null;
  window.__program = { program, voice, vt, minuteShots, frames: FRAMES, subs, segments: segs.map(({ finalist, ...s }) => ({ ...s, team: finalist?.team })), marks, segmentAt, feedAt: (t) => feed.keyAt(t), startId, get phase() { return phase; }, get debateAt() { return D; } };
  window.__frame = { duration, stage, get report() { return debate?.planner.report(duration ?? now()); } };
  if (virtual && debate) window.__live = debate;
  window.__program.wallText = () => feed.textBoxes();
  // walk-core: the Walk (GLOSSARY «Прогулка», spec §7.7): P or ?walk=1; never switched on, the page is as
  // before. Where the show is, for ui/walk-interact.js: { phase: "intro" | "preshow" | "hold" | "launch" |
  // "debate" | "envelopes" | "end", team: the Finalist of the minute or hold, else null }
  const walkCurrent = () => {
    const t = now(), id = segmentAt(t) ?? startId;
    const seg = segs.find((s) => s.id === id.split(":")[0]);
    const held = !!(seg?.hold && t >= seg.hold.from && t < seg.hold.to);
    if (id === "title") return { phase: "preshow", team: null };
    if (id.startsWith("intro")) return { phase: held ? "hold" : "intro", team: null };
    if (id.startsWith("finalist-")) return { phase: held ? "hold" : "preshow", team: seg?.finalist?.team ?? null };
    if (id.startsWith("launch")) return { phase: "launch", team: null };
    if (id === "debate") return { phase: debate?.played.envelopes.some((e) => e.stage === "open" && e.at <= t) ? "envelopes" : "debate", team: null };
    return { phase: "end", team: null };
  };
  let walk = null;
  if (!virtual || q.get("walk") === "1") {
    try {
      walk = createWalk({
        scene: stage.scene, camera: stage.camera, lens: stage.lens, renderer: stage.renderer, robots: stage.robots, world: stage,
        planner: () => debate?.planner ?? null, queue: () => debate?.director?.queue ?? null, beats: () => walkBeats,
        clock: { now }, voice, canvas, virtual, q,
        attachInteract: (w) => import("./walk-interact.js").then((m) => m.attach(w, { voice, subtitles: subs, programData: program, pubBase: "/pub/", current: walkCurrent }), () => {}),
      });
      window.__walk = walk;
      window.__program.walkCurrent = walkCurrent;
    } catch (e) {
      warn(`the Walk is off: ${e?.message ?? e}`);
      walk = null;
    }
  }
  const renderAt = (t) => {
    if (!virtual) {
      tickLive(t);
      if (debate && phase !== "entering") debate.frame(t);
      else show.flush(t);
    }
    feed.update(t);
    vt.update(t); // stage-tv: the big screen's picture before the frame is drawn
    walk?.frame(t); // walk-core
    stage.renderAt(t);
    subs.update(t);
    caps.update(t);
    bug.update(t);
  };
  const hook = runLoop({
    renderer: stage.renderer,
    renderAt,
    // stage-tv: a video seeked to its frame (?t=) is drawn again once the frame is there
    settle: async () => {
      if (await vt.settle()) renderAt(vt.lastT);
    },
  });
  if (q.has("check") && debate) Object.defineProperty(hook, "check", { get: () => debate.check(), enumerable: true });
  // operator-controls: Space / ← / →, the holds' camera, the indicator (ui/operator.js)
  if (!virtual) createOperator({ q, storeKey, segs, scheduled, startId, T0, cam, frames: FRAMES, voice, resumed, show: { get phase() { return phase; }, get debate() { return debate; }, get debateAt() { return D; } } });
  return window.__program;
}
