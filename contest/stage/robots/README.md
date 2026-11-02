# The Stage's scene: the interface the show drives

The 3D control room of the Final (spec §7.7): five Judges at their consoles facing the night pit, the
Host at its post by the ballot station, a director camera. The show layer `ui/show.js` is the
director's sink (`../director/README.md`, "The sink"): it takes the director's payloads as they are
and drives the scene through the calls below. `frame.html` is the reference wiring (the style
frame); `ui/mock.js` is the only place with invented data.

Rules every module keeps:

- **Time is the show clock** (`lib/clock.js`, seconds). Every call takes the time `t` it happens at;
  every `update(t)` is a pure function of `t` and of the calls made so far, so `?t=` stills, the
  live page and the frame-by-frame clip (`tools/clip.mjs`) show the same picture. Calls are kept
  as timed events: a call for a later `t` is scheduled, a still at an earlier `t` ignores it. Make
  calls in time order (the box queue and the subtitles assume it).
- **States are body and light, never badges.** There are no state colours. A state changes the
  robot's pose, its face light and its console's screen. Vendor families differ by material and
  shape only; both get the same rig and the same care, and read equally well on screen, black glass
  at 0.65-0.85 of the cream's mean luma (checked: `robots/check/luma.html`).
- **Nothing on screen is invented.** In-world text is file content, paths, tool names, model
  names, team ids and names, counts. The only 2D layer is subtitles and who-is-who captions.

```js
import { createStage } from "/world/stage.js";
import { createSubtitles, createCaptions } from "/ui/subtitles.js";
import { createShow } from "/ui/show.js";
const stage = await createStage({ canvas, gfx });     // gfx: "full" | "lite" (lib/clock.js reads ?gfx=)
const subs = createSubtitles(root), caps = createCaptions(root, stage);
const show = createShow({ stage, subs, caps });      // the director's sink
await stage.ready();
// per frame: stage.renderAt(t); subs.update(t); caps.update(t);
```

## Show layer (`ui/show.js`): the sink

Every method takes the director's payload as is and `meta.at` as its show-clock time. The camera
is not driven from here: a shot planner (or `frame.html`) calls `stage.camera`.

| Method | On the Stage |
|---|---|
| `setup(info, meta)` | `info.judges[].cli` fills the captions' CLI line |
| `judge(name, p, meta)` | `stage.judge(id, p, t)`; when `p` ends a vote turn (previous status «голосует», `p.turn.kind === "vote"`, not running, outcome not `error`), the Judge walks its token to the box: returns the walk's times (`stage.vote`), else `null`. During a spoken line the console follows at once, the body when the line ends. |
| `say(speaker, text, voice, meta)` | the speaker turns to the room ≈1.3 s before its first word, its face light follows the voice (`voice.words`, or `estimateTiming(text)`), subtitles; afterwards it returns to its live state (a waiting Judge stays facing the room). Returns the end time. |
| `host(text, voice, meta)` | the same for the Host |
| `unavailable(judge, info, meta)` | the robot goes `offline` |
| `tally(t, meta)` | `stage: "begin"`: the round's urns, majority line and ballot sheets; other stages are not drawn (the urns show the count) |
| `voteReveal(v, voice, meta)` | that Judge's token out of the box into `v.team`'s urn, then the Judge reads `v.reason`; returns `{ lands, end }` |
| `verdict(card, voice, meta)` | the Host reads `card.text` |
| `caption(id, t, mode, opts)` | who is who (below) |

Judge names are their ids (`opus-5.5`) or model names (`Opus 5.5`).

## Stage

`createStage({ canvas, gfx, roster })` resolves when every program is compiled; `stage.ready()`
resolves when the consoles' fonts and images are decoded (for stills). `roster` (optional)
overrides captions: `{ [id]: { model, cli, version } }`.

| Member | What |
|---|---|
| `robots[id]` | the five Judges and `host`, placed at their posts |
| `desks[id]` | each Judge's console: the main monitor and the side monitor |
| `ballot` | the ballot box, the Finalists' urns, the tokens |
| `camera` | the director camera |
| `judge(id, p, t)` | the director's live layer in one call (below) |
| `vote(id, t)` | the vote on foot, queued at the box: a Judge whose vote would arrive while another is there waits at its post until the box is free (+1.4 s). Returns the walk's times (`robot.vote`). |
| `setSheet({ kind: "ballot", place, contenders }, t)` | the ballot sheet the consoles show on vote turns |
| `renderAt(t)` | update everything for time `t` and draw |
| `project(Vector3)` | `{ x, y, visible }` in CSS pixels, for captions |
| `ready()` | consoles decoded |
| `renderer`, `scene`, `outside`, `post`, `three`, `size` | for checks |

`JUDGE_IDS` (from the camera's left): `fable-5.1, gpt-6.1-sol, opus-5.5, gpt-6-astra, sonnet-5.5`.
Positions are in `world/layout.js` (metres, y up, the glass and the pit toward −Z).

Lights (`world/hall.js`, `world/stage.js`): a warm downlight over each console, the tungsten
pendant over the ballot box, moonlight and a warm back fill through the glass, a hemisphere fill;
the voice light (a point light 0.42 m in front of the loudest speaking face, in its face colour);
two pooled spill lights that each frame go to the two brightest consoles (a tie goes to the one
nearer the camera) instead of one per console, which kept the fragment cost inside the bench.

### `stage.judge(id, p, t)`: the director's `judge(id, p)` as is

| `p.status` | Robot | Main monitor | Side monitor |
|---|---|---|---|
| «пишет» (message turn) | `working`: faces its console, leans in | the newest `p.activity` item with content (text or image) | the tool log: `p.activity` labels and paths; `p.since` timer |
| «голосует» (vote turn, no tools, ADR-0009) | `working` | the ballot sheet: the round's contenders | timer |
| «ждёт» | `waiting` | the last content, dim | dim |
| «недоступен» | `offline` | off | off |

`p.facing: "room"` keeps a waiting Judge facing the room. A spoken line (`show.say`) overrides
the live state for its duration: the speaker turns to the room (`speaking`), then returns to what
the live layer says. A finished vote turn starts the walk to the box (`show.judge` calls
`stage.vote`).

Content for the main monitor is not in `p.activity` yet: the adapter (`director/activity.js`)
gives `{kind, path, label}`. The text the Judge read is in the raw log: Claude's `tool_result`
block with the `tool_use_id` of the call, Codex's `mcp_tool_call` item `result`. The director
attaches it as `item.content = { text, from, to }` or `{ image: url }` (a screenshot path under
`/pub/`, or the image block of the result as a data URL). An item without content does not change
the main monitor (it keeps the previous content); only the side monitor's log grows. Nothing
placeholder-like is ever drawn.

## Robot

`stage.robots[id]`, made by `createRobot(id)` (`robots/index.js`).

### New in characters v3 (code against these names)

| Member | What |
|---|---|
| `info.height` | metres, floor to the top of the head in the rest pose (from the model): Opus 1.951, Sonnet 1.570, Fable 1.770, sol 1.815, astra 1.885, Host 1.445. Frame close shots on it (a fixed span cuts Sonnet at the knees). |
| `beat("decide", t)` | at its desk: the robot stops reading, lifts its head, straightens, a still beat (the choice), then its right hand takes a sealed token off the desk and holds it at the chest, ready to walk. Returns `{ t0, dimAt, tokenAt, end }`: dim its console at `dimAt` (`desk.setPower(0.16, dimAt)`), the token is in its hand from `tokenAt`, the walk can start at `end` (2.85 s after `t0` at tempo 1; Opus 3.4 s, Sonnet 2.55 s) with the existing `stage.vote(id, t ≥ end)`. The pose holds (token at the chest) until the vote starts; the trip then hands the token to the ballot from `tokenAt` (the plan given to `onTrip` carries `t0 = tokenAt − 0.25`, so `ballot.carry` shows it in hand from `tokenAt`). The robot calls `onBeat(fn)`'s `fn(id, "decide", times)` once per beat, so the stage can dim the console and show the token without the show layer. |
| `beat("gesture", t)` | a speaking gesture of its own, 1.3–2.9 s (Sonnet quickest, Opus slowest), in any state: the arms it uses first ease back to the relaxed pose (and off the desk), so it reads the same while `speaking` or `waiting`: Opus both palms open slowly at the chest (weighing); Sonnet a quick right-hand point and a small head tilt; Fable both palms open outward in a slow arc with a slow head tilt (the storyteller); sol a flat right hand that sets down a point; astra both hands framing a box; the Host an open hand toward the ballot box. Returns `{ t0, end }`. |
| `land(t, { from })` | the camera lands on the robot at t (`world/stage.js` calls it on every cut or move to its shot; `from`: the robot the shot before showed). A speaking robot answers with one `beat("gesture")`, unless it turned to the room less than 4 s ago, a gesture ended less than 4 s ago, or the shot is a new angle on itself (`from` = its id) within 10 s of its last move. Returns `{ t0, end }` or `null`. |
| `onBeat(fn)` | `fn(id, kind, times)` after every `beat`; `stage.js` wires the console dim and the token. |

Idle life runs inside `update(t)` in every state but `offline`: breathing (chest and shoulders), a weight shift from foot to foot every few seconds, the head glancing to its screen and back; the speaking Host turns toward the ballot box and presents it once with an open hand as it starts. A speaking robot holds still apart from a slow drift: its body does not follow the words (each word kicked the arms; owner 2026-10-28), the voice shows in its face light. Opus moves at ≈0.7× tempo, Sonnet at ≈1.25×.

| Member | What |
|---|---|
| `setState(state, t, opts?)` | `"waiting"`, `"working"`, `"speaking"`, `"offline"`. Eases from the pose at `t` over 0.8 s; a change of facing is a turn on the spot with steps (≈1 s for 180°). `opts.facing`: `"desk"` (default for `waiting`, `working`, `offline`) or `"room"` (default for `speaking`; for `waiting` after a vote, so the jury watches the count). |
| `setVoice(fn)` | `fn(t) → 0..1`, the loudness of the voice now (the TTS envelope; live: an analyser). The face light follows it while `speaking`. |
| `vote(t)` | the vote on foot from `t`: from its post to the ballot box with a sealed token in hand, the drop, back to its post, then `waiting` facing the room. Returns `{ t0, arriveAt, dropAt, leaveAt, backAt, end }` and hands the token to the ballot station itself (`onTrip` → `ballot.carry`). Phases, readable with `phaseAt(t)`: `"turn"`, `"to-urn"`, `"drop"`, `"back"`, `"settle"`. Use `stage.vote(id, t)`, which queues Judges at the box. |
| `previewVote(t)` | the same times without making the trip (for the queue) |
| `phaseAt(t)` | `null` at the post, else the vote-trip phase |
| `stateAt(t)` | the state in force at `t`; `"walking"` during a trip; `"deciding"` from a decide beat until its walk starts (the token at the chest) |
| `faceLevel` | the face light last applied (0..≈1.3), for the voice light |
| `update(t)` | once per frame (`renderAt` does it) |
| `info` | `{ id, model, cli, version, vendor: "anthropic" \| "openai" \| "house", role: "judge" \| "host" }` |
| `anchors` | `head`, `face`, `hand` (right), `chest`, `base`: `Object3D`s that follow the pose |

How a state reads, the same on every Judge:

| State | Body | Light |
|---|---|---|
| `working` | faces its console, torso leans in, head down to the screen, one hand on the desk | main monitor lit (its light falls on the robot), face light low (0.17) |
| `speaking` | turned to the room, upright, holds calm (moves once as it turns, and as the camera lands: `land`) | face light 0.5 + 0.75 × voice, and the voice light on the room |
| `waiting` | at rest, arms down, still | monitor dim, face light at a glow (0.1) |
| `walking` | the vote trip, token in the right hand at the fingertips | face light 0.22 |
| `offline` | powered down: upright and square, the head bowed a little, arms straight at the sides, knees locked, no motion (a machine at rest, not a sleeper) | monitor off, face off, the console's standby LED amber |

Faces: Opus and Sonnet, two soft warm eyes behind a dark visor (Opus a wide slot, Sonnet a tall
narrow window); Fable, one warm projector lens in a thin glazed bezel; sol, a warm bar behind a
wraparound smoked visor (3310 K measured on screen, the cream eyes 3340-3400 K); astra, a thin cold
bar (7200 K on screen); the Host, a cap lamp. The two OpenAI Judges also carry a status light on
the upper back in their bar's colour, so they read apart from behind. Face lights are emissive, so
they read in lite too. Every face is lit in every state but `offline` and is alive in the same
measure: eyes and the lens blink (a 0.2 s dip) and a bar scans (a brighter spot runs along it in
0.8 s), once every 4-7 s, seeded per robot, a function of the show clock. A bar's level is
compressed (level^0.6, equal at the speaking peak): against mirror-black glass a linear bar sank to
the facets' grey at the dim levels. On screen (`check/closeup.html?set=faces`, p95 sRGB luma of the
lit pixels): waiting 0.1 eyes 118-120, sol 157, astra 183; working 0.17 141-145, 170, 195;
speaking 0.5 187-191, 197, 223; peak 1.25 224-228, 223, 229.

### The characters (`robots/`)

| Judge | Read | Body |
|---|---|---|
| Opus 5.5 | large and calm | 1.95 m, shoulders 1.56× Sonnet's, a wide pebble head (1.9× Sonnet's) with a slot visor; matte cream bisque head to foot with terracotta as livery (a band above each knee, a collar round each ankle, the soles, the joints), a glazed breastplate, a terracotta yoke on the back; the forearm closes over the wrist and a jointed cream hand (ball wrist, squared finger segments, knuckle pins) comes out of it; tempo 0.7 |
| Sonnet 5.5 | light | 1.57 m, slim, an upright egg head with a tall narrow visor, a glazed drop down the chest, a terracotta spine strip, a terracotta stripe down each outer thigh, knee and ankle bands; jointed cream hands as Opus's; tempo 1.25 |
| Fable 5.1 | the storyteller | 1.77 m, matte terracotta over dark clay, a rounded acorn head on a visible neck (no lid, no slots) with one warm lens in a thin glazed bezel and glazed ear discs, glazed cream shoulder caps, a framed chest panel and a back tile whose cream glaze thins smoothly into the clay toward the foot (no runs); jointed terracotta hands; open palms and a slow head tilt |
| GPT 6.1 sol | warmer | 1.82 m, black glass on octagonal sections with wide rounded chamfers, a wraparound visor with a warm bar |
| GPT 6 astra | colder | 1.89 m, black glass on hexagonal sections with planar facets and a ridge down the head and chest, every hard edge chamfered 1.3 cm (the chamfer a polished line of light), a thin cold bar |
| Host | the mine's dispatcher | 1.45 m on two wheels, graphite, a safety-amber hard hat with a cap lamp, two camera eyes, amber shoulder caps and a hi-vis band; presents the ballot box with an open hand when it speaks; jointed graphite hands |

Materials (`materials.js`, by the models' slot names): cream bisque (roughness 0.64, a soft sheen),
glaze only on panels (clear coat), `glaze_fade` (Fable's tiles: the glaze thinning into terracotta,
a texture on front-projected UVs), matte terracotta, dark clay at the joints; black glass (glass v5):
obsidian under a sharp mirror (ior 1.9, roughness 0.06, clear coat in full), so most facets mirror
the dark room and read black at every distance, and a few carry a crisp highlight. The highlights
come from three narrow strip softboxes that travel with the camera (`SOFTBOX`: a tall key strip left
of the camera, a kicker strip on the right, an overhead bar), hung 0.6 m from the part they light so
a strip's hard edge crosses a flat facet as a line instead of lighting it whole; sol's strips are
warm (#ffe9d0), astra's cold (#dce8ff). Their radiance sits about the bloom threshold at a grazing
angle, so the visor bar stays the brightest thing. A thin Fresnel rim (falloff p 7: the edges that
graze the eye, not every oblique facet), point-light highlights clamped at 0.55 linear (below the
bloom's 1.2, so a glint never flares), the room's reflection (env 1.2×, lite 1.45×; astra 2.4×,
lite 2.9×) and a cool near-black floor on astra; `glass_cut` (astra): the same glass, its chamfers
(UV u = 1 from the model) each a line of the back light and a stronger reflection. From 3 to 8 m
from the eye the strips widen (sol 0.58× to 1.15× of `half`, astra 0.7× to 2.5×) and astra's
chamfer lines rise from 0.55× to 1×: afar a facet is a pixel or two and a strip's reflection a
speck, so the figure keeps the cream's readability while the share of lit facets stays small. Dark
satin titanium joints (#565a62).

Why v5 (v4.1 read as polished silver knights): v4.1's three softbox discs (cos 0.66/0.78/0.7)
covered about 86 % of the mirror's view, and a flat facet reflects one direction, so nearly every
facet was one flat grey panel (the term alone, switched off, took the grey away; the exposure lift
and the disc size had been ruled out before). Smaller, harder discs on their own give the same
chrome at a lower level; the grey also came from a rough mirror (0.14) spreading the ceiling's
fixtures over every upward facet, a rim at falloff 4 lighting every oblique facet, and the mid-grey
satin joints.

Models: `tools/blender/robots.py` (Blender 5, headless) writes `assets/robots/<id>.glb`, one node
per rigid part placed at its joint; `assets.js` reads the node positions as the skeleton and hangs
the parts on `rig.js`'s joints. Rebuild: `blender -b --factory-startup -P contest/stage/tools/blender/robots.py -- [--only id,...] [--review dir]`.

Checks (`robots/check/`, run with `node contest/stage/robots/check/run.mjs <page> --global <name> [--gfx lite] [--size WxH] [--shot png]`):

- `luma.html` (`__luma`): the fairness check. The style frame at `?ts=` (default 4.6 and 52.25), a
  mask per Judge, the mean Rec.709 luma of its silhouette at 640×360. Black glass must read as well
  as the cream without being as bright: each GPT Judge's mean 0.65-0.85 of Opus's in the wide shots,
  full and lite. Also each face light's colour on screen (the frame minus the frame with that light
  off) as a CCT. The style frame's wides since sequence v4.1: t 0.5 (the wide), 26.5 (the tally,
  the Judges from behind), 61 (the closing wide). Glass v5 (`--query ts=0.5,26.5,31.5,59,61`),
  GPT/Opus, full: t 0.5 sol 0.77, astra 0.80; 26.5 0.69, 0.69; 61 0.74, 0.79. Lite: 0.76, 0.80;
  0.69, 0.68; 0.72, 0.76. Not wides: at t 59 (a tube close shot, sol's legs behind it, Opus seen
  through a tube) sol is 0.80 full, 0.78 lite; at t 31.5 (Opus's decide close-up) astra is a dark
  sliver at the frame's edge, 0.30 in both (v4.1 gave 0.40 there: no black body reaches 0.65 in
  that frame). Visor CCT in the wides: sol 3710-4550 K, astra 6730-7030 K (a few pixels of bar
  mixed with the bloom; the same as v4.1: glass v5 does not touch the face lights, whose colours
  were measured up close at 3310 K and 7200 K, see Faces).
- `closeup.html` (`__close`, `--size 2400x2400`): close-ups in the Stage itself (its room, lights
  and post, a camera of its own) of every robot's right hand, with its token and at rest, Fable's
  head (front, three-quarter) and back tile, astra's facets. `?set=faces` (`--size 1920x1536`): the
  five faces at the states' levels, with each light's p95 luma on screen.
- `turnaround.html` (`__sheet`, `--size 2400x2700`): all six at one scale, front, three-quarter,
  side, on grey under a studio light, plus heights and proportions.
- `motion.html` (`__motion`, `--size 2400x3360`): idle twice, the gesture beat, speaking with a
  gesture, the decide beat at `tokenAt` and after `end`, plus the idle head speed and the beats'
  times per robot.

Locomotion is one procedural walk on one shared biped rig for every Judge (`robots/rig.js`):
stride, cadence, bob and sway per robot (Opus slow and heavy, Sonnet light and quick), the same
quality for both vendor families. The Host does not walk: it rolls on a wheeled base.

## Desk (console)

`stage.desks[id]`

| Member | What |
|---|---|
| `show(content, t)` | the main monitor: `{ kind: "text", path, text, from?, to? }` (verbatim file text; `from`/`to` = 1-based lines the tool returned, the view scrolls through them), `{ kind: "image", path, src }` (URL or `HTMLImageElement`), `{ kind: "ballot", place, contenders: [{ team, name, ceiling }] }`, or `null` (empty) |
| `setLog(items, t)` | the side monitor: `[{ kind, path, label, at }]` as the director gives it; newest last |
| `setTimer(since, t)` | turn start, show-clock seconds; the side monitor shows `м:сс`; `null` hides it |
| `setPower(level, t)` | `0` off, `0.16` dim, `1` lit; `stage.judge` sets it |
| `monitor()` | `{ center, normal, width, height }` of the main screen in world space (for the camera) |
| `spill` | `{ from, to, intensity }`: where the pooled spill light goes when this console gets one |

Monitor text: IBM Plex Mono at 44 px on a 1600×900 canvas (58 px lines). In the style frame's
over-the-shoulder shot the line pitch on the 1080p frame is 47–50 px, so the type is ≈ 36–38 px
(em), above the 28 px floor. Long files scroll; lines outside `from..to` are dimmed.

## Ballot station

`stage.ballot`: the ballot box (a glass drum under a steel cap with a slot, under the tungsten
pendant) and, in front of it toward the room, the round's urns in one straight row: a bar chart.

| Member | What |
|---|---|
| `setRound({ place, round, contenders: [{ team, name, ceiling }], line, voted }, t)` | the urns on show (up to 10, left to right as given, each on a plinth with its team id and name), a steel rod across the row at `line` tokens, the label «`line` из `voted`» at its end. `ceiling` urns for place 1 are capped and grey with «не может занять 1-е место». |
| `carry(id, plan)` | from `robot.vote`: the token is in the Judge's hand from `plan.t0` and goes into the slot at `plan.dropAt` |
| `drop(id, t)` | a token into the box at `t` without a walk (a fallback) |
| `reveal(id, team, t)` | that Judge's token rises from the box, turns to show the team it names and lands in that team's urn; returns the landing time (`t` + 2.35 s). `team: null` = no vote: the token opens empty and goes back. |
| `clear(t)` | tokens out: a new round |
| `count(team, t)` | tokens in that urn at `t` |
| `face(eye)` | called by `renderAt` after the camera moves: tokens in hand turn their sealed face to the lens |
| `anchors` | `slot`, `box`, `urn(team)` |

Tokens are made of their Judge's body material (cream ceramic or black glass) with a seal ring
inlaid in both faces in the family's second material (terracotta, or frosted white so a black
token reads in a black hand): a sealed token hides the choice, not the voter. Dropped tokens lie
in the glass drum in the order they came. An urn that reaches the line lights its line ring.

## Camera

`stage.camera`: shots are functions of time, so a shot can follow a walking robot; a held shot
pushes in slowly (a dolly, not a float).

| Call | What |
|---|---|
| `cut(shot, t)` | change shot at `t` |
| `move(shot, t, dur = 2)` | glide from whatever the camera shows at `t` (eased in and out) |
| `shotAt(t)` | the shot in force |
| `lens` | the last frame: `{ pos, target, fov, focus, aperture }` |

| Shot | Frames |
|---|---|
| `{ kind: "wide" }` | the room from the back and above: five consoles, the glass, the pit; the Host and the urn row in front |
| `{ kind: "medium", id, side?, span? }` | a Judge from the head to the waist, from the room side, off-centre toward `side` (±1); for a speaker facing the room |
| `{ kind: "ots", id, side? }` | over its shoulder onto its main monitor: the head and shoulder a dark edge of frame, the screen filling the rest (monitor type ≈ 36–38 px) |
| `{ kind: "walk", id, side? }` | three-quarter from the side of the box: the Judge crosses toward it, the token in hand turned to the lens, the slot in view |
| `{ kind: "ballot" }` | the box and the urn row from the front corner, the consoles behind: the walkers come and go |
| `{ kind: "reveal", team? }` | the urn row as a bar chart across the frame, the Judges behind it reading their reasons; `team` pushes in on that urn |
| `{ kind: "host" }` | the Host at its post |

Cuts between shots that cross the room; moves only between neighbouring frames (a move from the
wide into an over-the-shoulder flies through the room). Suggested mapping from the director (the
show decides; nothing in the scene picks shots), as in the style frame: a Judge's line → `medium`
of the speaker (cut a beat before the turn ends, so the face arrives on camera); a working Judge
with new content and no speaker → `ots`; the first finished vote turn → `walk` of that Judge,
then `ballot` while the rest walk; the first `voteReveal` → `reveal` until the line is reached;
`verdict` → `wide`; a Host line between beats → `wide`.

Depth of field is on in `medium` and `ots` only (full graphics).

## Subtitles and captions (`ui/subtitles.js`)

The only 2D layer. Both are pure functions of the show clock like the scene: `update(t)` sets the
DOM for `t`, with no CSS animation.

| Call | What |
|---|---|
| `subs.say(text, timing, t0, who?)` | broadcast pop-on subtitles: verbatim `text`, cut into blocks of ≤ 2 lines (measured in the real font, Inter 500 46 px, ≤ 1380 px wide; a block prefers to end at a sentence end; no one-word last block; a «quoted name» never breaks). A block appears whole when its first word starts (`timing.words[].start_s`, the `voice.prepare` shape) and stays until the next block's first word; the last holds 1.2 s. `who` (a Judge's model name) heads every block, a step bolder and dimmer; the Host is unnamed. `show.say` passes all of it. |
| `subs.stop(t)` | clear at `t` |
| `caps.introduce(id, t, mode, { dur, row })` | who is who, once per robot per mode: `"tag"`, a label over the robot's head that follows it in a wide shot (5.5 s; `row: 1` lifts it one row so neighbours never overlap), model (Inter 600 28 px) and CLI + version (Plex Mono 24 px); `"lower"`, a lower-left caption in a close shot (4.5 s; a newer one replaces it), model (42 px) and «Судья · CLI version» (26 px). |
