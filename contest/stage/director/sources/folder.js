// Node only: a finished run folder (runs/final/<run-id>/) as a ReplaySource, so the CLI and tests can
// re-render a whole Final offline.
//
// The folder holds only the end state, so the way it unfolded is rebuilt from what it records:
// transcript entries (`at`), journal.jsonl (every turn: when it ended and how long it took) and the raw
// logs under turns/<tid>/. Each turn becomes a status interval on its Judge; a vote wave starts together
// and lands in one tally; log lines are spread evenly over their turn; `since` is filled from the interval.
// Times are the engine's own (second resolution), clamped to never go backwards. A live recording
// (tools/record.py) is the faithful thing; this is the offline stand-in.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ReplaySource } from "./replay.js";

const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const readLines = (p) => (existsSync(p) ? readFileSync(p, "utf8").split("\n").filter((l) => l.trim() !== "") : []);

export function replayFromRunFolder(dir) {
  const final = readJson(join(dir, "state.json"));
  const meta = existsSync(join(dir, "final.json")) ? readJson(join(dir, "final.json")) : {};
  const journal = new Map();
  for (const l of readLines(join(dir, "journal.jsonl"))) {
    const r = JSON.parse(l);
    if (!r.kind) continue;
    const key = `${r.place}-${r.round}-${r.kind}-${r.judge}`;
    journal.set(key, [...(journal.get(key) ?? []), r]);
  }
  const t0 = Date.parse(final.started_at) / 1000;
  const rel = (iso) => (iso ? Date.parse(iso) / 1000 - t0 : 0);
  const iso = (t) => new Date((t0 + t) * 1000).toISOString();
  const agent = new Map(final.judges.map((j) => [j.name, j.agent]));
  const extra = []; // prompts and log lines; after the states of the same instant
  const records = [];
  const moments = []; // { t, apply }: changes to the unfolding state, replayed in time order
  const at = (t, apply) => moments.push({ t, apply });
  let clock = 0;
  const mono = (t) => (clock = Math.max(clock, t));

  // the turns of one Judge for one message/vote: attempts from the journal, else a single one
  const turnsOf = (kind, e, endT, judge) => {
    const recs = journal.get(`${e.place}-${e.round}-${kind}-${judge}`);
    if (recs?.length) {
      return [...recs].sort((a, b) => a.attempt - b.attempt)
        .map((r) => ({ tid: r.id, end: rel(r.at), dur: r.duration_s ?? 1, error: !!r.error }));
    }
    const tid = (e.log ?? `turns/p${e.place}-r${e.round}-${kind}-${judge}/`).replace(/^turns\//, "").replace(/\/$/, "");
    return [{ tid, end: endT, dur: e.duration_s ?? 1, error: false }];
  };

  // one turn: busy from start to end, its prompt at the start, its log lines spread over it
  const turn = (judge, kind, tr, start, end, lastUnavailable, log) => {
    at(start, (s) => s.statuses.set(judge, { status: kind === "vote" ? "голосует" : "пишет", since: iso(start), log: s.statuses.get(judge).log }));
    if (existsSync(join(dir, "turns", tr.tid, "prompt.txt"))) extra.push({ t: start, tid: tr.tid, prompt: true });
    const lines = readLines(join(dir, "turns", tr.tid, `${agent.get(judge)}.jsonl`));
    lines.forEach((line, i) => extra.push({ t: start + ((i + 1) * (end - start)) / (lines.length + 1), tid: tr.tid, line }));
    at(end, (s) => s.statuses.set(judge, { status: lastUnavailable === null ? (tr.error ? "недоступен" : "ждёт") : lastUnavailable ? "недоступен" : "ждёт", since: undefined, log }));
  };

  for (const e of final.transcript) {
    if (e.kind === "message") {
      const turns = turnsOf("message", e, rel(e.at), e.judge);
      turns.forEach((tr, i) => {
        const last = i === turns.length - 1;
        const before = clock;
        const end = mono(Math.max(before, tr.end));
        const start = Math.max(before, end - tr.dur);
        turn(e.judge, "message", tr, start, end, last ? e.text == null : null, last ? e.log : `turns/${tr.tid}/`);
        if (last) at(end, (s) => s.count++);
      });
    } else if (e.kind === "tally") {
      const waves = e.votes.map((v) => ({ v, turns: turnsOf("vote", { ...e, log: v.log }, rel(e.at), v.judge) }));
      const wave0 = mono(Math.max(clock, Math.min(...waves.map((w) => w.turns[0].end - w.turns[0].dur))));
      let endAll = wave0;
      at(wave0, (s) => (s.current = { ...s.current, phase: "voting" }));
      for (const w of waves) {
        w.turns.forEach((tr, i) => {
          const last = i === w.turns.length - 1;
          const start = i === 0 ? wave0 : Math.max(wave0, tr.end - tr.dur);
          const end = Math.max(start, tr.end);
          endAll = Math.max(endAll, end);
          turn(w.v.judge, "vote", tr, start, end, last ? w.v.team == null : null, last ? w.v.log : `turns/${tr.tid}/`);
        });
      }
      mono(endAll);
      at(endAll, (s) => { s.count++; s.votes += e.votes.length; });
    } else {
      const t = mono(rel(e.at));
      at(t, (s) => {
        s.count++;
        if (e.kind === "placement") s.placements++;
        if (e.kind === "round") s.current = { place: e.place, round: e.round, phase: "discussion" };
      });
    }
  }
  const finished = final.status === "done";
  at(mono(finished ? rel(final.finished_at) : clock), (s) => (s.done = finished));

  const s = { statuses: new Map(final.judges.map((j) => [j.name, { status: "ждёт", since: undefined, log: null }])),
    count: 0, votes: 0, placements: 0, current: null, done: false };
  moments.map((m, i) => [m, i]).sort((a, b) => a[0].t - b[0].t || a[1] - b[1]).forEach(([m]) => {
    m.apply(s);
    records.push({ t: m.t, state: {
      ...final, status: s.done ? "done" : "running", finished_at: s.done ? final.finished_at : null,
      judges: final.judges.map((j) => {
        const st = s.statuses.get(j.name);
        return { ...j, status: st.status, log: st.log, ...(st.since ? { since: st.since } : {}) };
      }),
      current: s.done ? null : s.current,
      transcript: final.transcript.slice(0, s.count), votes: final.votes.slice(0, s.votes),
      placements: final.placements.slice(0, s.placements),
    } });
  });
  return new ReplaySource([...records, ...extra], { format: "stage-replay/1", startedAt: final.started_at, runId: meta.created_at ?? final.started_at, source: "run folder" });
}
