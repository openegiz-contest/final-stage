// The command line, and the run-folder source behind it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Director, drive } from "../../director/director.js";
import { RecordingSink } from "../../director/sinks.js";
import { replayFromRunFolder } from "../../director/sources/folder.js";
import { REPLAYS, expectedKeys, keyOf, loadReplay, runShow, showCalls } from "./helpers.mjs";

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "director", "cli.mjs");
const cli = (...args) => spawnSync("node", [CLI, ...args], { encoding: "utf8" });

test("a run folder unfolds in time: the same show as the engine's transcript", async () => {
  const source = replayFromRunFolder(join(REPLAYS, "synthetic-run"));
  const sink = new RecordingSink();
  const d = new Director({ source, sink, clock: () => 0 });
  await drive(d, { stepS: 1, maxS: source.endT + 600 });
  assert.equal(d.finished, true);
  const final = source.stateAt(Infinity);
  assert.deepEqual(showCalls(sink).map(keyOf).filter(Boolean), expectedKeys(final, sink));
  assert.equal(final.status, "done");
  // the journal's retry (sonnet-5.5 at place 2) and the unavailable Judge show in the live layer
  const sonnet = sink.of("judge").filter((c) => c.args[0] === "sonnet-5.5").map((c) => c.args[1].turn?.tid);
  assert.ok(sonnet.includes("p2-r1-message-sonnet-5.5-a2"));
  assert.equal(sink.of("unavailable").length, 1);
  assert.equal(sink.of("verdict").length, 3);
});

test("cli --run prints the full show for a 3-place run folder", () => {
  const r = cli("--run", join(REPLAYS, "synthetic-run"), "--brief");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /SYNTHETIC|SETUP/);
  assert.equal((r.stdout.match(/\] #\d+ VERDICT/g) ?? []).length, 3);
  assert.equal((r.stdout.match(/\] #\d+ PODIUM/g) ?? []).length, 3);
  assert.match(r.stdout, /FINAL .*1: team-003  2: team-011  3: team-007/);
  assert.match(r.stdout, /-- show over: \d+ beats/);
  assert.match(r.stdout, /Определяем первое место/);
  // sealed envelopes (the default): no counts in the debate, the envelopes open 3 → 2 → 1
  assert.match(r.stdout, /Нет большинства\. Раунд 2 из 3\./);
  assert.ok(!/нет большинства, раунд 2/.test(r.stdout), "no counts before the reveal");
  assert.deepEqual([...r.stdout.matchAll(/ENVELOPE OPEN \S+ place (\d)/g)].map((m) => m[1]), ["3", "2", "1"]);
  assert.deepEqual([...r.stdout.matchAll(/#\d+ PODIUM .*/g)].length, 3);
  // the show of 2026-10-21 on request
  const each = cli("--run", join(REPLAYS, "synthetic-run"), "--brief", "--reveal-each");
  assert.equal(each.status, 0, each.stderr);
  assert.match(each.stdout, /нет большинства, раунд 2/);
  assert.ok(!/ENVELOPE/.test(each.stdout));
});

test("cli --replay marks synthetic data, --from resumes, --events lists the domain events", () => {
  const all = cli("--replay", join(REPLAYS, "synthetic-no-majority.jsonl"), "--brief");
  assert.equal(all.status, 0, all.stderr);
  assert.match(all.stdout, /^!! SYNTHETIC TEST DATA, never for air/);
  const from = cli("--replay", join(REPLAYS, "synthetic-no-majority.jsonl"), "--brief", "--from", "21");
  assert.equal(from.status, 0);
  assert.match(from.stdout, /RESUME from beat 21/);
  assert.ok(!/#020 /.test(from.stdout) && /#021 /.test(from.stdout));
  const ev = cli("--replay", join(REPLAYS, "synthetic-activity.jsonl"), "--events", "--brief");
  assert.match(ev.stdout, /\. activity opus-5\.5 open Read solutions\/team-003\/build_report\.json/);
  assert.match(ev.stdout, /\. event votes #/);
});

test("cli: usage and a run that is not finished", () => {
  assert.equal(cli().status, 2);
});

// A real fake run of the engine (python -m judge.final run --fake), when one is at hand
const FAKE = process.env.STAGE_FAKE_RUN ?? "/tmp/stage-dir/runs/fake1";
test("cli --run on a 3-place fake run of the engine", { skip: existsSync(join(FAKE, "state.json")) ? false : `no fake run at ${FAKE}` }, () => {
  const r = cli("--run", FAKE, "--brief");
  assert.equal(r.status, 0, r.stderr);
  assert.equal((r.stdout.match(/\] #\d+ VERDICT/g) ?? []).length, 3);
  assert.match(r.stdout, /-- show over/);
});
