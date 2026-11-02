# Director

Turns the AI-jury engine's live data into one ordered show for the 3D Stage (spec §7.7). Plain ES modules, no dependencies; the same files run in the browser and in Node 24. The Stage reads, the director decides nothing: every word on screen is in the data (`../CONTRACT.md`), Judge text is verbatim.

```
Source ──► StateDiffer ──► live layer ─────────────────────────────► sink.judge(...)    always the real "now"
  │             └─► Planner ──► beats ──► PresentationQueue (+ voice) ─► sink.say / host / voteReveal / ...
  └─ raw log lines ─► activity.js ─► live layer
```

Two layers. The **live layer** (each Judge's status, timer, activity with what it read) is never queued. The **presentation queue** (messages, Host bridges, vote reveals, verdicts, podium) plays strictly in order, skips nothing, and each beat lasts as long as its voice; while one robot speaks, the next Judge already works on its console.

| File | What |
|---|---|
| `director.js` | `Director`: `tick(now)`, `start()`/`stop()`, `drive()` |
| `sources/live.js` | `LiveSource(baseUrl)`: polls `/run/` of the Stage server |
| `sources/replay.js` | `ReplaySource`: plays a recording on a given clock |
| `sources/codec.js` | replay snapshots as deltas |
| `sources/folder.js` | Node only: a finished run folder as a `ReplaySource` |
| `events.js` | `StateDiffer`: snapshots → ordered domain events; turn ids |
| `activity.js` | the one adapter: raw log line → console activity, tool results, the end of a turn |
| `content.js` | a tool result → the item's `content` (text cut at 4000, `/pub/` image URL or `data:` URL, `error`) |
| `plan.js` | `Planner`: events → numbered beats |
| `queue.js` | `PresentationQueue`: order, durations, voice prefetch, waits for a walk (`awaits`) |
| `host.js` | the Host's templates and on-screen labels (Russian; every one a proposal for the owner; the envelope lines of 2026-10-28 listed in `../out/v6-envelopes/wording.md`) |
| `voice.js` | `EstimateVoice` (145 words/min) and the voice interface |
| `cursor.js` | resume cursor: `?from=`, localStorage |
| `sinks.js` | `ConsoleSink`, `RecordingSink` |
| `cli.mjs` | `node cli.mjs --run <run dir>` |
| `../tools/record.py` | records a run into a replay |

## Wiring a page

```js
import { Director, LiveSource, ReplaySource, cursorFromLocation, localStorageStore } from "./director/index.js";
import { now } from "./lib/clock.js";

const q = new URLSearchParams(location.search);
const replay = q.get("replay"); // a recording, e.g. test/replays/synthetic-last-word.jsonl
const director = new Director({
  source: replay ? await ReplaySource.fromUrl(replay) : new LiveSource(""), // "" = same origin as the Stage server
  sink: stageSink,                      // the scene: see "The sink"
  voice: myVoice,                       // optional: see "The voice"; default EstimateVoice
  clock: replay ? now : undefined,      // a replay runs on the Stage's clock (?t= freezes it); live: wall clock
  from: cursorFromLocation(),           // ?from=<n>
  store: localStorageStore(),
});
director.start();                       // tick every 100 ms
// a still of any moment of a recording: await director.tick(t) once; the sink is in the state of time t
```

`director.tick(now)` is the whole engine. `now` is seconds on the clock the source uses (live: wall-clock seconds; replay: seconds from the start of the recording). Ticks may come every frame or in one jump: the sequence of sink calls and their `meta.at` do not depend on the step. `director.cursor` = beats finished, `director.finished` = the final screen was played.

## Sources

A source has `read(now) → items`, optionally `runKey()` (identity of the run for the cursor) and `clockOf(iso)` (an engine ISO time → the source's clock). Items, in time order, are exactly the records of a replay:

| Item | Meaning |
|---|---|
| `{t, state}` | a `state.json` snapshot |
| `{t, tid, prompt: true}` | `turns/<tid>/prompt.txt` appeared: the turn began |
| `{t, tid, line}` | one new complete line of the turn's `claude.jsonl` / `codex.jsonl` |

**LiveSource(baseUrl, {fetch, clock, stateEveryS = 1, logsEveryS = 0.5, onError})** reads `${baseUrl}/run/state.json` every second (an unchanged file is not reported again) and tails the active turns every 0.5 s: refetch, cut by line count, only complete lines. The active turns come from the state: `current` plus each Judge whose status is «пишет»/«голосует»: `p<place>-r<round>-<message|vote>-<judge>`. The file is `claude.jsonl` or `codex.jsonl` by the Judge's `agent`. After a failed ask the retry is `…-a2`: every poll probes `HEAD turns/<tid>-a<n>/prompt.txt` for the next attempt (up to `settings.retries + 1`) and follows the highest that exists. A turn's log is read once more after it ends, so the last lines are not lost. A poll that fails is reported to `onError` and the next one goes on. `read()` never waits for the network; `poll(now)` (tests) waits for the due polls. `runKey()` is `/run/final.json` `created_at`, which survives an engine `--resume` (the state's `started_at` does not).

**ReplaySource**: `new ReplaySource(records, header)`, `ReplaySource.parse(text)`, `await ReplaySource.fromUrl(url)`; `stateAt(t)`, `seek(t)`, `endT`, `synthetic`. The file is JSON lines. Header first:

```
{"format":"stage-replay/1","startedAt":"<ISO time of t=0>","runId":"…","synthetic":true,"note":"…"}
{"t":0,"state":{…}}                     full snapshot
{"t":1.2,"delta":{"set":{"current":{…},"judges.2":{…}},"append":{"transcript":[…]},"unset":[]}}
{"t":2.5,"tid":"p1-r1-message-opus-5.5","prompt":true}
{"t":3.1,"tid":"p1-r1-message-opus-5.5","line":"{…raw log line…}"}
```

A `delta` is a change of the previous state (`sources/codec.js`): the engine only appends to `transcript`, `votes`, `placements`, so a recording of a whole Final stays small. Within one instant, states come before prompts and lines. Files named `synthetic-*` in `../test/replays/` carry `"synthetic": true` and a note: test data, never for air.

**`../tools/record.py <run dir> --out run.jsonl`** polls a run folder into this format, or with `--url http://127.0.0.1:8780/run` (the Stage server; the engine's own page is `--url http://127.0.0.1:8765`) what the Stage sees, scrubbed. It stops when the state says `done` (the engine's page must still be up then: do not run `--no-hold`), at `--max-s`, or on Ctrl-C. A folder recording holds the raw logs: do not publish it.

**`replayFromRunFolder(dir)`** (`sources/folder.js`, Node) unfolds a finished run folder in time from the transcript's `at`, `journal.jsonl` (when each attempt of each turn ended and how long it took) and `turns/`: Judge statuses, `since`, prompts, log lines spread over their turn. The engine's times have one-second resolution, so a fake run unfolds coarsely; a recording is the faithful thing.

## Events

`StateDiffer.diff(state)` returns the new events in engine order (`events.js`). A snapshot is compared with the last one; the transcript is append-only and taken by index, so nothing is seen twice and nothing is lost between two polls. A transcript shorter than the one seen is an engine restarted from its journal: the differ waits for it to pass what was seen.

| Event | Fields |
|---|---|
| `setup` | `judges, finalists, settings` (once) |
| `judge` | `judge, status, since, log` (status or `since` changed) |
| `turn.start` / `turn.end` | `judge, kind, place, round, attempt, tid` (+ `since` / `outcome: ok\|unavailable`) |
| `round` | `index, at, place, round` |
| `message` | `index, at, judge, place, round, text` |
| `unavailable` | `index, at, judge, place, round, where: "message", error` (message `text: null`, п. 10.5) |
| `votes` | `index, at, place, round, votes[], counts, voted, judges, majority, line = floor(voted/2)+1, unavailable[]`, and from the director `casts[]`: `{judge, at, unavailable, order}` in finish order (see "Vote cast") |
| `placement` | `index, at, place, team, name, decided_by: majority\|last_word\|vacant, rounds` |
| `done` | `placements` |

`onEvent(ev, t)` in the `Director` options sees every event and every activity item. Console activity comes from `activity.js`: `activityFrom(event, at) → [{id, kind, path, label, at}]`:

| `kind` | When |
|---|---|
| `open` | the Final's `read_file` (without `start_line`/`max_lines`); Claude `Read`; another MCP server's read/open/cat |
| `read` | `read_file` with `start_line`/`max_lines`; `Read` with `offset`/`limit`; `cat`, `sed -n`, `head`, `tail`, `nl`, `bat`, `less` |
| `list` | the Final's `list_dir` (path defaults to `.`); `Glob`, `LS`; another server's list/ls/glob/tree/dir; `ls`, `find`, `tree`, `fd`, `rg --files` |
| `search` | the Final's `search_text` (path defaults to `.`); `Grep`; another server's grep/search/find; `rg`, `grep`, `ack` |
| `image` | the Final's `view_image`; a file read whose path is png/jpg/jpeg/gif/webp/bmp/avif; another MCP server's tool with image/screenshot in its name |
| `tool` | everything else, shown by its own name (`label`), `path: null` |

Every item also carries `content` (below).

`label` is the tool's short name: the Final's four tools `list_dir`, `read_file`, `search_text «query»`, `view_image` (server `materials`: Claude `mcp__materials__<tool>`, Codex `mcp_tool_call` with `server:"materials"`; the prefix is never shown; a query over 48 characters is cut with `…`), and `Read`, `Grep «pattern»`, `cat`, `rg «pattern»`. A tool of another MCP server keeps its full name (`mcp__final__read_file`). Codex `command_execution` is opened (`bash -lc '…'` wrapper, a leading `cd x &&`, the first command of a pipe) and classified only if the program is in the table; `sed` reads only as `sed -n`. Not activity: thinking/reasoning blocks, text, tool results (they become `content` of their call), Codex `agent_message`, `reasoning`, `todo_list`, `error`. A Codex call arrives as `item.started` and `item.completed` with one `id`; it is shown once. The Final's tool set (ADR-0009) lives in `MATERIALS_TOOLS` at the top of `activity.js`; a change of the set is an edit there.

### What the Judge read: `content`

`activity` items are `[{kind, path, label, at, content}]`. `content` is what the call returned, from the scrubbed log (live.py); the director never fetches a file.

| `content` | Meaning |
|---|---|
| `null` | pending: the call has no result yet. The live layer calls `sink.judge` again when the result arrives (the same item, `at` unchanged), never the queue |
| `{text, truncated}` | the result's text: the first 4000 characters, `truncated: true` if more was cut |
| `{image}` | a picture the Judge looked at: `"/pub/<path>"` (the Stage's `<img src>`) when its path lies inside the Final Materials, else a `data:image/…;base64,…` URL from the result's own image block; with `text` too if the result had a text caption |
| `{text, truncated, error: true}` | a refused or failed call: the refusal text; never an image |
| `{}` | a result arrived with nothing to show (empty, an image block too big or not a plain base64 picture, an unknown shape) |

Where a result comes from (`resultsFrom` in `activity.js`; matched to its call by id):

- Claude: `{type:"user", message:{content:[{type:"tool_result", tool_use_id, content}]}}`. `content` is a string or a list of blocks; `text` blocks are joined with a newline; an `image` block `{source:{type:"base64", media_type, data}}` is kept as `{mime, data}`. `is_error: true` (a refusal: the text is a string) → `error`, the text kept, no image.
- Codex `item.completed`, `mcp_tool_call`: `result.content[]` text blocks (an image block is `{type:"image", data, mimeType}`), else `result` as a string, else `error.message`; `status:"failed"` (a refusal: the text is in `result.content[0].text`) → `error`. `item.started` has no result (pending). `command_execution`: `aggregated_output`. Anything else: no text.

Image: only for `kind: "image"` items (`view_image`, a file read of png/jpg/…, or an image/screenshot tool) whose call did not fail. The path is relative to the Final Materials root (`publication/…`, `teams/…`), which the Stage serves as `/pub/` (`server.py --pub <run>/materials`), so the URL is `/pub/` + the path; an absolute path counts only under `new Director({pubRoot})` (the Materials root on the Judges' machine; a path or a list; `--pub-root` in the CLI). Anything else (`..` out of the root, `~`, URLs, other absolute paths) gets no file URL; then the result's own image block becomes a `data:` URL if it is a PNG/JPEG/GIF/WebP of at most `IMAGE_DATA_MAX` (1 000 000) base64 characters, else no picture. Real Final screenshots are 40-60 KB of base64, so the file URL is the normal case and the `data:` URL the fallback. Text of an image item that looks like bytes (a `cat` of a png) is dropped. A call whose result never comes stays `content: null`; a result that arrives for an item already pushed out of the window (12 items) is ignored. `onEvent` also sees `{type:"activity.content", judge, tid, id, content}`.

## The sink

The director drives the Stage through one object. Every method is optional (`sink.x?.()`); every call ends with a `meta` argument. A sink method that throws is reported through `onWarn` and the show goes on.

Show calls come from the queue, in order, one beat after another; `meta = {n, type, at, durationS, place, round}`. `n` is the beat number (0, 1, 2, … without gaps), `at` the start on the director's clock, `durationS` how long the beat lasts. A beat can make several calls with the same `meta`; an `awaited` call (`voteCast`) also sets how long the beat lasts. A spoken call takes `voice` (see below; `null` when nothing is spoken) right before `meta`.

| Call | Payload |
|---|---|
| `setup(info, {at})` | once: `{judges: [{id, agent, model, cli}], finalists, settings, rounds, places}` |
| `restore(view, {at})` | once after a resume, before the first beat: `{cursor, status, podium}` as after beat `cursor − 1`; `status.phase: "done"` = draw the final screen (the show was over); `status.phase: "reveal"` = in an envelope's reveal: `status.reveal = {urn, shown}` (see «Sealed envelopes») |
| `judge(id, p, {at})` | **live layer**, on every change: `p = {status, since, sinceIso, sinceSource, activity, turn, agent, model, cli}` |
| `status(s, meta)` | `{place, round, rounds, phase: discussion\|voting\|sealed\|reveal\|decided\|done, contenders: [{team, name, rank, score, ceiling, blocked, blockedLabel, placed}], away, sealed?}`; `away` = the Judges out this round (a new round: `[]`; a vote wave: those without a vote); a restore's status also names a Judge out since its `unavailable` beat. With envelopes: `sealed` = the places decided and not opened yet; `contenders` = every Finalist at every place, `placed` always `null` (a row missing at place 2 would name the 1st place); `sealed` = a place just sealed, `reveal` = its envelope is open (`round` = the deciding round) |
| `say(speaker, text, voice, meta)` | a Judge's message, verbatim; the Stage types `text` under `voice.words` |
| `host(text, voice, meta)` | a Host line (bridge, place opener, explanation); `meta.type` says which beat: `round`, `ceiling` (place 1: the Finalists under the ceiling, п. 9.3), `unavailable`, `vote.wave` (the first line of every vote wave, before its first `voteCast`), `vote`, `vote.result`, … |
| `unavailable(judge, {where, place, round, error}, meta)` | the robot goes dark and stays out for the rest of the round (the corner header names it); the Host's line follows as `host` |
| `tally(t, meta)` | `stage: "begin"`: `{place, round, rounds, line, voted, judges, away, counts: {}, contenders}`, in an envelope's reveal also `reveal: true, urn: [judge…]` (the voters in the order they reached the urn: the Stage puts their sealed tokens back in the box); `stage: "result"`: `{…, counts, result: majority\|no_majority\|no_majority_last, winner, banner, next: {place, round}\|null}`. The result is the only call that announces a majority, and it comes after the wave's last token. With envelopes, during the debate: only `{stage: "result", sealed: true, result: "no_majority", winner: null, banner, next, …}` without `counts`, for a round without a majority before the last |
| `voteCast(judge, c, meta)` | **awaited**, one per Judge, in the order the vote turns really ended, before the round's `tally` begin: `c = {place, round, at, order, of, unavailable}`. The Judge walks to the urn and drops a sealed token (no team, no reason: those come with `voteReveal`). See "Vote cast" below |
| `voteReveal(v, voice, meta)` | one vote, **in the order the Judges reached the urn** (the `voteCast` order), the Judges without a vote first: `{place, round, rounds, line, voted, judges, away, judge, index, of, order, last, team, name, reason, unavailable, error, counts, teamVotes, reached, previous, changed}`; `index` = position in the reveal (0…), `order` = 1…`voted` among the tokens (`null` without a vote), `last` = the wave's last token, `counts` = bars after this vote, `reached` = the team's bar is at the line (a fact for the bars; the majority is announced by `tally` result only), `previous` = `{round, team, name}` the Judge's vote in the previous round of this place (`null` in round 1 or when it did not vote), `changed` = `previous` names another team. A Judge without a vote (`unavailable: true`) has a beat of at least 2 s (`abstainS`), silent unless the Host explains п. 10.5 there for the first time |
| `envelope(e, voice, meta)` | sealed envelopes: `{stage: "sealed"\|"open", place, round?, rounds?, envelopes: [{place, state: pending\|sealed\|opening\|open\|vacant}], text, durationS}`; `sealed`: the place is decided, its envelope sealed (no team, no count, no `decided_by`); `open`: the Host opens it after the debate, `round` = the deciding round. The Host's `text` is spoken by the call |
| `lastWord(card, voice, meta)` | `{place, rounds, team, name, rank, score, contenders: [{team, name, rank, score}], rule: "10.4", text}` |
| `verdict(card, voice, meta)` | `{place, team, name, rank, score, decided_by, votes, voted, judges, line, rounds, reasons: [{judge, text}], against: [{judge, team, name}], absent: [judge], durationS, text}`; a vacant place: `{place, vacant: true, team: null, decided_by: "vacant", reasons: [], against: [], absent: [], durationS, text}` |
| `podium(p, meta)` | `{filled, places: [{place, team, name, decided_by, rounds} \| {place, team: null, vacant: true} \| null]}`, filling 1 → 2 → 3 |
| `final(f, voice, meta)` | `{podium: [{place, team, name, …}], text}`: the final screen |

`judge`: `status` is the engine's own («ждёт», «пишет», «голосует», «недоступен»). `since` is the turn's start in the director's clock seconds (the Stage shows `director.now() − since`), `sinceIso` the engine's own timestamp or `null`, `sinceSource` says where it came from: `"state"` (the `since` field), `"prompt"` (when `prompt.txt` appeared), `"seen"` (when the turn was first seen). `activity` = the current (or last) turn's console items, oldest first, at most 12: `[{kind, path, label, at, content}]` (`content`: see above). `turn` = `{tid, kind: message\|vote, place, round, attempt, running, outcome?}` or `null`; a retry is `attempt: 2` with `tid` ending `-a2`, and replaces the first ask's activity.

Verdict card (spec §7.7 «Место», owner 2026-10-21): the Finalist, `votes` of `voted` in the deciding round, `rounds`, and every vote of that round, in reveal order: `reasons` = the reason of **every** Judge who voted for the winner, verbatim, none dropped (a Last Word winner has only the votes he did get, possibly none); `against` = each other vote, who for whom (the «Против» line); `absent` = the Judges without a vote (п. 10.5), with `line` the reduced majority line. The Host's `text` is a template over counts and teams only («Первое место — «Горный поток». За него 4 из 5, против — 1: «Штрек». Раундов: 2.»); reasons are never retold. `durationS` = `max(25, 7 + 4 × reasons + 2.5 × against + 1)` (`verdictDuration`; a vacant place 8): each named Judge gets its shot; the beat lasts at least that long. Majority line: `floor(voted / 2) + 1`, from the Judges who voted (4 voters → 3), never from the five.

Judges are named on screen and in the Host's lines by their display name (`judgeName` in `host.js`, the roster's: «Fable 5.1», never «fable-5.1»).

The sink tests in this folder use `RecordingSink` (every call → `{method, args, meta}`); `ConsoleSink({out, maxText})` prints one line per beat and `~` lines for the live layer.

### Vote cast

A wave of votes plays as: the Host's `vote.wave` line («Судьи голосуют тайно. Жетоны откроем, когда проголосуют все: нужно {line} из {voted}.», `voted` = the available Judges, as in the majority line), `status` (phase `voting`) + the first `voteCast`, the other `voteCast`s, `tally` begin, `voteReveal` ×N, `tally` result. The reveal follows the walks (owner 2026-10-21): first a beat for each Judge without a vote, then the tokens in the order their Judges reached the urn; the result comes after the last token, so a reveal never announces the majority, whoever crosses the line. They are ordinary numbered beats (the resume cursor counts them); a Judge with `vote.team: null` has a beat too.

`c = {place, round, at, order, of, unavailable}`: `at` = when the director saw the Judge's vote turn end (its clock), `null` if it did not see it; `order` = 1, 2, … among the Judges who voted (`null` when unavailable); `of` = the number who voted. `unavailable: true` = the Judge's vote turn failed (`vote.team: null`): the robot does not walk, the beat takes no time.

**The walk is awaited.** `sink.voteCast` returns (or resolves to) when the walk is done, and the queue plays the next beat then:

| Return | The beat ends |
|---|---|
| `{end}` (number, director's clock = the `meta.at` clock) | at `end` (not before the beat's start). The Stage: `return stage.vote(id, meta.at)`, which returns `{end}` |
| `{durationS}` | `meta.at + durationS` |
| a promise | when it settles: at the `end` / `durationS` it resolves to, else the time the queue saw it settle. A rejection is reported to `onWarn` and ends the walk. After `holdMaxS` (Director option, 60 s) the queue moves on and warns |
| nothing, or no `voteCast` on the sink | at once (`meta.durationS` is 0) |

**Finish order.** The first sign wins, per Judge, whichever comes first: its `judges[].status` leaves «голосует» (state poll time), or its vote turn's log gets its last line (Claude `result`; Codex `turn.completed` / `turn.failed`; the time that line was first seen). The Judges are sorted by that time; a tie within one poll falls to the order of arrival at the director, so a log line seen earlier (logs are polled every 0.5 s, the state every 1 s) breaks it, and after that the roster order. A vote asked again (`-a2`) forgets the first ask's end: the Judge finishes when the retry does. A Judge whose end was not seen (a Stage opened after it finished, or a turn shorter than a poll) goes before the observed ones, in the engine's vote order, with `at: null`: so a reload in the middle of a wave may walk (and reveal) the early finishers in a different order than the first showing did; the beats and their numbers are the same.

## Sealed envelopes

Owner 2026-10-28, spec §7.7 «Конверты»; the Planner's default (`new Director({plan: {envelopes: false}})`, the CLI's `--reveal-each` and the Stage's `?reveal=each` give the show of 2026-10-21, every place revealed as soon as it is decided). The engine still decides the places 1 → 2 → 3; the show keeps them sealed:

| When | Beats |
|---|---|
| a vote wave | the Host's `vote.wave` line (`host.voteWaveSealed`; the show's first wave says the tokens stay sealed until the end), `status` (voting) + the walks (`voteCast`), a silent `voteReveal` beat for each Judge without a vote (`unavailable: true`, `sealed: true`, no team, no previous vote: п. 10.5 and the line only). No `tally` begin, no token opened, no count, no bar |
| no majority, not the last round | `vote.result`: `tally {stage: "result", sealed: true, result: "no_majority", banner}` («Нет большинства → раунд 2 из 3») + the Host's `host.noMajoritySealed` («Нет большинства. Раунд 2 из 3.»). The tubes empty, the tokens go home |
| a place decided (a majority, or the Last Word Rule after the last round: the show does not say which) | `sealed`: `status {phase: "sealed", sealed}` + `envelope {stage: "sealed"}` with the Host's «Первое место решено. Конверт запечатан.» |
| a vacant place (every Finalist left under the ceiling: a rule known before the Final, it names no pick) | its card and podium step at once, as before |
| every place decided | `reveal.intro` (the Host: «Все места решены. Вскрываем конверты: третье, второе, первое место. …»), then per place, last to first: `reveal.open` (`status {phase: "reveal"}` + `envelope {stage: "open"}`, «Конверт третьего места. Решающий раунд — 1 из 3.»), the deciding round's `tally` begin (`reveal: true, urn`), a `voteReveal` per vote in the order the Judges reached the urn (the Judges without a vote first, silent: they were explained in the debate), the `tally` result (majority, or `no_majority_last` with the Host's count line), the Last Word card when the rule decided, the verdict card, the podium step. Then `final` |

`placement` events of a sealed place are kept (`Planner.sealed`) with the place's last wave (`Planner.waves`: the votes, the walk order, the previous round's votes for `previous`/`changed`), so the reveal replays the deciding round exactly as a wave would have: the same payloads, in the same order. The Last Word card of place 2 or 3 lists the Finalists with a vote in its last round and the winner (never every Finalist not yet placed: the top scores missing from it would name the places above); at place 1 every contender, as before. The reveal is planned when the last place is decided (`places` of the settings, at most the number of Finalists), or at `done` if the engine stops earlier.

Resume: the reveal is ordinary numbered beats. `restore` gets the podium of the places opened so far; a restore inside an envelope gets `status.phase: "reveal"` with `status.reveal = {urn, shown: [{judge, team}]}` (the voters in urn order, the tokens opened before the cursor): the Stage puts the urn's tokens in the box and the opened ones in their tubes (`ui/show.js` `sealTokens`, `world/ballot.js` `seal`).

What can still tell a result before the reveal, by design: the Judges' own words (a message names its favourite and may name a place's winner: verbatim, never hidden); the order and number of rounds (a place sealed after round 1 had a majority there); the Last Word card of a lower place opened first (its rule says the Finalists with a higher Qualifying score were placed above).

## The voice

```js
voice.prepare(speaker, text) → Promise<{ durationS, words: [{start_char, end_char, start_s, end_s}], audioUrl? }>
```

`speaker` is `"host"` or the Judge's name. `words` give, per word, its UTF-16 range in `text` and its time from the start of the line; the Stage types text under them. `audioUrl` is what the Stage plays. A beat lasts `max(minS, durationS)` (+0.3 s after a spoken one). The default `EstimateVoice` estimates 145 words/min, a word's share of the time by its length, with a pause at punctuation, and has no audio. A voice may reject: the director falls back to the estimate and reports through `onWarn`.

Prefetch: while a beat plays, the next spoken beat is prepared, never more than two ahead and each line once. A voice that is not ready holds the queue (not the live layer); the beat starts when it is.

## Resume

The cursor is the number of beats finished. The beats are a pure function of the data, so beat `n` is the same beat after a reload. The director plans from the start but only plays beats `≥ cursor`, and first calls `sink.restore({cursor, status, podium})` so a fresh scene gets the podium and the header of the state before it. The cursor comes from `?from=<n>` (wins), else localStorage `stage.cursor.<run key>`, written when a beat ends; a beat playing at the reload plays again from its start. `?from=0` plays everything again. The run key is `source.runKey()` (`final.json` `created_at`), else the state's `started_at`.

## CLI

```bash
node contest/stage/director/cli.mjs --run <run dir> [--speed N] [--brief] [--events] [--from n] [--wpm n] [--pub-root P]
node contest/stage/director/cli.mjs --replay <recording.jsonl> …
```

`--run` unfolds a finished run folder (`runs/final/<id>/`) and prints the whole show with `ConsoleSink`. `--speed N` paces the output at N× real time (default: instant). `--from` skips the first N beats as a Stage reload does; `--events` also prints domain events and Judge activity; `--brief` cuts texts to 100 characters. A synthetic replay is flagged on the first line.

## Contract notes

- `since` (judge side, landed): `state.judges[].since` is used when present (`sinceSource: "state"`), otherwise the `prompt.txt` appearance (`"prompt"`), otherwise first seen (`"seen"`).
- `pick` / `rival` of a message (team ids; `rival` null with one contender left, both null when the answer had text but no valid pick) are passed on in the `message` event (`onEvent`, the CLI's `--events`); no sink call carries them and the Stage draws nothing from them: with sealed envelopes a drawn pick would be a count before the reveal. The data contract is `../CONTRACT.md`.
- The Final's tools (ADR-0009): the server `materials` with `list_dir`, `read_file`, `search_text`, `view_image`, paths relative to the Materials root; votes have no tools, so a vote console shows status and timer only. The real raw events are in `../CONTRACT.md` and the fixtures `../test/director/fixtures/real/`. A turn's end in a Codex log is `turn.completed` (not "the last `item.completed`", which cannot be known until something follows it).
- `settings.rounds_per_place` (3) is read from the state; places default to 3.
- The engine's `at` has one-second resolution; the director never orders by it, only by transcript index.

## Tests

```bash
node --test contest/stage/test/director
node contest/stage/test/director/build-replays.mjs   # regenerates the simulated test/replays/synthetic-*.jsonl and synthetic-run/
node contest/stage/test/trust-check.mjs [--stills dir] [--bench]   # live.html on the GPU: reveal order, verdict close-ups per Judge, notes
```

`envelopes.test.mjs` holds the sealed envelopes (owner 2026-10-28): on both real recordings, the `--fake` recording, every synthetic replay and a simulated Final with a Last Word at place 2, nothing of a result is emitted before the Host opens the envelopes (no opened token, count, majority, Last Word card, verdict, podium or final screen; no payload with a team, count or reason; every Finalist's row at every place; empty restore views), the envelopes open 3 → 2 → 1 with each deciding round in urn order, verbatim, and a reload at every beat of the reveal resumes it exactly. The wave's own mechanics and the trust rules of each card (`votecast`, `votewave`, `trust`, parts of `show`) run on the show of 2026-10-21 (`LEGACY` in `helpers.mjs`); the verbatim test of every replay runs on both. `node contest/stage/test/envelope-check.mjs [--pub <run>/materials] [--stills dir]` checks the same on live.html on the GPU: what is on screen every second of the debate, the reveal over the tubes, a reload in the middle of the 1st place's reveal.

`trust.test.mjs` holds the red team's trust rules (2026-10-21): every majority reason on the verdict card, the «Против» line, display names, the ceiling line, the unavailable Judge's beat.

`node --test <folder>` does not recurse in Node 24, so `test/director/index.js` imports the test files. `synthetic-vote-order.jsonl` has vote turns that finish out of the roster order (and a log that ends before its state does). `synthetic-fake-engine.jsonl` is not simulated: it is a live recording (`record.py --url`) of `python -m judge.final run --fake` (scripted Judges, reason «репетиция», no raw logs), kept as the proof that the recorder and the engine's real output work together.

`test/director/sim.mjs` simulates the engine's output on a timeline. The simulated replays cover: no majority → round 2, no majority through the last round → Last Word, a vacant place, an unavailable Judge (4 voters, line 3; and two: 3 voters, line 2), retries (`-a2`), Finalists under the ceiling, tool activity in both CLIs' raw logs, and a full 3-place show (also as a run folder).
