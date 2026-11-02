// A small simulator of the Final engine's output (judge/final/engine.py) for tests: it builds the
// snapshots, the prompt.txt appearances and the raw log lines the Stage would read, on a timeline.
// Everything it makes is synthetic test data. build-replays.mjs writes the scenarios to test/replays/.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { encodeDelta } from "../../director/sources/codec.js";

export const START = "2026-10-24T12:00:00.000Z";

export const JUDGES = [
  { name: "opus-5.5", agent: "claude", model: "claude-opus-5-5", cli: "claude 9.9.9 (synthetic)" },
  { name: "sonnet-5.5", agent: "claude", model: "claude-sonnet-5-5", cli: "claude 9.9.9 (synthetic)" },
  { name: "fable-5.1", agent: "claude", model: "claude-fable-5-1", cli: "claude 9.9.9 (synthetic)" },
  { name: "gpt-6.1-sol", agent: "codex", model: "gpt-6.1-sol", cli: "codex 9.9.9 (synthetic)" },
  { name: "gpt-6-astra", agent: "codex", model: "gpt-6-astra", cli: "codex 9.9.9 (synthetic)" },
];

export const FINALISTS = [
  { team: "team-003", name: "Горный поток", rank: 1, score: "78.12", ceiling: false },
  { team: "team-011", name: "Штрек", rank: 2, score: "75.62", ceiling: false },
  { team: "team-007", name: "Карьер-Ай", rank: 3, score: "70.94", ceiling: false },
  { team: "team-002", name: "Забой", rank: 4, score: "53.75", ceiling: false },
  { team: "team-014", name: "Недра", rank: 5, score: "43.44", ceiling: false },
  { team: "team-009", name: "Рудник 4.0", rank: 6, score: "40", ceiling: true },
];

// raw log lines of the two CLIs
export const L = {
  claudeInit: (tools = ["Read", "Glob", "Grep", "LS"]) => JSON.stringify({ type: "system", subtype: "init", tools, model: "claude-synthetic" }),
  claudeThinking: () => JSON.stringify({ type: "assistant", message: { content: [{ type: "thinking", thinking: "" }] } }),
  claudeTool: (id, name, input) => JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id, name, input }] } }),
  claudeResult: (id) => JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: "…" }] } }),
  // content: a string or a list of blocks
  claudeToolResult: (id, content, extra = {}) => JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content, ...extra }] } }),
  claudeText: (text) => JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] } }),
  claudeDone: () => JSON.stringify({ type: "result", subtype: "success", result: "…" }),
  codexStart: () => JSON.stringify({ type: "thread.started", thread_id: "synthetic" }),
  codexCmd: (id, command, phase = "item.completed") => JSON.stringify({ type: phase, item: { id, type: "command_execution", command, status: phase === "item.started" ? "in_progress" : "completed" } }),
  codexMcp: (id, server, tool, args) => JSON.stringify({ type: "item.completed", item: { id, type: "mcp_tool_call", server, tool, arguments: args } }),
  // a Codex MCP call: item.started has no result, item.completed carries `extra` (result / error / status)
  codexMcpCall: (id, server, tool, args, phase = "item.completed", extra = {}) => JSON.stringify({ type: phase, item: { id, type: "mcp_tool_call", server, tool, arguments: args,
    status: phase === "item.started" ? "in_progress" : "completed", ...extra } }),
  codexItem: (id, type, extra = {}) => JSON.stringify({ type: "item.completed", item: { id, type, ...extra } }),
  codexDone: () => JSON.stringify({ type: "turn.completed", usage: {} }),
};

const r3 = (x) => Math.round(x * 1000) / 1000;

export class Sim {
  constructor({ name, note, finalists = FINALISTS, judges = JUDGES, settings = {} }) {
    this.name = name;
    this.note = note;
    this.t = 0;
    this.records = [];
    this.turns = new Map();   // tid -> { lines, prompt }
    this.journal = [];
    this.state = {
      status: "running", started_at: START, finished_at: null, duration_s: null,
      settings: { finalists: finalists.length, places: 3, rounds_per_place: 3, max_words: 90, retries: 1, turn_timeout_s: 240, ...settings },
      judges: judges.map((j) => ({ ...j, status: "ждёт", log: null })),
      finalists, current: null, transcript: [], votes: [], placements: [],
    };
    this.snap();
  }

  iso(t = this.t) {
    return new Date(Date.parse(START) + t * 1000).toISOString();
  }

  snap() {
    this.records.push({ t: r3(this.t), state: structuredClone(this.state) });
  }

  wait(dt) {
    this.t += dt;
    return this;
  }

  judge(name) {
    return this.state.judges.find((j) => j.name === name);
  }

  tid(kind, judge, attempt = 1) {
    const { place, round } = this.state.current;
    return `p${place}-r${round}-${kind}-${judge}` + (attempt > 1 ? `-a${attempt}` : "");
  }

  _startTurn(judge, kind, tid, lines, dur) {
    const j = this.judge(judge);
    j.status = kind === "vote" ? "голосует" : "пишет";
    j.since = this.iso();
    this.snap();
    this.records.push({ t: r3(this.t), tid, prompt: true });
    const rec = { lines: lines ?? [], prompt: true };
    this.turns.set(tid, rec);
    rec.lines.forEach((line, i) => this.records.push({ t: r3(this.t + ((i + 1) * dur) / (rec.lines.length + 1)), tid, line }));
  }

  _endTurn(judge, tid, ok) {
    const j = this.judge(judge);
    j.status = ok ? "ждёт" : "недоступен";
    delete j.since;
    j.log = `turns/${tid}/`;
    this.snap();
  }

  round(place, round) {
    this.state.current = { place, round, phase: "discussion" };
    this.state.transcript.push({ kind: "round", place, round, at: this.iso() });
    this.snap();
    return this;
  }

  // text null: the Judge is unavailable (every attempt failed). fail: failed attempts before the good one.
  message(judge, text, { dur = 4, fail = 0, lines = {} } = {}) {
    const attempts = text == null ? this.state.settings.retries + 1 : fail + 1;
    let total = 0, last;
    for (let a = 1; a <= attempts; a++) {
      const tid = this.tid("message", judge, a);
      this._startTurn(judge, "message", tid, lines[a], dur);
      this.wait(dur);
      total += dur;
      const ok = text != null && a === attempts;
      this._endTurn(judge, tid, ok);
      this.journal.push({ id: tid, judge, kind: "message", place: this.state.current.place, round: this.state.current.round, attempt: a,
        text: ok ? text : "", error: ok ? null : "synthetic failure", retryable: true, duration_s: dur, log: `turns/${tid}/`, at: this.iso() });
      last = tid;
    }
    const { place, round } = this.state.current;
    this.state.transcript.push({ kind: "message", place, round, judge, text, error: text == null ? "synthetic failure" : null,
      log: `turns/${last}/`, duration_s: total, at: this.iso() });
    this.snap();
    return this;
  }

  // votes: [{ judge, team|null, reason }] in roster order; all judges vote at once
  // durs: { judge: seconds } for the Judges that take longer or shorter than `dur`
  votes(votes, { dur: defaultDur = 3, durs = {}, fail = {}, lines = {} } = {}) {
    const { place, round } = this.state.current;
    this.state.current.phase = "voting";
    const t0 = this.t;
    const evs = [];
    let endAll = t0;
    const logOf = {};
    for (const v of votes) {
      const dur = durs[v.judge] ?? defaultDur;
      const attempts = v.team == null ? this.state.settings.retries + 1 : (fail[v.judge] ?? 0) + 1;
      for (let a = 1; a <= attempts; a++) {
        const s = t0 + (a - 1) * dur, tid = this.tid("vote", v.judge, a);
        const ok = v.team != null && a === attempts;
        evs.push({ t: s, order: 1, fn: () => this._startTurn(v.judge, "vote", tid, lines[v.judge]?.[a], dur) });
        evs.push({ t: s + dur, order: 0, fn: () => {
          this._endTurn(v.judge, tid, ok);
          this.journal.push({ id: tid, judge: v.judge, kind: "vote", place, round, attempt: a, text: ok ? JSON.stringify({ place, team: v.team, reason: v.reason }) : "",
            error: ok ? null : "synthetic failure", retryable: true, duration_s: dur, log: `turns/${tid}/`, at: this.iso() });
        } });
        endAll = Math.max(endAll, s + dur);
        logOf[v.judge] = `turns/${tid}/`;
      }
    }
    evs.map((e, i) => [e, i]).sort((a, b) => a[0].t - b[0].t || a[0].order - b[0].order || a[1] - b[1]).forEach(([e]) => {
      this.t = e.t;
      e.fn();
    });
    this.t = endAll;
    const entries = votes.map((v) => ({ judge: v.judge, place, round, team: v.team, reason: v.team == null ? null : v.reason,
      error: v.team == null ? "synthetic failure" : null, log: logOf[v.judge] }));
    const counts = {};
    for (const v of votes) if (v.team) counts[v.team] = (counts[v.team] ?? 0) + 1;
    const sorted = Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)));
    const voted = Object.values(counts).reduce((s, n) => s + n, 0);
    const line = Math.floor(voted / 2) + 1;
    this.state.votes.push(...entries);
    this.state.transcript.push({ kind: "tally", place, round, votes: entries, counts: sorted, voted, judges: this.state.judges.length,
      majority: Object.values(counts).some((n) => n >= line), at: this.iso() });
    this.snap();
    return this;
  }

  placement(team, decided_by, rounds) {
    const { place } = this.state.current ?? { place: this.state.placements.length + 1 };
    const name = team ? this.state.finalists.find((f) => f.team === team).name : null;
    this.state.placements.push({ place, team, name, decided_by, rounds, duration_s: 1 });
    this.state.transcript.push({ kind: "placement", place, team, name, decided_by, rounds, at: this.iso() });
    this.snap();
    return this;
  }

  vacant(place) {
    this.state.current = { place, round: 0, phase: "discussion" };
    return this.placement(null, "vacant", 0);
  }

  finish() {
    this.state.status = "done";
    this.state.current = null;
    this.state.finished_at = this.iso();
    this.state.duration_s = r3(this.t);
    this.snap();
    return this;
  }

  header() {
    return { format: "stage-replay/1", startedAt: START, runId: `synthetic-${this.name}`, synthetic: true,
      note: `SYNTHETIC TEST DATA, never for air. ${this.note ?? ""}`.trim() };
  }

  toJsonl() {
    const sorted = this.records.map((r, i) => [r, i]).sort((a, b) => a[0].t - b[0].t || a[1] - b[1]).map(([r]) => r);
    let prev = null; // states as deltas, the way tools/record.py writes them
    const out = sorted.map((r) => {
      if (!r.state) return r;
      const delta = prev ? encodeDelta(prev, r.state) : null;
      const rec = prev && delta ? { t: r.t, delta } : prev ? null : r;
      prev = r.state;
      return rec;
    }).filter(Boolean);
    return [this.header(), ...out].map((r) => JSON.stringify(r)).join("\n") + "\n";
  }

  // the same run as a run folder (runs/final/<id>/), for the CLI and the folder source
  writeFolder(dir) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "state.json"), JSON.stringify(this.state, null, 1) + "\n");
    writeFileSync(join(dir, "final.json"), JSON.stringify({ created_at: START, settings: this.state.settings, synthetic: true }) + "\n");
    writeFileSync(join(dir, "journal.jsonl"), this.journal.map((r) => JSON.stringify(r)).join("\n") + "\n");
    for (const [tid, rec] of this.turns) {
      const d = join(dir, "turns", tid);
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, "prompt.txt"), "synthetic prompt\n");
      if (rec.lines.length) {
        const agent = this.state.judges.find((j) => tid.includes(`-${j.name}`))?.agent ?? "claude";
        writeFileSync(join(d, `${agent}.jsonl`), rec.lines.join("\n") + "\n");
      }
    }
  }
}
