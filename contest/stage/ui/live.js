// The live show's wiring (live.html): source → Director → sink (ui/show.js: the scene; ui/planner.js:
// the camera; ui/cards.js: the cards) with the voice (lib/voice.js) on the Stage's clock (lib/clock.js).
// show.html (ui/program.js) builds the same Stage with createLiveStage and mounts the same debate with
// mountDebate when the engine's run appears, its camera handed over at that time (startAt).
//
//   source   LiveSource through server.py's /run/ (default), or ReplaySource(?replay=<url>)
//   voice    the TTS service (?tts=<url>, default http://127.0.0.1:8790); ?voice=estimate: no service,
//            every line estimated (145 words/min, silent)
//   clock    live: the page clock, the director ticked every 100 ms, the camera committed per frame.
//            ?t= (virtual, stills and clips): every voice is prepared first, then the whole recording is
//            played through the director on a fixed 0.1 s grid before the first frame, so any frame is a
//            pure function of t and two loads give the same picture. window.__frame.duration = the show's
//            length (tools/clip.mjs reads it).
//   resume   ?from=<n>; live also remembers the cursor per run (localStorage)
//   reveal   sealed envelopes, opened 3 → 2 → 1 after the last place (owner 2026-10-28); ?reveal=each:
//            every place revealed as soon as it is decided (the show of 2026-10-21)
//   codes    with envelopes the Judges' lines name the Finalists by codes drawn from the run's key until
//            the first envelope opens (ui/codes.js, ADR-0010); the Host maps them at the envelopes; the
//            Judges' monitors are veiled until then (ui/veil.js: coded paths, blurred pictures and text)
//   sound    live with the TTS service: a click unlocks the audio if the browser holds it back (an
//            OBS browser source or Chrome --autoplay-policy=no-user-gesture-required never asks)
//   checks   window.__live = { director, planner, played, report(), check() }; ?check=1 also puts
//            played and check() on window.__stage once the show is over
//
// The director's beats play in order, each as long as its voice; here the beats whose picture takes
// longer than the voice (the turn before a message, the vote's reveal, the cards) are awaited like
// voteCast: their sink call returns {end} (patchAwaits below; the beats and their numbers are the
// director's own).
import { now, frozenAt, gfx, runLoop } from "/lib/clock.js";
import { createVoice, DEFAULT_BASE } from "/lib/voice.js";
import { createStage } from "/world/stage.js";
import { createSubtitles, createCaptions } from "/ui/subtitles.js";
import { installCodes } from "/ui/codes.js";
import { createVeil } from "/ui/veil.js";
import { createShow } from "/ui/show.js";
import { createPlanner } from "/ui/planner.js";
import { createCards } from "/ui/cards.js";
import { ROSTER } from "/robots/roster.js";
import { fitFrame } from "/ui/safe.js";
import { Director, drive, LiveSource, ReplaySource, EstimateVoice, cursorFromLocation, localStorageStore } from "/director/index.js";

const STEP_S = 0.1; // the virtual clock's grid
const GAP_S = 0.3; // after a spoken beat (the director's gapS)
const TAIL_S = 4; // a clip runs this long past the final beat's end
const AWAITS = new Set(["say", "voteReveal", "tally", "envelope", "lastWord", "verdict", "podium", "final"]);
const BEATS = new Set([...AWAITS, "status", "host", "unavailable", "voteCast"]);
const LATE_S = 0.25; // live: a beat stamped this far behind the clock is moved to now (see lateBeats)

/** The beats whose picture outlasts their voice are awaited: their sink call returns {end}. */
function patchAwaits(director, { live = false } = {}) {
  const awaited = live ? BEATS : AWAITS; // live: any beat may be moved to now (lateBeats), so all report their end
  const plan = director.planner.plan.bind(director.planner);
  director.planner.plan = (ev) => {
    const beats = plan(ev);
    for (const b of beats) for (const c of b.calls) if (awaited.has(c.method)) c.awaits = true;
    return beats;
  };
}

/**
 * Live only: a beat whose voice was not ready when its turn came starts when the voice is ready, not
 * in the past. (director/queue.js advance() sets readyAt only when the voice resolves inside a tick's
 * race; a voice that resolves between ticks leaves readyAt at 0, so the beat is stamped at its due time,
 * seconds back: its audio and subtitles would be over before they start.) Every call of such a beat
 * gets the beat's meta with at = now, and reports the shifted end; a beat on time is passed through
 * untouched.
 */
function lateBeats(sink, clockNow) {
  const shifted = new WeakMap(); // the director's meta (one per beat) -> the meta the sink sees
  const metaOf = (meta) => {
    if (!shifted.has(meta)) {
      const t = clockNow();
      shifted.set(meta, meta.at < t - LATE_S ? { ...meta, at: t, lateS: t - meta.at } : meta);
    }
    return shifted.get(meta);
  };
  for (const name of BEATS) {
    const fn = sink[name];
    sink[name] = (...args) => {
      const m = metaOf(args.at(-1));
      args[args.length - 1] = m;
      const res = fn(...args);
      if (!m.lateS) return res;
      const own = Number.isFinite(res?.end) ? res.end : -Infinity;
      return { end: Math.max(own, m.at + (m.durationS ?? 0) + (m.durationS ? GAP_S : 0)) };
    };
  }
  return sink;
}

// The Planner's options: sealed envelopes, opened 3 → 2 → 1 after the last place (owner 2026-10-28);
// ?reveal=each = every place revealed as soon as it is decided (the show of 2026-10-21), a fallback.
export const planOptions = (q = new URLSearchParams(globalThis.location?.search ?? "")) => ({ envelopes: q.get("reveal") !== "each" });

/** Every line the show will speak, from a dry run of the recording (the voices are prepared from it). */
async function linesOf(replayUrl, from) {
  const lines = [];
  const est = new EstimateVoice();
  const dry = new Director({
    source: await ReplaySource.fromUrl(replayUrl), sink: {}, from, plan: planOptions(),
    voice: { prepare: (speaker, text) => (lines.push([speaker, text]), est.prepare(speaker, text)) },
  });
  installCodes(dry, { enabled: planOptions().envelopes }); // the voices of the coded lines
  await drive(dry, { stepS: 5 });
  return lines;
}

/** The sink the director drives: the scene (show), the camera (planner), and the record of what played. */
function composeSink({ show, planner, played, voice, veil = null }) {
  const beat = (meta, method) => {
    played.calls.push({ n: meta.n ?? null, method, at: meta.at });
    if (meta.n == null || meta.n === played.lastN) return;
    played.lastN = meta.n;
    played.beats.push({ n: meta.n, type: meta.type, at: Math.round(meta.at * 1000) / 1000 });
  };
  const cardsBeat = (res, meta, method, opts) => {
    beat(meta, method);
    planner.cards(res, meta, opts);
    return { end: res?.end ?? meta.at };
  };
  return {
    setup: (info, meta) => show.setup(info, meta),
    restore(view, meta) {
      played.restored = view.cursor;
      // monitor-codes: a resume past the first envelope's opening shows the monitors as they are
      const s = view?.status;
      if (s?.phase === "reveal" || s?.phase === "done" || (view?.podium ?? []).some((p) => p?.team)) veil?.open(meta.at);
      const res = show.restore(view, meta);
      planner.cards(res, meta, { last: view?.status?.phase === "done" });
    },
    judge(id, p, meta) {
      show.judge(id, p, meta);
      planner.live(show.idOf(id), p, meta.at);
    },
    status(s, meta) {
      beat(meta, "status");
      const res = show.status(s, meta);
      planner.status(s, meta);
      planner.cards(res, meta);
    },
    say(speaker, text, v, meta) {
      beat(meta, "say");
      const r = show.say(speaker, text, v, meta);
      played.says.push({ n: meta.n, speaker, text, t0: r.t0, end: r.end, prepared: v, engine: v?.engine ?? null });
      planner.say(r, meta);
      return { end: r.end + GAP_S };
    },
    host(text, v, meta) {
      beat(meta, "host");
      const r = show.host(text, v, meta);
      played.hosts.push({ n: meta.n, type: meta.type, text, t0: r.t0, end: r.end, engine: v?.engine ?? null });
      planner.host(r, meta);
    },
    unavailable(judge, info, meta) {
      beat(meta, "unavailable");
      planner.unavailable(show.unavailable(judge, info, meta));
    },
    voteCast(judge, c, meta) {
      beat(meta, "voteCast");
      const r = show.voteCast(judge, c, meta);
      played.casts.push({ n: meta.n, judge, order: c.order, unavailable: !!c.unavailable, at: meta.at, place: c.place, round: c.round });
      return { end: planner.cast(r) };
    },
    tally(tl, meta) {
      if (tl.stage === "begin") {
        beat(meta, "tally");
        show.tally(tl, meta);
        planner.tally(tl, meta);
        return { end: meta.at };
      }
      return cardsBeat(show.tally(tl, meta), meta, "tally");
    },
    voteReveal(v, vt, meta) {
      beat(meta, "voteReveal");
      const r = show.voteReveal(v, vt, meta);
      played.reveals.push({ n: meta.n, judge: v.judge, team: v.team ?? null, reason: v.reason ?? null, at: r.t, place: v.place, round: v.round });
      return { end: planner.reveal(r, v) };
    },
    envelope(e, v, meta) {
      if (e.stage === "open") veil?.open(meta.at); // monitor-codes: the monitors unveil with the first envelope
      const res = cardsBeat(show.envelope(e, v, meta), meta, "envelope");
      played.envelopes.push({ n: meta.n, stage: e.stage, place: e.place, text: e.text, at: meta.at });
      return res;
    },
    lastWord: (card, v, meta) => cardsBeat(show.lastWord(card, v, meta), meta, "lastWord"),
    verdict: (card, v, meta) => cardsBeat(show.verdict(card, v, meta), meta, "verdict"),
    podium: (p, meta) => cardsBeat(show.podium(p, meta), meta, "podium"),
    final(f, v, meta) {
      const res = cardsBeat(show.final(f, v, meta), meta, "final", { last: true });
      played.finalEnd = Math.max(res.end, meta.at + (meta.durationS ?? 0));
      return res;
    },
    voice,
  };
}

/**
 * The debate on a Stage that already stands (live.html: the whole page; show.html: from the moment the
 * engine's run appears, ui/program.js). Creates the camera planner (it takes the camera over at
 * `startAt`), the sink and the director; returns:
 *   director, planner, played, check()
 *   runVirtual()   virtual time: every voice prepared, the whole source played on the 0.1 s grid from
 *                  startAt; resolves to { finalEnd, t } (the final screen's end, the last grid time)
 *   start()        live: tick the director every 100 ms
 *   frame(t)       live: before every frame (the bodies after a presentation, the camera's cuts)
 * `source` plays on the show clock (lib/clock.js now()); `store` keeps the director's cursor.
 */
export async function mountDebate({ stage, caps, show, voice, source, virtual, replayUrl = null, from = null, store = null, startAt = null, warn = () => {} }) {
  const planner = createPlanner({ stage, caps, quiet: (t) => show.quiet(t), tubes: () => !!show.round, startAt });
  const played = { beats: [], calls: [], says: [], hosts: [], casts: [], reveals: [], envelopes: [], lastN: null, restored: null, finalEnd: null };
  // monitor-codes: the consoles veiled from the debate's start until the first envelope (ui/veil.js)
  const veil = createVeil({ from: startAt });
  for (const d of Object.values(stage.desks ?? {})) d.setVeil?.(veil);
  const sink = virtual ? composeSink({ show, planner, played, voice, veil }) : lateBeats(composeSink({ show, planner, played, voice, veil }), now);
  if (virtual && replayUrl) {
    // every voice first, so no beat waits for one and the plan does not depend on the network
    const lines = await linesOf(replayUrl, from);
    await Promise.all(lines.map(([speaker, text]) => voice.prepare(speaker, text)));
  }
  const director = new Director({ source, sink, voice, clock: now, from, store, onWarn: warn, plan: planOptions() });
  const codes = installCodes(director, { enabled: planOptions().envelopes });
  veil.codes = codes;
  patchAwaits(director, { live: !virtual });

  const finalState = () => (source.stateAt ? source.stateAt(Infinity) : source.state);
  const check = () => {
    const state = finalState() ?? {};
    const messages = (state.transcript ?? []).filter((e) => e.kind === "message" && e.text != null);
    const ns = played.beats.map((b) => b.n);
    const skip = played.restored ?? 0;
    const says = played.says.filter((s) => s.n >= skip);
    const msgs = skip ? messages.slice(messages.length - says.length) : messages;
    return {
      finished: director.finished,
      beatsPlanned: director.planner.n,
      beatsPlayed: ns.length,
      firstBeat: ns[0] ?? null,
      inOrder: ns.every((n, i) => n === (ns[0] ?? 0) + i),
      once: new Set(ns).size === ns.length,
      allPlayed: ns.length === director.planner.n - skip && (ns[0] ?? skip) === skip,
      says: says.length,
      messagesWithText: msgs.length,
      // verbatim but for the codes (ui/codes.js): the line as the Judge wrote it, before its coding
      verbatim: says.length === msgs.length && says.every((s, i) => (codes.original.get(s.n) ?? s.text) === msgs[i].text && show.idOf(s.speaker) === show.idOf(msgs[i].judge)),
      coded: says.filter((s) => codes.original.has(s.n)).length,
      typedWhole: says.every((s) => !s.prepared || voice.typedAt(s.prepared, s.end + 0.01, s.t0) === s.text.length),
      voteReveals: played.reveals.length,
      votes: (state.votes ?? []).length,
      casts: played.casts.length,
      hosts: played.hosts.length,
      engines: [...new Set([...played.says, ...played.hosts].map((s) => s.engine))],
    };
  };

  async function runVirtual() {
    // the whole recording through the director on a fixed grid, the camera committed on the same grid
    const t0 = startAt ?? 0;
    const end = source.endT ?? 0;
    let t = t0;
    for (let i = 0; ; i++) {
      t = Math.round((t0 + i * STEP_S) * 1000) / 1000;
      await director.tick(t);
      show.flush(t);
      planner.commit(t);
      if (director.finished && played.finalEnd != null && t >= played.finalEnd) break;
      if (t > end + 6 * 3600) {
        warn("the show did not reach its final screen");
        break;
      }
    }
    return { finalEnd: played.finalEnd, t };
  }

  return {
    director, planner, played, codes, veil, check, runVirtual,
    start: () => director.start(100),
    frame(t) {
      show.flush(t);
      planner.commit(t);
    },
  };
}

/**
 * The Judges' CLI versions on their tags before the engine reports its own (show.js setup overwrites
 * them from state.json judges[].cli): server.py /cli/versions.json, `--version` on this machine as the
 * engine words it (other servers give the repo's cli/versions.json, `{}`); without it the CLI's name
 * alone, never robots/roster.js's sample versions.
 */
async function cliVersions() {
  let v = null;
  try {
    const r = await fetch("/cli/versions.json", { cache: "no-store" });
    if (r.ok) v = await r.json();
  } catch {}
  for (const r of Object.values(ROSTER)) {
    if (r.role !== "judge") continue;
    const s = v?.[r.vendor === "openai" ? "codex" : "claude"];
    Object.assign(r, s ? { cli: s, version: "" } : { version: "" });
  }
}

/** The Stage's fonts, the scene and its 2D layer, the voice and the show layer (live.html, show.html). */
export async function createLiveStage({ canvas, overlay, q = new URLSearchParams(location.search) }) {
  const virtual = frozenAt !== null;
  const estimate = q.get("voice") === "estimate";
  fitFrame(); // the 1920×1080 frame, letterboxed to the window; ?cams=1 (ui/safe.js)
  await Promise.all(['500 46px "Inter"', '600 42px "Inter"', '650 112px "Inter"', '700 104px "Inter"', '400 24px "IBM Plex Mono"', '400 44px "IBM Plex Mono"', '500 46px "IBM Plex Mono"', '600 84px "Inter"']
    .map((f) => document.fonts.load(f)));
  const [stage] = await Promise.all([createStage({ canvas, gfx }), cliVersions()]);
  const subs = createSubtitles(overlay, { stage }), caps = createCaptions(overlay, stage);
  const voice = createVoice({
    base: q.get("tts") || DEFAULT_BASE,
    clock: { now, frozenAt },
    virtual,
    ...(estimate ? { fetch: () => Promise.reject(new Error("?voice=estimate")) } : {}),
  });
  const show = createShow({ stage, subs, caps, voice, live: true, createCards });
  return { stage, subs, caps, voice, show, virtual, estimate };
}

/** Live with the TTS service: a click unlocks the audio when the browser holds it back. */
export async function unlockSound(voice) {
  const needsClick = (() => {
    try {
      const c = new AudioContext();
      const s = c.state;
      c.close();
      return s !== "running";
    } catch {
      return false;
    }
  })();
  if (!needsClick) return;
  const el = document.createElement("div");
  el.className = "unlock";
  el.innerHTML = "<div>Нажмите, чтобы включить звук<small>эфир начнётся сразу</small></div>";
  document.body.appendChild(el);
  await new Promise((r) => el.addEventListener("click", r, { once: true }));
  await voice.unlock();
  el.remove();
}

/** The engine's ISO times on the page clock (a live source). */
export function liveSource(warn) {
  const source = new LiveSource("", { clock: now, onError: (e) => warn(`live source: ${e?.message ?? e}`) });
  // operator-controls: the epoch read at every call, so after a pause or a jump of the show clock
  // (ui/operator.js) an engine time maps to the show clock as it runs now
  source.clockOf = (iso) => Date.parse(iso) / 1000 - (Date.now() / 1000 - now());
  return source;
}

export async function startLive({ canvas, overlay }) {
  const q = new URLSearchParams(location.search);
  const replayUrl = q.get("replay");
  const from = cursorFromLocation();
  const warn = (m) => console.warn(`[stage] ${m}`);
  const { stage, subs, caps, voice, show, virtual, estimate } = await createLiveStage({ canvas, overlay, q });

  const source = replayUrl ? await ReplaySource.fromUrl(replayUrl) : liveSource(warn);
  const debate = await mountDebate({
    stage, caps, show, voice, source, virtual, replayUrl, from,
    store: !replayUrl && !virtual ? localStorageStore() : null,
    warn,
  });
  const { director, planner, played, codes, veil, check } = debate;

  let duration = null;
  if (virtual) {
    const { finalEnd, t } = await debate.runVirtual();
    duration = Math.ceil((finalEnd ?? t) + TAIL_S);
    show.flush(duration + 1);
    planner.commit(duration + 1);
  } else {
    if (!estimate) await unlockSound(voice);
    debate.start();
  }

  await stage.ready();
  const report = () => planner.report(virtual ? duration : now());
  window.__live = { director, planner, show, voice, played, codes, veil, report, check, get finished() { return director.finished; } };
  window.__frame = { duration, report, stage };
  const hook = runLoop({
    renderer: stage.renderer,
    renderAt(t) {
      if (!virtual) debate.frame(t);
      stage.renderAt(t);
      subs.update(t);
      caps.update(t);
    },
  });
  if (q.has("check")) {
    hook.played = played;
    Object.defineProperty(hook, "check", { get: check, enumerable: true });
  }
  return window.__live;
}
