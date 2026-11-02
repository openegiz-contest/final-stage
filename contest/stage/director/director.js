// The director: engine data in, one ordered show out, through the sink.
//
//   Source ──► StateDiffer ──► live layer ─────────────────────────────► sink.judge(...)   always real now
//     │            └─► Planner ──► beats ──► PresentationQueue (+ voice) ─► sink.say / host / voteReveal / ...
//     └─ log lines ──► activity adapter ──► live layer
//
// Two layers (spec §7.7): the live layer shows each Judge's status, timer and activity the moment the data
// says so and is never queued; the presentation queue plays messages, bridges, vote reveals, verdicts and
// the podium in order, none skipped, each as long as its voice. While a robot speaks, the next Judge
// already works on its console.
//
// The director is driven by tick(now): `now` is seconds on the clock the source uses. Live: a timer calls
// tick() with the wall clock; a replay or a test calls tick(t) with any t, in steps of any size, and gets
// the same sequence of sink calls.

import { activityFromLine, resultsFromLine, turnEndFromLine } from "./activity.js";
import { contentOf } from "./content.js";
import { StateDiffer, parseTid, makeTid } from "./events.js";
import { Planner } from "./plan.js";
import { PresentationQueue } from "./queue.js";
import { EstimateVoice } from "./voice.js";

const PRESENTATION = new Set(["round", "message", "unavailable", "votes", "placement", "done"]);

export class Director {
  constructor({
    source, sink, voice = new EstimateVoice(), clock = () => Date.now() / 1000,
    from = null,            // explicit cursor (?from=<n>)
    store = null,           // { get(key), set(key, n) } for the cursor, e.g. localStorageStore()
    runKey = null,          // identifies the run in the store; default source.runKey() or state.started_at
    plan = {},              // Planner options (verdictS, podiumS, ...)
    gapS = 0.3,             // pause after a spoken beat
    holdMaxS = 60,          // the longest a beat waits for the sink's promise (the walk to the urn)
    activityMax = 12,       // activity items kept per Judge
    pubRoot = null,         // absolute path(s) of the publication where the Judges ran: an image read under it gets a /pub/ URL
    onEvent = () => {},     // every domain event and activity item, for logs and the CLI
    onWarn = () => {},
  }) {
    Object.assign(this, { source, sink, clock, store, activityMax, pubRoot, onEvent, onWarn });
    this.explicitFrom = from;
    this.runKey = runKey;
    this.differ = new StateDiffer();
    this.planner = new Planner(plan);
    this.queue = new PresentationQueue({ voice, sink, gapS, holdMaxS, onWarn, onEnd: (beat, at) => this._beatEnded(beat, at) });
    this.cursor = 0;        // beats finished (also: the index of the next beat to play)
    this.skipUntil = 0;     // beats below this number are already shown: planned, not played
    this.restored = false;
    this.restoreView = null;
    this.live = new Map();  // judge -> live-layer record
    this.promptSeen = new Map();
    this.voteEnds = new Map(); // "place-round-judge" -> { t, seq }: when the Judge's vote turn was seen to end
    this._seq = 0;             // items handled, in source order: breaks a tie in time
    this.finished = false;
    this._inited = false;
    this._busy = false;
    this._timer = null;
  }

  now() {
    return this.clock();
  }

  async _init() {
    this._inited = true;
    this.runKey ??= (await this.source.runKey?.()) ?? null;
    this._resolveCursor();
  }

  // the cursor: ?from= first, then the stored one; needs the run key (the source's, else state.started_at)
  _resolveCursor() {
    if (this._cursorResolved || (this.runKey == null && this.explicitFrom == null)) return;
    this._cursorResolved = true;
    const stored = this.store && this.runKey != null ? this.store.get(this._key()) : null;
    this.skipUntil = this.explicitFrom ?? stored ?? 0;
    this.cursor = this.skipUntil;
  }

  _key() {
    return `stage.cursor.${this.runKey}`;
  }

  async tick(now = this.clock()) {
    if (this._busy) return;
    this._busy = true;
    try {
      if (!this._inited) await this._init();
      const items = await this.source.read(now);
      for (const it of items) {
        await this.queue.advance(it.t);
        this._item(it);
      }
      await this.queue.advance(now);
    } finally {
      this._busy = false;
    }
  }

  // Drive with a timer (the browser, a live run): tick every `everyMs`.
  start(everyMs = 100) {
    this.stop();
    this._timer = setInterval(() => this.tick().catch((e) => this.onWarn(`tick failed: ${e?.message ?? e}`)), everyMs);
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }

  // ---- items from the source ----

  _item(it) {
    this._seq++;
    if (it.state) this._state(it.state, it.t);
    else if (it.prompt) this._prompt(it);
    else if (it.line !== undefined) this._log(it);
  }

  _state(state, t) {
    this.runKey ??= state.started_at ?? null;
    this._resolveCursor();
    const dirty = new Set();
    for (const ev of this.differ.diff(state)) {
      if (ev.type === "votes") ev.casts = this._casts(ev);
      this.onEvent(ev, t);
      switch (ev.type) {
        case "setup":
          this.planner.plan(ev);
          this.sink.setup?.({ judges: ev.judges.map((j) => ({ id: j.name, agent: j.agent, model: j.model, cli: j.cli ?? null })),
            finalists: ev.finalists, settings: ev.settings, rounds: this.planner.maxRounds, places: this.planner.placesCount }, { at: t });
          for (const j of ev.judges) this.live.set(j.name, { agent: j.agent, model: j.model, cli: j.cli ?? null, status: j.status, since: null,
            sinceIso: null, sinceSource: null, turn: null, activity: [], ids: new Set(), orphans: new Map() });
          for (const j of ev.judges) dirty.add(j.name);
          break;
        case "judge": this._liveStatus(ev, dirty); break;
        case "turn.start": this._turnStart(ev, t, dirty); break;
        case "turn.end": this._turnEnd(ev, t, dirty); break;
        default:
          if (PRESENTATION.has(ev.type)) this._plan(ev, t);
      }
    }
    for (const name of dirty) this._emitJudge(name, t);
  }

  _plan(ev, t) {
    for (const beat of this.planner.plan(ev)) {
      if (beat.n < this.skipUntil) {
        this.restoreView = beat.view;
        if (beat.type === "final") this.finished = true; // reloaded after the end: nothing left to play
      } else this.queue.push(beat, t);
    }
    if (!this.restored && this.skipUntil > 0 && this.planner.n >= this.skipUntil) {
      this.restored = true;
      this.sink.restore?.({ cursor: this.skipUntil, ...this.restoreView }, { at: t });
    }
  }

  _beatEnded(beat, at) {
    this.cursor = beat.n + 1;
    if (this.store && this.runKey) this.store.set(this._key(), this.cursor);
    if (beat.type === "final") this.finished = true;
  }

  // ---- the live layer ----

  _liveStatus(ev, dirty) {
    const l = this.live.get(ev.judge);
    if (!l) return;
    l.status = ev.status;
    if (ev.since) l.sinceIso = ev.since;
    if (!(ev.status === "пишет" || ev.status === "голосует")) l.since = null;
    dirty.add(ev.judge);
  }

  _turnStart(ev, t, dirty) {
    const l = this.live.get(ev.judge);
    if (!l) return;
    // the highest attempt whose prompt.txt was seen wins over the status-count
    let attempt = ev.attempt;
    while (this.promptSeen.has(makeTid({ ...ev, attempt: attempt + 1 }))) attempt++;
    const tid = makeTid({ ...ev, attempt });
    // `confirmed`: the source has shown this very turn (prompt.txt or a log line); until then the attempt is
    // the status-count's guess and evidence for another attempt of the same turn corrects it
    l.turn = { tid, kind: ev.kind, place: ev.place, round: ev.round, attempt, running: true };
    l.confirmed = this.promptSeen.has(tid);
    l.activity = [];
    l.ids = new Set();
    l.orphans = new Map();
    if (ev.kind === "vote") this.voteEnds.delete(voteKey(ev)); // asked again: not finished
    this._setSince(l, ev.since, tid, t);
    dirty.add(ev.judge);
  }

  _turnEnd(ev, t, dirty) {
    const l = this.live.get(ev.judge);
    if (!l?.turn) return;
    if (ev.kind === "vote") this._voteEnded(ev, t);
    l.turn = { ...l.turn, running: false, outcome: ev.outcome };
    l.since = null;
    dirty.add(ev.judge);
  }

  // since: the state's own (pending field), else when prompt.txt appeared, else when the turn was first seen
  _setSince(l, iso, tid, t) {
    if (iso) {
      l.sinceIso = iso;
      l.since = this.source.clockOf ? this.source.clockOf(iso) : Date.parse(iso) / 1000;
      l.sinceSource = "state";
    } else if (this.promptSeen.has(tid)) {
      l.since = this.promptSeen.get(tid);
      l.sinceIso = null;
      l.sinceSource = "prompt";
    } else {
      l.since = t;
      l.sinceIso = null;
      l.sinceSource = "seen";
    }
  }

  // a log line or a prompt.txt of a turn the live layer follows; a higher attempt of the same turn
  // (the retry -a2) takes over
  _follow(tid, t) {
    const p = parseTid(tid);
    const l = p && this.live.get(p.judge);
    if (!l?.turn) return null;
    if (l.turn.tid === tid) {
      l.confirmed = true;
      return l;
    }
    const cur = parseTid(l.turn.tid);
    if (cur && cur.place === p.place && cur.round === p.round && cur.kind === p.kind && (p.attempt > cur.attempt || !l.confirmed)) {
      l.confirmed = true;
      l.turn = { ...l.turn, tid, attempt: p.attempt, running: true, outcome: undefined };
      l.activity = [];
      l.ids = new Set();
      l.orphans = new Map();
      if (p.kind === "vote") this.voteEnds.delete(voteKey(p)); // the retry has begun: the first ask did not end the vote
      l.status = l.status === "недоступен" ? (p.kind === "vote" ? "голосует" : "пишет") : l.status;
      this._setSince(l, null, tid, t);
      return l;
    }
    return null;
  }

  _prompt(it) {
    this.promptSeen.set(it.tid, it.t);
    const l = this._follow(it.tid, it.t);
    if (l && l.sinceSource === "seen") {
      l.since = it.t;
      l.sinceSource = "prompt";
    }
    if (l) this._emitJudge(parseTid(it.tid).judge, it.t);
  }

  _log(it) {
    const l = this._follow(it.tid, it.t);
    if (!l) return;
    const p = parseTid(it.tid);
    const judge = p.judge;
    let changed = false;
    const fresh = [];
    for (const a of activityFromLine(it.line, it.t)) {
      if (a.id && l.ids.has(a.id)) continue;
      if (a.id) l.ids.add(a.id);
      fresh.push({ ...a, content: null }); // pending until the call's result arrives
    }
    if (fresh.length) {
      l.activity = [...l.activity, ...fresh].slice(-this.activityMax);
      changed = true;
      for (const a of fresh) this.onEvent({ type: "activity", judge, tid: it.tid, activity: stripId(a) }, it.t);
    }
    // results: the call's content; a result before its call (not expected) waits for it
    for (const r of resultsFromLine(it.line)) {
      const at = l.activity.findIndex((a) => a.id === r.id);
      if (at < 0) {
        if (!l.ids.has(r.id)) l.orphans.set(r.id, r);
        continue;
      }
      if (this._attach(l, at, r)) {
        changed = true;
        this.onEvent({ type: "activity.content", judge, tid: it.tid, id: r.id, content: l.activity[at].content }, it.t);
      }
    }
    for (const a of fresh) {
      const r = a.id && l.orphans.get(a.id);
      if (!r) continue;
      l.orphans.delete(a.id);
      const at = l.activity.findIndex((x) => x.id === a.id);
      if (at >= 0 && this._attach(l, at, r)) changed = true;
    }
    if (p.kind === "vote" && turnEndFromLine(it.line)) this._voteEnded(p, it.t);
    if (changed) this._emitJudge(judge, it.t);
  }

  _attach(l, at, result) {
    const item = l.activity[at];
    if (item.content) return false; // a result is taken once
    const next = { ...item, content: contentOf(result, item, { pubRoot: this.pubRoot }) };
    l.activity = l.activity.map((a, i) => (i === at ? next : a));
    return true;
  }

  // ---- vote turns: who finished when ----

  // the first sign that the Judge's vote turn is over (the state leaves «голосует», or the log ends) counts;
  // the first thing seen at an earlier time wins a tie, then the order of arrival
  _voteEnded(p, t) {
    const key = voteKey(p);
    if (!this.voteEnds.has(key)) this.voteEnds.set(key, { t, seq: this._seq });
  }

  // the votes event -> [{ judge, at, unavailable, order }] in the order the Judges finished. A Judge whose
  // end was not seen (the Stage opened after it, or between two polls) goes first, in the engine's order.
  _casts(ev) {
    const rows = ev.votes.map((v, i) => {
      const key = voteKey({ place: ev.place, round: ev.round, judge: v.judge });
      const end = this.voteEnds.get(key) ?? null;
      this.voteEnds.delete(key);
      return { judge: v.judge, unavailable: v.team == null, end, i };
    });
    rows.sort((a, b) => {
      if (!a.end || !b.end) return a.end ? 1 : b.end ? -1 : a.i - b.i;
      return a.end.t - b.end.t || a.end.seq - b.end.seq || a.i - b.i;
    });
    let order = 0;
    return rows.map((r) => ({ judge: r.judge, at: r.end?.t ?? null, unavailable: r.unavailable, order: r.unavailable ? null : ++order }));
  }

  _emitJudge(name, t) {
    const l = this.live.get(name);
    if (!l) return;
    this.sink.judge?.(name, {
      status: l.status, since: l.since, sinceIso: l.sinceIso, sinceSource: l.sinceSource,
      activity: l.activity.map(stripId), turn: l.turn ? { ...l.turn } : null,
      agent: l.agent, model: l.model, cli: l.cli,
    }, { at: t });
  }
}

const voteKey = ({ place, round, judge }) => `${place}-${round}-${judge}`;
const stripId = ({ id, ...a }) => a;

// Run a director over a source that has an end (a replay, a folder): tick from t0 until the show is over.
// stepS only sets how often the clock is ticked; the sequence of sink calls does not depend on it.
export async function drive(director, { t0 = 0, stepS = 1, maxS = 24 * 3600 } = {}) {
  const end = director.source.endT ?? Infinity; // a source with an end: stop once it is drained and the queue is empty
  for (let t = t0; t <= maxS && !director.finished; t += stepS) {
    await director.tick(t);
    if (t > end && director.queue.depth === 0) break;
  }
  return director.finished;
}
