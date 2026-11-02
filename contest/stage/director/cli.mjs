#!/usr/bin/env node
// Run the director over a finished run folder and print the show as text.
//
//   node contest/stage/director/cli.mjs --run <run dir> [--speed N] [--brief] [--events] [--from n]
//   node contest/stage/director/cli.mjs --replay <file.jsonl> ...
//
//   --run DIR     runs/final/<run-id>/ (state.json, journal.jsonl, turns/): the run is unfolded in time from it
//   --replay F    a recording (tools/record.py) or a synthetic replay instead
//   --speed N     pace the output at N times real time (1 = as it would air); default: no pacing, instant
//   --from N      resume cursor: skip the first N beats (as a Stage reload does)
//   --brief       cut long texts to 100 characters
//   --events      also print the domain events and the Judges' activity
//   --wpm N       voice estimate, words per minute (default 145)
//   --pub-root P  where the publication lay for the Judges (absolute path): image reads under it get a /pub/ URL
//   --reveal-each every place revealed as soon as it is decided (the show of 2026-10-21); default: sealed
//                 envelopes, opened 3 → 2 → 1 after the last place (owner 2026-10-28)

import { readFileSync } from "node:fs";
import { Director } from "./director.js";
import { ConsoleSink } from "./sinks.js";
import { EstimateVoice } from "./voice.js";
import { ReplaySource } from "./sources/replay.js";
import { replayFromRunFolder } from "./sources/folder.js";

const argv = process.argv.slice(2);
const opt = (k, def = null) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? (argv[i + 1]?.startsWith("--") || argv[i + 1] === undefined ? true : argv[i + 1]) : def;
};
const run = opt("run"), replay = opt("replay");
if (!run && !replay) {
  console.error("usage: cli.mjs --run <run dir> | --replay <file> [--speed N] [--from N] [--brief] [--events] [--wpm N] [--pub-root P] [--reveal-each]");
  process.exit(2);
}
const source = run ? replayFromRunFolder(run) : ReplaySource.parse(readFileSync(replay, "utf8"));
if (source.synthetic) console.log(`!! SYNTHETIC TEST DATA, never for air: ${source.header.note ?? ""}`);
const speed = Number(opt("speed", 0));
const stepS = 0.5;
const sink = new ConsoleSink({ maxText: opt("brief") ? 100 : 0 });
const stamp = (t) => `[${String(Math.floor(t / 60)).padStart(2, "0")}:${(t % 60).toFixed(1).padStart(4, "0")}]`;
const director = new Director({
  source, sink, voice: new EstimateVoice({ wpm: Number(opt("wpm", 145)) }), clock: () => 0,
  pubRoot: opt("pub-root") || null,
  plan: { envelopes: !opt("reveal-each") },
  from: opt("from") !== null ? Number(opt("from")) : null,
  onWarn: (m) => console.error("warn:", m),
  onEvent: opt("events") ? (ev, t) => {
    if (ev.type === "activity") console.log(`${stamp(t)} . activity ${ev.judge} ${ev.activity.kind} ${ev.activity.label} ${ev.activity.path ?? ""}`);
    else if (ev.type === "activity.content") console.log(`${stamp(t)} . content ${ev.judge} ${ev.id} ${ev.content.text != null ? ev.content.text.length + " chars" : "no text"}${ev.content.truncated ? " (cut)" : ""}${ev.content.image ? " " + ev.content.image : ""}`);
    else if (!["setup", "judge"].includes(ev.type)) console.log(`${stamp(t)} . event ${ev.type}${ev.index !== undefined ? " #" + ev.index : ""}${ev.judge ? " " + ev.judge : ""}${ev.place ? " p" + ev.place : ""}${ev.round ? " r" + ev.round : ""}`);
  } : undefined,
});
const t0 = Date.now();
for (let t = 0; !director.finished && t < 24 * 3600; t += stepS) {
  if (speed > 0) await new Promise((r) => setTimeout(r, (stepS * 1000) / speed));
  await director.tick(t);
  if (t > source.endT && director.queue.depth === 0) break; // data ends: nothing more will come
}
console.log(director.finished ? `-- show over: ${director.cursor} beats, ${source.endT.toFixed(0)} s of engine time` : "-- the show did not finish (data ends before the final)");
if (!director.finished) process.exit(1);
