// What the Judge read: content on activity items (director/content.js, activity.js results).
import { test } from "node:test";
import assert from "node:assert/strict";
import { Director } from "../../director/director.js";
import { RecordingSink } from "../../director/sinks.js";
import { ReplaySource } from "../../director/sources/replay.js";
import { resultsFrom, resultsFromLine } from "../../director/activity.js";
import { TEXT_MAX, contentOf, publicationPath, pubUrl } from "../../director/content.js";
import { FINALISTS, JUDGES, L } from "./sim.mjs";

const base = (over = {}) => ({ status: "running", started_at: "2026-10-24T12:00:00.000Z", finished_at: null, duration_s: null,
  settings: { places: 1, rounds_per_place: 3, retries: 1 }, finalists: FINALISTS, votes: [], placements: [],
  judges: JUDGES.map((j) => ({ ...j, status: "ждёт", log: null })), current: { place: 1, round: 1, phase: "discussion" },
  transcript: [{ kind: "round", place: 1, round: 1, at: "x" }], ...over });
const writes = (name) => base({ judges: base().judges.map((j) => (j.name === name ? { ...j, status: "пишет" } : j)) });
const OPUS = "opus-5.5", SOL = "gpt-6.1-sol";
const tidOf = (name) => `p1-r1-message-${name}`;

// plays `records` (after the Judge's state and prompt) and returns the sink and the director
async function play(name, records, opts = {}) {
  const tid = tidOf(name);
  const recs = [{ t: 0, state: writes(name) }, { t: 0.1, tid, prompt: true }, ...records.map(([t, line]) => ({ t, tid, line }))];
  const sink = new RecordingSink();
  const d = new Director({ source: new ReplaySource(recs, { startedAt: "2026-10-24T12:00:00.000Z" }), sink, clock: () => 0, ...opts });
  for (let t = 0; t <= 20; t += 0.5) await d.tick(t);
  return { sink, d };
}
const states = (sink, name) => sink.of("judge").filter((c) => c.args[0] === name).map((c) => c.args[1].activity);
const last = (sink, name) => states(sink, name).at(-1);

test("Claude: a tool_use is pending until its tool_result arrives, then carries the string", async () => {
  const { sink } = await play(OPUS, [[1, L.claudeTool("t1", "Read", { file_path: "solutions/team-003/build_report.json" })],
    [3, L.claudeToolResult("t1", '{"ok": true}')]]);
  const seen = states(sink, OPUS).filter((a) => a.length);
  assert.equal(seen.length, 2, "the live layer is told twice: the call, then its result");
  assert.equal(seen[0][0].content, null, "pending");
  assert.deepEqual(seen[1][0].content, { text: '{"ok": true}', truncated: false });
  assert.equal(seen[1][0].label, "Read");
  assert.equal(seen[1][0].at, 1, "the item keeps the time of the call");
  assert.equal(seen[1].length, 1, "one item, not a second one for the result");
});

test("Claude: a result as a list of blocks: text blocks joined, images not read", async () => {
  const blocks = [{ type: "text", text: "first" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }, { type: "text", text: "second" }];
  const { sink } = await play(OPUS, [[1, L.claudeTool("t1", "Grep", { pattern: "x" })], [2, L.claudeToolResult("t1", blocks)]]);
  assert.deepEqual(last(sink, OPUS)[0].content, { text: "first\nsecond", truncated: false });
});

test("a result of no text or an unknown shape is {} (arrived, nothing to show); an error result still has its text", async () => {
  const lines = [[1, L.claudeTool("a", "Read", { file_path: "a" })], [1, L.claudeTool("b", "Read", { file_path: "b" })], [1, L.claudeTool("c", "Read", { file_path: "c" })],
    [1, L.claudeTool("d", "Read", { file_path: "d" })],
    [2, L.claudeToolResult("a", "")], [2, L.claudeToolResult("b", { weird: true })], [2, L.claudeToolResult("c", 42)],
    [2, L.claudeToolResult("d", "ENOENT: no such file", { is_error: true })]];
  const { sink } = await play(OPUS, lines);
  assert.deepEqual(last(sink, OPUS).map((a) => a.content), [{}, {}, {}, { text: "ENOENT: no such file", truncated: false, error: true }]);
});

test("text is cut at 4000 characters and says so; a surrogate pair is not split", async () => {
  const long = "абв".repeat(2000);
  const { sink } = await play(OPUS, [[1, L.claudeTool("t1", "Read", { file_path: "a" })], [2, L.claudeToolResult("t1", long)]]);
  const c = last(sink, OPUS)[0].content;
  assert.equal(TEXT_MAX, 4000);
  assert.equal(c.text, long.slice(0, 4000));
  assert.equal(c.truncated, true);
  assert.equal(contentOf({ text: "x".repeat(4000) }, {}).truncated, false, "exactly 4000: whole");
  const emoji = contentOf({ text: "a".repeat(3999) + "😀tail" }, {});
  assert.equal(emoji.text, "a".repeat(3999));
  assert.equal(emoji.truncated, true);
});

test("Codex mcp_tool_call: item.started is pending, item.completed carries result.content[] text", async () => {
  const args = { path: "teams/team-003/source/src/SUBMISSION.md" };
  const { sink } = await play(SOL, [[1, L.codexStart()], [1, L.codexMcpCall("m1", "final", "read_file", args, "item.started")],
    [3, L.codexMcpCall("m1", "final", "read_file", args, "item.completed", { result: { content: [{ type: "text", text: "# Концепт" }, { type: "text", text: "второй блок" }], structured_content: null } })]]);
  const seen = states(sink, SOL).filter((a) => a.length);
  assert.equal(seen.length, 2);
  assert.equal(seen[0][0].content, null);
  assert.deepEqual(seen[1][0], { kind: "open", path: args.path, label: "mcp__final__read_file", at: 1, content: { text: "# Концепт\nвторой блок", truncated: false } });
  assert.equal(seen[1].length, 1, "started and completed are one item");
});

test("Codex: result as a string, an error message, an unknown shape; a call with no result stays pending", async () => {
  const done = (id, extra) => L.codexMcpCall(id, "final", "read_file", { path: id }, "item.completed", extra);
  const { sink } = await play(SOL, [
    [1, L.codexMcpCall("s", "final", "read_file", { path: "s" }, "item.started")],
    [1, L.codexMcpCall("r", "final", "read_file", { path: "r" }, "item.started")],
    [1, L.codexMcpCall("e", "final", "read_file", { path: "e" }, "item.started")],
    [1, L.codexMcpCall("u", "final", "read_file", { path: "u" }, "item.started")],
    [1, L.codexMcpCall("p", "final", "read_file", { path: "p" }, "item.started")],
    [2, done("s", { result: "plain string" })], [2, done("r", { result: { content: [{ type: "text", text: "in blocks" }] } })],
    [2, done("e", { error: { message: "no such file" }, status: "failed" })], [2, done("u", { result: { structured_content: { a: 1 } } })]]);
  const byPath = Object.fromEntries(last(sink, SOL).map((a) => [a.path, a.content]));
  assert.deepEqual(byPath, {
    s: { text: "plain string", truncated: false }, r: { text: "in blocks", truncated: false },
    e: { text: "no such file", truncated: false, error: true }, u: {}, p: null,
  });
});

test("Codex command_execution: its aggregated_output is the content", async () => {
  const { sink } = await play(SOL, [[1, L.codexCmd("c1", "cat a.md", "item.started")],
    [2, JSON.stringify({ type: "item.completed", item: { id: "c1", type: "command_execution", command: "cat a.md", aggregated_output: "строка 1\n", exit_code: 0, status: "completed" } })]]);
  assert.deepEqual(last(sink, SOL)[0].content, { text: "строка 1\n", truncated: false });
});

test("an image read of a Materials file gets /pub/<path>; one outside gets a data: URL from the block", async () => {
  const png = [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }];
  const rel = "solutions/team-003/screenshots/opus-5.5/01.png";
  const { sink } = await play(OPUS, [
    [1, L.claudeTool("i1", "Read", { file_path: rel })], [1, L.claudeToolResult("i1", png)],
    [2, L.claudeTool("i2", "Read", { file_path: "./solutions/./team-003/screenshots/a b.jpg" })], [2, L.claudeToolResult("i2", png)],
    [3, L.claudeTool("i3", "Read", { file_path: "/srv/pub/solutions/team-011/screenshots/x/02.png" })], [3, L.claudeToolResult("i3", png)],
    [4, L.claudeTool("i4", "Read", { file_path: "/etc/passwd.png" })], [4, L.claudeToolResult("i4", png)],
    [5, L.claudeTool("i5", "Read", { file_path: "../secrets/shot.png" })], [5, L.claudeToolResult("i5", png)],
    [6, L.claudeTool("i6", "Read", { file_path: "/home/judge/elsewhere/shot.png" })], [6, L.claudeToolResult("i6", png)],
    [7, L.claudeTool("i7", "Read", { file_path: "solutions/team-003/notes.md" })], [7, L.claudeToolResult("i7", "text file")],
  ], { pubRoot: ["/srv/pub/"] });
  const imgs = last(sink, OPUS).map((a) => a.content.image ?? null);
  assert.deepEqual(imgs, [
    `/pub/${rel}`,
    "/pub/solutions/team-003/screenshots/a%20b.jpg",
    "/pub/solutions/team-011/screenshots/x/02.png",
    // outside the Materials: the picture of the result's own block, as a data: URL
    "data:image/png;base64,AAAA", "data:image/png;base64,AAAA", "data:image/png;base64,AAAA",
    null,
  ]);
  assert.deepEqual(last(sink, OPUS)[0].content, { image: `/pub/${rel}` }, "an image result has no text");
  assert.deepEqual(last(sink, OPUS)[0].kind, "image");
  assert.deepEqual(last(sink, OPUS)[6].content, { text: "text file", truncated: false });
});

test("an absolute image path with no pubRoot configured gets no image; a failed read gets none", () => {
  assert.equal(pubUrl("/srv/pub/a/b.png", []), null);
  assert.equal(pubUrl("/srv/pub/a/b.png", "/srv/pub"), "/pub/a/b.png");
  assert.equal(pubUrl("/srv/pubx/a.png", "/srv/pub"), null, "a sibling folder is not the publication");
  assert.equal(pubUrl("a/../../b.png", []), null);
  assert.equal(pubUrl("~/x.png", []), null);
  assert.equal(pubUrl("https://x/y.png", []), null);
  assert.equal(publicationPath("a/b/../c.png"), "a/c.png");
  assert.equal(contentOf({ text: null, image: { mime: "image/png", data: "AAAA" }, error: true }, { kind: "image", path: "a/b.png" }).image, undefined);
  assert.deepEqual(contentOf({ text: "\u0000PNG�", error: false }, { kind: "image", path: "a/b.png" }), { image: "/pub/a/b.png" }, "bytes are not text");
});

test("the result can come in a later poll than the call, and the live layer only updates", async () => {
  const { sink, d } = await play(OPUS, [[1, L.claudeTool("t1", "Read", { file_path: "a" })], [9, L.claudeToolResult("t1", "late")]]);
  const seen = states(sink, OPUS).filter((a) => a.length);
  assert.equal(seen[0][0].content, null);
  assert.deepEqual(seen.at(-1)[0].content, { text: "late", truncated: false });
  assert.equal(d.queue.depth, 0, "nothing was queued for it");
  // the round's opening (and the ceiling line, when a Finalist is capped) and nothing for the result
  assert.equal(d.cursor, d.planner.n, "only the round's own beats of the state were played");
  assert.ok(d.planner.n <= 2);
});

test("a result for a call that has fallen out of the activity window is ignored; a result before its call waits for it", async () => {
  const calls = Array.from({ length: 14 }, (_, i) => [1 + i * 0.1, L.claudeTool(`k${i}`, "Read", { file_path: `f${i}` })]);
  const { sink } = await play(OPUS, [...calls, [5, L.claudeToolResult("k0", "old")], [5, L.claudeToolResult("k13", "newest")]], { activityMax: 12 });
  const a = last(sink, OPUS);
  assert.equal(a.length, 12);
  assert.deepEqual(a.at(-1).content, { text: "newest", truncated: false });
  assert.equal(a.filter((x) => x.content).length, 1);
  const early = await play(OPUS, [[1, L.claudeToolResult("z", "early")], [2, L.claudeTool("z", "Read", { file_path: "z" })]]);
  assert.deepEqual(last(early.sink, OPUS)[0].content, { text: "early", truncated: false });
});

test("a retry or a new turn starts with no content from the turn before", async () => {
  const sink = new RecordingSink();
  const T = tidOf(OPUS);
  const down = base({ judges: base().judges.map((j) => (j.name === OPUS ? { ...j, status: "недоступен" } : j)) });
  const d = new Director({ sink, clock: () => 0, source: new ReplaySource([
    { t: 0, state: writes(OPUS) }, { t: 0.1, tid: T, prompt: true },
    { t: 1, tid: T, line: L.claudeTool("a", "Read", { file_path: "first" }) }, { t: 1.5, tid: T, line: L.claudeToolResult("a", "first text") },
    { t: 2, state: down }, { t: 3, state: writes(OPUS) }, { t: 3.1, tid: `${T}-a2`, prompt: true },
    { t: 4, tid: `${T}-a2`, line: L.claudeTool("a", "Read", { file_path: "second" }) },
  ], { startedAt: "2026-10-24T12:00:00.000Z" }) });
  for (let t = 0; t <= 6; t += 0.5) await d.tick(t);
  assert.deepEqual(last(sink, OPUS).map((a) => [a.path, a.content]), [["second", null]]);
});

test("results are parsed from raw events: Claude user blocks, Codex items; anything else has none", () => {
  assert.deepEqual(resultsFromLine(L.claudeToolResult("q", "t")), [{ id: "q", text: "t", image: null, error: false }]);
  assert.deepEqual(resultsFromLine(L.claudeResult("q")), [{ id: "q", text: "…", image: null, error: false }]);
  assert.deepEqual(resultsFrom({ type: "user", message: { content: [{ type: "text", text: "hi" }] } }), []);
  assert.deepEqual(resultsFromLine(L.claudeText("x")), []);
  assert.deepEqual(resultsFromLine(L.codexMcpCall("m", "s", "t", {}, "item.started")), [], "no result before item.completed");
  assert.deepEqual(resultsFromLine(L.codexItem("w", "web_search", { query: "x" })), [], "not a tool the monitor reads");
  assert.deepEqual(resultsFromLine("not json"), []);
});
