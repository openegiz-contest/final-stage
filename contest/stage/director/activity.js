// The one adapter between a Judge CLI's raw log line and what the Judge's console shows.
//
//   activityFrom(event, at) -> [{ id, kind, path, label, at }]
//
//   kind   "open" | "read" | "list" | "search" | "image" | "tool"
//   path   what the call targets (file, folder, glob), or null
//   label  what to print: the tool's short name (Claude "Read"; the Final's MCP tools "list_dir",
//          "read_file", "search_text «query»", "view_image", without the "mcp__materials__" prefix;
//          Codex: the program of a command, "rg «pattern»"). An unknown tool keeps its own name and
//          kind "tool".
//   id     the CLI's id of the call (dedup: Codex sends item.started and item.completed for one call)
//
// Nothing is guessed. A call is classified only by the tables below; anything outside them is "tool"
// with its own name and no path. Reasoning/thinking blocks, plain text, tool results and Codex
// agent_message items are not activity and return [].
//
// The Final's Judges read the Final Materials through one MCP server, `materials`, with four tools
// (ADR-0009, openegiz-judge docs/design.md «Final»); their paths are relative to the Materials root.
// The tables below are the only place that knows them.

export const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|avif)$/i;

// Claude's own tools.
const CLAUDE_TOOLS = {
  Read: (i) => ({ kind: i.offset != null || i.limit != null ? "read" : "open", path: i.file_path ?? i.path ?? null }),
  Glob: (i) => ({ kind: "list", path: i.path ? `${i.path.replace(/\/$/, "")}/${i.pattern ?? ""}` : (i.pattern ?? null) }),
  LS: (i) => ({ kind: "list", path: i.path ?? null }),
  Grep: (i) => ({ kind: "search", path: i.path ?? null, label: `Grep «${i.pattern ?? ""}»` }),
};

// The Final Materials server: Claude calls the tools "mcp__materials__<tool>", Codex sends an
// mcp_tool_call with server "materials". Paths are relative to the Materials root ("publication/…",
// "teams/team-NNN/source/src/…"), so a path is also the Stage's /pub/<path>.
export const MATERIALS_SERVER = "materials";
const QUERY_MAX = 48; // a search label is cut here so it fits a header
const quoted = (q) => `«${q.length > QUERY_MAX ? q.slice(0, QUERY_MAX - 1) + "…" : q}»`;
const MATERIALS_TOOLS = {
  list_dir: (i) => ({ kind: "list", path: i.path ?? "." }),
  read_file: (i) => ({ kind: i.start_line != null || i.max_lines != null ? "read" : "open", path: i.path ?? null }),
  search_text: (i) => ({ kind: "search", path: i.path ?? ".", label: `search_text ${quoted(String(i.query ?? ""))}` }),
  view_image: (i) => ({ kind: "image", path: i.path ?? null }),
};

// Any other MCP server (a development rig, a future tool): classified by the tool's own name, first
// match wins, and shown by its full name. Not used by the Final.
const MCP_RULES = [
  [/(^|_)(image|screenshot)(_|$)/, "image"],
  [/(^|_)(grep|search|find)(_|$)/, "search"],
  [/(^|_)(list|ls|glob|tree|dir)(_|$)/, "list"],
  [/(^|_)(read|open|cat)(_|$)/, "open"],
];
const PATH_KEYS = ["file_path", "path", "file", "filepath", "filename", "image_path", "image", "screenshot",
  "dir", "directory", "glob", "pattern", "query", "url"];

// Programs of a Codex command_execution that are a read, and what each one is.
const COMMANDS = {
  cat: "read", head: "read", tail: "read", nl: "read", bat: "read", less: "read", more: "read",
  sed: "sed", rg: "search", grep: "search", egrep: "search", fgrep: "search", ack: "search",
  ls: "list", tree: "list", find: "list", fd: "list",
};
// Flags that take a value, per program group (their value is not an operand).
const VALUE_FLAGS = {
  read: new Set(["-n", "-c"]),
  sed: new Set(["-e", "-f"]),
  search: new Set(["-e", "-f", "-g", "--glob", "-t", "--type", "-A", "-B", "-C", "-m", "--max-count", "--include",
    "--exclude", "--max-depth"]),
  list: new Set(["-L", "-I", "-P", "-d", "--max-depth", "-E", "-e"]),
};

const claudeMcp = /^mcp__(.+?)__(.+)$/;

function withImage(kind, path) {
  return (kind === "open" || kind === "read") && path && IMAGE_EXT.test(path) ? "image" : kind;
}

function mcpActivity(server, tool, args) {
  args = args && typeof args === "object" ? args : {};
  if (server === MATERIALS_SERVER && MATERIALS_TOOLS[tool]) {
    const a = MATERIALS_TOOLS[tool](args);
    return { kind: a.kind, path: typeof a.path === "string" ? a.path : null, label: a.label ?? tool };
  }
  const name = `mcp__${server}__${tool}`;
  const rule = MCP_RULES.find(([re]) => re.test(tool));
  if (!rule) return { kind: "tool", path: null, label: name };
  const key = PATH_KEYS.find((k) => typeof args[k] === "string");
  const path = key ? args[key] : null;
  return { kind: withImage(rule[1], path), path, label: name };
}

// ---- shell commands -------------------------------------------------------------------------

// Tokens of a shell line, quotes honoured; unquoted && || ; | become { op } tokens.
function shellTokens(s) {
  const out = [];
  let cur = "", quote = null, has = false;
  const push = () => { if (cur || has) out.push(cur); cur = ""; has = false; };
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === "\\" && quote === '"' && i + 1 < s.length) cur += s[++i];
      else cur += c;
    } else if (c === "'" || c === '"') {
      quote = c;
      has = true;
    } else if (c === "\\" && i + 1 < s.length) {
      cur += s[++i];
      has = true;
    } else if (/\s/.test(c)) {
      push();
    } else if ((c === "&" || c === "|") && s[i + 1] === c) {
      push();
      out.push({ op: c + c });
      i++;
    } else if (c === ";" || c === "|") {
      push();
      out.push({ op: c });
    } else {
      cur += c;
    }
  }
  push();
  return out;
}

// The first simple command of a shell line (a `bash -lc '…'` wrapper is opened, leading `cd <dir> &&`
// skipped), as tokens; null when nothing is left.
export function firstCommand(line) {
  let s = String(line ?? "").trim();
  const wrap = /^(?:\S*\/)?(?:bash|zsh|sh)\s+(?:-\w+\s+)*-\w*c\s+(['"])([\s\S]*)\1\s*$/.exec(s);
  if (wrap) s = wrap[2].trim();
  const tokens = shellTokens(s);
  let seg = [];
  for (const t of tokens) {
    if (typeof t === "object") {
      if (seg[0] === "cd" && t.op === "&&") { seg = []; continue; }
      break;
    }
    seg.push(t);
  }
  return seg.length ? seg : null;
}

function operands(args, valueFlags) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--") { out.push(...args.slice(i + 1)); break; }
    if (a.length > 1 && a.startsWith("-")) {
      if (valueFlags.has(a)) i++;
      continue;
    }
    out.push(a);
  }
  return out;
}

export function commandActivity(command) {
  const tokens = firstCommand(command);
  if (!tokens) return { kind: "tool", path: null, label: String(command ?? "command_execution").slice(0, 60) };
  const program = tokens[0].split("/").pop();
  const args = tokens.slice(1);
  let type = COMMANDS[program];
  // sed reads only as `sed -n …`; anything else may edit
  if (type === "sed") type = args.some((a) => /^-[a-zA-Z]*n[a-zA-Z]*$/.test(a)) ? "read" : undefined;
  if (!type) return { kind: "tool", path: null, label: program };
  if (type === "read") {
    let files = operands(args, program === "sed" ? VALUE_FLAGS.sed : VALUE_FLAGS.read);
    // sed's first operand is the script, unless -e/-f gave it
    if (program === "sed" && !args.some((a) => a === "-e" || a === "-f")) files = files.slice(1);
    const path = program === "cat" ? files.join(", ") || null : files.at(-1) ?? null;
    return { kind: withImage("read", path), path, label: program };
  }
  if (type === "search") {
    if (args.includes("--files")) return { kind: "list", path: operands(args, VALUE_FLAGS.search).at(-1) ?? ".", label: program };
    const rest = operands(args, VALUE_FLAGS.search);
    const e = args.indexOf("-e");
    const pattern = e >= 0 ? args[e + 1] : rest.shift();
    return { kind: "search", path: rest.join(" ") || null, label: `${program} «${pattern ?? ""}»` };
  }
  const ops = operands(args, VALUE_FLAGS.list);
  const path = program === "find" ? args.find((a) => !a.startsWith("-")) ?? "." : ops.at(-1) ?? ".";
  return { kind: "list", path, label: program };
}

// ---- events ---------------------------------------------------------------------------------

const CODEX_SKIP = new Set(["agent_message", "reasoning", "todo_list", "error"]);

function claudeBlocks(event, at) {
  const out = [];
  for (const b of event.message?.content ?? []) {
    if (b?.type !== "tool_use" && b?.type !== "server_tool_use") continue;
    const input = b.input && typeof b.input === "object" ? b.input : {};
    let a;
    if (CLAUDE_TOOLS[b.name]) {
      a = CLAUDE_TOOLS[b.name](input);
      a = { kind: withImage(a.kind, a.path), path: a.path, label: a.label ?? b.name };
    } else if (b.name === "Bash") {
      a = commandActivity(input.command);
    } else if (claudeMcp.test(b.name ?? "")) {
      const [, server, tool] = claudeMcp.exec(b.name);
      a = mcpActivity(server, tool, input);
    } else {
      a = { kind: "tool", path: null, label: String(b.name ?? "tool") };
    }
    out.push({ id: b.id ?? null, ...a, at });
  }
  return out;
}

function codexItem(item, at) {
  if (!item || typeof item !== "object" || CODEX_SKIP.has(item.type)) return [];
  let a;
  if (item.type === "mcp_tool_call") {
    let args = item.arguments;
    if (typeof args === "string") { try { args = JSON.parse(args); } catch { args = null; } }
    a = mcpActivity(String(item.server ?? ""), String(item.tool ?? ""), args);
  } else if (item.type === "command_execution") {
    a = commandActivity(item.command);
  } else {
    a = { kind: "tool", path: null, label: String(item.type ?? "tool") };
  }
  return [{ id: item.id ?? null, ...a, at }];
}

export function activityFrom(event, at = null) {
  if (!event || typeof event !== "object") return [];
  if (event.type === "assistant") return claudeBlocks(event, at);
  if ((event.type === "item.started" || event.type === "item.completed") && event.item) return codexItem(event.item, at);
  return [];
}

// A raw log line (string) -> activity; unparsable lines are not activity.
export function activityFromLine(line, at = null) {
  try {
    return activityFrom(JSON.parse(line), at);
  } catch {
    return [];
  }
}

// ---- results and the end of a turn -----------------------------------------------------------
//
// What the Judge read comes back in the same log: Claude `user` / `tool_result` blocks (keyed by
// `tool_use_id`), Codex `item.completed` of an `mcp_tool_call` (`result.content[]` text blocks, or a
// `result` string, or `error.message`) or `command_execution` (`aggregated_output`). Whatever else a result
// carries (structured content) is not read; an unknown shape is a result without text. An image block
// is kept as `{ mime, data }` (base64): Claude `{type:"image", source:{type:"base64", media_type, data}}`,
// Codex `{type:"image", data, mimeType}`. A refused call is an error result: Claude `is_error: true` with
// the text as a string; Codex `status: "failed"` with the text in `result.content[0].text`.

const RESULT_ITEMS = new Set(["mcp_tool_call", "command_execution"]);

// text of a result body: a string, or a list of blocks (text blocks joined by a newline), or null
function bodyText(c, depth = 0) {
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    const parts = c.map((b) => (typeof b === "string" ? b : b && b.type === "text" && typeof b.text === "string" ? b.text : null)).filter((s) => s !== null);
    return parts.length ? parts.join("\n") : null;
  }
  if (c && typeof c === "object" && depth < 1) return bodyText(c.content, depth + 1);
  return null;
}

// the first image block of a result body as { mime, data } (base64), or null
function bodyImage(c) {
  if (!Array.isArray(c)) return null;
  for (const b of c) {
    if (!b || b.type !== "image") continue;
    const src = b.source && typeof b.source === "object" ? b.source : b;
    const data = src.data, mime = src.media_type ?? src.mimeType ?? b.mimeType ?? null;
    return { mime: typeof mime === "string" ? mime : null, data: typeof data === "string" ? data : null };
  }
  return null;
}

// A raw log event -> the results of tool calls it carries: [{ id, text: string|null, image: {mime, data}|null, error: boolean }]
export function resultsFrom(event) {
  if (!event || typeof event !== "object") return [];
  if (event.type === "user" && Array.isArray(event.message?.content)) {
    return event.message.content.filter((b) => b?.type === "tool_result" && b.tool_use_id != null)
      .map((b) => ({ id: b.tool_use_id, text: bodyText(b.content), image: bodyImage(b.content), error: !!b.is_error }));
  }
  const item = event.type === "item.completed" ? event.item : null;
  if (!item || typeof item !== "object" || !RESULT_ITEMS.has(item.type) || item.id == null) return [];
  const err = item.error && typeof item.error === "object" ? item.error.message : typeof item.error === "string" ? item.error : null;
  let text = null, image = null;
  if (item.type === "command_execution") text = typeof item.aggregated_output === "string" ? item.aggregated_output : null;
  else {
    text = bodyText(item.result);
    image = bodyImage(item.result?.content);
    if (text === null && typeof err === "string") text = err;
  }
  return [{ id: item.id, text, image, error: !!err || item.status === "failed" || (item.type === "command_execution" && item.exit_code > 0) }];
}

export function resultsFromLine(line) {
  try {
    return resultsFrom(JSON.parse(line));
  } catch {
    return [];
  }
}

// The line that ends a CLI turn: Claude `result`, Codex `turn.completed` / `turn.failed`. -> { failed } | null
// (an attempt that failed may be followed by a retry: the caller treats a later attempt as a new turn).
export function turnEndFrom(event) {
  if (!event || typeof event !== "object") return null;
  if (event.type === "result") return { failed: !!event.is_error || (event.subtype != null && event.subtype !== "success") };
  if (event.type === "turn.completed") return { failed: false };
  if (event.type === "turn.failed") return { failed: true };
  return null;
}

export function turnEndFromLine(line) {
  try {
    return turnEndFrom(JSON.parse(line));
  } catch {
    return null;
  }
}
