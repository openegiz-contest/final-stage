// Timed events. Every scene module keeps the calls it gets as events on the show clock, so the
// picture at any t is a function of t: a still at ?t=, a live frame and a clip frame agree.
export class Track {
  constructor() {
    this.ev = [];
  }
  /** Add an event at t; events at the same t keep their call order. */
  add(t, value) {
    const e = { t, ...value };
    let i = this.ev.length;
    while (i > 0 && this.ev[i - 1].t > t) i--;
    this.ev.splice(i, 0, e);
    return e;
  }
  /** Index of the last event at or before t, or -1. */
  index(t) {
    let lo = 0, hi = this.ev.length - 1, r = -1;
    while (lo <= hi) {
      const m = (lo + hi) >> 1;
      if (this.ev[m].t <= t) (r = m), (lo = m + 1);
      else hi = m - 1;
    }
    return r;
  }
  current(t) {
    const i = this.index(t);
    return i >= 0 ? this.ev[i] : null;
  }
  previous(t) {
    const i = this.index(t);
    return i >= 1 ? this.ev[i - 1] : null;
  }
  /** Events with t0 < e.t <= t1. */
  between(t0, t1) {
    return this.ev.filter((e) => e.t > t0 && e.t <= t1);
  }
  upTo(t) {
    return this.ev.slice(0, this.index(t) + 1);
  }
}

export const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
export const lerp = (a, b, u) => a + (b - a) * u;
export const smooth = (u) => ((u = clamp01(u)), u * u * (3 - 2 * u));
export const smoother = (u) => ((u = clamp01(u)), u * u * u * (u * (u * 6 - 15) + 10));
export const inOut3 = (u) => ((u = clamp01(u)), u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2);
export const out3 = (u) => ((u = clamp01(u)), 1 - Math.pow(1 - u, 3));
export const between = (t, a, b) => clamp01((t - a) / (b - a));
/** Wrap an angle to (-PI, PI]. */
export const wrap = (a) => a - 2 * Math.PI * Math.floor((a + Math.PI) / (2 * Math.PI));

/** Seeded PRNG (mulberry32). */
export function rng(seed = 1) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let x = Math.imul(a ^ (a >>> 15), 1 | a);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}
