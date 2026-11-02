// The Stage's clock and its test hook. Every animated thing reads time from here, never from
// performance.now(), so any moment of the show can be rendered exactly:
//   ?t=12.5    freeze at 12.5 s (stills, headless checks)
//   ?gfx=lite  the light-graphics preset (read by the scene, listed here so pages agree on it)
// window.__stage is the hook tools/render.mjs drives:
//   ready        true once the first frame at the requested time is drawn
//   seek(t)      render the frame at time t; resolves when it is on screen (and when the page's
//                settle() says its media are at t: a video seeked to its frame)
//   bench(n)     render n frames back to back, GPU-synced; resolves to { msPerFrame, frames }
//   info         { gpu, gfx } filled by the page

const params = new URLSearchParams(location.search);
export const frozenAt = params.has("t") ? Number(params.get("t")) : null;
export const gfx = params.get("gfx") === "lite" ? "lite" : "full";

const t0 = performance.now();
let manual = frozenAt;
let offset = 0, pausedAt = null; // operator-controls: the show clock behind the page clock, and where it stands paused

// Seconds since the page started, or the frozen/sought time.
export function now() {
  return manual ?? pausedAt ?? (performance.now() - t0) / 1000 - offset;
}

// Install the hook. renderAt(t) draws one frame at time t; renderer is the THREE.WebGLRenderer;
// settle() (optional) resolves once what renderAt(t) started outside the canvas is in place.
export function installStageHook({ renderAt, renderer, settle = null }) {
  const gl = renderer.getContext();
  const sync = () => gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
  const dbg = gl.getExtension("WEBGL_debug_renderer_info");
  const hook = {
    ready: false,
    info: { gpu: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : "unknown", gfx },
    async seek(t) {
      manual = t;
      renderAt(t);
      sync();
      if (settle) await settle();
      await new Promise((r) => requestAnimationFrame(() => r()));
    },
    async bench(n = 120) {
      const was = manual;
      const start = performance.now();
      for (let i = 0; i < n; i++) {
        manual = (was ?? 0) + i / 30;
        renderAt(manual);
        sync();
      }
      const msPerFrame = (performance.now() - start) / n;
      manual = was;
      return { msPerFrame, frames: n };
    },
  };
  window.__stage = hook;
  return hook;
}

// The usual loop: real time, or one frame at ?t= and then idle.
export function runLoop({ renderAt, renderer, settle = null }) {
  const hook = installStageHook({ renderAt, renderer, settle });
  if (frozenAt !== null) {
    hook.seek(frozenAt).then(() => (hook.ready = true));
    return hook;
  }
  const tick = () => {
    if (manual === null) renderAt(now()); // after seek() the page stays on that frame
    hook.ready = true;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  return hook;
}

// operator-controls: the operator pauses and jumps the show clock (ui/operator.js; live only, never
// under ?t= or after seek()). Everything on the Stage is a pure function of now(), so a jump shows
// the frame of that time; the voices follow it through voice.resync().
export const showClock = {
  get paused() {
    return pausedAt !== null;
  },
  pause() {
    if (manual === null && pausedAt === null) pausedAt = now();
  },
  resume() {
    if (pausedAt === null) return;
    offset = (performance.now() - t0) / 1000 - pausedAt;
    pausedAt = null;
  },
  /** Show time t from now on (paused: stays paused at t). */
  jump(t) {
    if (manual !== null) return;
    if (pausedAt !== null) pausedAt = t;
    else offset = (performance.now() - t0) / 1000 - t;
  },
};
