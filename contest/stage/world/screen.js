// What a console's monitors show: the real thing the Judge reads. The main monitor is a plain file
// viewer (the tool's own name and the path in a header bar, line numbers, the file's text verbatim,
// lines outside the range the tool returned dimmed) or the image it views; on a vote turn the
// ballot sheet of the round. The side monitor is the turn's tool log and its timer.
// Text is drawn once into a tall texture and scrolled by UV offset, so a scrolling screen costs no
// redraw per frame. Everything is a function of the show clock.
// Until the first envelope opens the monitors are veiled (ui/veil.js, ADR-0010): paths and labels by
// the Finalists' codes, a picture and a file's text blurred (the reading and its scroll stay visible).
import * as THREE from "three";
import { Track, clamp01, smooth } from "./timeline.js";

const MONO = '"IBM Plex Mono", ui-monospace, monospace';
const SANS = '"Inter", system-ui, sans-serif';
const C = { bg: "#0d0f12", head: "#171a1f", text: "#ded9d0", dim: "#5d636c", num: "#4d535b", path: "#efeae2", label: "#8c939c", rule: "#262a30" };
export const MAIN_PX = [1600, 900], SIDE_PX = [800, 480];
const HEAD_H = 92, LINE_H = 58, FONT = 44, GUTTER = 128, PAD = 34;

const canvas = (w, h) => {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
};
const tex = (c) => {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  return t;
};

// ---- monitor-codes: the veiled drawing (ui/veil.js)
// A picture under the veil is drawn only into a canvas SOFT_W px wide (no text, no detail survives),
// greyed and flattened there, then brought up in two smooth steps with a blur between them; a file's
// text is drawn at 1/TEXT_K of its size, then brought up the same way: rows of soft bands that scroll
// as the file does. (A browser without canvas filters keeps the two smooth steps.)
export const SOFT_W = 48, TEXT_K = 16;
function upscale(g, src, x, y, w, h, blur = 2) {
  const mid = canvas(Math.max(1, Math.min(Math.round(w), src.width * 4)), Math.max(1, Math.min(Math.round(h), src.height * 4)));
  const mg = mid.getContext("2d");
  mg.imageSmoothingEnabled = true;
  mg.imageSmoothingQuality = "high";
  mg.filter = `blur(${blur}px)`;
  mg.drawImage(src, 0, 0, mid.width, mid.height);
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = "high";
  g.drawImage(mid, x, y, w, h);
}
function softImage(g, img, x, y, w, h) {
  const tiny = canvas(SOFT_W, Math.max(2, Math.round((SOFT_W * h) / w))), tg = tiny.getContext("2d");
  tg.imageSmoothingEnabled = true;
  tg.imageSmoothingQuality = "high";
  tg.drawImage(img, 0, 0, tiny.width, tiny.height);
  // most of the colour out, the contrast down under a light haze: frosted glass over a screenshot
  tg.globalCompositeOperation = "saturation";
  tg.fillStyle = "rgba(128, 128, 128, 0.6)";
  tg.fillRect(0, 0, tiny.width, tiny.height);
  tg.globalCompositeOperation = "source-over";
  tg.fillStyle = "rgba(150, 156, 166, 0.18)";
  tg.fillRect(0, 0, tiny.width, tiny.height);
  upscale(g, tiny, x, y, w, h, 2);
}
// ---- end monitor-codes

/** Wrap a line into rows of at most `cols` characters (soft wrap at spaces when possible). */
function wrapLine(s, cols) {
  if (s.length <= cols) return [s];
  const out = [];
  let rest = s;
  while (rest.length > cols) {
    let cut = rest.lastIndexOf(" ", cols);
    if (cut < cols * 0.6) cut = cols;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^ /, "");
  }
  out.push(rest);
  return out;
}

/** Shorten a path in the middle, keeping its head and its file name. */
export function shortPath(p, max) {
  if (!p || p.length <= max) return p ?? "";
  const parts = p.split("/");
  const file = parts.pop();
  let head = "";
  for (const part of parts) {
    if ((head + part + "/…/" + file).length > max) break;
    head += part + "/";
  }
  return head + "…/" + file;
}

function headerCanvas(label, path, right) {
  const c = canvas(MAIN_PX[0], HEAD_H), g = c.getContext("2d");
  g.fillStyle = C.head;
  g.fillRect(0, 0, c.width, c.height);
  g.fillStyle = C.rule;
  g.fillRect(0, HEAD_H - 2, c.width, 2);
  g.textBaseline = "middle";
  let x = PAD;
  if (label) {
    g.font = `500 34px ${MONO}`;
    g.fillStyle = C.label;
    g.fillText(label, x, HEAD_H / 2 + 1);
    x += g.measureText(label).width + 28;
  }
  g.font = `500 38px ${MONO}`;
  g.fillStyle = C.path;
  const cols = Math.floor((c.width - x - PAD - (right ? 200 : 0)) / (38 * 0.6));
  g.fillText(shortPath(path, cols), x, HEAD_H / 2 + 1);
  if (right) {
    g.font = `400 32px ${MONO}`;
    g.fillStyle = C.label;
    g.textAlign = "right";
    g.fillText(right, c.width - PAD, HEAD_H / 2 + 1);
  }
  return c;
}

/** The body of a text file: every row drawn once; returns { canvas, rows, focusRow, focusEnd }.
 *  soft (veiled): the text blurred, the line numbers sharp. */
function textBody(text, from, to, { soft = false } = {}) {
  const cols = Math.floor((MAIN_PX[0] - GUTTER - PAD) / (FONT * 0.6));
  const lines = String(text).replace(/\r/g, "").replace(/\t/g, "  ").split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  const rows = [];
  lines.forEach((l, i) => wrapLine(l, cols).forEach((r, k) => rows.push({ n: k === 0 ? i + 1 : null, s: r, line: i + 1 })));
  const H = Math.min(16384, Math.max(MAIN_PX[1] - HEAD_H, rows.length * LINE_H + 2 * PAD));
  const c = canvas(MAIN_PX[0], H), g = c.getContext("2d");
  g.fillStyle = C.bg;
  g.fillRect(0, 0, c.width, c.height);
  g.textBaseline = "alphabetic";
  // monitor-codes: the rows' text on a small layer of their own when soft
  const layer = soft ? canvas(Math.ceil(c.width / TEXT_K), Math.ceil(H / TEXT_K)) : c;
  const tg = soft ? layer.getContext("2d") : g;
  if (soft) {
    tg.scale(1 / TEXT_K, 1 / TEXT_K);
    tg.textBaseline = "alphabetic";
  }
  const lo = from ?? 1, hi = to ?? lines.length;
  rows.forEach((r, i) => {
    const y = PAD + i * LINE_H + FONT * 0.92;
    if (y > H) return;
    const inRange = r.line >= lo && r.line <= hi;
    if (r.n !== null) {
      g.font = `400 ${FONT - 6}px ${MONO}`;
      g.fillStyle = C.num;
      g.textAlign = "right";
      g.fillText(String(r.n), GUTTER - 30, y);
    }
    tg.textAlign = "left";
    tg.font = `400 ${FONT}px ${MONO}`;
    tg.fillStyle = inRange ? C.text : C.dim;
    tg.fillText(r.s, GUTTER, y);
  });
  if (soft) upscale(g, layer, 0, 0, c.width, H);
  const focusRow = rows.findIndex((r) => r.line >= lo);
  let focusEnd = rows.length - 1;
  for (let i = rows.length - 1; i >= 0; i--) if (rows[i].line <= hi) { focusEnd = i; break; }
  return { canvas: c, rows: rows.length, focusRow: Math.max(0, focusRow), focusEnd, height: H };
}

function imageBody(img, { soft = false } = {}) {
  const W = MAIN_PX[0], H = MAIN_PX[1] - HEAD_H;
  const c = canvas(W, H), g = c.getContext("2d");
  g.fillStyle = "#08090b";
  g.fillRect(0, 0, W, H);
  if (img?.naturalWidth > 0) {
    const k = Math.min((W - 2 * 24) / img.width, (H - 2 * 20) / img.height);
    const w = img.width * k, h = img.height * k;
    if (soft) softImage(g, img, (W - w) / 2, (H - h) / 2, w, h); // monitor-codes
    else g.drawImage(img, (W - w) / 2, (H - h) / 2, w, h);
  }
  return { canvas: c, rows: 0, focusRow: 0, focusEnd: 0, height: H };
}

function ballotBody({ contenders = [], place }, coded = null) {
  const W = MAIN_PX[0], H = MAIN_PX[1] - HEAD_H;
  const c = canvas(W, H), g = c.getContext("2d");
  g.fillStyle = C.bg;
  g.fillRect(0, 0, W, H);
  const lh = Math.min(LINE_H + 8, (H - 2 * PAD) / Math.max(1, contenders.length));
  if (coded) {
    // monitor-codes: the codes in the letters' order, no team, no rank, no ceiling mark (ui/veil.js)
    coded.forEach((f, i) => {
      g.font = `500 ${FONT}px ${SANS}`;
      g.fillStyle = C.text;
      g.textAlign = "left";
      g.fillText(f.label, PAD + 10, PAD + i * lh + lh * 0.72);
    });
    return { canvas: c, rows: 0, focusRow: 0, focusEnd: 0, height: H };
  }
  contenders.forEach((f, i) => {
    const y = PAD + i * lh + lh * 0.72;
    g.font = `500 ${FONT - 2}px ${MONO}`;
    g.fillStyle = f.ceiling && place === 1 ? C.dim : C.label;
    g.textAlign = "left";
    g.fillText(f.team, PAD + 10, y);
    g.font = `500 ${FONT}px ${SANS}`;
    g.fillStyle = f.ceiling && place === 1 ? C.dim : C.text;
    g.fillText(f.name ?? "", PAD + 330, y);
    if (f.ceiling && place === 1) {
      g.font = `400 32px ${SANS}`;
      g.fillStyle = C.dim;
      g.textAlign = "right";
      g.fillText("не может занять 1-е место", W - PAD, y);
    }
  });
  return { canvas: c, rows: 0, focusRow: 0, focusEnd: 0, height: H };
}

/**
 * The main monitor. Returns { group, show(content, t), setPower(level, t), update(t), light: 0..1 }.
 * w, h: the screen's size in metres (16:9).
 */
export function createMainScreen(w, h) {
  const group = new THREE.Group();
  const headH = h * (HEAD_H / MAIN_PX[1]);
  const headMat = new THREE.MeshBasicMaterial({ color: 0x000000, toneMapped: false });
  const bodyMat = new THREE.MeshBasicMaterial({ color: 0x000000, toneMapped: false });
  const head = new THREE.Mesh(new THREE.PlaneGeometry(w, headH), headMat);
  head.position.y = h / 2 - headH / 2;
  const body = new THREE.Mesh(new THREE.PlaneGeometry(w, h - headH), bodyMat);
  body.position.y = -headH / 2;
  group.add(head, body);
  const contents = new Track(), power = new Track();
  const cache = new Map(); // content → { plain, veiled }
  const blank = { head: tex(headerCanvas("", "", "")), body: { ...imageBody(null) } };
  blank.body.tex = tex(blank.body.canvas);
  let veil = null; // monitor-codes: ui/veil.js, set by the desk

  function build(c, veiled = false) {
    const k = veiled ? "veiled" : "plain";
    const hit = cache.get(c)?.[k];
    // a picture still loading is drawn again once it has loaded (live: the first frame may come first)
    if (hit && !(hit.loading && c.img?.complete)) return hit;
    if (hit) [hit.head, hit.body.tex].forEach((x) => x.dispose());
    let b, label = c.label ?? "", path = c.path ?? "", right = "";
    if (c.kind === "text") {
      b = textBody(veiled ? veil.text(c.text ?? "") : c.text ?? "", c.from, c.to, { soft: veiled });
      if (c.from || c.to) right = `${c.from ?? 1}–${c.to ?? ""}`;
    } else if (c.kind === "image") {
      b = imageBody(c.img ?? null, { soft: veiled });
    } else if (c.kind === "ballot") {
      b = ballotBody(c, veiled ? veil.ballot(c.contenders ?? []) : null);
      label = "";
      path = c.title ?? "";
    } else b = imageBody(null);
    if (veiled) [label, path] = [veil.label(label), veil.path(path)];
    b.tex = tex(b.canvas);
    b.tex.wrapT = THREE.ClampToEdgeWrapping;
    const out = { head: tex(headerCanvas(label, path, right)), body: b, loading: c.kind === "image" && !!c.img && !c.img.complete };
    cache.set(c, { ...cache.get(c), [k]: out });
    return out;
  }

  let level = 0;
  return {
    group,
    get light() {
      return level;
    },
    /** content: { kind: "text", label, path, text, from, to } | { kind: "image", label, path, img } | { kind: "ballot", title, place, contenders } | null */
    show(content, t) {
      if (content?.kind === "image" && content.src && !content.img) {
        content.img = new Image();
        content.img.src = content.src;
        content.ready = content.img.decode().catch(() => {});
      }
      contents.add(t, { content });
    },
    setPower(lv, t) {
      power.add(t, { level: lv });
    },
    /** monitor-codes: the veil (ui/veil.js) asked at every frame; null = never veiled */
    setVeil(v) {
      veil = v;
    },
    /** resolves when every image shown so far is decoded (for stills) */
    async ready() {
      await Promise.all(contents.ev.map((e) => e.content?.ready).filter(Boolean));
      cache.clear();
    },
    update(t) {
      // brightness eases over 0.35 s (a backlight, not a fade)
      const p = power.current(t), q = power.previous(t);
      const target = p?.level ?? 0, from = q?.level ?? 0;
      level = p ? from + (target - from) * smooth((t - p.t) / 0.35) : 0;
      const e = contents.current(t);
      const v = e?.content ? build(e.content, !!veil?.on(t)) : blank;
      headMat.map = v.head;
      bodyMat.map = v.body.tex;
      const visible = (h - headH) / h * MAIN_PX[1];
      const H = v.body.height;
      const rep = Math.min(1, visible / H);
      // scroll: start a little above the range, then move through it at ~1.6 rows per second
      let scroll = 0;
      if (e?.content?.kind === "text" && H > visible) {
        const start = Math.max(0, (v.body.focusRow - 1) * LINE_H);
        const endPx = Math.max(start, (v.body.focusEnd + 2) * LINE_H + PAD - visible);
        const dt = Math.max(0, t - e.t - 1.2);
        scroll = Math.min(endPx, start + dt * LINE_H * 1.6);
        scroll = Math.min(scroll, H - visible);
      }
      v.body.tex.repeat.set(1, rep);
      v.body.tex.offset.set(0, 1 - rep - scroll / H);
      headMat.needsUpdate = bodyMat.needsUpdate = false;
      const k = 1.08 * level; // whites a touch over 1: the screen is the brightest thing on the desk
      headMat.color.setScalar(k);
      bodyMat.color.setScalar(k);
    },
  };
}

/** The side monitor: the tool log (labels and paths as the director gives them) and the timer. */
export function createSideScreen(w, h) {
  const c = canvas(...SIDE_PX), g = c.getContext("2d");
  const t = tex(c);
  const mat = new THREE.MeshBasicMaterial({ map: t, color: 0x000000, toneMapped: false });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
  const logs = new Track(), timers = new Track(), power = new Track();
  let drawn = "";
  let veil = null; // monitor-codes: ui/veil.js
  function draw(items, since, now) {
    const sec = since == null ? null : Math.max(0, Math.floor(now - since));
    const veiled = !!veil?.on(now);
    const coded = (s) => (veiled ? veil.path(s) : s);
    const codedLabel = (s) => (veiled ? veil.label(s) : s);
    const key = JSON.stringify([items?.length, items?.at(-1)?.at, sec, veiled]);
    if (key === drawn) return;
    drawn = key;
    const [W, H] = SIDE_PX;
    g.fillStyle = C.bg;
    g.fillRect(0, 0, W, H);
    g.fillStyle = C.head;
    g.fillRect(0, 0, W, 64);
    if (sec !== null) {
      g.font = `500 36px ${MONO}`;
      g.fillStyle = C.path;
      g.textAlign = "right";
      g.textBaseline = "middle";
      g.fillText(`${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`, W - 24, 33);
    }
    g.textAlign = "left";
    g.textBaseline = "alphabetic";
    const list = (items ?? []).slice(-6);
    list.forEach((a, i) => {
      const y = 112 + i * 62;
      const newest = i === list.length - 1;
      g.font = `500 28px ${MONO}`;
      g.fillStyle = newest ? C.path : C.label;
      // the label is the tool's short name ("search_text «query»"): the name goes in the label column,
      // a quoted query leads the path column
      const full = codedLabel(a.label ?? a.kind ?? "");
      const q = full.indexOf(" «");
      const label = q > 0 ? full.slice(0, q) : full;
      const query = q > 0 ? full.slice(q + 1) : "";
      g.fillText(label.length > 16 ? label.slice(0, 15) + "…" : label, 24, y);
      g.font = `400 28px ${MONO}`;
      g.fillStyle = newest ? C.text : C.dim;
      const where = a.path && !(query && a.path === ".") ? coded(a.path) : "";
      g.fillText(query ? shortPath(`${query} ${where}`.trim(), 30) : shortPath(where, 30), 290, y);
    });
    t.needsUpdate = true;
  }
  let level = 0;
  return {
    mesh,
    setLog(items, at) {
      logs.add(at, { items });
    },
    setTimer(since, at) {
      timers.add(at, { since });
    },
    setPower(lv, at) {
      power.add(at, { level: lv });
    },
    setVeil(v) {
      veil = v;
    },
    update(now) {
      const p = power.current(now), q = power.previous(now);
      const target = p?.level ?? 0, from = q?.level ?? 0;
      level = p ? from + (target - from) * smooth((now - p.t) / 0.35) : 0;
      const items = (logs.current(now)?.items ?? []).filter((a) => a.at == null || a.at <= now);
      draw(items, timers.current(now)?.since ?? null, now);
      mat.color.setScalar(0.95 * level);
    },
  };
}
