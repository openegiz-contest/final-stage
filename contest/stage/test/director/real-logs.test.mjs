// The Final's tool calls as the Judge CLIs really write them: turn logs of a live Final on the new fixture
// (test/director/fixtures/real/, README there). Cases the real run did not produce (a refusal, Claude's
// read_file and search_text) are built from the documented shape (openegiz-judge docs/design.md «Final»,
// «Raw events of a tool call») and marked SYNTHETIC.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Director } from "../../director/director.js";
import { RecordingSink } from "../../director/sinks.js";
import { ReplaySource } from "../../director/sources/replay.js";
import { StateDiffer } from "../../director/events.js";
import { activityFromLine, resultsFromLine, turnEndFromLine } from "../../director/activity.js";
import { IMAGE_DATA_MAX } from "../../director/content.js";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "real");
const lines = (f) => readFileSync(join(DIR, f), "utf8").split("\n").filter(Boolean);
const STATE = JSON.parse(readFileSync(join(DIR, "state.json"), "utf8"));
const OPUS = "opus-5.5", ASTRA = "gpt-6-astra";
const MSG = { [OPUS]: lines("p1-r1-message-opus-5.5.claude.jsonl"), [ASTRA]: lines("p1-r1-message-gpt-6-astra.codex.jsonl") };
const VOTE = { [OPUS]: lines("p1-r1-vote-opus-5.5.claude.jsonl"), [ASTRA]: lines("p1-r1-vote-gpt-6-astra.codex.jsonl") };
const REAL_SINCE = STATE.judges.find((j) => j.since).since; // a real `since` from the engine's state

// the real state, set at the start of place 1, round 1, with `name` working since `since`
function stateOf(name, kind = "message", since = REAL_SINCE) {
  const judges = STATE.judges.map((j) => ({ ...j, status: j.name === name ? (kind === "vote" ? "голосует" : "пишет") : "ждёт", since: j.name === name ? since : null }));
  return { ...STATE, status: "running", finished_at: null, current: { place: 1, round: 1, phase: kind === "vote" ? "voting" : "discussion" },
    judges, transcript: [STATE.transcript[0]], votes: [], placements: [] };
}

// plays raw log lines of one Judge's turn through a Director; returns the sink
async function play(name, rawLines, { kind = "message", since = REAL_SINCE, step = 0.5 } = {}) {
  const tid = `p1-r1-${kind}-${name}`;
  const recs = [{ t: 0, state: stateOf(name, kind, since) }, { t: 0.1, tid, prompt: true }, ...rawLines.map((line, i) => ({ t: 1 + i * step, tid, line }))];
  const sink = new RecordingSink();
  const d = new Director({ source: new ReplaySource(recs, { startedAt: STATE.started_at }), sink, clock: () => 0 });
  for (let t = 0; t <= 2 + rawLines.length * step; t += step) await d.tick(t);
  return { sink, d };
}
const finalJudge = (sink, name) => sink.of("judge").filter((c) => c.args[0] === name).at(-1).args[1];
const callsIn = (rawLines) => rawLines.flatMap((l) => activityFromLine(l, 0));

// --- real Claude message turn ----------------------------------------------------------------

test("real Claude turn: list_dir and view_image calls get the short tool name, a kind, a path", async () => {
  const { sink } = await play(OPUS, MSG[OPUS]);
  const acts = finalJudge(sink, OPUS).activity;
  assert.deepEqual(acts.map((a) => [a.kind, a.label]), [["list", "list_dir"], ["list", "list_dir"], ["list", "list_dir"], ["list", "list_dir"], ["image", "view_image"], ["image", "view_image"]]);
  assert.ok(acts.every((a) => !a.label.includes("mcp__")));
  assert.deepEqual(acts.map((a) => a.path), [
    "publication/solutions/team-003/screenshots", "publication/solutions/team-011/screenshots",
    "publication/solutions/team-003/screenshots/opus-5.5", "publication/solutions/team-011/screenshots/opus-5.5",
    "publication/solutions/team-003/screenshots/opus-5.5/01-overview.png", "publication/solutions/team-011/screenshots/opus-5.5/01-overview.png"]);
});

test("real Claude turn: a listing shows the result's text, a screenshot shows its file URL (/pub/<Materials path>) and no text", async () => {
  const { sink } = await play(OPUS, MSG[OPUS]);
  const acts = finalJudge(sink, OPUS).activity;
  assert.match(acts[0].content.text, /^publication\/solutions\/team-003\/screenshots\/ \(4 entries\)/);
  assert.equal(acts[0].content.truncated, false);
  assert.deepEqual(acts[4].content, { image: "/pub/publication/solutions/team-003/screenshots/opus-5.5/01-overview.png" });
  assert.deepEqual(acts[5].content, { image: "/pub/publication/solutions/team-011/screenshots/opus-5.5/01-overview.png" });
  assert.ok(acts.every((a) => a.content && !a.content.error));
});

test("real Claude turn: the state's own `since` is used (sinceSource: state), and the turn is the one the log belongs to", async () => {
  const { sink } = await play(OPUS, MSG[OPUS]);
  const p = finalJudge(sink, OPUS);
  assert.equal(p.sinceSource, "state");
  assert.equal(p.sinceIso, REAL_SINCE);
  assert.equal(p.turn.tid, `p1-r1-message-${OPUS}`);
  assert.equal(p.status, "пишет");
  // without a `since` in the state the prompt.txt time is the fallback
  const { sink: s2 } = await play(OPUS, MSG[OPUS].slice(0, 3), { since: null });
  assert.equal(finalJudge(s2, OPUS).sinceSource, "prompt");
});

// --- real Codex message turn -----------------------------------------------------------------

test("real Codex turn: item.started and item.completed of one call are shown once", async () => {
  const rawIds = new Set(MSG[ASTRA].map((l) => JSON.parse(l)).filter((e) => e.item?.type === "mcp_tool_call").map((e) => e.item.id));
  const started = MSG[ASTRA].map((l) => JSON.parse(l)).filter((e) => e.type === "item.started" && e.item.type === "mcp_tool_call").length;
  const completed = MSG[ASTRA].map((l) => JSON.parse(l)).filter((e) => e.type === "item.completed" && e.item.type === "mcp_tool_call").length;
  assert.equal(started, completed);
  assert.ok(rawIds.size >= 6);
  const { sink } = await play(ASTRA, MSG[ASTRA]);
  const acts = finalJudge(sink, ASTRA).activity;
  assert.equal(acts.length, rawIds.size, "one item per call");
  assert.deepEqual(acts.map((a) => a.label).sort(), callsIn(MSG[ASTRA]).filter((a, i, all) => all.findIndex((b) => b.id === a.id) === i).map((a) => a.label).sort());
  assert.ok(acts.every((a) => a.content), "every call got its result");
});

test("real Codex turn: list_dir, read_file and view_image are classified, labelled short, and carry their content", async () => {
  const { sink } = await play(ASTRA, MSG[ASTRA]);
  const acts = finalJudge(sink, ASTRA).activity;
  const by = (label) => acts.filter((a) => a.label === label);
  assert.ok(by("list_dir").length >= 4 && by("list_dir").every((a) => a.kind === "list"));
  const [read] = by("read_file");
  assert.equal(read.kind, "open");
  assert.equal(read.path, "teams/team-011/source/src/SUBMISSION.md");
  assert.match(read.content.text, /^teams\/team-011\/source\/src\/SUBMISSION\.md \(843 B\), lines 1-27:/);
  const images = by("view_image");
  assert.equal(images.length, 3);
  assert.deepEqual(images.map((a) => a.content.image), images.map((a) => "/pub/" + a.path));
  assert.ok(images.every((a) => a.kind === "image" && a.content.text === undefined), "the base64 block is not text");
  assert.ok(acts.every((a) => !a.label.includes("mcp__")));
});

test("real Codex turn: a started call is pending (content null) until its item.completed arrives", async () => {
  const startIdx = MSG[ASTRA].findIndex((l) => l.includes('"item.started"') && l.includes('"view_image"'));
  const doneIdx = MSG[ASTRA].findIndex((l) => l.includes('"item.completed"') && l.includes('"view_image"'));
  const { sink } = await play(ASTRA, MSG[ASTRA].slice(0, startIdx + 1));
  const pending = finalJudge(sink, ASTRA).activity.at(-1);
  assert.equal(pending.label, "view_image");
  assert.equal(pending.content, null);
  const { sink: s2 } = await play(ASTRA, MSG[ASTRA].slice(0, doneIdx + 1));
  assert.ok(finalJudge(s2, ASTRA).activity.some((a) => a.label === "view_image" && a.content?.image));
});

// --- votes have no tools ---------------------------------------------------------------------

test("real vote turns carry no tool call; their end is read from the log", () => {
  for (const name of [OPUS, ASTRA]) {
    assert.deepEqual(callsIn(VOTE[name]), [], name);
    assert.deepEqual(VOTE[name].flatMap((l) => resultsFromLine(l)), [], name);
    assert.deepEqual(VOTE[name].map(turnEndFromLine).filter(Boolean), [{ failed: false }], name);
  }
  assert.deepEqual(JSON.parse(VOTE[OPUS][0]).tools, [], "the vote's Claude lists no tool");
});

test("the fixtures are what the adapter claims to read: every call is on the materials server", () => {
  for (const l of MSG[OPUS]) for (const b of JSON.parse(l).message?.content ?? []) if (b.type === "tool_use") assert.match(b.name, /^mcp__materials__(list_dir|read_file|search_text|view_image)$/);
  for (const l of MSG[ASTRA]) { const i = JSON.parse(l).item; if (i?.type === "mcp_tool_call") assert.equal(i.server, "materials"); }
});

// --- image URL or data URL -------------------------------------------------------------------

test("a view_image path outside the Materials gets a data: URL from the real image block; an oversized block gets none", async () => {
  const use = JSON.parse(MSG[OPUS].find((l) => l.includes('"view_image"') && l.includes('"tool_use"')));
  const res = JSON.parse(MSG[OPUS].find((l) => l.includes('"tool_result"') && l.includes('"image"')));
  const id = use.message.content[0].id;
  assert.equal(res.message.content[0].tool_use_id, id, "the first image result is the first view_image call");
  for (const path of ["/Users/x/shot.png", "../shot.png", "~/shot.png"]) {
    use.message.content[0].input = { path };
    const { sink } = await play(OPUS, [JSON.stringify(use), JSON.stringify(res)]);
    const [a] = finalJudge(sink, OPUS).activity;
    assert.equal(a.kind, "image");
    assert.match(a.content.image, /^data:image\/png;base64,iVBORw0KGgo/, path);
  }
  const big = structuredClone(res);
  big.message.content[0].content[0].source.data = "A".repeat(IMAGE_DATA_MAX + 4);
  use.message.content[0].input = { path: "/Users/x/shot.png" };
  const { sink } = await play(OPUS, [JSON.stringify(use), JSON.stringify(big)]);
  assert.deepEqual(finalJudge(sink, OPUS).activity[0].content, {}, "too big: no picture, no text");
});

// --- SYNTHETIC: shapes the real run did not produce, built from docs/design.md «Final» --------

const useLine = (id, tool, input) => JSON.stringify({ type: "assistant", message: { id: "msg_1", content: [{ type: "tool_use", id, name: `mcp__materials__${tool}`, input }] } });
const resLine = (id, content, extra = {}) => JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content, ...extra }] } });
const codexCall = (phase, id, tool, args, extra = {}) => JSON.stringify({ type: phase, item: { id, type: "mcp_tool_call", server: "materials", tool, arguments: args,
  result: null, error: null, status: phase === "item.started" ? "in_progress" : "completed", ...extra } });

test("SYNTHETIC Claude read_file and search_text: short labels, the query in the label, lines in the content", async () => {
  const { sink } = await play(OPUS, [
    useLine("t1", "read_file", { path: "teams/team-003/source/src/SUBMISSION.md" }),
    useLine("t2", "read_file", { path: "teams/team-003/source/src/team/mine/model.py", start_line: 40, max_lines: 80 }),
    useLine("t3", "search_text", { query: "вентиляция", path: "teams/team-003/source/src" }),
    useLine("t4", "search_text", { query: "ceiling" }),
    resLine("t1", [{ type: "text", text: "teams/team-003/source/src/SUBMISSION.md (812 B), lines 1-3:\n    1  # Горный поток\n    2  \n    3  Двойник шахты." }]),
    resLine("t3", [{ type: "text", text: "teams/team-003/source/src/team/mine/vent.py:12: # вентиляция по выработкам" }]),
  ]);
  const acts = finalJudge(sink, OPUS).activity;
  assert.deepEqual(acts.map((a) => [a.kind, a.label, a.path]), [
    ["open", "read_file", "teams/team-003/source/src/SUBMISSION.md"],
    ["read", "read_file", "teams/team-003/source/src/team/mine/model.py"],
    ["search", "search_text «вентиляция»", "teams/team-003/source/src"],
    ["search", "search_text «ceiling»", "."],
  ]);
  assert.match(acts[0].content.text, /Двойник шахты\.$/);
  assert.equal(acts[1].content, null);
  assert.match(acts[2].content.text, /vent\.py:12/);
});

test("SYNTHETIC Claude refusal: is_error with a string; the tool stays the tool, the text is the refusal, marked as an error, no image", async () => {
  const text = "Error executing tool read_file: refused: '/etc/hosts' is not a path inside the Final Materials (absolute paths are not allowed)";
  const { sink } = await play(OPUS, [
    useLine("r1", "read_file", { path: "/etc/hosts" }), resLine("r1", text, { is_error: true }),
    useLine("r2", "view_image", { path: "../../secret.png" }),
    resLine("r2", "Error executing tool view_image: refused: '../../secret.png' leads outside the Final Materials", { is_error: true }),
  ]);
  const [a, b] = finalJudge(sink, OPUS).activity;
  assert.deepEqual([a.kind, a.label, a.path], ["open", "read_file", "/etc/hosts"]);
  assert.deepEqual(a.content, { text, truncated: false, error: true });
  assert.equal(b.label, "view_image");
  assert.equal(b.content.error, true);
  assert.equal(b.content.image, undefined, "a refused picture is not shown");
  assert.match(b.content.text, /leads outside the Final Materials/);
});

test("SYNTHETIC Codex refusal: status failed, error null, the text in result.content[0].text", async () => {
  const text = "Error executing tool read_file: refused: '/etc/hosts' is not a path inside the Final Materials (absolute paths are not allowed)";
  const { sink } = await play(ASTRA, [
    codexCall("item.started", "item_0", "read_file", { path: "/etc/hosts" }),
    codexCall("item.completed", "item_0", "read_file", { path: "/etc/hosts" }, { status: "failed", result: { content: [{ type: "text", text }], structured_content: null } }),
    codexCall("item.started", "item_1", "view_image", { path: "/etc/hosts.png" }),
    codexCall("item.completed", "item_1", "view_image", { path: "/etc/hosts.png" }, { status: "failed", result: { content: [{ type: "text", text }], structured_content: null } }),
  ]);
  const acts = finalJudge(sink, ASTRA).activity;
  assert.equal(acts.length, 2, "each call once");
  assert.deepEqual(acts[0].content, { text, truncated: false, error: true });
  assert.equal(acts[0].label, "read_file");
  assert.deepEqual([acts[1].label, acts[1].content.error, acts[1].content.image], ["view_image", true, undefined]);
});

test("SYNTHETIC search_text label: a long query is cut so it fits a header", () => {
  const [a] = activityFromLine(useLine("q", "search_text", { query: "x".repeat(200) }), 0);
  assert.ok(a.label.length < 70 && a.label.endsWith("…»"), a.label);
});

// --- the engine's message entries carry pick and rival ----------------------------------------

test("real state: message events carry pick and rival (rival may be null)", () => {
  const msgs = STATE.transcript.filter((e) => e.kind === "message");
  assert.ok(msgs.length >= 5 && msgs.every((m) => "pick" in m && "rival" in m), "the fixture state has the fields");
  const events = new StateDiffer().diff(STATE).filter((e) => e.type === "message");
  assert.deepEqual(events.map((e) => [e.judge, e.pick, e.rival]), msgs.map((m) => [m.judge, m.pick, m.rival]));
  assert.ok(events.every((e) => /^team-\d+$/.test(e.pick)));
});
