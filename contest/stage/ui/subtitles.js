// The Stage's only 2D layer (spec §7.7): broadcast subtitles under the voice and who-is-who captions.
// Both are pure functions of the show clock, like the 3D scene: every call is a timed event and
// update(t) sets the DOM for t (no CSS animation), so stills, the live page and the clip agree.
//
// Subtitles: broadcast pop-on, verbatim (never cut or paraphrased, only chunked). The spoken line is
// cut into short blocks of at most two lines; a block appears whole when its first word is spoken
// (voice.words) and is replaced when the next block's first word starts, so the text never reflows or
// crawls. Inside a block the line breaks at a phrase boundary, the word being spoken is marked and
// the words still to come are dimmer, in time with the voice. Two looks (owner 2026-10-28):
//   speech line  the camera is on the speaking Judge (its medium, close or over-the-shoulder shot,
//                ui/planner.js): the block stands beside the robot's head, on the side of the frame
//                with room, in its vendor's look (Anthropic: cream ceramic and terracotta; OpenAI:
//                black glass and white light)
//   bottom bar   every other shot, and the Host always (the narrator): the speaker's name over the
//                line, an accent in the speaker's colour
// The speech line keeps clear of the corner header, of a lower-third caption on screen and, with
// ?cams=1 (ui/safe.js), of the webcam circles.
import { Track, clamp01 } from "/world/timeline.js";
import { ROSTER, caption } from "/robots/roster.js";
import { FRAME, SAFE, camsOn } from "/ui/safe.js";

const SUB_FONT = '500 40px "Inter"', SUB_MAX_W = 680, SUB_LINES = 2; // a block: two speech-line lines at most
const BAR_FONT = '500 44px "Inter"', BAR_MAX_W = 1480;
const HOLD = 1.2; // s a finished line stays up
const FADE = 0.18;
const SPEECH_SHOTS = new Set(["medium", "close", "ots"]); // the camera on the speaker itself
const EDGE = 56; // px a speech line keeps from the frame's edges

let measureCtx = null;
const measure = (text, font) => {
  measureCtx ??= document.createElement("canvas").getContext("2d");
  measureCtx.font = font;
  return measureCtx.measureText(text).width;
};
const widthOf = (ws, font) => measure(ws.map((x) => x.text).join(" "), font);

/** Greedy wrap of words into lines of at most maxW px. */
function wrap(words, font, maxW) {
  const lines = [];
  let cur = [];
  for (const w of words) {
    const next = [...cur, w];
    if (cur.length && measure(next.map((x) => x.text).join(" "), font) > maxW) {
      // never break inside a «quoted name»: its opening word moves down with the rest
      const open = cur.length > 1 && /«[^»]*$/.test(cur.at(-1).text) ? [cur.pop()] : [];
      lines.push(cur);
      cur = [...open, w];
    } else cur = next;
  }
  if (cur.length) lines.push(cur);
  return lines;
}

// Russian words a line should not end on (prepositions, conjunctions, particles), and words that open
// a phrase (a line may start with them)
const WEAK = new Set("и а но или да в во на с со к ко по о об обо у из от до за при для без под над про через между перед что чтобы как не ни же ли бы если когда где это эти этот эта то та тот".split(" "));
const OPENS = new Set("и а но или что чтобы как который которая которое которые где когда если потому поэтому хотя зато".split(" "));
const bare = (w) => w.text.toLowerCase().replace(/^[«"(„]+|[»"),.!?…:;]+$/g, "");

/**
 * A block as one or two lines of at most maxW px, the break at a phrase boundary: after a punctuation
 * mark, before a conjunction, never after a preposition or inside a «quoted name»; then balanced.
 */
export function lines2(words, font, maxW) {
  if (words.length < 2 || widthOf(words, font) <= maxW) return [words];
  let best = null;
  for (let k = 1; k < words.length; k++) {
    const a = words.slice(0, k), b = words.slice(k);
    const wa = widthOf(a, font), wb = widthOf(b, font);
    if (wa > maxW || wb > maxW) continue;
    const prev = words[k - 1], next = words[k];
    let score = Math.abs(wa - wb) / 24;
    if (/[,;:.!?…]$/.test(prev.text) || /^[—–]$/.test(next.text)) score -= 30;
    else if (/^[—–]$/.test(prev.text)) score -= 20;
    if (WEAK.has(bare(prev))) score += 40;
    if (OPENS.has(bare(next))) score -= 12;
    if (/«[^»]*$/.test(a.map((x) => x.text).join(" "))) score += 80;
    if (a.length === 1 || b.length === 1) score += 25; // no lone word on a line
    if (!best || score < best.score) best = { score, k };
  }
  return best ? [words.slice(0, best.k), words.slice(best.k)] : wrap(words, font, maxW);
}

/** Cut a line into blocks of ≤ 2 lines; prefer to end a block at a sentence end once it is half full. */
export function blocks(text, timing, { font = SUB_FONT, maxW = SUB_MAX_W, lines = SUB_LINES } = {}) {
  const words = timing.words.map((w) => ({ text: text.slice(w.start_char, w.end_char), start: w.start_s, end: w.end_s }));
  const out = [];
  let i = 0;
  while (i < words.length) {
    let j = i + 1, best = i + 1;
    while (j <= words.length && wrap(words.slice(i, j), font, maxW).length <= lines) {
      best = j;
      // a sentence ends a block once the block holds three words: a cut at a sentence then shows
      // only that sentence's words (the shot planner cuts lines at their sentences, ui/shots.js)
      if (j - i >= 3 && j < words.length && /[.!?…]$/.test(words[j - 1].text)) break;
      j++;
    }
    // a sentence end inside the block's second half is a better cut than a full block; a block that
    // would end inside a sentence ends at a clause (a comma, a semicolon, a dash) in its second half,
    // so a sentence too long for one block splits where it pauses, never mid-phrase (red team 2:42:
    // «…и баллы Отборочного» / «этапа это показывают.»)
    const half = i + Math.floor((best - i) / 2);
    let cut = null;
    for (let k = best - 1; k > half && cut === null; k--) if (best < words.length && /[.!?…:]$/.test(words[k - 1].text)) cut = k;
    if (cut === null && best < words.length && !/[.!?…:,;—–]$/.test(words[best - 1].text) && !/^[—–]$/.test(words[best]?.text ?? "")) {
      for (let k = best - 1; k > half && cut === null; k--) if (/[,;—–]$/.test(words[k - 1].text)) cut = k;
    }
    if (cut !== null) best = cut;
    // a block does not end on a preposition, a conjunction or a number («7,81» / «балла из 100»)
    if (best < words.length && best - i > 3 && (WEAK.has(bare(words[best - 1])) || /^\d+([,.]\d+)*$/.test(words[best - 1].text))) best--; // «3.» ends a sentence: a cut
    // never end a block inside a «quoted name»: the name opens the next block
    if (best < words.length && /«[^»]*$/.test(words.slice(i, best).map((w) => w.text).join(" "))) {
      for (let k = best - 1; k > i; k--) if (words[k].text.includes("«")) {
        if (k - i >= 2) best = k;
        break;
      }
    }
    out.push(words.slice(i, best));
    i = best;
  }
  // no orphan: a last block of three words or fewer takes the previous block's tail, from a pause if any
  const n = out.length;
  if (n > 1 && out[n - 1].length < 4 && !/[.!?…]$/.test(out[n - 2].at(-1).text)) {
    const prev = out[n - 2];
    let cut = prev.length - (4 - out[n - 1].length);
    for (let j = prev.length - 1; j >= Math.max(1, prev.length - 6); j--) if (/[,.!?…:;—]$/.test(prev[j - 1].text)) { cut = j; break; }
    out[n - 1] = [...prev.slice(cut), ...out[n - 1]];
    out[n - 2] = prev.slice(0, cut);
  }
  return out;
}

const vendorOf = (id) => ROSTER[id]?.vendor ?? "house";
const idOf = (who) => (ROSTER[who] ? who : Object.keys(ROSTER).find((k) => ROSTER[k].model === who) ?? "host");
const overlaps = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

/** createSubtitles(root, { stage }): without a stage (a page with no camera) only the bottom bar. */
export function createSubtitles(root, { stage = null } = {}) {
  const bar = document.createElement("div");
  bar.className = "subs";
  const line = document.createElement("div");
  line.className = "say";
  root.append(bar, line);
  const track = new Track(); // { blocks, t0, end, id } | { stop: true }
  let shown = null; // { block, mode, el, words: [span], cur }
  let pos = null; // the speech line's placement key, to skip unchanged writes

  // the speech line's anchor: over the robot's root at about its head's height (steady: no bone sway);
  // half = the head's half width on screen, so the gap scales with the shot
  function anchor(id) {
    const r = stage.robots[id], base = r.anchors?.base ?? r.object3d;
    const p = base.getWorldPosition(base.position.clone());
    p.y = r.object3d.position.y + (r.info?.height ?? 1.8) * 0.86;
    const right = p.clone().setFromMatrixColumn(stage.three.matrixWorld, 0);
    const a = stage.project(p), b = stage.project(p.clone().addScaledVector(right, 0.3));
    return { x: a.x, y: a.y, half: Math.abs(b.x - a.x) };
  }
  const boxOf = (el) => (el.style.display !== "none" && Number(el.style.opacity || 1) > 0.05 && el.offsetWidth
    ? { left: el.offsetLeft, top: el.offsetTop, right: el.offsetLeft + el.offsetWidth, bottom: el.offsetTop + el.offsetHeight } : null);
  // what the speech line keeps clear of: the cams' corners, the corner header, a lower third on screen
  function avoid() {
    const out = [];
    if (camsOn) out.push({ left: 0, top: 0, right: SAFE.x, bottom: SAFE.y }, { left: FRAME.W - SAFE.x, top: 0, right: FRAME.W, bottom: SAFE.y });
    for (const el of root.querySelectorAll(".cd-bug, .cap-lower")) {
      const b = boxOf(el);
      if (b) out.push({ left: b.left - 16, top: b.top - 16, right: b.right + 16, bottom: b.bottom + 16 });
    }
    return out;
  }
  function place(id) {
    const a = anchor(id);
    const bw = line.offsetWidth, bh = line.offsetHeight;
    const gap = Math.min(260, Math.max(40, a.half * 1.15));
    const right = a.x < FRAME.W / 2; // the robot's open side: the frame has room there
    let left = right ? a.x + gap : a.x - gap - bw;
    let top = a.y - bh * 0.35;
    left = Math.min(Math.max(left, EDGE), FRAME.W - EDGE - bw);
    top = Math.min(Math.max(top, EDGE), FRAME.H - EDGE - bh);
    for (const r of avoid()) {
      if (!overlaps({ left, top, right: left + bw, bottom: top + bh }, r)) continue;
      top = r.bottom + 8 + bh <= FRAME.H - EDGE ? r.bottom + 8 : Math.max(EDGE, r.top - 8 - bh);
    }
    const notch = Math.min(Math.max(a.y - top, 30), bh - 30);
    const key = `${right}|${left.toFixed(0)}|${top.toFixed(0)}|${notch.toFixed(0)}`;
    if (key === pos) return;
    pos = key;
    line.classList.toggle("say-r", right);
    line.classList.toggle("say-l", !right);
    line.style.transform = `translate(${left.toFixed(0)}px, ${top.toFixed(0)}px)`;
    line.style.setProperty("--notch", `${notch.toFixed(0)}px`);
  }

  function build(el, e, block, mode) {
    const words = [];
    const say = mode === "say";
    const name = document.createElement("div");
    name.className = say ? "say-who" : "subs-who";
    name.textContent = ROSTER[e.id]?.model ?? "";
    const rows = lines2(block, say ? SUB_FONT : BAR_FONT, say ? SUB_MAX_W : BAR_MAX_W).map((ws) => {
      const row = document.createElement("div");
      row.className = "subs-line";
      ws.forEach((w, i) => {
        const span = document.createElement("span");
        span.className = "w";
        span.textContent = w.text;
        words.push(span);
        if (i) row.append(" ");
        row.append(span);
      });
      return row;
    });
    el.className = say ? `say say-${vendorOf(e.id)}` : `subs subs-${vendorOf(e.id)}`;
    el.replaceChildren(...(name.textContent ? [name] : []), ...rows);
    pos = null;
    return words;
  }

  return {
    /**
     * A spoken line from t0: text verbatim, timing = voice ({durationS, words}), speaker = a robot id
     * ("host", "opus-5.5", …) or a Judge's model name.
     */
    say(text, timing, t0, speaker = "host") {
      track.add(t0, { blocks: blocks(text, timing), t0, end: t0 + timing.durationS + HOLD, id: idOf(speaker ?? "host") });
    },
    stop(t) {
      track.add(t, { stop: true });
    },
    /** The look of t ("say" | "bar" | null) and the block's text, for checks. */
    get shown() {
      return shown ? { mode: shown.mode, id: shown.id, text: shown.block.map((w) => w.text).join(" ") } : null;
    },
    update(t) {
      const e = track.current(t);
      let block = null, alpha = 0;
      const rel = e ? t - e.t0 : 0;
      if (e && !e.stop && t < e.end) {
        for (const b of e.blocks) if (b[0].start <= rel + 1e-6) block = b;
        if (block) alpha = Math.min(clamp01((t - e.t0) / FADE), clamp01((e.end - t) / FADE));
      }
      let mode = "bar";
      if (block && stage && e.id !== "host" && stage.robots[e.id]) {
        const shot = stage.camera.shotAt(t);
        if (SPEECH_SHOTS.has(shot.kind) && shot.id === e.id) mode = "say";
      }
      if (block !== shown?.block || mode !== shown?.mode) {
        for (const el of [bar, line]) (el.replaceChildren(), (el.style.opacity = "0"));
        shown = block ? { block, mode, id: e.id, el: mode === "say" ? line : bar, cur: -2 } : null;
        if (shown) shown.words = build(shown.el, e, block, mode);
      }
      if (!shown) return;
      // the word being spoken; the words still to come
      let cur = -1;
      block.forEach((w, i) => (w.start <= rel + 1e-6 ? (cur = i) : null));
      if (cur !== shown.cur) {
        shown.words.forEach((s, i) => (s.className = i === cur ? "w now" : i > cur ? "w next" : "w"));
        shown.cur = cur;
      }
      if (mode === "say") place(e.id);
      shown.el.style.opacity = alpha.toFixed(3);
    },
  };
}

// ---- who is who ---------------------------------------------------------------------------------
// introduce(id, t, "tag"): a small name over the robot's head that follows it (the wide shot);
// introduce(id, t, "lower"): a lower-third name (a close shot). Model in Latin, then CLI and version.
// Each robot is introduced once per mode; the director's setup() roster fills the versions.

const TAG_S = 5.5, LOWER_S = 4.5;

export function createCaptions(root, stage) {
  const layer = document.createElement("div");
  layer.className = "caps";
  root.appendChild(layer);
  const items = []; // { id, mode, t0, dur, el }
  const lowerTrack = new Track();
  const el = (cls, children) => {
    const d = document.createElement("div");
    d.className = cls;
    d.append(...children);
    return d;
  };
  const line = (cls, text) => {
    const d = document.createElement("div");
    d.className = cls;
    d.textContent = text;
    return d;
  };
  function build(id, mode) {
    const r = ROSTER[id], sub = caption(id);
    const kids = [line("cap-name", r.model)];
    if (mode === "lower") kids.push(line("cap-sub", r.role === "judge" ? `Судья · ${sub}` : sub || ""));
    else if (sub) kids.push(line("cap-sub", sub));
    const d = el(`cap cap-${mode}`, kids.filter((k) => k.textContent));
    d.style.opacity = "0";
    layer.appendChild(d);
    return d;
  }
  const head = (id) => {
    const a = stage.robots[id].anchors.head;
    const p = a.getWorldPosition(a.position.clone());
    p.y += id === "host" ? 0.42 : 0.5;
    return p;
  };
  return {
    /** row: tags of neighbours sit on alternate rows (0, 1) so they never overlap. */
    introduce(id, t, mode = "tag", { dur = mode === "tag" ? TAG_S : LOWER_S, row = 0 } = {}) {
      const it = { id, mode, t0: t, dur, row, el: build(id, mode) };
      items.push(it);
      if (mode === "lower") lowerTrack.add(t, { it }); // Track copies the value: keep a reference
    },
    /** After stage.renderAt(t): the camera of t is in place. */
    update(t) {
      const lower = lowerTrack.current(t)?.it;
      for (const it of items) {
        const u = t - it.t0;
        let a = u < 0 || u > it.dur ? 0 : Math.min(clamp01(u / 0.3), clamp01((it.dur - u) / 0.4));
        if (it.mode === "lower" && lower !== it) a = 0; // a newer lower third replaces it
        if (a > 0 && it.mode === "tag") {
          const p = stage.project(head(it.id));
          if (!p.visible) a = 0;
          else it.el.style.transform = `translate(${p.x.toFixed(1)}px, ${(p.y - it.row * 84).toFixed(1)}px) translate(-50%, -100%)`;
        }
        it.el.style.opacity = a.toFixed(3);
      }
    },
  };
}
