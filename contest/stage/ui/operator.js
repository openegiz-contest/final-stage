// The operator's keys on show.html (owner 2026-10-28: «паузу внутри, может, перемотку»). Live only:
// under ?t= (stills, clips) nothing here runs and the plan has no holds. Nothing of it is on air except
// the holds themselves.
//
//   Space   pause / resume the whole Stage: the show clock (lib/clock.js showClock), the voices (the
//           audio clock stands), the typing, the camera, the robots. In the debate the engine keeps
//           running: on resume the director plays on from where it paused, no beat skipped (the queue
//           rule), the engine's news waiting in its next poll. On a hold Space goes on, as →.
//   →       before the debate: the next segment from its start (on a hold: go on to the next Finalist;
//           after the 1st, the launch). In the debate: the next beat now (the one playing cut short),
//           never past what the engine has produced; after a ← the beats already played, one by one.
//   ←       before the debate: this segment again from its start, or the one before within 3 s of a
//           start. In the debate: back one beat (rehearsals): the picture and the voices replay it, the
//           director waits until the clock is back where it was.
//
// Holds (the preshow of 2026-10-28, spec §7.7: after each Finalist's minute the two hosts talk to its
// Stand live): after the intro and after every Finalist's minute the plan has a hold of HOLD_S, the
// Finalist's page on the wall, the room, slow cuts, no voice; → or Space ends it (the clock jumps to
// the next segment). ?hold=0: no holds (the old automatic timeline).
//
// A reload (⌘R, an OBS refresh) or a crash comes back to the same place: the segment and the time in it
// (a hold included), the debate's line and the time in it, paused if it was (resumePlan below).
// ?restart=1 or Shift+R twice starts over.
//
// A jump moves the show clock. The scene is a pure function of it (world/timeline.js) and the voices
// are rescheduled on it (voice.resync), so a jump back shows and says exactly what was on air then.
//
// The indicator (state, segment, keys) sits bottom left, unless ?air=1 (OBS loads that).
// window.__operator: { state, now(), toggle(), next(), prev(), jump(t) } for checks.
import { now, showClock } from "/lib/clock.js";
import { ReplaySource } from "/director/index.js";

export const HOLD_S = 3600; // a hold in the plan; the show goes on by itself after it
const BACK_S = 3; // ← within this of a segment's (a beat's: BEAT_BACK_S) start goes to the one before
const BEAT_BACK_S = 2;
const HOLD_CUT_S = 12; // the camera during a hold: a calm cut this often, for HOLD_CUTS_S
const HOLD_CUTS_S = 20 * 60;
const RESTART_S = 3; // Shift+R, then Shift+R again within this: the show from the start
const SAVE_MS = 250; // the position is saved this often (and as the page goes away)
export const STALE_S = 6 * 3600; // a saved position older than this is a previous rehearsal's: not resumed

// live: on unless ?hold=0; virtual (?t=): off unless ?hold=1 (stills of the holds, test/safe-check.mjs)
export const holdsOn = ({ q, virtual }) => (virtual ? q.get("hold") === "1" : q.get("hold") !== "0");

/** The plan with a hold after the intro and after every Finalist: the later segments move by HOLD_S. */
export function withHolds(segs, on) {
  if (!on) return segs;
  let off = 0;
  for (const s of segs) {
    if (off) for (const k of Object.keys(s)) if (typeof s[k] === "number" && Number.isFinite(s[k])) s[k] += off; // from, to, lineEnd, appearAt
    if (s.kind === "intro" || s.kind === "finalist") {
      s.hold = { from: s.to, to: s.to + HOLD_S };
      off += HOLD_S;
    }
  }
  return segs;
}

/**
 * The holds' camera: calm cuts between the wall (the Finalist's page), the Host with the wall, the
 * screenshot and the room; the first one well after the minute's last cut. Live from createOperator;
 * virtual (?hold=1) from ui/program.js, so stills show them.
 */
export function holdCuts({ scheduled, cam, frames }) {
  for (const s of scheduled) {
    if (!s.hold) continue;
    const shots = s.kind === "intro" ? [frames.two, frames.wide, frames.wall] : [frames.wall, frames.two, frames.visual, frames.wide];
    const last = cam.list().filter((c) => c.t < s.hold.from).at(-1)?.t ?? -Infinity;
    let t = Math.max(s.hold.from + 2, last + 6), i = 0;
    for (; t < Math.min(s.hold.to, s.hold.from + HOLD_CUTS_S); t += HOLD_CUT_S) cam.cut(shots[i++ % shots.length], t);
  }
}

const opKey = (storeKey) => storeKey.replace(/^stage\.program\./, "stage.operator."); // beside the segment cursor (stage.program.<built_at>…)
const readJson = (key) => {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "{}") ?? {};
  } catch {
    return {};
  }
};
/** The run the debate would show now: the director's run key (director.js: source.runKey(), else started_at). */
async function runKeyNow(replayUrl) {
  try {
    if (replayUrl) {
      const rec = await ReplaySource.fromUrl(replayUrl);
      return (await rec.runKey()) ?? rec.records.find((r) => r.state)?.state.started_at ?? null;
    }
    const f = await fetch("/run/final.json", { cache: "no-store" });
    if (f.ok) {
      const k = (await f.json()).created_at;
      if (k) return k;
    }
    const s = await fetch("/run/state.json", { cache: "no-store" });
    return s.ok ? (await s.json()).started_at ?? null : null;
  } catch {
    return null;
  }
}

/**
 * Where a live show.html starts after a reload or a crash (owner 2026-10-28: a ⌘R in the debate went
 * back to the title of a stale ?segment=title). The operator saves the position every SAVE_MS:
 * { segment, into (s into it), n and nInto (the debate's line and s into it), paused, runKey, url
 * (the ?segment= and ?from= the page was opened with), savedAt }, keyed by the programme
 * (stage.operator.<built_at>|<replay>). It wins over the URL when the page was reloaded (or restored:
 * navigation type reload / back_forward) or opened with the same ?segment= / ?from= as the page that
 * saved it (an OBS source's own refresh); another ?segment= in the URL is the operator's choice. A
 * debate position belongs to its run: another run (or none yet) starts clean. ?restart=1 forgets it
 * all (the segment cursor, the director's cursors) and drops itself from the URL. Returns the saved
 * position, { fresh: true } after ?restart=1, or null.
 */
export async function resumePlan({ q, storeKey, replayUrl }) {
  const key = opKey(storeKey);
  if (q.get("restart") === "1") {
    try {
      for (const k of Object.keys(localStorage)) if (k === key || k === storeKey || k.startsWith("stage.cursor.")) localStorage.removeItem(k);
    } catch {}
    const u = new URL(location.href);
    u.searchParams.delete("restart");
    history.replaceState(null, "", u.href);
    return { fresh: true };
  }
  const saved = readJson(key);
  if (!saved.segment || !(Date.now() - (saved.savedAt ?? 0) < STALE_S * 1000)) return null;
  const nav = performance.getEntriesByType?.("navigation")?.[0]?.type;
  const same = (q.get("segment") ?? null) === (saved.url?.segment ?? null) && (q.get("from") ?? null) === (saved.url?.from ?? null);
  if (!(nav === "reload" || nav === "back_forward" || same)) return null;
  if (["debate", "outro"].includes(saved.segment) && (saved.runKey == null || (await runKeyNow(replayUrl)) !== saved.runKey)) return null;
  return saved;
}

/**
 * The operator on a live show.html (ui/program.js startShow, after the plan is scheduled). `show` gives
 * the page's state as getters: phase ("program" | "await" | "entering" | "debate" | "outro"), debate
 * (ui/live.js mountDebate's result, once mounted), debateAt.
 */
export function createOperator({ q, storeKey, segs, scheduled, startId, T0, cam, frames, voice, show, resumed = null }) {
  const key = opKey(storeKey);
  const load = () => readJson(key);
  const save = (patch) => {
    try {
      localStorage.setItem(key, JSON.stringify({ ...load(), ...patch }));
    } catch {}
  };
  const urlOrigin = { segment: q.get("segment"), from: q.get("from") };
  const pre = scheduled; // the segments on this page: from the one it started in to the launch
  holdCuts({ scheduled, cam, frames });

  // ---- where the show is
  const inProgram = () => pre.length > 0 && (show.phase === "program" || show.phase === "await");
  const segAt = (t) => pre.filter((s) => s.from <= t + 1e-6).at(-1) ?? pre[0];
  const holding = (t = now()) => {
    if (show.phase !== "program") return null;
    const s = segAt(t);
    return s?.hold && t >= s.hold.from && t < s.hold.to ? s : null;
  };
  const beatStarts = () => [...new Set((show.debate?.played.beats ?? []).map((b) => b.at))].sort((a, b) => a - b);

  // ---- actions
  let lastJump = null; // { from, to }: show times of the latest jump (checks)
  function jump(t) {
    lastJump = { from: now(), to: t };
    showClock.jump(t);
    voice.resync();
    update();
  }
  async function pause() {
    if (showClock.paused) return;
    showClock.pause();
    for (const m of document.querySelectorAll("video, audio")) if (!m.paused) m.pause();
    save({ paused: true });
    update();
    await voice.pause();
  }
  async function resume() {
    if (!showClock.paused) return;
    await voice.resume();
    showClock.resume();
    voice.resync(); // the audio clock stopped and started a little later than the show clock: back in step
    save({ paused: false });
    update();
  }
  const toggle = () => (showClock.paused ? resume() : holding() ? next() : pause());

  // a segment that is not scheduled on this page (it started later): a reload into it
  function reloadInto(id) {
    try {
      localStorage.setItem(storeKey, id);
    } catch {}
    stopSaving = true;
    save({ segment: id, into: 0, n: null, nInto: 0, paused: showClock.paused, url: { segment: null, from: null }, savedAt: Date.now() });
    const u = new URL(location.href);
    u.searchParams.delete("segment");
    u.searchParams.delete("from");
    location.replace(u.href);
  }

  function next() {
    const t = now();
    if (inProgram()) {
      const i = pre.indexOf(segAt(t));
      const to = pre[i + 1];
      if (to) jump(to.from);
      return;
    }
    const d = show.debate;
    if (!d) return;
    // after a ←: the next beat already played; else the beat playing now cut short
    const ahead = beatStarts().find((a) => a > t + 0.05);
    if (ahead != null) return jump(ahead);
    const qd = d.director.queue;
    if (qd.current && Number.isFinite(qd.current.end) && qd.current.end > t) return jump(qd.current.end);
    const head = qd.pending[0];
    if (head) {
      const at = Math.max(qd.lastEnd, head.availableAt);
      if (at > t) jump(at);
    }
  }

  function prev() {
    const t = now();
    if (inProgram()) {
      const s = segAt(t);
      if (t - s.from > BACK_S) return jump(s.from);
      const i = segs.indexOf(s);
      const before = segs[i - 1];
      if (!before) return jump(s.from);
      if (pre.includes(before)) return jump(before.from);
      return reloadInto(before.id);
    }
    if (!show.debate) return;
    const starts = beatStarts().filter((a) => a <= t + 1e-6);
    const cur = starts.at(-1);
    if (cur == null) return;
    const to = t - cur > BEAT_BACK_S || starts.length < 2 ? cur : starts.at(-2);
    jump(Math.max(to, show.debateAt ?? -Infinity));
  }

  // start over (Shift+R twice within RESTART_S): ?restart=1 forgets the position (resumePlan)
  let restartArmed = 0;
  function restart() {
    if (Date.now() > restartArmed) return void ((restartArmed = Date.now() + RESTART_S * 1000), update());
    stopSaving = true;
    const u = new URL(location.href);
    u.searchParams.delete("segment");
    u.searchParams.delete("from");
    u.searchParams.set("restart", "1");
    location.replace(u.href);
  }

  // ---- the keys
  // OBS's «Interact» window on macOS delivers one press as two keydowns (rehearsal 2026-10-31: one → skipped
  // two Finalists), so the same key again within KEY_TWIN_MS is that echo, not a second press.
  const KEY_TWIN_MS = 150;
  let lastKey = { k: "", t: -Infinity };
  window.addEventListener("keydown", (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const k = `${e.shiftKey ? "S-" : ""}${e.code || e.key}`, t = performance.now();
    if (k === lastKey.k && t - lastKey.t < KEY_TWIN_MS) return void e.preventDefault();
    lastKey = { k, t };
    if (e.shiftKey && (e.key === "R" || e.key === "r" || e.code === "KeyR")) return void (e.preventDefault(), e.repeat || restart());
    const act = { " ": toggle, Spacebar: toggle, ArrowRight: next, ArrowLeft: prev }[e.key];
    if (!act) return;
    e.preventDefault();
    if (e.repeat) return;
    act();
  });

  // ---- the indicator
  const air = q.get("air") === "1";
  let el = null;
  if (!air) {
    el = document.createElement("div");
    el.id = "operator";
    Object.assign(el.style, {
      position: "fixed", left: "16px", bottom: "16px", zIndex: 30, pointerEvents: "none",
      font: '500 18px/1.35 "IBM Plex Mono", ui-monospace, monospace', color: "#f4f1ec",
      background: "rgba(10, 10, 12, 0.78)", border: "1px solid #3a3f47", borderRadius: "8px", padding: "8px 12px",
    });
    document.body.append(el);
  }
  const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
  function state() {
    const t = now(), h = holding(t);
    const seg = inProgram() ? segAt(t)?.id : show.phase;
    return { paused: showClock.paused, holding: h?.id ?? null, segment: seg, phase: show.phase, t };
  }
  function update() {
    const s = state();
    if (!el) return;
    const mode = s.paused ? ["❚❚ ПАУЗА", "#e0b354"] : s.holding ? ["◼ ДЕРЖИМ (→ дальше)", "#7fc4e8"] : ["▶ ИДЁТ", "#8fd48f"];
    const seg = inProgram() ? segAt(s.t) : null;
    const into = seg ? ` ${mmss(Math.max(0, s.t - seg.from))}` : "";
    const keys = Date.now() < restartArmed ? "Shift+R ещё раз — эфир с начала" : `${inProgram() ? "Пробел пауза · ← → сегмент" : "Пробел пауза · ← → реплика"} · ⌘R продолжит отсюда · Shift+R ×2 с начала`;
    el.innerHTML = "";
    const head = document.createElement("div");
    head.style.color = mode[1];
    head.textContent = `${mode[0]} · ${s.segment ?? ""}${into}`;
    const foot = document.createElement("div");
    foot.style.cssText = "color:#9aa1aa;font-size:14px";
    foot.textContent = keys;
    el.append(head, foot);
  }
  setInterval(update, 250);

  // ---- the position, for a reload or a crash (resumePlan)
  let stopSaving = false, pendingBeat = null, pendingPause = false;
  function position() {
    const t = now(), base = { paused: showClock.paused, url: urlOrigin, savedAt: Date.now() };
    if (inProgram()) {
      const s = segAt(t);
      return { ...base, segment: s.id, into: Math.max(0, t - s.from), n: null, nInto: 0, runKey: null };
    }
    const d = show.debate;
    if (!d || pendingBeat || !(show.phase === "debate" || show.phase === "outro")) return null; // entering, or the resume's line not reached yet
    const cur = d.director.queue.current;
    return { ...base, segment: show.phase, into: 0, n: cur?.beat.n ?? d.director.cursor, nInto: cur ? Math.max(0, t - cur.start) : 0, runKey: d.director.runKey ?? null };
  }
  const savePosition = () => {
    const p = !stopSaving && position();
    if (p) save(p);
  };
  // the debate's line: once it plays again (the director resumes from its cursor, that line from its
  // start), the clock jumps as far into it as it was
  function resumeBeat() {
    if (!pendingBeat) return;
    const b = show.debate?.played.beats.find((x) => x.n === pendingBeat.n);
    const late = now() > pendingBeat.giveUpAt;
    if (!b && !late) return;
    if (b && pendingBeat.nInto > 0.3) jump(b.at + pendingBeat.nInto);
    pendingBeat = null;
    if (pendingPause) pause();
  }
  setInterval(() => (resumeBeat(), savePosition()), SAVE_MS);
  addEventListener("pagehide", savePosition);

  // ---- a reload: back where it was (segment, time in it, the debate's line), paused if it was
  if (resumed?.segment && resumed.segment === startId) {
    const s = pre.find((x) => x.id === startId);
    if (s) jump(s.from + (resumed.into ?? 0));
    else if (resumed.n != null) pendingBeat = { n: resumed.n, nInto: resumed.nInto ?? 0, giveUpAt: now() + 120 };
  }
  if (resumed?.paused) {
    if (pendingBeat) pendingPause = true;
    else {
      if (inProgram() && !(resumed.segment === startId)) jump(Math.max(now(), T0));
      pause();
    }
  }
  update();

  if (window.__stage) Object.defineProperty(window.__stage, "time", { get: now, configurable: true });
  const api = { get state() { return state(); }, get lastJump() { return lastJump; }, get resumed() { return resumed; }, get pendingBeat() { return pendingBeat; }, now, toggle, next, prev, jump, pause, resume };
  window.__operator = api;
  return api;
}
