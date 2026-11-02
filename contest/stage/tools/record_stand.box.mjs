// Where a plan step's element is in the recorded frame (record_stand.mjs writes it to the sidecar,
// the montage crops onto it). Pure helpers, no browser: record_stand.test.mjs runs them on fakes.

// The element a step acts on: its Playwright selector, or null for goto / scroll / press / sh.
export function stepSelector(s) {
  return s.click || s.hover || (s.fill && s.fill[0]) || null;
}

// A CSS-px box (locator.boundingBox()) → pixels of the video frame. The frame is the viewport
// scaled (deviceScaleFactor, or a screencast smaller than the viewport) and offset by any padding.
export function toFrameBox(box, { scale = 1, dx = 0, dy = 0 } = {}) {
  if (!box || ![box.x, box.y, box.width, box.height].every(Number.isFinite)) return null;
  const r = (v) => Math.round(v * 10) / 10;
  return { x: r(box.x * scale + dx), y: r(box.y * scale + dy), w: r(box.width * scale), h: r(box.height * scale) };
}

// The step's element box right before the action: null when the step has no element or the
// element has no box (detached, hidden, never appeared); never throws, the take goes on.
export async function stepBox(locatorFor, s, map, timeoutMs = 2000) {
  const sel = stepSelector(s);
  if (!sel) return null;
  try {
    return toFrameBox(await locatorFor(sel).boundingBox({ timeout: timeoutMs }), map);
  } catch {
    return null;
  }
}
