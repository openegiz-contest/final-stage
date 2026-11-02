// The outcome layer of the Stage (spec §7.7 «Голоса», «Место», «Ведущий»): after a round's vote
// reveal, what happened and why, seen with the sound off. The room says it first: the winner's tube
// lights from inside and the other plaques dim (world/ballot.js highlight); a round without a majority
// empties the tubes and the tokens fly back to the Judges' desks for the next round (ballot reset).
// The 2D layer only names what the room shows, in the broadcast style of ui/stage.css: a corner bug
// with the place, the round and the podium so far; a banner over the tubes; the Last Word card; the
// verdict card with the Judges' reasons verbatim; the podium filling 1 → 2 → 3; the final screen.
// Every word is the payload's (director/README.md "The sink") or a label below; the Host's lines are
// the director's templates (the payload's `text`), spoken with speak().
//
//   createCards({ stage, subs, speak, root? }) → {
//     header(status, t), tallyResult(tally, voice, t), envelope(e, voice, t), lastWord(card, voice, t), verdict(card, voice, t),
//     podium(p, t), final(f, voice, t), restore(view, t), update(t) }
//
// Each call returns { end, shots: [{ kind, from, to, target?, id?, team?, tight?, side?, move? }] }:
// the beat ends at `end` (show clock); the shots are world/camera.js shot kinds in time order, `move`
// = a camera move of that many seconds (else a cut); applyShots(stage.camera, shots) plays them.
// tallyResult speaks only when the payload carries the Host's line (`tally.text`); the director's
// beat speaks it with a separate host() call, so without `text` the card is timed to `voice` from t.
//
// A pure function of the show clock: calls register timed items, update(t) sets the DOM for t (no
// CSS animation, no timers). update() runs after every stage.renderAt() on its own (the stage's
// renderAt is wrapped once); calling it from the page as well is harmless.
import { ROSTER } from "/robots/roster.js";
import { estimateTiming } from "/director/voice.js";
import { ordinal, votes as votesOf, rounds as roundsOf, plural, labels as HOST_LABELS } from "/director/host.js";
import { sentenceStarts } from "/ui/shots.js";
import { CERAMIC } from "/world/palette.js";
import { clamp01, smooth } from "/world/timeline.js";

// Timing (seconds). The planner's minimums (director/plan.js DEFAULTS) are honoured on top.
export const CARD_TIMES = {
  majorityS: 4.2,   // the majority result: the winner's tube lights, then the row
  noMajorityS: 3.0, // the no-majority banner at least, before the tubes empty
  lastS: 3.0,       // «Нет большинства → Правило последнего слова»
  lastWordS: 10,
  verdictS: 25,
  vacantS: 8,
  podiumS: 4,
  reasonMinS: 4.0,  // a reason stays alone on the card at least this long before the next joins it
  reasonMaxS: 6.0,  // ... and at most this long (a 20-word reason)
  againstS: 2.5,    // each Judge of the «Против» line on camera
  abstainS: 2.0,    // «Fable 5.1 — не голосует (п. 10.5)»
  fin: 0.3, fout: 0.4,
};
// the verdict card's text sizes, largest first: the largest at which the whole card fits the frame
const REASON_SIZES = ["", "cd-m", "cd-s", "cd-xs"];
const CARD_MAX_H = 1080 - 56 - 28;

// On-screen labels (not spoken). PROPOSALS for the owner, like director/host.js labels.
export const LABELS = {
  place: (p) => `${p}-е место`,
  placeTitle: (p) => `${cap(ordinal(p))} место`,
  round: (r, max) => `раунд ${r} из ${max}`,
  decided: () => "решено",
  ceiling: () => HOST_LABELS.ceiling(), // «не может занять 1-е место»
  majority: () => "Большинство",
  lastWordRule: (rule) => `Пункт ${rule} Положения`,
  lastWordTitle: () => "Правило последнего слова",
  lastWordWhy: (n) => `Большинства нет после ${n} ${plural(n, "раунда", "раундов", "раундов")} → место получает Финалист с наибольшим баллом Отборочного этапа`,
  score: () => "Балл Отборочного этапа",
  votesOf: (n, voted) => `${votesOf(n)} из ${voted}`,
  rounds: (r) => roundsOf(r),
  byLastWord: () => "по Правилу последнего слова",
  vacant: () => "не присуждено",
  final: () => "Итог Финала",
  empty: () => "—",
  // the red team's trust fixes (2026-10-21); PROPOSALS like the rest
  against: () => HOST_LABELS.against(),                                  // «Против»
  againstOne: (judge, team) => `${modelOf(judge)} → ${team}`,             // «GPT 6.1 sol → «Штрек»»
  abstains: (judge) => HOST_LABELS.abstains(judge),                       // «Fable 5.1 — не голосует (п. 10.5)»
  away: (judge) => HOST_LABELS.away(judge),                               // corner header: «Fable 5.1 — недоступен»
  reducedLine: (line, voted, n) => `Большинство — ${HOST_LABELS.reducedLine(line, voted, n)}`, // «Большинство — 3 из 4: один Судья недоступен»
  changed: (judge, from, to) => HOST_LABELS.changed(judge, from, to),     // «Fable 5.1: «Штрек» → «Горный поток»»
  changedKicker: (from, to) => HOST_LABELS.changedKicker(from, to),       // «Голос изменён · раунд 1 → 2»
  // sealed envelopes (owner 2026-10-28); PROPOSALS like the rest
  sealed: () => HOST_LABELS.sealed(),                                     // «конверт запечатан»
  decidedTitle: () => HOST_LABELS.decidedTitle(),                         // «Решено»
  envelopeOf: (p) => HOST_LABELS.envelopeOf(p),                           // «Конверт 1-го места»
  opening: () => HOST_LABELS.opening(),                                   // «вскрываем конверт»
  decidingRound: (r, max) => HOST_LABELS.decidingRound(r, max),           // «решающий раунд 2 из 3»
};

const BRASS = "#c9a46a";
const FAMILY = { anthropic: CERAMIC.terracotta, openai: "#e9ecef", house: BRASS };

function cap(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
const score = (s) => (s === null || s === undefined ? "" : String(s).replace(".", ","));
const num = (s) => (Number.isFinite(Number(s)) ? Number(s) : -Infinity);
const idOf = (name) => (ROSTER[name] ? name : Object.keys(ROSTER).find((k) => ROSTER[k].model.toLowerCase() === String(name).toLowerCase()) ?? name);
const modelOf = (name) => ROSTER[idOf(name)]?.model ?? String(name);
const familyOf = (name) => FAMILY[ROSTER[idOf(name)]?.vendor] ?? BRASS;

/** Play shots on the director camera: a cut at `from`, or a move of `move` s. */
export function applyShots(cam, shots) {
  for (const s of shots ?? []) {
    const { from, to, target, move, ...shot } = s;
    if (move) cam.move(shot, from, move);
    else cam.cut(shot, from);
  }
}

// ---- tiny DOM helpers
const h = (tag, cls, kids = []) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  for (const k of [].concat(kids)) if (k !== null && k !== undefined && k !== false) e.append(k);
  return e;
};
const txt = (cls, text, tag = "div") => {
  const e = document.createElement(tag);
  e.className = cls;
  e.textContent = text;
  return e;
};

/**
 * An envelope (sealed envelopes, owner 2026-10-28): "pending" (the place is not decided yet: a dim
 * outline of paper), "sealed" (closed, a brass seal with the place's number), "open" (the flap up, no
 * seal), "vacant". The flap and the seal are their own elements: the envelope card animates them.
 */
function envelopeGlyph(state, place, cls = "") {
  const flap = h("div", "cd-env-flap");
  const seal = txt("cd-env-seal", cls.includes("cd-env-mini") ? "" : String(place)); // the header's mini envelope: the row names the place
  const el = h("div", `cd-env-one cd-env-${state} ${cls}`.trim(), [h("div", "cd-env-body"), txt("cd-env-num", String(place)), flap, seal]);
  if (state === "open") flap.style.transform = "scaleY(-1)";
  if (state !== "sealed") seal.style.display = "none";
  return el;
}

/** When the first word at or after char index `idx` of `text` is spoken (s from the line's start). */
function wordAt(timing, idx) {
  if (idx < 0) return null;
  const w = timing.words.find((x) => x.end_char > idx);
  return w ? w.start_s : null;
}

export function createCards({ stage, subs, speak, root = null }) {
  // the layer: inside the page's 2D overlay when there is one
  if (!document.querySelector('link[href$="/ui/cards.css"]')) {
    const l = document.createElement("link");
    l.rel = "stylesheet";
    l.href = "/ui/cards.css";
    document.head.append(l);
  }
  const host = root ?? document.getElementById("overlay") ?? (() => {
    const d = h("div", "ov");
    document.body.append(d);
    return d;
  })();
  const layer = h("div", "cd");
  host.prepend(layer); // under the subtitles and captions
  const cam = stage.camera;
  const ballot = stage.ballot;

  const names = new Map(); // team -> name, from every payload that has one
  const learn = (list) => {
    for (const c of list ?? []) if (c?.team && c.name) names.set(c.team, c.name);
  };
  const nameOf = (team, name) => (name ?? names.get(team) ?? null);
  const quoted = (team, name) => {
    const n = nameOf(team, name);
    return n ? `«${n}»` : team ?? "";
  };

  // ---- timed items: { el, from, to, fin, fout, parts: [{ el, from, fin, rise? }], hides? }
  const items = [];
  const shown = new Map(); // el -> applied style key
  function item(el, from, to, { fin = CARD_TIMES.fin, fout = CARD_TIMES.fout, parts = [], hides = false } = {}) {
    el.style.display = "none";
    layer.append(el);
    const it = { el, from, to, fin, fout, parts, hides };
    items.push(it);
    return it;
  }
  const style = (el, key, apply) => {
    if (shown.get(el) === key) return;
    shown.set(el, key);
    apply();
  };

  // ---- the corner bug: place · round, the ceiling note, the podium so far
  const bug = h("div", "cd-bug cd-back");
  bug.style.display = "none";
  layer.append(bug);
  const statuses = []; // { t, status, id } ascending
  const pods = []; // { t, places, id } ascending: the bug's podium rows from t
  let seq = 0;
  const add = (list, e) => {
    e.id = ++seq;
    let i = list.length;
    while (i > 0 && list[i - 1].t > e.t) i--;
    list.splice(i, 0, e);
  };
  const at = (list, t) => {
    let r = null;
    for (const e of list) if (e.t <= t + 1e-9) r = e; else break;
    return r;
  };
  function drawBug(s, pod) {
    const kids = [];
    if (s && s.phase !== "done") {
      const head = h("div", "cd-bug-head", [txt("cd-bug-place", LABELS.place(s.place), "span")]);
      const sub = s.phase === "decided" ? LABELS.decided() : s.phase === "sealed" ? LABELS.sealed() : s.phase === "reveal" ? LABELS.opening()
        : s.round ? LABELS.round(s.round, s.rounds) : null;
      if (sub) head.append(txt("cd-bug-sep", " · ", "span"), txt("cd-bug-round", sub, "span"));
      kids.push(head);
      const debate = s.phase === "discussion" || s.phase === "voting";
      const blocked = (s.contenders ?? []).filter((c) => c.blocked && !c.placed);
      if (blocked.length && debate && !pod?.places?.[s.place - 1]) {
        kids.push(txt("cd-bug-note", `${cap(blocked[0].blockedLabel ?? LABELS.ceiling())}: ${blocked.map((c) => quoted(c.team, c.name)).join(", ")}`));
      }
      // a Judge out for this round (п. 10.5): its desk is dark, the header says so
      if (debate) for (const j of s.away ?? []) kids.push(txt("cd-bug-note cd-bug-away", LABELS.away(j)));
    }
    // the podium so far, and (sealed envelopes) the places decided but not opened yet
    const opened = (pod?.places ?? []).filter(Boolean);
    const sealedRows = (s?.phase !== "done" ? s?.sealed ?? [] : []).filter((p) => !opened.some((x) => x.place === p)).map((p) => ({ place: p, sealed: true }));
    const rows = [...opened, ...sealedRows].sort((a, b) => a.place - b.place);
    if (rows.length) {
      kids.push(h("div", "cd-bug-pod", rows.map((p) => h("div", "cd-bug-row" + (p.team ? "" : " cd-dim"), [
        txt("cd-num", String(p.place), "span"),
        p.sealed ? h("span", "cd-bug-name", [envelopeGlyph("sealed", p.place, "cd-env-mini"), txt("", LABELS.sealed(), "span")])
          : txt("cd-bug-name", p.team ? quoted(p.team, p.name) : LABELS.vacant(), "span"),
      ]))));
    }
    bug.replaceChildren(...kids);
    return kids.length > 0;
  }

  // ---- the podium as steps 2 · 1 · 3; `big` for the final screen
  function steps(places, { big = false, filled = null } = {}) {
    const n = Math.max(3, places.length);
    const cols = [];
    const parts = [];
    for (let place = 1; place <= Math.min(n, 3); place++) {
      const p = places[place - 1] ?? null;
      const name = p ? (p.team ? quoted(p.team, p.name) : LABELS.vacant()) : "\u00a0"; // a step not yet filled stays empty
      const nameEl = txt("cd-step-name" + (p && p.team ? "" : " cd-dim"), name);
      const teamEl = txt("cd-step-team", p?.team ?? " ");
      const block = h("div", `cd-step-block cd-step-${place}` + (p && p.team ? " cd-on" : ""), [txt("cd-step-num", String(place))]);
      const col = h("div", "cd-step", [nameEl, teamEl, block]);
      cols[place] = col;
      if (filled === place) parts.push({ el: nameEl, rel: 0.55, fin: 0.35 }, { el: teamEl, rel: 0.6, fin: 0.35 }, { el: block, rel: 0.15, fin: 0.5, rise: true });
    }
    const row = h("div", "cd-steps" + (big ? " cd-big" : ""), [cols[2], cols[1], cols[3]].filter(Boolean));
    return { row, parts };
  }

  let litTeam = null, litAt = -Infinity;
  const light = (team, t) => {
    // one highlight per decided place: a second call for the same team would restart its rise
    if (team === litTeam && t >= litAt) return;
    litTeam = team;
    litAt = t;
    ballot.highlight(team, t);
  };

  const api = {
    LABELS,
    /** The round's header: the corner bug shows place · round (and the ceiling note on place 1). */
    header(status, t) {
      if (!status) return { end: t, shots: [] };
      learn(status.contenders);
      add(statuses, { t, status });
      return { end: t, shots: [] };
    },

    /** A Judge goes out in the middle of a round (its message failed): the corner header names it from t. */
    away(judge, t) {
      const s = at(statuses, t)?.status;
      if (!s || (s.away ?? []).includes(judge)) return;
      add(statuses, { t, status: { ...s, away: [...(s.away ?? []), judge] } });
    },

    /**
     * A note over a vote's reveal, top right (clear of the corner bug, the subtitles and the token):
     * a Judge without a vote («Fable 5.1 — не голосует (п. 10.5)», with the reduced majority line), or a
     * vote that differs from the Judge's vote in the previous round («Fable 5.1: «Штрек» → «Горный
     * поток»»), shown once the token is open. Nothing for an ordinary vote. Returns { end }.
     */
    revealNote(v, { from, to }) {
      if (v.unavailable) {
        const n = Math.max(1, (v.judges ?? 0) - (v.voted ?? 0), v.away?.length ?? 0);
        const kids = [txt("cd-note-main", LABELS.abstains(v.judge))];
        if (v.line != null && v.voted != null) kids.push(txt("cd-note-sub", LABELS.reducedLine(v.line, v.voted, n)));
        item(h("div", "cd-note cd-back", kids), from, to);
        return { end: to };
      }
      if (v.changed && v.previous) {
        const el = h("div", "cd-note cd-back", [
          txt("cd-kicker", LABELS.changedKicker(v.previous.round, v.round)),
          txt("cd-note-main", LABELS.changed(v.judge, quoted(v.previous.team, v.previous.name), quoted(v.team, v.name))),
        ]);
        el.style.borderLeft = `6px solid ${familyOf(v.judge)}`;
        item(el, from, to);
        return { end: to };
      }
      return { end: from };
    },

    /**
     * The round's result, after the last reveal. majority: the winner's tube lights, its name and
     * «3 из 4» over the row. no_majority: «Нет большинства → раунд 2 из 3» over the row, then the
     * tubes empty and the tokens fly back to the desks. no_majority_last: the banner, then lastWord.
     */
    tallyResult(tally, voice, t) {
      const shots = [];
      let said = t;
      if (tally.text) said = speak("host", tally.text, voice, t + 0.2);
      else if (voice?.durationS) said = t + voice.durationS;
      const main = h("div", "cd-banner-main");
      const el = h("div", "cd-banner cd-back");
      let end;
      if (tally.result === "majority") {
        const w = tally.winner;
        el.append(txt("cd-kicker", LABELS.majority()));
        main.textContent = `${quoted(w)} — ${tally.banner ?? HOST_LABELS.reached(tally.counts?.[w] ?? 0, tally.voted)}`;
        el.append(main);
        // fewer voters than Judges: the line the count was measured against (п. 10.5)
        const n = Math.max(tally.away?.length ?? 0, (tally.judges ?? 0) - (tally.voted ?? 0));
        if (n > 0 && tally.line != null) el.append(txt("cd-banner-sub", LABELS.reducedLine(tally.line, tally.voted, n)));
        light(w, t + 0.25);
        end = Math.max(t + CARD_TIMES.majorityS, said + 0.4);
        shots.push({ kind: "tube", team: w, tight: true, target: w, from: t, to: t + 2.0 });
        shots.push({ kind: "tally", from: t + 2.0, to: end });
        item(el, t + 0.3, end + 0.2);
      } else if (tally.result === "no_majority") {
        main.textContent = tally.banner ?? HOST_LABELS.noMajority(tally.round + 1, tally.rounds);
        el.append(main);
        const n = Math.max(tally.away?.length ?? 0, (tally.judges ?? 0) - (tally.voted ?? 0));
        if (n > 0 && tally.line != null) el.append(txt("cd-banner-sub", LABELS.reducedLine(tally.line, tally.voted, n)));
        // the tubes empty once the banner has been read and the Host has named the counts
        // (the row while the tokens rise out of their tubes, then the camera pulls out with them to the desks)
        const resetAt = Math.max(t + CARD_TIMES.noMajorityS, said - 1.4);
        const r = ballot.reset(resetAt);
        end = Math.max(said + 0.3, r.end + 0.6);
        shots.push({ kind: "tally", from: t, to: resetAt + 0.45 });
        shots.push({ kind: "wide", from: resetAt + 0.45, to: end, move: 1.5 });
        item(el, t + 0.3, end);
        if (litTeam) light(null, t);
      } else {
        main.textContent = tally.banner ?? HOST_LABELS.noMajorityLast();
        el.append(main);
        end = Math.max(t + CARD_TIMES.lastS, said + 0.3);
        shots.push({ kind: "tally", from: t, to: end });
        item(el, t + 0.3, end + 0.3);
      }
      return { end, shots };
    },

    /**
     * Sealed envelopes (owner 2026-10-28): a place decided and sealed (stage "sealed": its envelope
     * closes, the seal sets), or an envelope opened after the debate (stage "open": the seal breaks,
     * the flap opens; the tokens follow). A row of every place's envelope, the Host's line spoken.
     * Names no team: the result comes with the tokens.
     */
    envelope(e, voice, t) {
      const said = e.text ? speak("host", e.text, voice, t + 0.3) : t + 0.3;
      const end = Math.max(t + (e.durationS ?? 4), said + 0.6);
      const open = e.stage === "open";
      const parts = [];
      const row = h("div", "cd-env-row", (e.envelopes ?? []).map((x) => {
        const cur = x.place === e.place;
        const state = open && cur ? "sealed" : !open && cur ? "open" : x.state === "opening" ? "sealed" : x.state;
        const el = envelopeGlyph(state, x.place, cur ? "cd-env-cur" : "");
        const flap = el.querySelector(".cd-env-flap"), seal = el.querySelector(".cd-env-seal");
        // sealing: the flap folds down, the seal sets; opening: the seal goes, the flap folds up
        if (cur && !open) {
          if (flap) parts.push({ el: flap, from: t + 0.6, fin: 0.5, flip: "close" });
          seal.style.display = "";
          parts.push({ el: seal, from: t + 1.15, fin: 0.35, stamp: true });
        }
        if (cur && open) {
          parts.push({ el: seal, from: t + 1.0, fin: 0.35, out: true });
          if (flap) parts.push({ el: flap, from: t + 1.3, fin: 0.55, flip: "open" });
          // the place's number on the opened envelope, as the seal goes
          el.classList.add("cd-env-numshow");
          parts.push({ el: el.querySelector(".cd-env-num"), from: t + 1.2, fin: 0.4 });
        }
        return h("div", "cd-env-col" + (cur ? " cd-env-on" : ""), [el, txt("cd-env-label", LABELS.place(x.place))]);
      }));
      const kids = open
        ? [txt("cd-kicker", LABELS.envelopeOf(e.place)), txt("cd-env-sub", LABELS.decidingRound(e.round, e.rounds)), row]
        : [txt("cd-kicker", LABELS.place(e.place)), txt("cd-env-main", LABELS.decidedTitle()), txt("cd-env-sub", LABELS.sealed()), row];
      item(h("div", `cd-env cd-back${open || (e.envelopes ?? []).some((x) => x.state === "open") ? " cd-env-opening" : ""}`, kids), t + 0.2, end, { parts, hides: true });
      // sealed: the urn that holds the sealed tokens, then the Host; open: the Host
      const shots = [];
      if (!open && end - t > 3.6) shots.push({ kind: "box", from: t, to: t + 1.8 }, { kind: "host", from: t + 1.8, to: end });
      else shots.push({ kind: "host", from: t, to: end });
      return { end, shots };
    },

    /** Rule 10.4: what fired (no majority after N rounds) and whose Qualifying scores decided. */
    lastWord(card, voice, t) {
      learn(card.contenders);
      if (card.team && card.name) names.set(card.team, card.name);
      const timing = voice?.words?.length ? voice : estimateTiming(card.text);
      const t0 = t + 0.3;
      const said = speak("host", card.text, voice, t0);
      const end = Math.max(t + CARD_TIMES.lastWordS, said + 1.2);
      // the moment the Host names the winner: its row and its tube light
      const nameIdx = card.name ? card.text.indexOf(card.name) : -1;
      const named = t0 + (wordAt(timing, nameIdx) ?? timing.durationS * 0.7);
      const rows = [...(card.contenders ?? [])].sort((a, b) => num(b.score) - num(a.score) || (a.rank ?? 99) - (b.rank ?? 99));
      if (card.team && !rows.some((r) => r.team === card.team)) rows.unshift({ team: card.team, name: card.name, rank: card.rank, score: card.score });
      const shown = rows.slice(0, 5);
      const parts = [];
      const list = h("div", "cd-lw-rows", shown.map((r, i) => {
        const row = h("div", "cd-lw-row", [txt("cd-lw-score", score(r.score), "span"), txt("cd-lw-name", quoted(r.team, r.name), "span"), txt("cd-lw-team", r.team, "span")]);
        parts.push({ el: row, from: t + 0.9 + i * 0.18, fin: 0.3 });
        if (r.team === card.team) parts.push({ el: row, from: named, fin: 0.4, cls: "cd-win" });
        return row;
      }));
      const el = h("div", "cd-lw cd-back", [
        txt("cd-kicker", LABELS.lastWordRule(card.rule ?? "10.4")),
        txt("cd-lw-title", LABELS.lastWordTitle()),
        txt("cd-lw-why", LABELS.lastWordWhy(card.rounds)),
        txt("cd-lw-head", LABELS.score()),
        list,
      ]);
      item(el, t + 0.2, end, { parts, hides: true });
      light(card.team, named);
      // the shots follow the Host's sentences: the row that did not reach its line, the Host on the
      // rule, the winner's tube when it is named
      const starts = sentenceStarts(card.text, timing).map((s) => t0 + s);
      const shots = [{ kind: "tally", from: t, to: starts[1] ?? named }];
      if (starts[1] !== undefined && starts[1] < named - 1) shots.push({ kind: "host", from: starts[1], to: named - 0.2 });
      // the winner's tube as it lights (centre; the card on the right sits over its neighbours)
      shots.push({ kind: "tube", team: card.team, tight: true, target: card.team, from: named - 0.2, to: end });
      return { end, shots };
    },

    /**
     * The verdict card, card.durationS (25 s; a vacant place 8): the place, the Finalist, the vote,
     * the rounds; then the winner's reasons from the deciding round, verbatim, one after another
     * (each with its Judge on camera), staying on the card together.
     */
    verdict(card, voice, t) {
      if (card.team && card.name) names.set(card.team, card.name);
      const dur = card.durationS ?? (card.vacant ? CARD_TIMES.vacantS : CARD_TIMES.verdictS);
      const said = speak("host", card.text, voice, t + 0.3);
      const end = Math.max(t + dur, said + 1.5);
      const shots = [];
      const kids = [txt("cd-kicker cd-v-place", LABELS.placeTitle(card.place))];
      const parts = [];
      if (card.vacant || !card.team) {
        kids.push(txt("cd-v-name cd-dim", LABELS.vacant()));
        item(h("div", "cd-verdict cd-back", kids), t + 0.3, end, { hides: true });
        shots.push({ kind: "host", from: t, to: Math.min(end, said + 0.5) });
        if (said + 0.5 < end) shots.push({ kind: "wide", from: said + 0.5, to: end });
        return { end, shots };
      }
      kids.push(txt("cd-v-name", quoted(card.team, card.name)));
      const meta = [txt("cd-v-team", card.team, "span")];
      const how = card.decided_by === "last_word" ? LABELS.byLastWord() : LABELS.votesOf(card.votes, card.voted);
      meta.push(txt("cd-v-sep", " · ", "span"), txt("cd-v-how", how, "span"), txt("cd-v-sep", " · ", "span"), txt("cd-v-rounds", LABELS.rounds(card.rounds), "span"));
      kids.push(h("div", "cd-v-meta", meta));
      return verdictBody(card, t, said, dur, kids, parts, shots);
    },

    /** The podium fills one step (p.filled): the steps over the room, then the corner bug keeps it. */
    podium(p, t) {
      learn(p.places);
      const dur = CARD_TIMES.podiumS;
      const { row, parts } = steps(p.places ?? [], { filled: p.filled });
      for (const x of parts) x.from = t + x.rel;
      const el = h("div", "cd-podium cd-back", [row]);
      item(el, t, t + dur, { parts, hides: true }); // over the window, the bug steps aside
      add(pods, { t: t + dur - CARD_TIMES.fout, places: (p.places ?? []).map((x) => (x ? { ...x } : null)) });
      return { end: t + dur, shots: [{ kind: "wide", from: t, to: t + dur }] };
    },

    /** The final screen: the whole podium over the dimmed room, the Host reads the result. */
    final(f, voice, t) {
      learn(f.podium);
      const said = f.text ? speak("host", f.text, voice, t + 1.0) : t + 1.0;
      finalScreen(f.podium ?? [], t, 0.8);
      return { end: said + 1.5, shots: [{ kind: "wide", from: t, to: Infinity, move: 3.0 }] };
    },

    /** After a resume: the header and the podium of the state before the cursor, at once. */
    restore(view, t) {
      const pod = (view?.podium ?? []).map((x) => (x ? { ...x } : null));
      learn(pod);
      learn(view?.status?.contenders);
      if (pod.some(Boolean)) add(pods, { t, places: pod });
      if (view?.status) add(statuses, { t, status: view.status });
      if (view?.status?.phase === "done") {
        finalScreen(pod.map((x, i) => x ?? { place: i + 1, team: null, vacant: true }), t, 0);
      }
      return { end: t, shots: [{ kind: "wide", from: t, to: t }] };
    },

    /** Set the DOM for show time t. */
    update(t) {
      let hidden = false;
      for (const it of items) {
        let a = 0;
        if (t >= it.from && t < it.to) a = Math.min(it.fin ? clamp01((t - it.from) / it.fin) : 1, it.fout && Number.isFinite(it.to) ? clamp01((it.to - t) / it.fout) : 1);
        if (a > 0 && it.hides) hidden = true;
        style(it.el, a > 0 ? a.toFixed(3) : "off", () => {
          it.el.style.display = a > 0 ? "" : "none";
          it.el.style.opacity = a.toFixed(3);
        });
        if (a <= 0) continue;
        for (const p of it.parts) {
          const u = p.from === undefined ? 1 : p.fin ? clamp01((t - p.from) / p.fin) : t >= p.from ? 1 : 0;
          if (p.cls) {
            style(p, u > 0 ? "on" : "off", () => p.el.classList.toggle(p.cls, u > 0));
            continue;
          }
          const k = smooth(u);
          if (p.flip || p.out || p.stamp) {
            // an envelope's flap folding (scaleY about its top edge), its seal breaking or setting
            style(p.el, `${p.flip ?? (p.out ? "out" : "stamp")}:${k.toFixed(3)}`, () => {
              if (p.flip) p.el.style.transform = `scaleY(${(p.flip === "open" ? 1 - 2 * k : -1 + 2 * k).toFixed(3)})`;
              else if (p.out) (p.el.style.opacity = (1 - k).toFixed(3)), (p.el.style.transform = `scale(${(1 + 0.25 * k).toFixed(3)})`);
              else (p.el.style.opacity = k.toFixed(3)), (p.el.style.transform = `scale(${(1.6 - 0.6 * k).toFixed(3)})`);
            });
            continue;
          }
          // an earlier reason steps back (still readable) when the next one joins with its Judge
          const o = k * (p.dimAt ? 1 - 0.38 * smooth((t - p.dimAt) / 0.5) : 1);
          style(p.el, `${k.toFixed(3)}:${o.toFixed(3)}`, () => {
            // a part that has not come yet takes no room (a card grows as its reasons join)
            p.el.style.display = u > 0 || !p.collapse ? "" : "none";
            p.el.style.opacity = o.toFixed(3);
            p.el.style.transform = p.rise ? `scaleY(${k.toFixed(3)})` : `translateY(${((1 - k) * 14).toFixed(1)}px)`;
          });
        }
      }
      const s = at(statuses, t)?.status ?? null;
      const pod = at(pods, t);
      const key = hidden ? "hidden" : `${at(statuses, t)?.id ?? 0}:${pod?.id ?? 0}`;
      style(bug, key, () => {
        const any = !hidden && drawBug(s, pod);
        bug.style.display = any ? "" : "none";
      });
    },
  };

  // The verdict card after its headline (owner 2026-10-21, after the red team): the reason of EVERY
  // majority Judge, verbatim, in the order the tokens were revealed, one after another, each with its
  // Judge on camera; then «Против»: who voted for whom, each of them on camera; a note for a Judge
  // without a vote and the reduced majority line. Nothing is capped: the text steps down a size until
  // the whole card fits the frame, and the card lasts as long as its Judges need.
  function verdictBody(card, t, said, dur, kids, parts, shots) {
    const reasons = card.reasons ?? [];
    const against = card.against ?? [];
    const absent = card.absent ?? [];
    // reasons: after the Host's line and its subtitle hold, so nothing sits under the subtitles
    const r0 = Math.max(said + 1.4, t + 6);
    const slots = reasons.map((r) => Math.min(CARD_TIMES.reasonMaxS, Math.max(CARD_TIMES.reasonMinS, 1.5 + r.text.length / 25)));
    const startOf = (i) => r0 + slots.slice(0, i).reduce((s, x) => s + x, 0);
    const a0 = startOf(reasons.length);
    const end = Math.max(t + dur, said + 1.5, a0 + CARD_TIMES.againstS * against.length + 1.0);
    const box = h("div", "cd-v-reasons");
    reasons.forEach((r, i) => {
      const textEl = txt("cd-reason-text", r.text);
      const who = txt("cd-reason-who", modelOf(r.judge));
      const el = h("div", "cd-reason", [who, textEl]);
      el.style.borderLeftColor = familyOf(r.judge);
      el.dataset.judge = r.judge;
      box.append(el);
      parts.push({ el, from: startOf(i), fin: 0.35, collapse: true, dimAt: i + 1 < reasons.length || against.length ? startOf(i + 1) : null });
    });
    kids.push(box);
    if (against.length) {
      const el = h("div", "cd-v-against", [txt("cd-v-against-k", `${LABELS.against()}: `, "span"),
        ...against.flatMap((a, i) => [i ? txt("cd-v-sep", " · ", "span") : null, txt("cd-v-against-one", LABELS.againstOne(a.judge, quoted(a.team, a.name)), "span")]).filter(Boolean)]);
      el.dataset.judges = against.map((a) => a.judge).join(",");
      kids.push(el);
      parts.push({ el, from: a0, fin: 0.35, collapse: true });
    }
    if (absent.length) {
      const n = Math.max(absent.length, (card.judges ?? 0) - (card.voted ?? 0));
      const note = [...absent.map((j) => LABELS.abstains(j)), card.line != null ? LABELS.reducedLine(card.line, card.voted, n) : null].filter(Boolean).join(" · ");
      kids.push(txt("cd-v-absent", note)); // with the headline: it qualifies the count
    }
    const el = h("div", "cd-verdict cd-back", kids);
    el.classList.add(fitSize(el));
    item(el, t + 0.3, end, { parts, hides: true });
    light(card.team, t + 0.2);
    // the row with the winner's tube lit under the headline, the Host reading it, then each reason's
    // Judge from the front (its face on the right of the frame, the card on the left), then each
    // Judge of the «Против» line
    const named = [...reasons.map((r, i) => ({ judge: r.judge, from: startOf(i) })), ...against.map((a, i) => ({ judge: a.judge, from: a0 + i * CARD_TIMES.againstS }))];
    const rowTo = Math.min(t + 3.0, r0 - 0.3);
    shots.push({ kind: "tally", target: card.team, from: t, to: rowTo });
    shots.push({ kind: "host", from: rowTo, to: named.length ? r0 - 0.3 : end });
    named.forEach((x, i) => {
      const from = x.from - 0.3, to = i + 1 < named.length ? named[i + 1].from - 0.3 : end;
      shots.push({ kind: "card", id: idOf(x.judge), side: 1, target: idOf(x.judge), from, to });
    });
    return { end, shots };
  }

  // the largest text size at which the whole card (every reason shown) fits the frame
  function fitSize(el) {
    const probe = el.cloneNode(true);
    Object.assign(probe.style, { visibility: "hidden", display: "block", opacity: "0" });
    layer.append(probe);
    let pick = REASON_SIZES.at(-1);
    for (const size of REASON_SIZES) {
      probe.className = `cd-verdict cd-back ${size}`.trim();
      if (probe.offsetHeight <= CARD_MAX_H) {
        pick = size;
        break;
      }
    }
    probe.remove();
    return pick || "cd-l";
  }

  function finalScreen(places, t, fin) {
    const scrim = h("div", "cd-scrim");
    item(scrim, t, Infinity, { fin, hides: true });
    const { row } = steps(places, { big: true });
    const el = h("div", "cd-final", [txt("cd-kicker cd-final-title", LABELS.final()), row]);
    item(el, t + (fin ? 0.3 : 0), Infinity, { fin, hides: true });
  }

  // update after every 3D frame, whoever draws it
  if (!stage.__cardsWrapped) {
    const draw = stage.renderAt;
    stage.renderAt = (t) => {
      draw(t);
      api.update(t);
    };
    stage.__cardsWrapped = true;
  }
  return api;
}
