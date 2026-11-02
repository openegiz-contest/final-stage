import { test } from "node:test";
import assert from "node:assert/strict";
import { activityFrom, activityFromLine, commandActivity } from "../../director/activity.js";
import { L } from "./sim.mjs";

const one = (line, at = 5) => {
  const out = activityFromLine(line, at);
  assert.equal(out.length, 1, line);
  const { id, ...a } = out[0];
  return a;
};

test("Claude built-in tools", () => {
  assert.deepEqual(one(L.claudeTool("1", "Read", { file_path: "a/b.md" })), { kind: "open", path: "a/b.md", label: "Read", at: 5 });
  assert.deepEqual(one(L.claudeTool("1", "Read", { file_path: "a/b.md", offset: 3, limit: 20 })), { kind: "read", path: "a/b.md", label: "Read", at: 5 });
  assert.equal(one(L.claudeTool("1", "Read", { file_path: "shots/01.PNG" })).kind, "image");
  assert.equal(one(L.claudeTool("1", "Read", { file_path: "shots/01.jpeg" })).kind, "image");
  assert.deepEqual(one(L.claudeTool("1", "Glob", { pattern: "**/*.json" })), { kind: "list", path: "**/*.json", label: "Glob", at: 5 });
  assert.equal(one(L.claudeTool("1", "Glob", { pattern: "*.json", path: "solutions/" })).path, "solutions/*.json");
  assert.deepEqual(one(L.claudeTool("1", "LS", { path: "teams" })), { kind: "list", path: "teams", label: "LS", at: 5 });
  assert.deepEqual(one(L.claudeTool("1", "Grep", { pattern: "ceil", path: "solutions" })), { kind: "search", path: "solutions", label: "Grep «ceil»", at: 5 });
  assert.equal(activityFrom(JSON.parse(L.claudeTool("x7", "Read", { file_path: "a" })))[0].id, "x7");
});

test("Claude MCP tools: by the tool's own name, unknown ones keep it", () => {
  assert.deepEqual(one(L.claudeTool("1", "mcp__final__read_file", { path: "x.md" })), { kind: "open", path: "x.md", label: "mcp__final__read_file", at: 5 });
  assert.equal(one(L.claudeTool("1", "mcp__final__list_dir", { path: "x" })).kind, "list");
  assert.equal(one(L.claudeTool("1", "mcp__final__search_files", { query: "foo" })).kind, "search");
  assert.deepEqual(one(L.claudeTool("1", "mcp__vm__presentation_page_image", { path: "p1.png" })), { kind: "image", path: "p1.png", label: "mcp__vm__presentation_page_image", at: 5 });
  assert.equal(one(L.claudeTool("1", "mcp__shots__view_image", { file_path: "a.png" })).kind, "image");
  // unknown: its own name, no path, no guess
  assert.deepEqual(one(L.claudeTool("1", "mcp__final__fancy", { path: "secret", command: "rm" })), { kind: "tool", path: null, label: "mcp__final__fancy", at: 5 });
  assert.deepEqual(one(L.claudeTool("1", "WebFetch", { url: "https://x" })), { kind: "tool", path: null, label: "WebFetch", at: 5 });
  assert.deepEqual(one(L.claudeTool("1", "TodoWrite", {})), { kind: "tool", path: null, label: "TodoWrite", at: 5 });
});

test("Claude: what is not activity", () => {
  for (const line of [L.claudeInit(), L.claudeThinking(), L.claudeText("hello"), L.claudeResult("1"), L.claudeDone(), "not json", "", "[]", "null"]) {
    assert.deepEqual(activityFromLine(line, 1), [], line);
  }
  // several blocks in one message
  const multi = JSON.stringify({ type: "assistant", message: { content: [{ type: "thinking", thinking: "x" }, { type: "tool_use", id: "a", name: "Read", input: { file_path: "1" } }, { type: "tool_use", id: "b", name: "Read", input: { file_path: "2" } }] } });
  assert.deepEqual(activityFromLine(multi).map((a) => a.path), ["1", "2"]);
});

test("Codex command_execution: reads are classified, the rest keeps the program's name", () => {
  const c = (command) => { const { kind, path, label } = commandActivity(command); return [kind, path, label]; };
  assert.deepEqual(c(`/bin/zsh -lc "cat solutions/team-003/build_report.json"`), ["read", "solutions/team-003/build_report.json", "cat"]);
  assert.deepEqual(c("bash -lc 'sed -n 1,80p README.md'"), ["read", "README.md", "sed"]);
  assert.deepEqual(c("sed -n '10,20p' a b.txt"), ["read", "b.txt", "sed"]);
  assert.deepEqual(c("head -n 20 a/b.md"), ["read", "a/b.md", "head"]);
  assert.deepEqual(c("head -20 a/b.md"), ["read", "a/b.md", "head"]);
  assert.deepEqual(c("tail -n 5 log.txt"), ["read", "log.txt", "tail"]);
  assert.deepEqual(c(`rg -n "foo bar" src docs`), ["search", "src docs", "rg «foo bar»"]);
  assert.deepEqual(c(`rg -g '*.md' -e ceiling .`), ["search", ".", "rg «ceiling»"]);
  assert.deepEqual(c(`grep -rn needle solutions/`), ["search", "solutions/", "grep «needle»"]);
  assert.deepEqual(c("rg --files solutions"), ["list", "solutions", "rg"]);
  assert.deepEqual(c("ls -la teams/"), ["list", "teams/", "ls"]);
  assert.deepEqual(c("ls"), ["list", ".", "ls"]);
  assert.deepEqual(c(`find solutions -name "*.png"`), ["list", "solutions", "find"]);
  assert.deepEqual(c("cd /x && cat y.txt | head"), ["read", "y.txt", "cat"]);
  assert.deepEqual(c("cat shots/a.png"), ["image", "shots/a.png", "cat"]);
  assert.deepEqual(c("cat a.txt b.txt"), ["read", "a.txt, b.txt", "cat"]);
  // not reads
  assert.deepEqual(c("python3 -c 'print(1)'"), ["tool", null, "python3"]);
  assert.deepEqual(c("sed -i s/a/b/ f"), ["tool", null, "sed"]);
  assert.deepEqual(c("curl https://x"), ["tool", null, "curl"]);
  assert.deepEqual(c(""), ["tool", null, ""]);
});

test("Codex items: started and completed share an id; reasoning and messages are not activity", () => {
  const started = activityFromLine(L.codexCmd("i0", "cat a.md", "item.started"), 1);
  const done = activityFromLine(L.codexCmd("i0", "cat a.md"), 2);
  assert.equal(started[0].id, "i0");
  assert.equal(done[0].id, "i0");
  assert.deepEqual(one(L.codexMcp("m1", "final", "read_file", { path: "x.md" })), { kind: "open", path: "x.md", label: "mcp__final__read_file", at: 5 });
  assert.deepEqual(one(L.codexMcp("m2", "final", "other", { path: "x.md" })), { kind: "tool", path: null, label: "mcp__final__other", at: 5 });
  // arguments as a JSON string
  assert.equal(activityFromLine(JSON.stringify({ type: "item.completed", item: { id: "m3", type: "mcp_tool_call", server: "s", tool: "read_file", arguments: "{\"path\":\"z\"}" } }))[0].path, "z");
  for (const type of ["reasoning", "agent_message", "todo_list", "error"]) assert.deepEqual(activityFromLine(L.codexItem("q", type, { text: "hidden" })), [], type);
  assert.deepEqual(one(L.codexItem("w", "web_search", { query: "x" })), { kind: "tool", path: null, label: "web_search", at: 5 });
  assert.deepEqual(activityFromLine(L.codexStart()), []);
  assert.deepEqual(activityFromLine(L.codexDone()), []);
});
