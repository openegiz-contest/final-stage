import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Director, drive } from "../../director/director.js";
import { RecordingSink } from "../../director/sinks.js";
import { ReplaySource } from "../../director/sources/replay.js";

export const HERE = dirname(fileURLToPath(import.meta.url));
export const REPLAYS = join(HERE, "..", "replays");
export const replayFiles = () => readdirSync(REPLAYS).filter((f) => f.startsWith("synthetic-") && f.endsWith(".jsonl")).sort();
export const loadReplay = (name) => ReplaySource.parse(readFileSync(join(REPLAYS, name.endsWith(".jsonl") ? name : `synthetic-${name}.jsonl`), "utf8"));

// Run a whole show over a replay; returns { sink, director, source, warnings }
export async function runShow(name, { stepS = 1, ...opts } = {}) {
  const source = typeof name === "string" ? loadReplay(name) : name;
  const sink = new RecordingSink();
  const warnings = [];
  const director = new Director({ source, sink, clock: () => 0, onWarn: (m) => warnings.push(m), ...opts });
  await drive(director, { stepS, maxS: source.endT + 3600 });
  return { sink, director, source, warnings };
}

// The calls that make up the show itself (not the live layer)
export const SHOW_METHODS = ["status", "say", "host", "unavailable", "voteCast", "voteReveal", "tally", "envelope", "lastWord", "verdict", "podium", "final"];
export const showCalls = (sink) => sink.calls.filter((c) => SHOW_METHODS.includes(c.method));

// A comparable key of the Judges' and Finalists' lines in the show, in the order they were played
export function keyOf(c) {
  const a = c.args;
  switch (c.method) {
    case "say": return `say|${a[0]}|${a[1]}`;
    case "unavailable": return `dark|${a[0]}|${a[1].where}|${a[1].place}|${a[1].round}`;
    case "voteReveal": return `vote|${a[0].place}|${a[0].round}|${a[0].judge}|${a[0].team}|${a[0].reason}`;
    case "verdict": return `verdict|${a[0].place}|${a[0].team}`;
    case "status": return a[0].phase === "discussion" ? `round|${a[0].place}|${a[0].round}` : null;
    default: return null;
  }
}

// The order the votes of a wave are revealed in (spec §7.7, owner 2026-10-21): the order the Judges
// walked to the urn (the sink's voteCast calls), the Judges without a vote first. Without a sink: the
// engine's order with the same rule.
export function revealOrder(tally, sink = null) {
  const walked = sink ? sink.of("voteCast").filter((c) => c.args[1].place === tally.place && c.args[1].round === tally.round).map((c) => c.args[0]) : [];
  const seq = [...walked.filter((j) => tally.votes.some((v) => v.judge === j)), ...tally.votes.map((v) => v.judge).filter((j) => !walked.includes(j))];
  const vote = (j) => tally.votes.find((v) => v.judge === j);
  return [...seq.filter((j) => vote(j).team == null), ...seq.filter((j) => vote(j).team != null)].map(vote);
}

// Planner options of the show of 2026-10-21 (every place revealed as soon as it is decided). The air
// show seals the places in envelopes (owner 2026-10-28, the Planner's default); the tests of the wave's
// own mechanics (walks, reveal order, result after the last token) run on both.
export const LEGACY = { plan: { envelopes: false } };

// The same keys, from the transcript of a finished state; the votes in reveal order (see revealOrder).
// With envelopes (the default): the debate in engine order with only the beats of Judges without a vote;
// then, after the last place, each place's deciding round and verdict, from the last place to the first
// (a vacant place has no envelope: its card comes when it is decided).
export function expectedKeys(state, sink = null, { envelopes = true } = {}) {
  const out = [];
  const voteKey = (e, v) => `vote|${e.place}|${e.round}|${v.judge}|${v.team}|${v.reason}`;
  const lastTally = new Map();
  const sealed = [];
  for (const e of state.transcript) {
    if (e.kind === "round") out.push(`round|${e.place}|${e.round}`);
    else if (e.kind === "message") out.push(e.text == null ? `dark|${e.judge}|message|${e.place}|${e.round}` : `say|${e.judge}|${e.text}`);
    else if (e.kind === "tally") {
      lastTally.set(e.place, e);
      for (const v of revealOrder(e, sink)) if (!envelopes || v.team == null) out.push(voteKey(e, v));
    } else if (e.kind === "placement") {
      if (envelopes && e.decided_by !== "vacant") sealed.push(e);
      else out.push(`verdict|${e.place}|${e.team}`);
    }
  }
  for (const e of sealed.sort((a, b) => b.place - a.place)) {
    const t = lastTally.get(e.place);
    if (t) for (const v of revealOrder(t, sink)) out.push(voteKey(t, v));
    out.push(`verdict|${e.place}|${e.team}`);
  }
  return out;
}
