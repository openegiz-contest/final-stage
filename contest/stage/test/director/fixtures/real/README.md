# Real Final turn logs

Source run: `openegiz-judge/runs/final/live-probe-20261021/` (a live Final on the new fixture, Final Materials sha256 `e87d67a1…e4e5`), judge side `integration` at `0294bd4` (tip `a4fea38` when fetched), fetched 2026-10-21 12:27 from the engine's live page `http://127.0.0.1:8765/turns/<tid>/…` and `/state.json`, i.e. scrubbed by `live.py`. The files are unedited. They still hold the CLI's temporary working folder in `system/init` and base64 screenshots (about 300 KB together).

| File | What |
|---|---|
| `p1-r1-message-opus-5.5.claude.jsonl` | Claude Code 2.1.302 message turn: 4 `list_dir`, 2 `view_image` (tool_result with a base64 image block) |
| `p1-r1-message-gpt-6-astra.codex.jsonl` | codex-cli 0.160.1 message turn: `list_dir`, `read_file`, 3 `view_image` (`item.started` + `item.completed`, image `{type, data, mimeType}`) |
| `p1-r1-vote-opus-5.5.claude.jsonl`, `p1-r1-vote-gpt-6-astra.codex.jsonl` | vote turns: no tools, text only |
| `state.json` | `state.json` of the same run mid-Final (place 2, round 1): `pick`, `rival`, `judges[].since` |

Not in the real run, so tested from the documented shape and marked SYNTHETIC in `real-logs.test.mjs`: Claude `read_file` and `search_text`, and a refused call (Claude `is_error`, Codex `status:"failed"`).
