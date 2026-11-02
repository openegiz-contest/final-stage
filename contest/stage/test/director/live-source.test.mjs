// LiveSource against a fake server that serves a replay as if the engine were running (/run/...).
import { test } from "node:test";
import assert from "node:assert/strict";
import { Director } from "../../director/director.js";
import { LiveSource } from "../../director/sources/live.js";
import { RecordingSink } from "../../director/sinks.js";
import { expectedKeys, keyOf, loadReplay, showCalls } from "./helpers.mjs";

// What /run/ shows at time T: the last state, the prompt.txt files and the log lines written so far.
function fakeServer(replay, { partialAt = null, failAt = null } = {}) {
  const T = { now: 0 };
  const requests = [];
  const agentOf = (tid) => replay.stateAt(Infinity).judges.find((j) => tid.includes(`-${j.name}`))?.agent;
  const fetch = async (url, init = {}) => {
    const method = init.method ?? "GET";
    const path = new URL(url, "http://x").pathname.replace(/^\/run\//, "");
    requests.push({ method, path, at: T.now });
    const res = (status, body = "", type = "text/plain") => ({ ok: status === 200, status, text: async () => body, json: async () => JSON.parse(body) });
    if (failAt !== null && Math.abs(T.now - failAt) < 1e-9 && path === "state.json") return res(500);
    if (path === "final.json") return res(200, JSON.stringify({ created_at: "2026-10-24T11:59:00Z" }));
    if (path === "state.json") {
      const s = replay.stateAt(T.now);
      return s ? res(200, JSON.stringify(s)) : res(404);
    }
    let m = /^turns\/([^/]+)\/prompt\.txt$/.exec(path);
    if (m) return replay.records.some((r) => r.prompt && r.tid === m[1] && r.t <= T.now) ? res(200, method === "HEAD" ? "" : "prompt") : res(404);
    m = /^turns\/([^/]+)\/(claude|codex)\.jsonl$/.exec(path);
    if (m) {
      const lines = replay.records.filter((r) => r.line !== undefined && r.tid === m[1] && r.t <= T.now).map((r) => r.line);
      if (!lines.length || agentOf(m[1]) !== m[2]) return res(404);
      let body = lines.join("\n") + "\n";
      if (partialAt !== null && Math.abs(T.now - partialAt) < 1e-9) body = body.slice(0, -10); // caught mid-write
      return res(200, body);
    }
    return res(404);
  };
  return { fetch, T, requests };
}

async function liveShow(name, serverOpts) {
  const replay = loadReplay(name);
  const server = fakeServer(replay, serverOpts);
  const errors = [];
  const source = new LiveSource("", { fetch: server.fetch, clock: () => server.T.now, onError: (e) => errors.push(e) });
  const sink = new RecordingSink();
  const d = new Director({ source, sink, clock: () => server.T.now });
  for (let t = 0; t <= replay.endT + 400 && !d.finished; t += 0.25) {
    server.T.now = t;
    await source.poll(t);
    await d.tick(t);
  }
  return { sink, d, server, source, replay, errors };
}

const lastPerTurn = (sink) => {
  const m = new Map();
  for (const c of sink.of("judge")) if (c.args[1].turn) m.set(c.args[1].turn.tid, c.args[1]);
  return m;
};

test("LiveSource: the show over polled data is the show of the engine's transcript", async () => {
  for (const name of ["no-majority", "unavailable", "last-word"]) {
    const { sink, d, replay } = await liveShow(name);
    assert.equal(d.finished, true, name);
    assert.deepEqual(showCalls(sink).map(keyOf).filter(Boolean), expectedKeys(replay.stateAt(Infinity), sink), name);
  }
});

test("LiveSource: logs are tailed by line count, each line once, the right file per CLI", async () => {
  const { sink, server, replay } = await liveShow("activity");
  const turns = lastPerTurn(sink);
  const kinds = (tid) => turns.get(tid).activity.map((a) => a.kind);
  assert.deepEqual(kinds("p1-r1-message-opus-5.5"), ["open", "list", "image", "search"]);
  assert.deepEqual(kinds("p1-r1-message-gpt-6.1-sol"), ["read", "open", "search"], "the started+completed pair is one call");
  assert.deepEqual(kinds("p1-r1-message-gpt-6-astra"), ["list", "tool", "image"]);
  const logRequests = server.requests.filter((r) => /\.jsonl$/.test(r.path));
  assert.ok(logRequests.some((r) => r.path === "turns/p1-r1-message-opus-5.5/claude.jsonl"));
  assert.ok(logRequests.some((r) => r.path === "turns/p1-r1-message-gpt-6.1-sol/codex.jsonl"));
  assert.ok(!logRequests.some((r) => r.path.includes("-opus-5.5/codex") || r.path.includes("-gpt-6.1-sol/claude")), "no probing of the other CLI's file");
  // a turn's log is not polled before the turn is active, and not long after it
  const opusTurn = replay.records.filter((r) => r.tid === "p1-r1-message-opus-5.5" && r.line);
  const first = logRequests.find((r) => r.path.includes("message-opus-5.5/"));
  const last = logRequests.filter((r) => r.path.includes("message-opus-5.5/")).at(-1);
  assert.ok(first.at >= 0 && last.at <= opusTurn.at(-1).t + 1.5, `last read at ${last.at}`);
  // the live layer matches the one from the replay directly
  const { runShow } = await import("./helpers.mjs");
  const direct = lastPerTurn((await runShow("activity")).sink);
  for (const [tid, p] of direct) {
    if (!p.turn || p.turn.kind !== "message") continue;
    assert.deepEqual(turns.get(tid).activity.map((a) => [a.kind, a.label, a.path]), p.activity.map((a) => [a.kind, a.label, a.path]), tid);
  }
});

test("LiveSource: a retry (-a2) is found by probing its prompt.txt", async () => {
  const { sink, server } = await liveShow("retry");
  assert.ok(server.requests.some((r) => r.method === "HEAD" && r.path === "turns/p1-r1-message-sonnet-5.5-a2/prompt.txt"));
  assert.ok(server.requests.some((r) => r.path === "turns/p1-r1-message-sonnet-5.5-a2/claude.jsonl"));
  assert.ok(server.requests.some((r) => r.path === "turns/p1-r1-vote-gpt-6.1-sol-a2/codex.jsonl"));
  const turns = lastPerTurn(sink);
  assert.deepEqual(turns.get("p1-r1-message-sonnet-5.5-a2").activity.map((a) => a.label), ["Glob"]);
  assert.deepEqual(turns.get("p1-r1-message-sonnet-5.5").activity.map((a) => a.label), ["Read"], "the first ask keeps its own");
  // prompt.txt time is reported (the turn start fallback)
  const probes = server.requests.filter((r) => r.method === "HEAD" && r.path.endsWith("prompt.txt"));
  assert.ok(probes.length > 0 && probes.length < 400, `${probes.length} probes`);
});

test("LiveSource: a half-written last line waits for the next poll; a failed poll is survived", async () => {
  const base = await liveShow("activity");
  const withHiccups = await liveShow("activity", { partialAt: 8.25, failAt: 5 });
  assert.ok(withHiccups.errors.length >= 1, "the 500 was reported");
  assert.equal(withHiccups.d.finished, true);
  const norm = (sink) => [...lastPerTurn(sink)].map(([tid, p]) => [tid, p.activity.map((a) => a.label)]);
  assert.deepEqual(norm(withHiccups.sink), norm(base.sink), "no line lost or doubled");
});

test("LiveSource: an unchanged state.json is reported once, runKey is the run's created_at", async () => {
  const replay = loadReplay("no-majority");
  const server = fakeServer(replay);
  const source = new LiveSource("http://127.0.0.1:8780/", { fetch: server.fetch, clock: () => server.T.now });
  assert.equal(await source.runKey(), "2026-10-24T11:59:00Z");
  server.T.now = 0.5;
  await source.poll(0.5);
  const first = source.read(0.5);
  assert.equal(first.filter((i) => i.state).length, 1);
  server.T.now = 1.6;
  await source.poll(1.6); // state polled again, replay state at 1.6 is the same as at 0.5? only if nothing changed
  const again = source.read(1.6).filter((i) => i.state);
  assert.ok(again.length <= 1);
  server.T.now = 2.7;
  await source.poll(2.7);
  const same = source.read(2.7).filter((i) => i.state);
  assert.equal(same.length, 0, "no turn started between 1.6 and 2.7: the same file is not reported again");
});
