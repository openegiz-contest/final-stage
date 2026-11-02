// A Finalist's minute as an edit (stage-tv, owner 2026-10-28: «анимации как монтаж, привязанные к тому,
// что говорится»): which of four shots is on screen when. Pure, no imports: ui/program.js lays the plan
// on the camera (its FRAMES room, tv, tvClose, host), test/director/minute-shots.test.mjs checks it.
//
//   room      the Host in the room and the big screen behind it
//   tv        the big screen filling most of the frame, from the room's side
//   tv-close  pushed in, square on: the screen fills the frame, the action on it reads
//   host      the Host
//
// beats (program.json finalists[i].beats, written by the montage, session minute-montage):
// [{ t, shot, label }], t in seconds from the minute's zero (its video's first frame). Cuts between
// shots; tv ↔ tv-close is an eased move (a push in, a pull out), not a cut. No shot is shorter than
// minCut: a beat that comes too soon waits for it, or is dropped when the next beat comes first.
// Without beats the default edit: room → tv → tv-close (pushed in) at the middle → room, the cuts on
// sentence starts nearby. The screenshots (the only picture on air since the owner dropped Stand videos,
// 2026-10-28 evening; no beats either): room → tv, then at each change of screenshot a push in or a pull
// out, alternating, → room; the changes fall on the Host's sentence starts (stillChanges).

export const SHOT_KINDS = ["room", "tv", "tv-close", "host"];
export const EDIT = {
  minCut: 3.2,       // s, the shortest shot (ui/program.js TIMES.minCut)
  push: 1.8, pull: 1.6, // s, the moves tv → tv-close and back
  open: 4.5,         // s, the default edit's first room shot at least
  tail: 6.0,         // s, its last room shot about
  snap: 2.5,         // s, how far a default cut moves to a sentence start
};

const isMove = (a, b) => (a === "tv" && b === "tv-close") || (a === "tv-close" && b === "tv");

/** The beats that can be shot: known kinds, finite times, in time order. */
export function cleanBeats(beats) {
  if (!Array.isArray(beats)) return [];
  return beats
    .filter((b) => b && SHOT_KINDS.includes(b.shot) && Number.isFinite(Number(b.t)))
    .map((b) => ({ t: Number(b.t), shot: b.shot, label: b.label ?? "" }))
    .sort((a, b) => a.t - b.t);
}

/**
 * planMinute({ from, to, zero, beats, starts }) → [{ t, shot, move?, label? }]: the shots of the minute on
 * the show clock, the first at `from`, each held until the next (the last until `to`). `move` (s): the
 * shot is reached by an eased move of that length from the one before. `zero`: the beats' zero on the
 * show clock; `starts`: the Host's sentence starts on the show clock (the default edit snaps to them);
 * `changes`: the screenshots' cross-fades on the show clock, each one a move (moveOnChanges).
 */
export function planMinute({ from, to, zero = from, beats = null, starts = [], changes = [], minCut = EDIT.minCut }) {
  const bs = cleanBeats(beats).map((b) => ({ ...b, t: zero + b.t })).filter((b) => b.t < to - minCut);
  const want = bs.length ? bs : defaultEdit({ from, to, starts, minCut, moves: changes.length > 0 });
  const out = [];
  // the opening: the first beat's shot when it comes within minCut of the start, else the room
  const first = want[0] && want[0].t < from + minCut ? want.shift() : null;
  out.push({ t: from, shot: first?.shot ?? "room", ...(first?.label ? { label: first.label } : {}) });
  for (let i = 0; i < want.length; i++) {
    const b = want[i], last = out.at(-1);
    if (b.shot === last.shot) continue;
    let t = Math.max(b.t, last.t + minCut);
    if (t > to - minCut) break;
    const next = want.slice(i + 1).find((x) => x.shot !== b.shot);
    if (t > b.t && next && next.t < t + minCut) continue; // late, and the next beat is due before it would end
    out.push({ t: round(t), shot: b.shot, ...(b.label ? { label: b.label } : {}) });
  }
  for (let i = 1; i < out.length; i++) {
    const a = out[i - 1].shot, b = out[i].shot;
    if (isMove(a, b)) out[i].move = b === "tv-close" ? EDIT.push : EDIT.pull;
  }
  return changes.length ? moveOnChanges(out, changes, { to, minCut }) : out;
}

/**
 * The screenshots' minute: at each change of screenshot inside a tv or tv-close shot, an eased move to
 * the other of the two, so the screen breathes with its pictures; only where both shots around the move
 * keep minCut. A change too close to a cut takes the cut instead (the cut to the screen, or away from it,
 * lands on the change), so every change shows. `changes`: the cross-fades' starts on the show clock.
 */
export function moveOnChanges(plan, changes, { to, minCut = EDIT.minCut } = {}) {
  const out = plan.map((s) => ({ ...s }));
  const onTv = (s) => !!s && (s.shot === "tv" || s.shot === "tv-close");
  for (const c of [...changes].sort((a, b) => a - b)) {
    const i = out.findLastIndex((s) => s.t <= c);
    const cur = out[i], prev = out[i - 1], nxt = out[i + 1], next = nxt?.t ?? to;
    if (!cur) continue;
    if (!onTv(cur)) {
      // the room or the Host, the cut to the screen due within minCut: on the change
      if (onTv(nxt) && !nxt.move && nxt.t - c < minCut && c - cur.t >= minCut) nxt.t = round(c);
      continue;
    }
    if (c - cur.t < minCut) {
      // the cut to the screen just before the change: on the change (the shot before holds on)
      if (!cur.move && prev && c - prev.t >= minCut && next - c >= minCut) cur.t = round(c);
      continue;
    }
    if (next - c < minCut) {
      // the cut away just after the change: on the change
      if (nxt && !nxt.move && !onTv(nxt)) nxt.t = round(c);
      continue;
    }
    const shot = cur.shot === "tv" ? "tv-close" : "tv";
    out.splice(i + 1, 0, { t: round(c), shot, move: shot === "tv-close" ? EDIT.push : EDIT.pull, label: "screenshot" });
    if (out[i + 2] && isMove(shot, out[i + 2].shot)) out[i + 2].move = out[i + 2].shot === "tv-close" ? EDIT.push : EDIT.pull;
    else if (out[i + 2]) delete out[i + 2].move;
  }
  return out;
}

/** room → tv → tv-close at the middle → room, on sentence starts where one is near (`moves`: the
 * screenshots' changes move the screen instead of the middle push: room → tv → room). */
function defaultEdit({ from, to, starts, minCut, moves = false }) {
  const near = (t, lo, hi) => {
    const c = starts.filter((s) => s >= lo && s <= hi && Math.abs(s - t) <= EDIT.snap).sort((a, b) => Math.abs(a - t) - Math.abs(b - t))[0];
    return c ?? Math.min(Math.max(t, lo), hi);
  };
  const len = to - from;
  if (len < 2 * minCut) return [];
  if (len < 4 * minCut) return [{ t: near(from + len / 2, from + minCut, to - minCut), shot: "tv-close" }];
  const tv = near(from + Math.max(EDIT.open, minCut) + 1, from + Math.max(EDIT.open, minCut), from + len / 2 - minCut);
  if (moves) return [{ t: tv, shot: "tv" }, { t: near(to - EDIT.tail, tv + minCut, to - minCut), shot: "room" }];
  const close = near(from + len / 2, tv + minCut, to - 2 * minCut);
  const room = near(to - EDIT.tail, close + minCut, to - minCut);
  return [{ t: tv, shot: "tv" }, { t: close, shot: "tv-close" }, { t: room, shot: "room" }];
}

/**
 * stillChanges({ from, end, n, starts, stillS, fade }) → the n − 1 cross-fades' starts (show clock) of n
 * screenshots over [from, end): spread evenly, each moved to a sentence start of the Host's (0.2 s
 * before it) within EDIT.snap, so a new picture comes in with a new sentence; every picture stays at
 * least stillS (the first from `from`, the last until `end`).
 */
export function stillChanges({ from, end, n, starts = [], stillS = 7.5, fade = 1.6 }) {
  const D = (end - from) / n, out = [];
  for (let k = 1; k < n; k++) {
    const ideal = from + k * D - fade;
    const lo = k === 1 ? from + stillS - fade : out.at(-1) + stillS;
    const hi = end - (n - k) * stillS;
    const cands = starts.map((s) => s - 0.2).filter((c) => c >= lo && c <= hi && Math.abs(c - ideal) <= EDIT.snap);
    const c = cands.sort((a, b) => Math.abs(a - ideal) - Math.abs(b - ideal))[0] ?? Math.min(Math.max(ideal, lo), Math.max(lo, hi));
    out.push(round(c));
  }
  return out;
}

const round = (t) => Math.round(t * 1000) / 1000;
