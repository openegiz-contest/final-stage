// state.json snapshots -> ordered domain events.
//
// StateDiffer.diff(state) compares a snapshot with the ones before it and returns the new events in the
// engine's order. It never assumes an entry shows up once between two polls: the transcript is append-only,
// so entries are taken by index, and a judge's status is compared with the last one seen.
//
// Events (all plain objects, `type` first):
//   setup        { judges, finalists, settings }                       once, from the first snapshot
//   judge        { judge, status, since, log }                         a Judge's status or `since` changed
//   turn.start   { judge, kind, place, round, attempt, tid, since }    status became пишет/голосует
//   turn.end     { judge, kind, place, round, attempt, tid, outcome }  outcome "ok" | "unavailable"
//   round        { index, at, place, round }                           transcript entry
//   message      { index, at, judge, place, round, text, pick, rival } transcript entry with text; pick/rival: team ids or null
//   unavailable  { index, at, judge, place, round, where: "message", error }   message with text null (п. 10.5)
//   votes        { index, at, place, round, votes, counts, voted, judges, majority, line, unavailable: [judge] }
//   placement    { index, at, place, team, name, decided_by, rounds }  decided_by: majority | last_word | vacant
//   done         { placements }                                        status "done" and every entry consumed
//
// `index` is the transcript index: the cursor of a resume is derived from it.

export const ACTIVE = { "пишет": "message", "голосует": "vote" };
const TID = /^p(\d+)-r(\d+)-(message|vote)-(.+?)(?:-a(\d+))?$/;

export function makeTid({ place, round, kind, judge, attempt = 1 }) {
  return `p${place}-r${round}-${kind}-${judge}` + (attempt > 1 ? `-a${attempt}` : "");
}

export function parseTid(tid) {
  const m = TID.exec(tid ?? "");
  return m ? { place: +m[1], round: +m[2], kind: m[3], judge: m[4], attempt: m[5] ? +m[5] : 1 } : null;
}

// The majority line: more than half of the Judges who voted (judge/last_word.py).
export const majorityLine = (voted) => Math.floor(voted / 2) + 1;

// The turns that run now: one per Judge whose status is пишет/голосует. `tid` is the first attempt's id.
export function activeTurns(state) {
  const cur = state?.current;
  if (!cur) return [];
  return (state.judges ?? [])
    .filter((j) => ACTIVE[j.status])
    .map((j) => {
      const kind = ACTIVE[j.status];
      return { judge: j.name, agent: j.agent, kind, place: cur.place, round: cur.round,
        tid: makeTid({ place: cur.place, round: cur.round, kind, judge: j.name }) };
    });
}

export class StateDiffer {
  constructor() {
    this.started = false;
    this.seen = 0;           // transcript entries already turned into events
    this.judges = new Map(); // name -> { status, since, turn }
    this.starts = new Map(); // "p-r-kind-judge" -> number of turns started (the attempt counter)
    this.doneEmitted = false;
    this.startedAt = null;   // one value per engine process: a --resume starts a new one
  }

  diff(state) {
    const out = [];
    if (!state || typeof state !== "object") return out;
    if (!this.started) {
      this.started = true;
      out.push({ type: "setup", judges: state.judges ?? [], finalists: state.finalists ?? [], settings: state.settings ?? {} });
    }
    // a resumed engine counts its turns again from the first ask
    if (this.startedAt !== null && state.started_at !== this.startedAt) this.starts.clear();
    this.startedAt = state.started_at ?? null;
    for (const j of state.judges ?? []) this._judge(state, j, out);
    const entries = state.transcript ?? [];
    // A shorter transcript than the one seen is an engine restarted from its journal rebuilding the same
    // entries: wait for it to pass what was seen.
    for (let i = this.seen; i < entries.length; i++) out.push(...this._entry(entries[i], i, state));
    this.seen = Math.max(this.seen, entries.length);
    if (state.status === "done" && !this.doneEmitted && this.seen === entries.length) {
      this.doneEmitted = true;
      out.push({ type: "done", placements: state.placements ?? [] });
    }
    return out;
  }

  _judge(state, j, out) {
    const prev = this.judges.get(j.name) ?? { status: "ждёт", since: null, turn: null };
    const since = j.since ?? null;
    const statusChanged = j.status !== prev.status;
    // a `since` that lands late on a turn already seen (null -> time) is the same turn
    const sinceChanged = prev.since != null && since !== prev.since && ACTIVE[j.status] && ACTIVE[prev.status];
    let turn = prev.turn;
    if (statusChanged || sinceChanged) {
      const wasActive = !!ACTIVE[prev.status];
      const isActive = !!ACTIVE[j.status];
      const kind = ACTIVE[j.status];
      const newTurn = isActive && (!wasActive || ACTIVE[prev.status] !== kind || sinceChanged);
      if (wasActive && (!isActive || newTurn) && prev.turn) {
        out.push({ type: "turn.end", ...pick(prev.turn), outcome: j.status === "недоступен" ? "unavailable" : "ok" });
        turn = null;
      }
      if (newTurn && state.current) {
        const { place, round } = state.current;
        const key = `p${place}-r${round}-${kind}-${j.name}`;
        const attempt = (this.starts.get(key) ?? 0) + 1;
        this.starts.set(key, attempt);
        turn = { judge: j.name, kind, place, round, attempt, tid: makeTid({ place, round, kind, judge: j.name, attempt }) };
        out.push({ type: "turn.start", ...turn, since });
      }
      out.push({ type: "judge", judge: j.name, status: j.status, since, log: j.log ?? null });
    }
    this.judges.set(j.name, { status: j.status, since, turn });
  }

  _entry(e, index, state) {
    const base = { index, at: e.at ?? null };
    if (e.kind === "round") return [{ type: "round", ...base, place: e.place, round: e.round }];
    if (e.kind === "message") {
      if (e.text == null) {
        return [{ type: "unavailable", ...base, judge: e.judge, place: e.place, round: e.round, where: "message", error: e.error ?? null }];
      }
      return [{ type: "message", ...base, judge: e.judge, place: e.place, round: e.round, text: e.text, pick: e.pick ?? null, rival: e.rival ?? null }];
    }
    if (e.kind === "tally") {
      return [{ type: "votes", ...base, place: e.place, round: e.round, votes: e.votes ?? [], counts: e.counts ?? {},
        voted: e.voted, judges: e.judges, majority: !!e.majority, line: majorityLine(e.voted ?? 0),
        unavailable: (e.votes ?? []).filter((v) => v.team == null).map((v) => v.judge) }];
    }
    if (e.kind === "placement") {
      return [{ type: "placement", ...base, place: e.place, team: e.team ?? null, name: e.name ?? null,
        decided_by: e.decided_by, rounds: e.rounds }];
    }
    return [];
  }
}

function pick(t) {
  return { judge: t.judge, kind: t.kind, place: t.place, round: t.round, attempt: t.attempt, tid: t.tid };
}
