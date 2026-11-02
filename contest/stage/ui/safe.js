// The broadcast frame and its safe zones (spec §7.7 «Preshow с живыми ведущими», owner 2026-10-28).
//
// The frame. Every Stage page lays out a 1920×1080 picture: the canvas renders at 1920×1080 and the
// 2D layer is laid out in those pixels. fitFrame() scales the frame to the window and letterboxes it
// (black bars), so a window of any shape shows the whole picture OBS captures, never a crop of it.
//
// ?cams=1. OBS composites the two live hosts' webcams as circles in the top-left and top-right
// corners. With the flag the page carries class `cams` on <html>; ui/stage.css and ui/cards.css move
// every card clear of the circles, ui/subtitles.js keeps the speech line out of them, ui/program.js
// frames the dispatch wall inside the band between them. Without the flag the layout is as before.
export const FRAME = { W: 1920, H: 1080 };
export const CAMS = { d: 300, margin: 40 }; // circle diameter and its margin from the frame's edges, px
// clear of the circles: what may sit beside them starts this far from the frame's sides, or below SAFE.y
export const SAFE = { x: CAMS.margin + CAMS.d + 40, y: CAMS.margin + CAMS.d + 16 };

const q = new URLSearchParams(globalThis.location?.search ?? "");
export const camsOn = q.get("cams") === "1";

/** The two circles: [{ cx, cy, r }] in frame pixels. */
export function camCircles() {
  const r = CAMS.d / 2, c = CAMS.margin + r;
  return [{ cx: c, cy: c, r }, { cx: FRAME.W - c, cy: c, r }];
}

/** Whether a rect { left, top, right, bottom } (frame px) touches a cam circle, `pad` px around it. */
export function hitsCams(rect, pad = 0) {
  return camCircles().some(({ cx, cy, r }) => {
    const x = Math.max(rect.left, Math.min(cx, rect.right)), y = Math.max(rect.top, Math.min(cy, rect.bottom));
    return (x - cx) ** 2 + (y - cy) ** 2 < (r + pad) ** 2;
  });
}

/** Scale the 1920×1080 frame to the window (letterbox), now and on every resize; set the cams class. */
export function fitFrame() {
  const root = document.documentElement;
  root.classList.add("framed");
  root.classList.toggle("cams", camsOn);
  const fit = () => root.style.setProperty("--fit", String(Math.min(innerWidth / FRAME.W, innerHeight / FRAME.H)));
  fit();
  addEventListener("resize", fit);
}
