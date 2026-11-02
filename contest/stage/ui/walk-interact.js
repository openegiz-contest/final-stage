// The Walk's interactions (spec §7.7 «Прогулка», GLOSSARY «Прогулка»; owner 2026-10-28). ui/walk.js lets
// the Co-host drive the Host through the control room and click things; this module answers each click.
// The Judges speak here only their own published words (ADR-0010: nothing else is ever said for them).
//
//   judge    the robot reacts without words (robots/rig.js react: head and chest turn to the Host, a nod
//            or a small gesture of its own, the face light warms) and a card names it: model · CLI ·
//            vendor, from state.json's judges[] once the engine runs, else program.json's `judges` if
//            it has them, else the CLI's name alone (no version is ever written here: the roster's are
//            samples). In a hold after a Finalist (phase "hold", team set) the three Qualifying Judges
//            (QUALIFYING) also say their own published reason for that Finalist: scores/<judge>.json of
//            the Qualifying publication, the overall reason if the file has one, else the reason of the
//            highest-weight criterion (the first in Rubric order on a tie), verbatim, whole sentences up
//            to ~40 words; in their own voice (ctx.voice → /synth), subtitled, under the label
//            «из Отборочного этапа · о «<Team>»». Sonnet 5.5 and Fable 5.1 (Final-only Judges) never
//            speak; in any other phase, the debate above all, nobody does.
//   console  the Judge's console shows what it opened in the Qualifying for the current Finalist: the
//            screenshots its Score cites (screenshots/<judge>/) on the main monitor, every reference of
//            its Score on the side monitor (never a folder listing, CONTRACT.md §3). Not in the
//            debate and not without a Finalist: the consoles show the live reading then.
//   wall     a panel: the current Finalist's Stand video (program.json finalists[i].video), its
//            screenshots (finalists[i].images, else the ones the Qualifying Judges cite) and its Concept
//            (its Concept section of SUBMISSION.md, verbatim, as tools/build.py reads it; only where /pub/ has
//            the Final Materials' teams/); with no Finalist on, the Finalists' list.
//   urn      the voting rules in the Host's accepted words: the «Правила голосования» paragraph of
//            program.json's intro (tools/build.py intro_text), else the intro's sentences on voting,
//            verbatim; spoken by the Host when nothing else speaks and the phase allows (never in the
//            launch, the debate or the envelopes), else shown on a card; with no such text the rules
//            card is built from ui/cards.js LABELS.
//
// One interaction at a time. walk.busy(true) only while a line may be said (its preparation, ≤ 1.5 s,
// and the line itself): a click then goes nowhere, so no line is ever cut or doubled. A wordless one
// gives way to the next click at once (its reaction eases out, its card and panel close), so a click
// is never lost. A panel or a card stays up passively until its time runs out, Escape, the next
// interaction or the Walk switched off (P: a line still going stops too). Nothing here touches the director: the debate's queue of real lines, its
// consoles and its camera hand-over are never disturbed (in the debate: focus and a wordless reaction).
// A line is spoken only into silence (no other line of ctx.voice overlaps it). The show clock rules
// everything (lib/clock.js now(): the operator's pause holds it all); when the operator jumps the clock
// (← / →) every interaction not yet over is undone: its voice taken out of the voice's queue (so
// voice.resync never plays it again), its subtitles stopped, its reaction removed, its panels closed.
// Only a console's monitor keeps what it was shown (world/desk.js has no undo): after a jump back over
// a console click the Judge's own Qualifying screenshots show again at that moment, dimly, without sound.
//
// What is shown is on air only while the Walk's camera is (walk.share; in the debate the director holds the
// screen through every line and vote): a click made off the air shows nothing on the director's shot.
//
// Under ?cams=1 every panel, card and label stays out of the top-corner webcam circles (ui/safe.js):
// panels live in the band between them (SAFE.x from either side), the card bottom-left, the label next
// to the subtitles and moved below them if it would touch a circle.
//
//   import * as m from "/ui/walk-interact.js";
//   const wi = m.attach(walk, { stage, voice, subtitles, programData, pubBase: "/pub/", current, overlay });
//     stage: world/stage.js (or walk.stage); programData: loadProgram()'s program; current() →
//     { phase: "intro"|"preshow"|"hold"|"launch"|"debate"|"envelopes"|"end", team: "team-NNN"|null }
//   wi.close()   closes the panel and the card;  wi.dispose();  wi.log: what every click did (checks)
import * as THREE from "three";
import { now, showClock } from "/lib/clock.js";
import { ROSTER } from "/robots/roster.js";
import { LABELS as CARD_LABELS } from "/ui/cards.js";
import { labels as HOST_LABELS } from "/director/host.js";
import { majorityLine } from "/ui/show.js";
import { FRAME, SAFE, hitsCams } from "/ui/safe.js";
import { SIDE_X } from "/world/layout.js";

/** The Judges who scored in the Qualifying Round and may say their reason in a hold. */
export const QUALIFYING = ["opus-5.5", "gpt-6.1-sol", "gpt-6-astra"];
const QUIET_PHASES = new Set(["launch", "debate", "envelopes"]); // nobody speaks here
const LIVE_PHASES = new Set(["launch", "debate", "envelopes", "end"]); // state.json is this show's run

export const WALK = {
  quoteWords: 40,   // a reason is said whole up to this; longer, whole sentences up to it
  quoteMaxWords: 60, // a first sentence longer than this is not said at all (never cut inside a sentence)
  lead: 0.9,        // s from the start to the first word: the Judge turns to the Host first
  tail: 0.8,        // s the reaction holds after the last word
  focusS: 2.6,      // s the camera holds what was clicked when nothing is said (walk.focus)
  readyS: 1.5,      // a line not prepared by then is not said (the reaction stays wordless)
  fetchS: 3,        // s a publication file may take
  cardS: 5.5,       // the Judge's card
  wallS: 20,        // the wall's panel without a video (with one: the video's length, at most 60 s)
  listS: 14, rulesS: 16, consoleS: 14, consoleShotS: 4.5,
  quietPanelS: 8,   // a panel in the launch, the debate or the envelopes: short, the director's cards come first
  fade: 0.25,
  subsHold: 1.2,    // ui/subtitles.js HOLD: a finished line stays up this long
};

// On the panels and cards. PROPOSALS for the owner (like ui/cards.js LABELS), except fromQualifying,
// the owner's own label (2026-10-28).
export const LABELS = {
  fromQualifying: (name) => `из Отборочного этапа · о «${name}»`,
  rank: (r) => `${r}-е место Отборочного этапа`, // ui/program.js LABELS.rank + rankOf
  concept: () => "Замысел", // GLOSSARY
  finalists: () => "Финалисты",
  finalistsOf: () => "места и баллы Отборочного этапа",
  ceiling: () => HOST_LABELS.ceiling(), // «не может занять 1-е место»
  vendor: { anthropic: "Anthropic", openai: "OpenAI" },
};

// ---- pure helpers (exported for the checks) ------------------------------------------------------

const wordCount = (s) => String(s).trim().split(/\s+/).filter(Boolean).length;

/** Sentence spans [{ from, to }] of a text: a sentence ends at . ! ? … (and closing quotes) before a
 *  capital letter or the end, so «п. 9.3» or «т. е. двойник» stay inside their sentence. */
export function sentences(text) {
  const s = String(text ?? ""), out = [], re = /[.!?…]+[»")\]]*(?=\s+[«"(]?[A-ZА-ЯЁ]|\s*$)/g;
  let from = 0, m;
  while ((m = re.exec(s))) {
    const to = m.index + m[0].length;
    if (s.slice(from, to).trim()) out.push({ from, to });
    from = to;
  }
  if (s.slice(from).trim()) out.push({ from, to: s.length });
  return out;
}

/** What a Judge says of a reason: the whole text up to `max` words, else whole sentences up to it, else
 *  the first sentence if it has at most `hard` words, else null. Always a verbatim prefix of the text. */
export function clipQuote(text, max = WALK.quoteWords, hard = WALK.quoteMaxWords) {
  const s = String(text ?? "").trim();
  if (!s) return null;
  if (wordCount(s) <= max) return s;
  const sp = sentences(s);
  let end = 0;
  for (const x of sp) {
    if (wordCount(s.slice(0, x.to)) > max) break;
    end = x.to;
  }
  if (!end && sp[0] && wordCount(s.slice(0, sp[0].to)) <= hard) end = sp[0].to;
  return end ? s.slice(0, end).trim() : null;
}

/** The reason a Score gives (score.schema.json of openegiz-judge: criteria in Rubric order with max,
 *  points, reasoning, references): an overall reason if the file has one, else the highest-weight
 *  criterion's (the first on a tie). { text, criterion } or null. */
export function reasonOf(score) {
  if (!score || typeof score !== "object") return null;
  const overall = [score.reasoning, score.reason].find((x) => typeof x === "string" && x.trim());
  if (overall) return { text: overall, criterion: null };
  const cs = (Array.isArray(score.criteria) ? score.criteria : []).filter((c) => typeof c?.reasoning === "string" && c.reasoning.trim());
  if (!cs.length) return null;
  const best = cs.reduce((a, c) => (Number(c.max) > Number(a.max) ? c : a));
  return { text: best.reasoning, criterion: best.id ?? null };
}

/** The voting rules in the Host's accepted words from the intro's text: the paragraph that opens with
 *  «Правила голосования.» (and the ceiling paragraph after it, if any), else the intro's sentences on
 *  voting, verbatim; null when there are none. */
export function rulesOf(intro) {
  const s = String(intro ?? "");
  if (!s.trim()) return null;
  const paras = s.split(/\n\s*\n/).map((p) => p.trim());
  const i = paras.findIndex((p) => /^Правила голосования\./.test(p));
  if (i >= 0) return [paras[i], ...(/потол/i.test(paras[i + 1] ?? "") ? [paras[i + 1]] : [])].join("\n\n");
  const picked = sentences(s).map(({ from, to }) => s.slice(from, to).trim())
    .filter((x) => /голосу|голосов|большинств|Правил[оа] последнего слова/i.test(x));
  return picked.length ? picked.join(" ") : null;
}

/** The Concept (GLOSSARY «Замысел»): its section of SUBMISSION.md, the body verbatim. */
export function conceptOf(md) {
  // tools/build.py concept_section, line for line (as judge/solution.py reads it): the section under a
  // «## Concept | Замысел | Тұжырымдама» heading, up to the next # or ## outside a code fence, HTML
  // comments dropped. (Python's \b is Unicode-aware, JS's is not: hence the lookahead.)
  const HEADING = /^##[ \t]+(?:\d+[.)]?[ \t]*)?(?:concept|замысел|тұжырымдама)(?![\p{L}\p{N}_])/iu;
  let section = null, fence = null;
  for (const line of String(md ?? "").split(/\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/)) {
    const mark = /^\s*(```+|~~~+)/.exec(line);
    if (mark) {
      const kind = mark[1][0];
      fence = fence === kind ? null : fence || kind;
    }
    if (fence === null && !mark) {
      if (section !== null && /^#{1,2}[ \t]/.test(line)) break;
      if (section === null && HEADING.test(line)) {
        section = [];
        continue;
      }
    }
    if (section !== null) section.push(line);
  }
  if (section === null) return null;
  return section.join("\n").replace(/<!--[\s\S]*?-->/g, "").trim() || null;
}

/** A Score's references («kind:value», as the Judge wrote them): the screenshots it cites (file names
 *  in screenshots/<judge>/) and every reference as a { label, path } row for the side monitor. */
export function refsOf(score) {
  const shots = [], files = [], seen = new Set();
  for (const c of Array.isArray(score?.criteria) ? score.criteria : []) {
    for (const r of Array.isArray(c?.references) ? c.references : []) {
      if (typeof r !== "string" || seen.has(r)) continue;
      seen.add(r);
      const k = r.indexOf(":"), kind = k > 0 ? r.slice(0, k) : r, rest = k > 0 ? r.slice(k + 1) : "";
      if (kind === "screenshot" && rest && !/[\\/]|\.\./.test(rest)) shots.push(rest);
      files.push({ label: kind, path: rest });
    }
  }
  return { shots, files };
}

/** Who a Judge is, for its card: { name, model, cli, vendor, source }: state.json's judges[] (the run on
 *  air), else program.json's `judges`, else the roster's CLI name (no version: the roster's are samples). */
export function cardOf(id, { state = null, program = null } = {}) {
  const r = ROSTER[id] ?? {};
  const live = Array.isArray(state?.judges) ? state.judges.find((j) => j?.name === id) : null;
  const built = !live && Array.isArray(program?.judges) ? program.judges.find((j) => j?.name === id) : null;
  const src = live ?? built;
  return {
    id, name: r.model ?? id, model: src?.model ?? null, cli: (src?.cli && !/^fake\b/.test(src.cli) ? src.cli : null) ?? r.cli ?? null,
    vendor: LABELS.vendor[r.vendor] ?? null, source: live ? "state" : built ? "program" : "roster",
  };
}
export const cardLine = (c) => [c.model, c.cli, c.vendor].filter(Boolean).join(" · ");

// ---- the 2D layer (the look of ui/stage.css and ui/cards.css; no CSS animation: update(t) sets it) --

const CSS = `
.wi { position: absolute; inset: 0; pointer-events: none; }
.wi > div { position: absolute; opacity: 0; display: none; }
.wi-card { left: 96px; bottom: 292px; padding: 12px 22px 14px 28px; border-radius: 9px; background: rgba(8, 8, 9, 0.72);
  white-space: nowrap; box-shadow: inset 6px 0 0 var(--accent, #c9a46a); }
.wi-card.wi-anthropic { --accent: #c8714b; } .wi-card.wi-openai { --accent: #e9ecf2; }
.wi-card-name { font: 600 42px/1.12 "Inter", system-ui, sans-serif; color: #f6f3ee; }
.wi-card-sub { font: 400 26px/1.3 "IBM Plex Mono", ui-monospace, monospace; color: #d6d0c7; margin-top: 2px; }
.wi-label { left: 0; top: 0; padding: 6px 14px 7px; border-radius: 7px; background: rgba(8, 8, 9, 0.8);
  font: 600 28px/1.2 "Inter", system-ui, sans-serif; color: #c9a46a; white-space: nowrap; }
.wi-panel { left: ${SAFE.x}px; top: 48px; width: ${FRAME.W - 2 * SAFE.x}px; max-height: 720px; padding: 22px 28px 24px;
  border-radius: 10px; background: rgba(8, 8, 9, 0.93); overflow: hidden; color: #f6f3ee; }
.wi-kicker { font: 600 28px/1.2 "Inter", system-ui, sans-serif; letter-spacing: 0.06em; text-transform: uppercase; color: #c9a46a; }
.wi-title { font: 700 56px/1.08 "Inter", system-ui, sans-serif; color: #fbf6ee; margin-top: 2px; }
.wi-meta { font: 500 28px/1.3 "Inter", system-ui, sans-serif; color: #d6d0c7; margin-top: 4px; }
.wi-meta .wi-note { color: #8f8a83; }
.wi-media-row { display: flex; gap: 16px; margin-top: 16px; }
.wi-media { width: 560px; height: 315px; flex: none; background: #050506; border-radius: 6px; overflow: hidden; }
.wi-media video, .wi-media img { display: block; width: 100%; height: 100%; object-fit: contain; }
.wi-thumbs { display: grid; grid-template-columns: repeat(2, 260px); grid-auto-rows: 146px; gap: 16px 12px; align-content: start; }
.wi-thumbs img { width: 260px; height: 146px; object-fit: cover; border-radius: 4px; background: #050506; display: block; }
.wi-concept-k { margin-top: 18px; }
.wi-concept { font: 500 28px/1.34 "Inter", system-ui, sans-serif; color: #f6f3ee; white-space: pre-line; margin-top: 6px;
  display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 5; overflow: hidden; }
.wi-rows { margin-top: 10px; }
.wi-row { display: flex; gap: 24px; align-items: baseline; font: 500 32px/1.46 "Inter", system-ui, sans-serif; white-space: nowrap; }
.wi-row-rank { min-width: 1.6em; text-align: right; font-weight: 600; color: #c9a46a; }
.wi-row-name { overflow: hidden; text-overflow: ellipsis; }
.wi-row-note { font-size: 26px; color: #8f8a83; }
.wi-row-score { margin-left: auto; font: 500 30px/1.46 "IBM Plex Mono", ui-monospace, monospace; color: #bdb7ae; }
.wi-rules { font: 500 32px/1.36 "Inter", system-ui, sans-serif; color: #f6f3ee; margin-top: 10px; white-space: pre-line; }
.wi-rule { margin-top: 16px; padding-left: 20px; border-left: 6px solid #c9a46a; }
.wi-rule-title { font: 600 34px/1.25 "Inter", system-ui, sans-serif; color: #f6f3ee; }
.wi-rule-why { font: 500 28px/1.3 "Inter", system-ui, sans-serif; color: #d6d0c7; }
`;

const el = (tag, cls, kids = []) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  for (const k of [].concat(kids)) if (k !== null && k !== undefined && k !== false) e.append(k);
  return e;
};
const txt = (cls, text) => el("div", cls, [String(text)]);
const score2 = (s) => (s === null || s === undefined ? "" : String(s).replace(".", ","));
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

/** Resolve with the promise's value, or with null after `s` seconds (the promise keeps running). */
const within = (p, s) => Promise.race([Promise.resolve(p).catch(() => null), new Promise((r) => setTimeout(() => r(null), s * 1000))]);

async function fetchWithin(url, s, as = "json") {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), s * 1000);
  try {
    const r = await fetch(url, { cache: "no-store", signal: ctl.signal });
    if (!r.ok) return null;
    return as === "json" ? await r.json() : await r.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function loadImage(src) {
  const img = new Image();
  img.src = src;
  try {
    await img.decode();
    return img;
  } catch {
    return null;
  }
}

// ---- attach --------------------------------------------------------------------------------------

export function attach(walk, ctx = {}) {
  const stage = ctx.stage ?? walk?.stage;
  if (!stage) throw new Error("walk-interact: no stage (pass ctx.stage, or expose walk.stage)");
  const voice = ctx.voice ?? null, subs = ctx.subtitles ?? null, program = ctx.programData ?? {};
  const current = ctx.current ?? (() => ({ phase: "preshow", team: null }));
  const pub = String(ctx.pubBase ?? "/pub/").replace(/\/?$/, "/");
  const stateUrl = ctx.stateUrl ?? "/run/state.json";
  const root = ctx.overlay ?? document.getElementById("overlay") ?? document.body;
  const warn = (m) => console.warn(`[walk-interact] ${m}`);
  const finalists = Array.isArray(program.finalists) ? program.finalists : [];
  const finalistOf = (team) => finalists.find((f) => f.team === team) ?? null;
  const nameOf = (team) => finalistOf(team)?.name ?? team;
  const rules = rulesOf(program.intro?.text);

  // ---- the layer
  const style = el("style", null, [CSS]);
  document.head.append(style);
  const layer = el("div", "wi");
  const card = el("div", "wi-card"), label = el("div", "wi-label"), panel = el("div", "wi-panel");
  layer.append(panel, card, label);
  root.append(layer);
  const shown = { card: null, label: null, panel: null }; // { from, to, kind, run }
  const nodes = { card, label, panel };
  function put(key, from, to, kind, run) {
    shown[key] = { from, to, kind, run };
  }
  function hide(key) {
    shown[key] = null;
    nodes[key].style.display = "none";
    nodes[key].style.opacity = "0";
    if (key === "panel") for (const v of panel.querySelectorAll("video")) v.pause();
  }
  const closePassive = () => ["card", "label", "panel"].forEach(hide);

  // ---- where things are: the wall's centre (props/board.js on the left wall, world/hall.js)
  const BX = -SIDE_X + 0.07, BY = 1.78, BZ = 0.6;
  const wallAnchor = new THREE.Object3D();
  wallAnchor.name = "walk-wall";
  wallAnchor.position.set(BX, BY, BZ);
  stage.scene?.add(wallAnchor);
  const WALL_SHOT = { kind: "look", name: "walk-wall", pos: [BX + 4.15, 1.72, BZ], target: [BX, BY - 0.02, BZ], fov: 32, exposure: 1.5, rate: 0.012, max: 0.18 };
  const hostPoint = () => stage.robots.host?.anchors?.head?.getWorldPosition(new THREE.Vector3()) ?? null;
  const focus = (obj, opts) => {
    try {
      return walk.focus?.(obj, opts);
    } catch (e) {
      warn(`focus: ${e?.message ?? e}`);
      return null;
    }
  };

  // ---- the publication (Qualifying Round): /pub/publication/… (the Final Materials) or /pub/… (the
  // publication itself, before a run)
  // Which of the two it is, asked once by the publication's results.json (CONTRACT.md): with no /pub/
  // at all (server.py without --pub) that is the only request that fails, never one per Judge and team.
  let layout = null;
  const pubRoot = () => (layout ??= (async () => {
    for (const base of [`${pub}publication/`, pub]) if (await fetchWithin(`${base}results.json`, WALK.fetchS)) return base;
    return null; // no Qualifying words, screenshots or Concept: wordless reactions, cards and lists only
  })());
  const scores = new Map(); // `${judge}|${team}` → Promise<{ score, base } | null>
  function scoreOf(judge, team) {
    const key = `${judge}|${team}`;
    if (!scores.has(key)) scores.set(key, (async () => {
      const r = await pubRoot();
      if (!r) return null;
      const base = `${r}solutions/${team}/`;
      const score = await fetchWithin(`${base}scores/${encodeURIComponent(judge)}.json`, WALK.fetchS);
      return score && typeof score === "object" ? { score, base } : null;
    })());
    return scores.get(key);
  }
  const concepts = new Map();
  const conceptFor = (team) => {
    // the sources are in the Final Materials only (teams/ beside publication/), not in a publication
    if (!concepts.has(team)) concepts.set(team, pubRoot().then((r) => (r === `${pub}publication/` ? fetchWithin(`${pub}teams/${team}/source/src/SUBMISSION.md`, WALK.fetchS, "text").then(conceptOf) : null)));
    return concepts.get(team);
  };
  let stateCache = { at: -Infinity, state: null };
  async function liveState(phase) {
    if (!LIVE_PHASES.has(phase)) return null; // before the launch any state.json is another run's
    if (performance.now() - stateCache.at < 3000) return stateCache.state;
    const state = await fetchWithin(stateUrl, 1.5);
    stateCache = { at: performance.now(), state };
    return state;
  }
  const quoteOf = async (judge, team) => {
    const s = await scoreOf(judge, team);
    const reason = reasonOf(s?.score);
    const text = clipQuote(reason?.text);
    return text ? { text, criterion: reason.criterion, full: reason.text } : null;
  };

  // ---- voice: only into silence
  const quiet = (a, b) => !(voice?.plays ?? []).some((p) => p.end > a - 0.2 && p.at < b);
  function playLine(run, speaker, text, prepared, at) {
    const p = voice.play(prepared, { at });
    const entry = voice.plays?.at(-1);
    subs?.say(text, prepared, at, speaker);
    run.undo.push(() => {
      p?.stop?.();
      const q = voice.plays, i = q ? q.indexOf(entry) : -1;
      if (i >= 0) q.splice(i, 1); // out of the queue: voice.resync() after a jump never plays it again
      subs?.stop(at);
    });
    return at + prepared.durationS;
  }

  // ---- interactions
  const log = [];
  const history = []; // every run, for the undo after a jump of the clock
  let active = null;
  const clicks = {};
  function begin(kind, id, cur) {
    closePassive();
    const run = { kind, id, phase: cur.phase, team: cur.team ?? null, t0: now(), end: Infinity, undo: [], reacts: [], busy: false, cancelled: false, rec: { kind, id, phase: cur.phase, team: cur.team ?? null, at: now() } };
    active = run;
    history.push(run);
    log.push(run.rec);
    return run;
  }
  // walk.busy only while a line may be said (prepared or spoken): a wordless interaction gives way to
  // the next click at once, so a Co-host's click never goes nowhere
  function setBusy(run, b) {
    if (run.busy === b || (b && active !== run)) return;
    run.busy = b;
    try {
      walk.busy?.(b);
    } catch {}
  }
  function finish(run) {
    if (active !== run) return;
    active = null;
    run.done = now();
    setBusy(run, false);
  }
  const reactOf = (run, h) => (h && run.reacts.push(h), h);
  function undo(run, { soft = false } = {}) {
    // soft (the next click, the Walk switched off): its reaction eases out; hard (a jump of the clock): gone
    run.cancelled = true;
    for (const h of run.reacts.splice(0)) {
      try {
        soft ? h.release(now()) : h.cancel();
      } catch {}
    }
    for (const u of run.undo.splice(0).reverse()) {
      try {
        u();
      } catch {}
    }
    for (const k of ["card", "label", "panel"]) if (shown[k]?.run === run) hide(k);
    finish(run);
  }

  function showCard(run, id, t) {
    const c0 = cardOf(id, { program });
    const draw = (c) => {
      card.className = `wi-card wi-${ROSTER[id]?.vendor ?? "house"}`;
      card.replaceChildren(txt("wi-card-name", c.name), ...(cardLine(c) ? [txt("wi-card-sub", cardLine(c))] : []));
      run.rec.card = { ...c, line: cardLine(c) };
    };
    draw(c0);
    put("card", t, t + WALK.cardS, "card", run);
    liveState(run.phase).then((state) => {
      if (state && shown.card?.run === run) draw(cardOf(id, { state, program }));
    });
  }

  async function onJudge(run, id) {
    const r = stage.robots[id];
    if (!r) return finish(run);
    const t = now();
    showCard(run, id, t);
    const toward = hostPoint();
    // the reason, said in a hold after a Finalist by a Qualifying Judge, when its line is ready in time
    let line = null;
    if (run.phase === "hold" && run.team && QUALIFYING.includes(id) && voice) {
      setBusy(run, true);
      const q = await within(quoteOf(id, run.team), WALK.readyS);
      const prepared = q ? await within(voice.prepare(id, q.text), WALK.readyS) : null;
      if (run.cancelled) return;
      if (q && prepared?.durationS > 0) line = { ...q, prepared };
    }
    const t1 = now();
    if (line) {
      const at = t1 + WALK.lead, end = at + line.prepared.durationS;
      if (quiet(at, end + WALK.tail)) {
        reactOf(run, r.react?.("speak", t1, { toward, dur: end + WALK.tail - t1, level: (x) => voice.levelAt(x) }));
        playLine(run, id, line.text, line.prepared, at);
        label.textContent = LABELS.fromQualifying(nameOf(run.team));
        put("label", at, end + WALK.subsHold, "label", run);
        focus(r.object3d, { seconds: end + WALK.tail - t1, shot: { kind: "medium", id } });
        run.end = end + WALK.tail;
        Object.assign(run.rec, { react: "speak", spoke: { speaker: id, text: line.text, criterion: line.criterion, at, end }, label: label.textContent });
        return;
      }
      run.rec.skipped = "not quiet";
    }
    setBusy(run, false);
    const n = (clicks[id] = (clicks[id] ?? 0) + 1);
    const kind = n % 2 ? "nod" : "gesture";
    const h = reactOf(run, r.react?.(kind, t1, { toward }));
    focus(r.object3d, { seconds: WALK.focusS, shot: { kind: "medium", id } });
    run.end = Math.max(t1 + WALK.focusS, h?.end ?? 0);
    Object.assign(run.rec, { react: h ? kind : null, spoke: null });
  }

  async function onConsole(run, id) {
    const d = stage.desks[id];
    if (!d) return finish(run);
    const t = now();
    showCard(run, id, t);
    focus(d.object3d, { seconds: WALK.focusS + 1, shot: { kind: "ots", id } }); // over the shoulder: the monitor and its path line (world/camera.js)
    run.end = t + WALK.focusS + 1;
    run.rec.console = null;
    if (!run.team || QUIET_PHASES.has(run.phase)) return; // the consoles show the live reading in the debate
    const s = await within(scoreOf(id, run.team), WALK.fetchS);
    if (run.cancelled || !s) return;
    const { shots, files } = refsOf(s.score);
    const rel = (name) => `publication/solutions/${run.team}/screenshots/${id}/${name}`;
    const imgs = (await Promise.all(shots.map(async (name) => {
      const src = `${s.base}screenshots/${encodeURIComponent(id)}/${encodeURIComponent(name)}`;
      const img = await within(loadImage(src), WALK.fetchS);
      return img ? { name, src, img } : null;
    }))).filter(Boolean);
    if (run.cancelled) return;
    const t1 = now(), dur = Math.max(WALK.consoleS, imgs.length * WALK.consoleShotS);
    d.setPower(0.9, t1);
    d.setLog(files, t1);
    imgs.forEach((x, i) => d.show({ kind: "image", label: "screenshot", path: rel(x.name), src: x.src, img: x.img }, t1 + i * WALK.consoleShotS));
    d.setPower(0.16, t1 + dur); // back to the room's idle level (ui/program.js judgesAt)
    run.rec.console = { shots: imgs.map((x) => x.src), files: files.map((f) => (f.path ? `${f.label}:${f.path}` : f.label)), until: t1 + dur };
  }

  const panelS = (run, s) => (QUIET_PHASES.has(run.phase) ? Math.min(s, WALK.quietPanelS) : s);
  function finalistPanel(run, f, t) {
    const media = el("div", "wi-media"), thumbs = el("div", "wi-thumbs");
    const concept = txt("wi-concept", ""), conceptK = txt("wi-kicker wi-concept-k", LABELS.concept());
    conceptK.style.display = concept.style.display = "none";
    const meta = el("div", "wi-meta", [LABELS.rank(f.rank), ...(f.ceiling ? [" · ", el("span", "wi-note", [LABELS.ceiling()])] : [])]);
    panel.replaceChildren(txt("wi-title", `«${f.name}»`), meta, el("div", "wi-media-row", [media, thumbs]), conceptK, concept);
    let video = null;
    if (f.video) {
      video = el("video");
      Object.assign(video, { muted: true, playsInline: true, preload: "auto", src: f.video });
      video.muted = true;
      media.append(video);
      video.play?.().catch(() => {});
    }
    const pics = (srcs) => {
      const list = srcs.slice(0, video ? 4 : 5);
      if (!video && list.length) {
        media.replaceChildren(el("img", null));
        media.firstChild.src = list.shift();
      }
      thumbs.replaceChildren(...list.slice(0, 4).map((src) => Object.assign(el("img"), { src })));
      run.rec.images = srcs.slice(0, video ? 4 : 5);
    };
    if (f.images?.length) pics(f.images);
    else {
      // the screenshots the Qualifying Judges cite, in their order (the minute had none of its own)
      Promise.all(QUALIFYING.map(async (j) => {
        const s = await scoreOf(j, f.team);
        return s ? refsOf(s.score).shots.map((n) => `${s.base}screenshots/${encodeURIComponent(j)}/${encodeURIComponent(n)}`) : [];
      })).then((lists) => {
        if (shown.panel?.run !== run) return;
        const seen = new Set(), all = [];
        for (let i = 0; all.length < 6 && lists.some((l) => l[i]); i++) for (const l of lists) if (l[i] && !seen.has(l[i])) (seen.add(l[i]), all.push(l[i]));
        if (all.length) pics(all);
      });
    }
    conceptFor(f.team).then((c) => {
      if (!c || shown.panel?.run !== run) return;
      concept.textContent = c;
      conceptK.style.display = concept.style.display = "";
      run.rec.concept = c;
    });
    const len = f.video ? Math.min(60, f.videoDurationS > 0 ? f.videoDurationS : 60) : WALK.wallS;
    put("panel", t, t + panelS(run, len), "finalist", run);
    Object.assign(run.rec, { panel: "finalist", video: f.video ?? null });
  }

  function listPanel(run, t) {
    // the Qualifying's places (never to be read as the Final's: the line under the title says whose)
    const rows = [...finalists].sort((a, b) => a.rank - b.rank).map((f) => el("div", "wi-row", [
      txt("wi-row-rank", String(f.rank)), el("div", "wi-row-name", [`«${f.name}»`]),
      ...(f.ceiling ? [txt("wi-row-note", LABELS.ceiling())] : []), txt("wi-row-score", score2(f.score)),
    ]));
    panel.replaceChildren(txt("wi-kicker", LABELS.finalists()), txt("wi-meta", LABELS.finalistsOf()), el("div", "wi-rows", rows));
    put("panel", t, t + panelS(run, WALK.listS), "list", run);
    Object.assign(run.rec, { panel: "list", rows: rows.length });
  }

  async function rulesPanel(run, t) {
    if (rules) {
      const [first, ...rest] = rules.split(/(?<=^Правила голосования\.)\s+/);
      panel.replaceChildren(...(rest.length ? [txt("wi-kicker", first.replace(/\.$/, "")), txt("wi-rules", rest.join(" "))] : [txt("wi-rules", rules)]));
      run.rec.panel = "rules-text";
    } else {
      // no accepted Host text on voting: the rules card from ui/cards.js LABELS
      const state = await liveState(run.phase);
      if (run.cancelled) return;
      const voted = state?.judges?.filter((j) => j.status !== "недоступен").length || 5;
      const max = state?.settings?.rounds_per_place ?? null;
      const capped = finalists.filter((f) => f.ceiling);
      panel.replaceChildren(
        el("div", "wi-rule", [txt("wi-rule-title", `${CARD_LABELS.majority()} — ${HOST_LABELS.reached(majorityLine(voted), voted)}`)]),
        el("div", "wi-rule", [txt("wi-rule-title", CARD_LABELS.lastWordTitle()), ...(max ? [txt("wi-rule-why", CARD_LABELS.lastWordWhy(max))] : [])]),
        ...capped.map((f) => el("div", "wi-rule", [txt("wi-rule-title", `«${f.name}» — ${CARD_LABELS.ceiling()}`)])),
      );
      run.rec.panel = "rules-labels";
    }
    put("panel", t, t + panelS(run, WALK.rulesS), run.rec.panel, run);
  }

  async function onWall(run) {
    const t = now();
    focus(wallAnchor, { seconds: WALK.focusS, shot: WALL_SHOT });
    run.end = t + WALK.focusS;
    const f = run.team ? finalistOf(run.team) : null;
    if (f) finalistPanel(run, f, t);
    else listPanel(run, t);
  }

  async function onUrn(run) {
    const t = now();
    focus(stage.ballot?.group ?? wallAnchor, { seconds: WALK.focusS, shot: { kind: "tally" } });
    run.end = t + WALK.focusS;
    if (rules && voice && !QUIET_PHASES.has(run.phase)) {
      setBusy(run, true);
      const prepared = await within(voice.prepare("host", rules), WALK.readyS);
      if (run.cancelled) return;
      const at = now() + 0.4, end = at + (prepared?.durationS ?? 0);
      if (prepared?.durationS > 0 && quiet(at, end + 0.3)) {
        reactOf(run, stage.robots.host?.react?.("speak", at - 0.3, { dur: end + WALK.tail - at + 0.3, level: (x) => voice.levelAt(x) }));
        playLine(run, "host", rules, prepared, at);
        run.end = end + WALK.tail;
        Object.assign(run.rec, { spoke: { speaker: "host", text: rules, at, end }, panel: null });
        return;
      }
      setBusy(run, false);
    }
    run.rec.spoke = null;
    await rulesPanel(run, t);
  }

  const HANDLERS = { judge: onJudge, console: onConsole, wall: onWall, urn: onUrn };
  let played = false; // the Co-host has clicked something: from then on the prewarm may ask /pub/
  async function handle(ev = {}) {
    const { kind, id = null } = ev;
    played = true;
    if (active?.busy) {
      log.push({ kind, id, ignored: "busy", at: now() });
      return;
    }
    const fn = HANDLERS[kind];
    if (!fn) return;
    if (active) {
      active.rec.superseded = now();
      undo(active, { soft: true });
    }
    const cur = current() ?? {};
    const run = begin(kind, id, cur);
    try {
      await fn(run, id);
    } catch (e) {
      warn(`${kind} ${id ?? ""}: ${e?.message ?? e}`);
      run.end = now();
    }
  }
  const off = walk.on?.("interact", (ev) => void handle(ev));
  // the Walk switched off (P): the director has the room again, so a line still going stops with the rest
  const offToggle = walk.on?.("toggle", ({ enabled } = {}) => {
    if (enabled) return;
    if (active) undo(active, { soft: true });
    closePassive();
  });

  // ---- the prewarm: a Finalist on the wall → its three reasons prepared before the hold's clicks. Only
  // once the Co-host has clicked: a Walk merely switched on asks nothing of /pub/ (a server without
  // --pub then logs no 404 at all)
  let warmed = null;
  function warm() {
    const cur = current() ?? {};
    if (!played || !voice || !cur.team || QUIET_PHASES.has(cur.phase) || cur.team === warmed) return;
    warmed = cur.team;
    for (const id of QUALIFYING) quoteOf(id, cur.team).then((q) => q && voice.prepare(id, q.text)).catch(() => {});
  }
  if (voice && rules) voice.prepare("host", rules);

  // ---- every frame: the clock's jumps, the end of an interaction, the layer
  function place(t) {
    // the quote's label sits over the subtitles (the bottom bar or the speech line beside the Judge)
    const frame = root.getBoundingClientRect(), k = frame.width / FRAME.W || 1;
    const subEl = [...root.querySelectorAll(".subs, .say")].find((e) => e.offsetWidth && Number(e.style.opacity || 0) > 0.05);
    if (!subEl) return false;
    const b = subEl.getBoundingClientRect();
    const box = { left: (b.left - frame.left) / k, top: (b.top - frame.top) / k, right: (b.right - frame.left) / k, bottom: (b.bottom - frame.top) / k };
    const w = label.offsetWidth, h = label.offsetHeight;
    let x = Math.min(Math.max(box.left, 24), FRAME.W - 24 - w), y = box.top - h - 10;
    if (y < 24 || hitsCams({ left: x, top: y, right: x + w, bottom: y + h }, 8)) y = box.bottom + 10;
    label.style.transform = `translate(${x.toFixed(0)}px, ${y.toFixed(0)}px)`;
    return true;
  }
  // the Walk's share of the picture (ui/walk.js: 0 while the director holds the screen, e.g. a Judge's line
  // or a vote in the debate, 1 when the Walk's camera is on air): what this module shows fades with it, so
  // nothing from a click made off the air lands on the director's shot. A public walk.share wins over the
  // checks' walk.debug.share; with neither the Walk is taken to be on air
  function screenShare() {
    try {
      const v = typeof walk.share === "function" ? walk.share() : walk.share ?? walk.debug?.share?.();
      return Number.isFinite(v) ? clamp01(v) : 1;
    } catch {
      return 1;
    }
  }
  function render(t) {
    const k = screenShare();
    for (const key of ["panel", "card", "label"]) {
      const s = shown[key], n = nodes[key];
      if (!s) continue;
      if (t >= s.to) {
        hide(key);
        continue;
      }
      const a = t < s.from ? 0 : Math.min(clamp01((t - s.from) / WALK.fade), clamp01((s.to - t) / WALK.fade));
      n.style.display = "block";
      let ok = true;
      if (key === "label") ok = place(t);
      n.style.opacity = (ok ? a * k : 0).toFixed(3);
    }
    // a Stand video in the panel stands with the show clock (the operator's pause)
    for (const v of panel.querySelectorAll("video")) {
      if (showClock.paused || !shown.panel) {
        if (!v.paused) v.pause();
      } else if (v.paused && !v.ended && v.readyState >= 2) v.play?.().catch(() => {});
    }
  }
  function onJump(t) {
    // the operator moved the clock: every interaction not over by now is undone (a line said again
    // after ←, or under the next Finalist's minute after →, would be a line nobody chose)
    for (const run of history) if (!run.cancelled && (run === active || run.end > t || run.t0 > t)) undo(run);
    closePassive();
  }
  let lastT = now(), lastP = performance.now(), lastWarm = 0, raf = 0;
  function tick() {
    const t = now(), p = performance.now();
    const jumped = showClock.paused ? t !== lastT : Math.abs(t - lastT - (p - lastP) / 1000) > 0.5;
    if (jumped) onJump(t);
    lastT = t;
    lastP = p;
    if (active && t >= active.end) finish(active);
    render(t);
    if (p - lastWarm > 1000) {
      lastWarm = p;
      warm();
    }
    raf = requestAnimationFrame(tick);
  }
  raf = requestAnimationFrame(tick);
  const onKey = (e) => {
    if (e.key !== "Escape") return;
    closePassive();
    // a line goes on (Escape closes only what is shown); one still being prepared is dropped
    if (active && !active.rec.spoke) active.busy ? undo(active, { soft: true }) : finish(active);
  };
  addEventListener("keydown", onKey);

  return {
    close: closePassive,
    log,
    get active() {
      return active ? { kind: active.kind, id: active.id, end: active.end } : null;
    },
    get shown() {
      return Object.fromEntries(Object.entries(shown).map(([k, s]) => [k, s ? { kind: s.kind, from: s.from, to: s.to } : null]));
    },
    /** frame-pixel boxes of what is visible now (the checks' cam-circle test) */
    boxes() {
      const frame = root.getBoundingClientRect(), k = frame.width / FRAME.W || 1;
      return [...layer.querySelectorAll("*")].filter((e) => e.offsetWidth && e.closest(".wi > div")?.style.display !== "none" && Number(e.closest(".wi > div")?.style.opacity || 0) > 0.05)
        .map((e) => {
          const b = e.getBoundingClientRect();
          return { cls: e.className, left: (b.left - frame.left) / k, top: (b.top - frame.top) / k, right: (b.right - frame.left) / k, bottom: (b.bottom - frame.top) / k };
        });
    },
    dispose() {
      cancelAnimationFrame(raf);
      removeEventListener("keydown", onKey);
      for (const f of [off, offToggle]) if (typeof f === "function") f();
      if (active) undo(active, { soft: true });
      layer.remove();
      style.remove();
      wallAnchor.removeFromParent();
    },
  };
}
