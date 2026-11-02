// The show layer: the director's sink on the Stage (director/README.md, "The sink"). Every method
// takes the director's payload as is and `meta.at` as its show-clock time; it moves robots, consoles,
// the ballot station, subtitles and captions, and returns the times of what it scheduled. The camera
// is not driven from here: ui/planner.js (the live show, ui/live.js) or ui/mock.js (the style frame)
// calls stage.camera with those times.
//
// Two modes. createShow({ stage, subs, caps }) is the style frame's layer (ui/mock.js drives it by
// hand: a finished vote turn in judge() starts the walk, say/host return the line's end).
// createShow({ ..., voice, live: true, createCards }) is the live sink (ui/live.js): the walk comes
// with voteCast, every call returns an object of times for the planner, lines play through the voice
// (lib/voice.js: audio, the face light on voice.levelAt, subtitles on the voice's own word times),
// and the cards (verdict, Last Word, podium, final, the round's header and result) are ui/cards.js.
//
//   setup(info, meta)                 the CLI line of the captions
//   restore(view, meta)               a reload mid-show: the round's tubes, the cards' header and podium
//   judge(id, p, {at})                live layer: state, console; held while the robot presents (below)
//   status(s, meta)                   the cards' header; a new round lays every token back on its desk
//   say(speaker, text, voice, meta)   turns to the room (≈1.3 s, inside the beat), then speaks
//   host(text, voice, meta)           a Host line
//   unavailable(judge, info, meta)    the robot goes dark for the beat, then back to its live state
//   voteCast(judge, c, meta)          decide at the desk, walk the sealed token to the box: stage.vote
//   tally(t, meta)                    begin: the round's tubes and ballot sheets; result: the cards
//   voteReveal(v, voice, meta)        the token out of the box, open in front of its Judge, into its
//                                     tube; the Judge reads its reason (waits until it is back at its post)
//   envelope(e, voice, meta)          a place sealed («конверт запечатан») or an envelope opened (owner 2026-10-28)
//   lastWord, verdict, podium, final  the cards
//
// While a robot presents (speaks, walks, shows its token) the live layer's changes reach its console
// at once and its body when the presentation ends ("held").
import { ROSTER, JUDGE_IDS } from "/robots/roster.js";
import { Track } from "/world/timeline.js";
import { estimateTiming } from "/director/voice.js";
import { DESKS, dropSpot } from "/world/layout.js";

const TURN_LEAD = 1.3; // s a Judge starts turning to the room before its first word (a 180° turn takes ≈1.2 s)
const FACING_TOL = 0.35; // rad: a Judge this close to its room yaw needs no turn before it speaks
const TAIL = 0.4; // s after a line before the body goes back to its live state (the style frame)
// live: long enough that a speaker still faces the room while the next one turns round to it (the
// planner cuts to the next one once it faces the lens, ui/planner.js say), so neither shot shows a back
const TAIL_LIVE = 1.5;
const BRISK = 1.3; // a compact vote wave's pace (robots/rig.js setPace): decide and walk this much faster
// s between two drops at the slot (world/stage.js vote): the show's first wave keeps the stage's own 1.5 s,
// a brisk one is tighter (the near-spot clearance below still keeps neighbours apart)
const SLOT_GAP_BRISK = 0.8;
const FACE_OK = 0.6; // rad off its room yaw: a turning Judge reads as facing the lens of its medium shot
// a brisk wave: a Judge whose drop spot is near another's (world/stage.js NEAR_SPOT) reaches the box
// at least this long after that one turns away. The stage's own margin (0.25 s) is set for the
// robots' own pace; at a brisk pace the newcomer brushed through the one walking off
const NEAR_SPOT = 0.75, BRISK_CLEAR = 0.6;
// A vote's reveal, in seconds from the beat's start (world/ballot.js REVEAL): the token leaves the
// slot at once and flies to a spot in front of the Judge who cast it (stage.card); it opens there
// from 0.9 s, reads from ≈1.15 s and closes at 3.7 s (2.55 s readable); the Judge reads its reason
// while it is open (from READ). The beat's pictures, for a shot planner (ui/shots.js): the card
// (the Judge from the front, its open token beside it) from CARD until TUBE, the token into its
// tube until NEXT. The director's vote beat lasts at least NEXT (ui/live.js awaits voteReveal).
export const REVEAL_BEAT = { CARD: 0.45, READ: 1.2, TUBE: 3.95, NEXT: 4.95 };

export const majorityLine = (voted) => Math.floor(voted / 2) + 1;

/** The face light of a voice: up on each word, a little flutter inside it, low between words. */
function level(segs, t) {
  for (const s of segs) {
    if (t < s.t0 || t > s.end) continue;
    const rel = t - s.t0;
    for (const w of s.words) {
      if (rel < w.start_s) return 0.12;
      if (rel <= w.end_s) {
        const u = (rel - w.start_s) / Math.max(0.05, w.end_s - w.start_s);
        return 0.3 + 0.7 * Math.pow(Math.sin(Math.PI * u), 0.6) * (0.85 + 0.15 * Math.sin(rel * 31));
      }
    }
    return 0.12;
  }
  return 0;
}

const wrap = (a) => a - 2 * Math.PI * Math.floor((a + Math.PI) / (2 * Math.PI));

export function createShow({ stage, subs, caps = null, voice = null, live: liveMode = false, createCards = null }) {
  const idOf = (name) => (ROSTER[name] ? name : Object.keys(ROSTER).find((k) => ROSTER[k].model.toLowerCase() === String(name).toLowerCase()) ?? name);
  const live = {}; // id -> the last p of judge()
  const busy = {}; // id -> the robot presents until (show clock): its body follows the live layer from then
  const lines = new Track(); // { id, end } every spoken line, for the face light
  const segs = {}; // style frame: the face light from the words
  let lt = NaN, lv = 0;
  const levelAt = (t) => (t === lt ? lv : ((lt = t), (lv = voice.levelAt(t))));
  const speakerAt = (t) => {
    const e = lines.current(t);
    return e && t < e.end + TAIL ? e.id : null;
  };
  for (const id of Object.keys(ROSTER)) {
    segs[id] = [];
    stage.robots[id].setVoice(voice ? (t) => (speakerAt(t) === id ? levelAt(t) : 0) : (t) => level(segs[id], t));
  }
  // a round's tokens go back to the desks before the next round (world/ballot.js reset): the cards
  // do it after a round without a majority, here before a new place's first round
  let voteSinceReset = false;

  // the live state on the robot and its console
  function apply(id, p, t) {
    if (id === "host" || !p) return;
    stage.judge(id, awayView(id, p), t);
  }
  // After a presentation the body goes back to what the live layer says (a waiting Judge stays
  // facing the room). Not scheduled ahead: a presentation booked later may still extend the hold
  // (the reveal after the walk), so flush(t) applies it once the hold has passed (ui/live.js calls
  // it before every frame and on the virtual grid).
  const pending = new Set();
  function release(id, t) {
    busy[id] = Math.max(busy[id] ?? -Infinity, t);
    pending.add(id);
  }
  function flush(t) {
    for (const id of pending) {
      const at = busy[id];
      if (!(at <= t)) continue;
      pending.delete(id);
      if (id === "host") stage.robots.host.setState("waiting", at);
      else if (!live[id]) stage.robots[id].setState("waiting", at, { facing: "room" });
      else apply(id, live[id].status === "ждёт" ? { ...live[id], facing: "room" } : live[id], at);
    }
  }
  // whether the robot already faces the room at t (its tracks are pure functions of time)
  function facesRoom(id, t) {
    const r = stage.robots[id];
    r.update(t);
    return Math.abs(wrap(r.object3d.rotation.y - DESKS[id].roomYaw)) < FACING_TOL;
  }

  // the first time in [a, b] a Judge turning to the room is within FACE_OK of it (b if never): the
  // planner opens the speaker's shot there, not on the back it turns from
  function facingFrom(id, a, b) {
    const r = stage.robots[id];
    for (let x = a; x < b; x += 0.05) {
      r.update(x);
      if (Math.abs(wrap(r.object3d.rotation.y - DESKS[id].roomYaw)) < FACE_OK) return x;
    }
    return b;
  }

  // ---- a Judge out for the round (п. 10.5; red team 2026-10-21, fix 5). From the beat that says so
  // (unavailable, or a wave's status whose `away` names it) until the round ends its desk stays dark
  // and the corner header says «недоступен», whatever the live layer's idle status; a live turn it
  // really works on (пишет / голосует, a retry) still shows as work.
  const away = new Set();
  function awayView(id, p) {
    if (!away.has(id) || p.status === "пишет" || p.status === "голосует") return p;
    return { ...p, status: "недоступен" };
  }
  function goAway(id, t) {
    if (!stage.desks[id]) return;
    away.add(id);
    stage.judge(id, { ...(live[id] ?? {}), status: "недоступен", activity: live[id]?.activity ?? [] }, t);
  }
  // a status with `away` (a new round: none; a vote wave: the Judges without a vote) sets who is out
  function syncAway(s, t) {
    if (!Array.isArray(s?.away)) return;
    const now = new Set(s.away.map((j) => idOf(j)));
    for (const id of [...away]) {
      if (now.has(id)) continue;
      away.delete(id);
      if (live[id] && !(t < (busy[id] ?? -Infinity))) apply(id, live[id], t);
    }
    for (const id of now) if (!away.has(id)) goAway(id, t);
  }

  /** speak(id, text, voice, t0, { turnAt }) → the time the line ends. */
  function speak(id, text, prepared, t0, { turnAt = null } = {}) {
    const timing = prepared?.words?.length || prepared?.durationS > 0 ? prepared : estimateTiming(text);
    const end = t0 + (timing.durationS ?? 0);
    const r = stage.robots[id];
    if (voice && prepared) voice.play(prepared, { at: t0 });
    lines.add(t0, { id, end });
    segs[id].push({ t0, end, words: timing.words ?? [] });
    r.setState("speaking", turnAt ?? (id === "host" ? t0 - 0.2 : t0 - TURN_LEAD), { facing: "room" });
    // a Judge's console shows what it read while it speaks about it (a cut to it reads the file)
    if (id !== "host") stage.desks[id].setPower(0.9, t0 - 0.3);
    subs.say(text, timing, t0, id);
    if (liveMode) release(id, end + (id === "host" ? TAIL : TAIL_LIVE));
    else {
      busy[id] = end + TAIL;
      if (id === "host") r.setState("waiting", end + TAIL);
      else if (live[id]) apply(id, live[id].status === "ждёт" ? { ...live[id], facing: "room" } : live[id], end + TAIL); // having spoken, it waits facing the room
      else r.setState("waiting", end + TAIL, { facing: "room" });
    }
    return end;
  }

  // ---- the round on the ballot station (live mode)
  let judgesN = JUDGE_IDS.length;
  let round = null; // { place, round, voted, line, teams, contenders }
  let sheet = null;
  const rowsOf = (contenders) => (contenders ?? []).filter((c) => c.placed == null)
    .map((c) => ({ team: c.team, name: c.name, rank: c.rank, ceiling: !!(c.ceiling || c.blocked) }));
  // returns the time the round's tubes stand (after the tokens flew home)
  function setRound({ place, round: rn, contenders, voted, line }, t, { epoch = false } = {}) {
    if (!contenders?.length) return t;
    if (epoch && voteSinceReset) {
      // the tokens fly home from the last round's tubes, then the new tubes stand
      t = stage.ballot.reset(t).end;
      voteSinceReset = false;
    }
    const key = `${place}|${rn}|${voted}|${line}|${contenders.map((c) => c.team).join(",")}`;
    if (round?.key === key) return t;
    round = { key, place, round: rn, voted, line, contenders };
    stage.ballot.setRound({ place, round: rn, contenders, line, voted }, t);
    sheet = { kind: "ballot", place, contenders };
    stage.setSheet(sheet, t);
    return t;
  }
  // Sealed envelopes (owner 2026-10-28): an envelope opened after the debate puts its deciding round's
  // tokens back in the (opaque) box, in the order the Judges reached the urn, so they come out one by
  // one as after a wave; `shown` = the votes already opened before a reload, laid in their tubes at once.
  function sealTokens(urn, t, shown = []) {
    const ids = (urn ?? []).map((j) => idOf(j)).filter((id) => stage.robots[id]);
    if (!ids.length) return;
    stage.ballot.seal(ids, shown.length ? t - 6 : t);
    shown.forEach((v, i) => v.team && stage.robots[idOf(v.judge)] && stage.ballot.reveal(idOf(v.judge), v.team, t - 5.5 + i * 0.01));
    voteSinceReset = true;
  }

  const cards = createCards ? createCards({ stage, subs, speak: (id, text, v, t0) => speak(id === "host" ? "host" : idOf(id), text, v, t0) }) : null;
  const tripEnd = {}; // id -> when its walk ends (back at its post, facing the room)
  let waveKey = null, compact = false, fullShown = false; // the vote wave being cast (voteCast)
  let waveTrips = []; // { spot, leaveAt } of the wave so far

  const common = {
    idOf,
    speak,
    setup(info, meta) {
      judgesN = info?.judges?.length || judgesN;
      for (const j of info?.judges ?? []) {
        const id = idOf(j.id);
        // a --fake engine names its CLI «fake codex»: keep this machine's real CLI on the tags
        if (ROSTER[id] && j.cli && !/^fake\b/.test(j.cli)) Object.assign(ROSTER[id], { cli: j.cli, version: "" });
      }
    },
    caption(id, t, mode, opts) {
      caps?.introduce(id, t, mode, opts);
    },
    /** Clear the subtitles at t (a cut away from a finished line: its 1.2 s hold ends at the cut). */
    quiet(t) {
      subs.stop(t);
    },
    JUDGE_IDS,
  };

  if (!liveMode) {
    // ---- the style frame's layer (ui/mock.js)
    return {
      ...common,
      judge(name, p, meta) {
        const id = idOf(name), t = meta.at, prev = live[id];
        live[id] = p;
        // a finished vote turn: the Judge walks its sealed token to the box
        const voted = prev?.status === "голосует" && p.status !== "голосует" && p.status !== "недоступен" && p.turn?.kind === "vote" && !p.turn.running && p.turn.outcome !== "error";
        if (t < (busy[id] ?? -Infinity)) {
          // a line is being spoken: the console follows now, the body when the line ends
          stage.desks[id].setLog(p.activity ?? [], t);
          apply(id, p, busy[id]);
          return voted ? stage.vote(id, busy[id]) : null;
        }
        apply(id, p, t);
        return voted ? stage.vote(id, t) : null; // the walk's times, for a planner
      },
      say(speaker, text, v, meta) {
        return speak(idOf(speaker), text, v, meta.at);
      },
      host(text, v, meta) {
        return speak("host", text, v, meta.at);
      },
      unavailable(judge, info, meta) {
        const id = idOf(judge);
        live[id] = { ...(live[id] ?? {}), status: "недоступен" };
        apply(id, live[id], meta.at);
      },
      tally(tl, meta) {
        if (tl.stage !== "begin") return;
        const contenders = (tl.contenders ?? []).map((c) => ({ team: c.team, name: c.name, ceiling: !!(c.ceiling || c.blocked) }));
        stage.ballot.setRound({ place: tl.place, round: tl.round, contenders, line: tl.line, voted: tl.voted }, meta.at);
        stage.setSheet({ kind: "ballot", place: tl.place, contenders }, meta.at);
      },
      voteReveal(v, voiceTiming, meta) {
        const id = idOf(v.judge), t = meta.at, B = REVEAL_BEAT;
        const card = stage.camera.card ? stage.camera.card(id) : stage.card(id); // the camera's card frame (its angle per Judge)
        const token = stage.ballot.reveal(id, v.team ?? null, t, card);
        const end = v.reason ? speak(id, v.reason, voiceTiming, t + B.READ) : token.landAt;
        return {
          id, team: v.team ?? null, side: card.side, lands: token.landAt, end, opens: token.openAt, reads: token.readFrom, closes: token.closeAt,
          shots: { card: t + B.CARD, tube: t + B.TUBE, next: Math.max(t + B.NEXT, token.landAt + 0.27) },
        };
      },
      verdict(card, voiceTiming, meta) {
        return speak("host", card.text, voiceTiming, meta.at);
      },
    };
  }

  // ---- the live sink (ui/live.js)
  const none = (t) => ({ end: t, shots: [] });
  // a card's shot of a Judge from the front (its reason on the verdict card): the Judge turns to the
  // room for it, from the beat's start at the earliest, and back to its live state after
  const FRONT = new Set(["card", "medium", "close"]);
  function facing(res, t) {
    for (const s of res?.shots ?? []) {
      const id = s.id ?? (typeof s.target === "string" ? s.target : s.target?.id);
      if (!FRONT.has(s.kind) || !stage.desks[id] || !Number.isFinite(s.to)) continue;
      stage.robots[id].setState("waiting", Math.max(t, s.from - 2 * TURN_LEAD), { facing: "room" });
      release(id, s.to + 0.2);
      idleTimers(s.from - 0.05);
    }
    return res;
  }
  // A Judge portrayed beside a 2D card stands before its desk: an idle console's turn timer («3:05»)
  // read through the card next to a reason (red team fix 10). Consoles of Judges not at work stop
  // showing it from then (a working Judge's next turn sets its timer again).
  function idleTimers(t) {
    for (const j of JUDGE_IDS) {
      const st = live[j]?.status;
      if (st !== "пишет" && st !== "голосует") stage.desks[j]?.setTimer(null, t);
    }
  }
  // A Judge without a vote has its own beat in the reveal (red team fix 5): dark, «Fable 5.1 — не
  // голосует (п. 10.5)» with the reduced majority line, ≥ 2 s (the director's beat; the Host's line
  // when it explains п. 10.5 for the first time).
  function abstainReveal(v, id, meta) {
    const t = meta.at;
    const end = t + Math.max(meta.durationS ?? 0, 2.0);
    if (stage.desks[id]) {
      goAway(id, t);
      release(id, end + 0.2);
    }
    cards?.revealNote(v, { from: t + 0.1, to: end });
    return { kind: "reveal", id, t, end, unavailable: true };
  }
  return {
    ...common,
    get round() {
      return round;
    },
    flush,
    restore(view, meta) {
      const t = meta.at, s = view?.status;
      if (s?.contenders) setRound({ place: s.place, round: s.round, contenders: rowsOf(s.contenders), voted: judgesN, line: majorityLine(judgesN) }, t, { epoch: true });
      // a reload in the middle of an envelope's reveal: its tokens in the box, the opened ones in their tubes
      if (s?.phase === "reveal" && s.reveal?.urn?.length) sealTokens(s.reveal.urn, t, s.reveal.shown ?? []);
      syncAway(s, t);
      return cards?.restore(view, t) ?? none(t);
    },
    judge(name, p, meta) {
      const id = idOf(name), t = meta.at;
      live[id] = p;
      if (id === "host" || !stage.desks[id]) return null;
      if (t < (busy[id] ?? -Infinity)) {
        // presenting: the console follows now, the body when the presentation ends (flush)
        stage.desks[id].setLog(p.activity ?? [], t);
        if (p.status === "пишет" || p.status === "голосует") stage.desks[id].setTimer(p.since ?? null, t);
        pending.add(id);
        return null;
      }
      apply(id, p, t);
      return null;
    },
    status(s, meta) {
      const t = meta.at;
      // a new round, or an envelope opened after the debate: the last tokens fly home, the tubes stand
      if ((s.phase === "discussion" || s.phase === "reveal") && s.contenders) {
        setRound({ place: s.place, round: s.round, contenders: rowsOf(s.contenders), voted: judgesN, line: majorityLine(judgesN) }, t, { epoch: true });
      }
      syncAway(s, t);
      return cards?.header(s, t) ?? none(t);
    },
    say(speaker, text, v, meta) {
      const id = idOf(speaker), t = meta.at;
      const lead = id === "host" || facesRoom(id, t) ? 0.15 : TURN_LEAD;
      const t0 = t + lead;
      const timing = v?.words ? v : estimateTiming(text);
      const end = speak(id, text, v, t0, { turnAt: t });
      const faceAt = id === "host" ? t : facingFrom(id, t, t0 + 0.4);
      return { kind: "say", id, turnAt: t, faceAt, t0, end, text, timing };
    },
    host(text, v, meta) {
      const t = meta.at;
      const timing = v?.words ? v : estimateTiming(text);
      const end = speak("host", text, v, t);
      return { kind: "host", id: "host", turnAt: t, t0: t, end, text, timing };
    },
    unavailable(judge, info, meta) {
      const id = idOf(judge), t = meta.at;
      // dark (the Host explains) and out for the rest of the round: the corner header names it
      goAway(id, t);
      cards?.away(judge, t);
      release(id, t + Math.max(3, meta.durationS ?? 0) + 0.3);
      return { kind: "unavailable", id, t };
    },
    voteCast(judge, c, meta) {
      const id = idOf(judge), t = meta.at;
      if (c.unavailable || !stage.robots[id]) return { kind: "cast", id, t, unavailable: true };
      if (round && c.of && c.of !== round.voted) setRound({ ...round, voted: c.of, line: majorityLine(c.of) }, t);
      // its console lit with the round's ballot until the decision dims it
      if (sheet) stage.desks[id].show(sheet, t - 0.02);
      stage.desks[id].setPower(1, t - 0.02);
      // the show's first wave at the robots' own pace (the whole choreography once), every later one
      // brisk and compact (ui/planner.js castCompact): the same beats, in the same order
      const place = c.place ?? round?.place ?? 1, rn = c.round ?? round?.round ?? 1, key = `${place}|${rn}`;
      if (waveKey !== key) {
        waveKey = key;
        compact = fullShown || place > 1 || rn > 1;
        fullShown = true;
        waveTrips = [];
      }
      const r = stage.robots[id];
      r.setPace?.(compact ? BRISK : 1, t - 1e-3);
      let at = t;
      if (compact && r.previewDecide) {
        const spot = dropSpot(id), dEnd = r.previewDecide(t).end, pv = r.previewVote(dEnd);
        const need = Math.max(-Infinity, ...waveTrips.filter((w) => w.spot.distanceTo(spot) < NEAR_SPOT).map((w) => w.leaveAt + BRISK_CLEAR));
        at = t + Math.max(0, need - (dEnd + pv.arriveAt - pv.t0));
      }
      const plan = stage.vote(id, at, compact ? { gap: SLOT_GAP_BRISK } : undefined);
      waveTrips.push({ spot: dropSpot(id), leaveAt: plan.leaveAt });
      voteSinceReset = true;
      tripEnd[id] = plan.end;
      release(id, plan.end + 0.05);
      return { kind: "cast", id, t, plan, order: c.order, of: c.of, compact };
    },
    tally(tl, meta) {
      const t = meta.at;
      if (tl.stage === "begin") {
        const at = setRound({ place: tl.place, round: tl.round, contenders: rowsOf(tl.contenders), voted: tl.voted, line: tl.line }, t);
        if (tl.reveal) sealTokens(tl.urn, Math.max(t, at));
        return { kind: "tally", stage: "begin", t, end: t, shots: [] };
      }
      if (tl.result === "no_majority") voteSinceReset = false; // the cards empty the tubes
      // the Host's line is the beat's own host() call: the banner is timed to it (meta.durationS)
      return { kind: "tally", stage: "result", t, ...(cards?.tallyResult(tl, meta.durationS ? { durationS: meta.durationS, words: [] } : null, t) ?? none(t)) };
    },
    voteReveal(v, vt, meta) {
      const id = idOf(v.judge), B = REVEAL_BEAT;
      if (v.unavailable || !stage.robots[id]) return abstainReveal(v, id, meta);
      // the card waits until the Judge is back at its post, facing the room, and so does every other
      // walker (one on its way back crosses the card's frame); a Judge at its desk (the engine already
      // has it on the next turn) first turns round
      let t = Math.max(meta.at, ...Object.values(tripEnd).map((e) => e - 0.4));
      let turnAt = t - 0.1, turns = null;
      if (!(t < (tripEnd[id] ?? -Infinity)) && !facesRoom(id, t)) (turns = turnAt = t), (t += TURN_LEAD);
      const card = stage.camera.card ? stage.camera.card(id) : stage.card(id); // the camera's card frame (its angle per Judge)
      const token = stage.ballot.reveal(id, v.team ?? null, t, card);
      let end = token.landAt;
      if (v.reason) end = speak(id, v.reason, vt, t + B.READ, { turnAt });
      else stage.robots[id].setState("waiting", turnAt, { facing: "room" });
      release(id, token.landAt + 0.3); // it faces its card until the token is in its tube
      // a vote unlike its last round's: «Fable 5.1: «Штрек» → «Горный поток»», once the token is open
      if (v.changed) cards?.revealNote(v, { from: token.readFrom, to: Math.max(end, token.landAt) + 0.4 });
      return {
        kind: "reveal", id, t, turns, team: v.team ?? null, reached: !!v.reached, side: card.side, lands: token.landAt, end, opens: token.openAt, reads: token.readFrom, closes: token.closeAt,
        shots: { card: t + B.CARD, tube: t + B.TUBE, next: Math.max(t + B.NEXT, token.landAt + 0.27) },
      };
    },
    lastWord(card, v, meta) {
      return facing(cards?.lastWord(card, v, meta.at) ?? { end: speak("host", card.text, v, meta.at), shots: [] }, meta.at);
    },
    verdict(card, v, meta) {
      return facing(cards?.verdict(card, v, meta.at) ?? { end: speak("host", card.text, v, meta.at), shots: [] }, meta.at);
    },
    /** A place sealed in its envelope, or an envelope opened after the debate (ui/cards.js envelope). */
    envelope(e, v, meta) {
      return cards?.envelope(e, v, meta.at) ?? { end: speak("host", e.text, v, meta.at), shots: [] };
    },
    podium(p, meta) {
      return cards?.podium(p, meta.at) ?? none(meta.at);
    },
    final(f, v, meta) {
      return cards?.final(f, v, meta.at) ?? { end: speak("host", f.text, v, meta.at), shots: [] };
    },
  };
}
