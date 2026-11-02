# What the Stage reads

The Stage reads three sources, only through `server.py`, only for reading (spec §7.7). Everything a viewer sees comes from them; the Stage invents no event, no text and no activity. Judge text is shown verbatim.

Source of this file: `openegiz-judge` branch `integration` at `0294bd4` (`judge/final/engine.py`, `runner.py`, `materials_mcp.py`; `docs/design.md` «Final»), checked on a live Final on the new fixture, `runs/final/live-probe-20261021/`, 2026-10-21. Real turn logs of that run are the director's test fixtures (`test/director/fixtures/real/`). When the judge side changes a field or an event shape, update this file and the director's adapter (`director/activity.js`, `director/content.js`), nothing else.

## 1. `/run/state.json`

Rewritten atomically by the engine after every event. Poll it (1 s, `no-store`); never assume an entry appears only once between polls. With `--no-hold` live.py stops with the engine, so the final state can be gone before a poll sees it (first live Final, 2026-10-21). live.py holds after `done` by default; never start the engine with `--no-hold` on air (the probe run was started with it). As a backup, run the Stage with `server.py --live … --fallback-run runs/final/<id>`, which serves this file and `final.json` from the run folder when live.py does not answer (never the raw turn logs: only live.py scrubs them).

```
status        "running" | "done"
started_at, finished_at   ISO time; duration_s   number | null
settings      { finalists, places, rounds_per_place, max_words, retries, turn_timeout_s, … }   [final] of judges.toml
judges[]      { name, agent: "claude"|"codex", model, cli, status, log }
              status: "ждёт" | "пишет" | "голосует" | "недоступен"
              log: "turns/<tid>/" of the Judge's latest finished turn
              since: ISO time the current turn started, or null while the Judge is not working
finalists[]   { team: "team-NNN", name, rank, score: string, ceiling: bool }   (ceiling: cannot take 1st place, §7.3)
current       { place, round, phase: "discussion"|"voting" } | null
transcript[]  ordered entries, each with "at" (ISO time):
  { kind: "round", place, round }
  { kind: "message", place, round, judge, text | null, error | null, log, duration_s }
      pick, rival: team ids ("team-NNN"), same schema as a vote's team. rival is null when one contender
      is left; pick and rival are both null when the Judge's answer had usable text but no valid pick
  { kind: "tally", place, round, votes[], counts: {team: n} (sorted), voted, judges, majority: bool }
  { kind: "placement", place, team | null, name | null, decided_by: "majority"|"last_word"|"vacant", rounds }
votes[]       every vote so far: { judge, place, round, team | null, reason | null, error | null, log }
placements[]  { place, team, name, decided_by, rounds, duration_s }
```

Order on the engine side, per round: `round` entry, then five `message` entries one by one (who opens rotates), then all five votes at once (parallel turns, written together in one `tally`), then `placement` if a majority or the last round. A Judge with `text: null` was unavailable for that message (п. 10.5). A vote with `team: null` is an unavailable Judge. A `message` with `pick`/`rival` null and `text` set is a Judge whose answer had no valid pick; the text is still shown.

What the Stage shows of this file before the reveal (sealed envelopes): the rounds, the messages verbatim, the walks, a Judge without a vote, «нет большинства» without counts, and «N-е место решено, конверт запечатан». Not before the reveal: `tally.votes`, `tally.counts`, `tally.majority` of a place's last round, `placement`'s team and `decided_by`, `placements[]`, and a message's `pick`/`rival` (never drawn; the text that names them is the Judge's own and is shown). `votes[]` and `placements[]` are also on the engine's own page (`127.0.0.1:8765`): keep it off the broadcast.

Majority: `tally.majority`; the line is more than half of the **available** Judges, `floor(voted / 2) + 1` (`judge/last_word.py:51-54`): with one Judge unavailable, 3 of 4. Show the line from `voted`, not from `judges`.

## 2. `/run/turns/<tid>/` raw turn logs

`tid` = `p<place>-r<round>-<message|vote>-<judge>[-a<attempt>]`. Folder appears when the turn starts:

- `prompt.txt` — written before the CLI starts. Its appearance means "this Judge's turn began" until `since` lands.
- `claude.jsonl` | `codex.jsonl` — the CLI's raw stdout, one JSON event per line, flushed line by line while the turn runs. Served scrubbed by live.py. `--fake` runs write no `.jsonl`.
- `*.stderr.txt`; Codex also `last-message.txt` (at the end) and `answer.schema.json` (vote turns).

Claude (`--output-format stream-json --verbose`): first line `{type:"system", subtype:"init", tools, model, …}`; then `{type:"assistant", message:{content:[…]}}` per complete message, content blocks `thinking` (empty text: redacted), `text`, `tool_use {name, input}`; tool results come back as `{type:"user", message:{content:[{type:"tool_result", tool_use_id, content}]}}` (`content`: a string or a list of `text`/`image` blocks; `is_error` on a failed call); last `{type:"result", result, …}` ends the turn.

Codex (`--json`): `thread.started`, `turn.started`, `item.started` / `item.completed {item:{id, type, …}}` (`agent_message` with `text`; `mcp_tool_call` with `server`, `tool`, `arguments`, and on `item.completed` its result: `result.content[]` text blocks, or `result` as a string, or `error.message`; `command_execution` with `command` and on `item.completed` `aggregated_output`), `turn.completed`. The result of a call is what the Judge read: the Stage shows it on the Judge's monitor, from this scrubbed log only (the Stage never opens a file itself). A result shape not listed here is shown as no content.

**What the Stage derives from a log** (`director/README.md` has the details): each tool call becomes a console item `{kind, path, label, at, content}`; `content` is `null` until the call's result arrives, then `{text, truncated}` (first 4000 characters) and, for an image read of a publication file, `image: "/pub/<path in the publication>"`. The end of a vote turn (Claude `result`, Codex `turn.completed` / `turn.failed`, or the state leaving «голосует», whichever the Stage sees first) orders the walks to the urn: one `voteCast` per Judge in that real order, before the round's tally; the votes are then revealed in the same order (owner 2026-10-21), the majority only after the last token. With sealed envelopes (owner 2026-10-28, spec §7.7 «Конверты») the reveal waits: during the debate only the walks play; once every place is decided, the Host opens the envelopes 3 → 2 → 1 and each place's deciding round is revealed in that walk order (`director/README.md` «Sealed envelopes»).

**Tools of a turn (ADR-0009).** A message turn of a Final with Materials reads them through one MCP server, `materials`, with four read-only tools and no built-in tool. A vote turn has no tools: its log is text only (Claude `system/init` lists no tool, Codex has no tool item), so a vote console shows status and timer only. Paths are relative to the Materials root: `publication/…` (the Qualifying publication: `publication/results.json`, `publication/solutions/team-NNN/screenshots/<judge>/*.png`, …) and `teams/team-NNN/source/src/…` (a Finalist's source, `…/src/SUBMISSION.md` is the Concept).

| Tool | Arguments | Result |
|---|---|---|
| `list_dir` | `path` (default `.`) | one text block: `<path>/ (N entries)` then `name/` or `name  <bytes> B` per line |
| `read_file` | `path`, `start_line`, `max_lines` | one text block: `<path> (<size>), lines a-b:` then numbered lines; images and binary files are refused |
| `search_text` | `query`, `path` (default `.`) | one text block: `path:line: text`, at most 40 matches |
| `view_image` | `path` | one image block (PNG, JPEG, GIF, WebP) |

The agents call them `mcp__materials__list_dir`, … (Claude) and `server:"materials"`, `tool:"list_dir"`, … (Codex). Raw events, from the real logs (one example each, text and base64 cut):

```
Claude call    {"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_01Wi…","name":"mcp__materials__list_dir","input":{"path":"publication/solutions/team-003/screenshots"}}]}}
Claude text    {"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_01Wi…","content":[{"type":"text","text":"publication/solutions/team-003/screenshots/ (4 entries)\n…"}]}]}}
Claude image   {"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_01CQ…","content":[{"type":"image","source":{"type":"base64","media_type":"image/png","data":"iVBORw0KGgoA…"}}]}]}}
Codex call     {"type":"item.started","item":{"id":"item_6","type":"mcp_tool_call","server":"materials","tool":"read_file","arguments":{"path":"teams/team-011/source/src/SUBMISSION.md"},"result":null,"error":null,"status":"in_progress"}}
Codex text     {"type":"item.completed","item":{"id":"item_6",…same…,"result":{"content":[{"type":"text","text":"teams/team-011/source/src/SUBMISSION.md (843 B), lines 1-27:\n…"}],"structured_content":null},"error":null,"status":"completed"}}
Codex image    {"type":"item.completed","item":{"id":"item_4",…,"tool":"view_image",…,"result":{"content":[{"type":"image","data":"iVBORw0KGgoA…","mimeType":"image/png"}],"structured_content":null},"error":null,"status":"completed"}}
```

Claude writes a call as one `assistant` event per `tool_use` block and the result as a later `user` event, matched by `tool_use_id`. Codex writes `item.started` and `item.completed` for one call under one `item.id`; the Stage shows the call once. Both CLIs may run calls in parallel: results can arrive in another order than the calls.

**Refusal.** A path outside the Materials, an absolute path, `~`, a binary file read as text: the tool answers with an error text, `Error executing tool read_file: refused: '/etc/hosts' is not a path inside the Final Materials (…)`. Claude marks the `tool_result` with `"is_error":true` and the text is a plain string; Codex sets `"status":"failed"` on the `item.completed`, `"error":null`, and the text is `result.content[0].text`. (Shapes from `docs/design.md`; the live probe has no refusal in its logs yet, the director's tests build them and mark them synthetic.)

**What the Stage derives from a log** (`director/README.md` has the details): each tool call becomes a console item `{kind, path, label, at, content}`. `label` is the tool's short name: `list_dir`, `read_file`, `search_text «query»`, `view_image` (no `mcp__materials__`). `content` is `null` until the call's result arrives, then `{text, truncated}` (first 4000 characters), and for `view_image` `image`: the file URL `/pub/<path>` (the path is relative to the Materials root, so it is the URL), or a `data:` URL built from the result's own image block when the path lies outside the Materials (at most 1 000 000 base64 characters, else no picture). A refused call keeps its tool and kind, gets the refusal text as `text`, `error: true`, and no image. The end of a vote turn (Claude `result`, Codex `turn.completed` / `turn.failed`, or the state leaving «голосует», whichever the Stage sees first) orders the walks to the urn: one `voteCast` per Judge in that real order, before the round's tally; the votes are then revealed in the same order (owner 2026-10-21), the majority only after the last token. With sealed envelopes (owner 2026-10-28, spec §7.7 «Конверты») the reveal waits: during the debate only the walks play; once every place is decided, the Host opens the envelopes 3 → 2 → 1 and each place's deciding round is revealed in that walk order (`director/README.md` «Sealed envelopes»).

A tool outside the table (a Codex `command_execution`, another server, a future tool) is shown by its own name, never guessed; a result shape not listed here is shown as no content. The tool tables live in `director/activity.js` only.

Not shown, by decision: reasoning summaries (`--thinking-display`, `model_reasoning_summary` stay off, spec §7.7).

## 3. `/pub/` the Final Materials

`/pub/<path>` is the Final Materials folder of the run, `<run>/materials/`, served read-only: `python3 contest/stage/server.py --run <run> --pub <run>/materials` (`--materials` is an alias of `--pub`). So `/pub/<path>` is the tool path itself, 1:1: a Judge's `view_image` of `publication/solutions/team-003/screenshots/opus-5.5/01-overview.png` shows as `/pub/publication/solutions/team-003/screenshots/opus-5.5/01-overview.png`, a `read_file` of `teams/team-011/source/src/SUBMISSION.md` is `/pub/teams/team-011/source/src/SUBMISSION.md`. The Stage shows a file from the Judge's own result text, and an image by that URL; it never lists the folder.

The folder is the read-only copy the engine makes at the start (`materials/publication/` is the Qualifying publication: `results.json`, `solutions/team-NNN/` with `build_report.json`, `scores/<judge>.json`, `screenshots/<judge>/*.png|jpg`, `presentation.json`; `materials/teams/team-NNN/source/src/` the Finalists' sources). Its manifest is `materials.sha256` beside it; the Materials hash is the sha256 of that manifest, printed in `final.log` and `final.json` (`materials.sha256`) and by `python -m judge.final.materials --qualifying <publication>` before a run. `stage build` puts the computed hash in `program.json` (`hashes.materials`, `checked` true only against the published one: `--run <run dir>` or `--published-materials`) for the wall of the programme. Layout of the publication: `judge/qualify/publish.py:1-16`; `stage build` reads the publication itself (`--qualifying`), not `/pub/`, for Finalist minutes and the hologram. The Finalists' sources are not inside a Qualifying publication: they live beside it, `<pub>/../teams/team-NNN/source/src/` (`<qualify run>/teams/`; openegiz-judge `docs/design.md` «## Final», the dossier paragraph); the engine copies them into `materials/teams/`.

## 4. Fake runs for development

```
cd ~/Projects/openegiz-judge
.venv/bin/python -m judge.final fixture --out /tmp/stage-base/publication
.venv/bin/python -m judge.final run --qualifying /tmp/stage-base/publication --runs /tmp/stage-base/runs --fake --fake-delay 2
```

`--fake-delay` seconds per turn; `--rounds N` for more rounds; the live page on `127.0.0.1:8765` unless `--no-serve`. Scripted Judges always reach a majority in round 1 and give the reason «репетиция»: no-majority, last-word and vacant paths need synthetic states.
