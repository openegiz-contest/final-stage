// tools/record.py: a run folder (and the live page) into a replay the director plays.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Director } from "../../director/director.js";
import { RecordingSink } from "../../director/sinks.js";
import { ReplaySource } from "../../director/sources/replay.js";
import { Sim, JUDGES } from "./sim.mjs";
import { drive } from "../../director/director.js";
import { expectedKeys, keyOf, showCalls } from "./helpers.mjs";

const RECORD = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "tools", "record.py");
const py = spawnSync("python3", ["--version"]);
const skip = py.status !== 0 ? "python3 is not available" : false;

function scenario() {
  const s = new Sim({ name: "rec", settings: { places: 1 } });
  s.round(1, 1);
  JUDGES.forEach((j, i) => s.message(j.name, `Сообщение ${i} с «кавычками» и юникодом — ✓`, { dur: 1,
    lines: { 1: j.agent === "claude" ? ['{"type":"system","subtype":"init","tools":["Read"]}', '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"a","name":"Read","input":{"file_path":"x.md"}}]}}'] : ['{"type":"thread.started"}'] } }));
  s.votes(JUDGES.map((j) => ({ judge: j.name, team: "team-003", reason: "модель" })), { dur: 1 });
  s.placement("team-003", "majority", 1).finish();
  return s;
}

// write the simulated engine's output into a folder, record by record, the way the engine does
async function writeLive(dir, sim, { pauseMs = 6 } = {}) {
  mkdirSync(join(dir, "turns"), { recursive: true });
  writeFileSync(join(dir, "final.json"), JSON.stringify({ created_at: "2026-10-24T11:59:00Z" }));
  const agent = (tid) => sim.state.judges.find((j) => tid.includes(`-${j.name}`)).agent;
  const written = [];
  const records = sim.records.map((r, i) => [r, i]).sort((a, b) => a[0].t - b[0].t || a[1] - b[1]).map(([r]) => r);
  for (const r of records) {
    if (r.state) {
      writeFileSync(join(dir, "state.tmp"), JSON.stringify(r.state));
      renameSync(join(dir, "state.tmp"), join(dir, "state.json"));
      written.push(JSON.stringify(r.state));
    } else if (r.prompt) {
      mkdirSync(join(dir, "turns", r.tid), { recursive: true });
      writeFileSync(join(dir, "turns", r.tid, "prompt.txt"), "prompt");
    } else {
      mkdirSync(join(dir, "turns", r.tid), { recursive: true });
      appendFileSync(join(dir, "turns", r.tid, `${agent(r.tid)}.jsonl`), r.line + "\n");
    }
    await new Promise((ok) => setTimeout(ok, pauseMs));
  }
  return written;
}

const finished = (child) => new Promise((ok, fail) => { child.on("exit", (code) => (code === 0 ? ok() : fail(new Error(`record.py exited ${code}`)))); child.on("error", fail); });

test("record.py: follows a running Final into a replay, deltas included, and the director plays it", { skip }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "stage-rec-"));
  const out = join(dir, "out.jsonl");
  const run = join(dir, "run");
  mkdirSync(run);
  const sim = scenario();
  const child = spawn("python3", [RECORD, run, "--out", out, "--interval", "0.02", "--max-s", "60", "--note", "test"], { stdio: ["ignore", "ignore", "inherit"] });
  const done = finished(child);
  const written = await writeLive(run, sim);
  await done;
  const text = readFileSync(out, "utf8");
  const source = ReplaySource.parse(text);
  assert.equal(source.header.recorded, true);
  assert.equal(source.header.runId, "2026-10-24T11:59:00Z");
  assert.equal(source.header.note, "test");
  // every recorded state is one the engine wrote, in order; the last one is the final state
  const states = source.records.filter((r) => r.state).map((r) => JSON.stringify(r.state));
  let at = -1;
  for (const s of states) {
    const i = written.indexOf(s, at + 1);
    assert.ok(i > at, "a recorded state is a written state, in order");
    at = i;
  }
  assert.equal(states.at(-1), written.at(-1));
  assert.ok(states.length >= 10);
  assert.ok(text.split("\n").some((l) => l.includes('"delta"')), "later states are deltas");
  assert.ok(text.length < sim.records.length * 3000, "much smaller than full snapshots");
  // all prompts and every log line exactly once
  const prompts = source.records.filter((r) => r.prompt).map((r) => r.tid).sort();
  assert.deepEqual(prompts, [...sim.turns.keys()].sort());
  const lines = source.records.filter((r) => r.line !== undefined);
  assert.equal(lines.length, [...sim.turns.values()].reduce((n, t) => n + t.lines.length, 0));
  // and the director plays the recording as the engine's show
  const sink = new RecordingSink();
  const d = new Director({ source, sink, clock: () => 0 });
  await drive(d, { stepS: 1, maxS: source.endT + 600 });
  assert.equal(d.finished, true);
  assert.deepEqual(showCalls(sink).map(keyOf).filter(Boolean), expectedKeys(sim.state, sink));
  assert.ok(sink.of("judge").some((c) => c.args[1].activity.some((a) => a.label === "Read" && a.path === "x.md")));
  rmSync(dir, { recursive: true, force: true });
});

test("record.py --url: records what the live page serves, listing included", { skip }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "stage-rec-"));
  const run = join(dir, "run");
  mkdirSync(run);
  const sim = scenario();
  // a minimal static server with folder listings like the engine's live page
  const server = createServer((req, res) => {
    const p = join(run, decodeURIComponent(new URL(req.url, "http://x").pathname));
    try {
      if (statSync(p).isDirectory()) {
        res.writeHead(200, { "content-type": "text/html" }).end(`<ul>${readdirSync(p).map((n) => `<li><a href="${n}/">${n}</a></li>`).join("")}</ul>`);
      } else {
        const body = readFileSync(p);
        res.writeHead(200, { "content-length": body.length }).end(req.method === "HEAD" ? undefined : body);
      }
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  const url = `http://127.0.0.1:${server.address().port}`;
  const out = join(dir, "out.jsonl");
  const child = spawn("python3", [RECORD, "--url", url, "--out", out, "--interval", "0.03", "--max-s", "60"], { stdio: ["ignore", "ignore", "inherit"] });
  const done = finished(child);
  await writeLive(run, sim, { pauseMs: 8 });
  await done;
  server.close();
  const source = ReplaySource.parse(readFileSync(out, "utf8"));
  assert.deepEqual(JSON.stringify(source.stateAt(Infinity)), JSON.stringify(sim.state));
  assert.equal(source.records.filter((r) => r.line !== undefined).length, [...sim.turns.values()].reduce((n, t) => n + t.lines.length, 0));
  rmSync(dir, { recursive: true, force: true });
});
