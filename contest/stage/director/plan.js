// Presentation events -> beats.
//
// The Planner turns the events that belong to the show (round, message, unavailable, votes, placement,
// done) into numbered beats. It is a pure, deterministic function of the events and the options, so the
// beat numbered n is the same beat on every run and in every Stage reload: that is what the resume cursor
// counts. The live layer (judge statuses, timers, activity) does not go through here.
//
// A beat: { n, type, place, round, calls, voice, minS, view }
//   calls   [{ method, args, voiced?, silent?, awaits? }]   sink calls made when the beat starts; a `voiced` call gets
//                                         the beat's prepared voice (or null) as its last argument before
//                                         `meta`; a `silent` one gets null there (same signature, no sound);
//                                         an `awaits` one returns {end} / a promise: the beat lasts until then
//   voice   { speaker, text } | null      what is spoken during the beat (null: silent)
//   minS    least duration; the beat lasts max(minS, voice duration)
//   view    { status, podium }            what a freshly loaded Stage needs after this beat (sink.restore)
//
// Sealed envelopes (owner 2026-10-28, spec §7.7 «Конверты»; `envelopes: true`, the default): the engine
// still decides the places 1 → 2 → 3, but the show keeps them sealed. During the debate a vote wave plays
// the walks to the urn and nothing else: no token opens, no count, no bar, no majority, no verdict, no
// podium. A round without a majority says so without counts; a decided place gets one beat, «N-е место
// решено. Конверт запечатан.» Once every place is decided, the Host opens the envelopes from the last
// place to the first: the deciding round's tokens in the order the Judges reached the urn, the result,
// the Last Word card when the rule decided, the verdict card with every majority reason verbatim, the
// podium step. `envelopes: false` is the show of 2026-10-21: every place revealed as soon as it is decided.

import { host, labels, teamName } from "./host.js";

export const DEFAULTS = {
  verdictS: 25,   // verdict card (spec §7.7: 20–30 s), at least; longer with many reasons (verdictDuration)
  podiumS: 4,     // a podium step filling
  lastWordS: 10,  // the Last Word card, at least
  vacantS: 8,     // a vacant place's card
  resultS: 2,     // the «Нет большинства → раунд 2 из 3» banner
  abstainS: 2,    // the reveal beat of a Judge without a vote: «Fable 5.1 — не голосует (п. 10.5)»
  envelopes: true, // sealed envelopes, opened 3 → 2 → 1 after the last place (owner 2026-10-28)
  sealedS: 4,     // the «место решено, конверт запечатан» card, at least
  openS: 4,       // an envelope opening, at least
};

// The verdict card's least length: the headline (~7 s), each majority reason with its Judge on camera
// (4 s), the «Против» line with each dissenter on camera (2.5 s), 1 s to read the last.
export const verdictDuration = ({ reasons = 0, against = 0, base = DEFAULTS.verdictS }) =>
  Math.max(base, 7 + 4 * reasons + 2.5 * against + 1);

export class Planner {
  constructor(options = {}) {
    this.o = { ...DEFAULTS, ...options };
    this.n = 0;
    this.finalists = [];
    this.byTeam = new Map();
    this.settings = {};
    this.placements = [];      // placement events played so far
    this.podium = [];
    this.status = null;
    this.tallies = new Map();  // place -> the last votes event of that place
    this.revealed = new Map(); // place -> the judges of its last wave, in reveal order
    this.lastVotes = new Map(); // place -> Map(judge -> { round, team }) of its last wave
    this.away = [];            // Judges unavailable in the current round so far (the status’ `away`)
    this.explained = new Set();
    this.waves = new Map();    // place -> the last wave of that place: { ev, casts, order, before } (its reveal comes later when sealed)
    this.sealed = [];          // envelopes: { place, ev } placements decided and not opened yet, in the order decided
    this.decided = 0;          // placements seen
    this.waveSaid = false;     // the first wave's line explains the envelopes
  }

  get envelopes() {
    return this.o.envelopes !== false;
  }

  // the places sealed and not opened yet (the corner header draws an envelope for each)
  sealedPlaces() {
    return this.sealed.map((s) => s.place).sort((a, b) => a - b);
  }

  get maxRounds() {
    return this.settings.rounds_per_place ?? 3;
  }

  get placesCount() {
    return Math.min(this.settings.places ?? 3, this.finalists.length || 3);
  }

  nameOf = (team) => teamName(this.byTeam.get(team), team);

  setup({ finalists, settings }) {
    this.finalists = finalists ?? [];
    this.byTeam = new Map(this.finalists.map((f) => [f.team, f]));
    this.settings = settings ?? {};
    this.podium = Array.from({ length: this.placesCount }, () => null);
  }

  // who is in the running for `place`: not placed yet, and not under the ceiling for place 1
  contenders(place) {
    const placed = new Set(this.placements.map((p) => p.team));
    return this.finalists
      .filter((f) => !placed.has(f.team) && !(place === 1 && f.ceiling))
      .sort((a, b) => a.rank - b.rank);
  }

  // With envelopes every Finalist stays in every round's rows and tubes, none marked placed: a row that
  // went missing for place 2 would name the winner of place 1. The ceiling of place 1 is known before
  // the Final (п. 9.3) and stays.
  finalistRows(place) {
    const placedAt = new Map(this.envelopes ? [] : this.placements.filter((p) => p.team).map((p) => [p.team, p.place]));
    return this.finalists.map((f) => ({
      team: f.team, name: f.name, rank: f.rank, score: f.score, ceiling: !!f.ceiling,
      blocked: place === 1 && !!f.ceiling, blockedLabel: place === 1 && f.ceiling ? labels.ceiling() : null,
      placed: placedAt.get(f.team) ?? null,
    }));
  }

  plan(ev) {
    switch (ev.type) {
      case "setup": this.setup(ev); return [];
      case "round": return this.round(ev);
      case "message": return [this.beat("say", ev, { calls: [{ method: "say", args: [ev.judge, ev.text], voiced: true }],
        voice: { speaker: ev.judge, text: ev.text } })];
      case "unavailable": return this.unavailableMessage(ev);
      case "votes": return this.votesWave(ev);
      case "placement": return this.placement(ev);
      case "done": return this.final(ev);
      default: return [];
    }
  }

  beat(type, ev, { calls, voice = null, minS = 0, view = {} }) {
    if (view.status) this.status = view.status;
    return {
      n: this.n++, type, place: ev.place ?? null, round: ev.round ?? null, calls, voice, minS,
      view: { status: this.status, podium: this.podium.map((p) => (p ? { ...p } : null)) },
    };
  }

  round(ev) {
    this.away = [];
    const status = { place: ev.place, round: ev.round, rounds: this.maxRounds, phase: "discussion",
      contenders: this.finalistRows(ev.place), away: [], ...this.sealedField() };
    const calls = [{ method: "status", args: [status] }];
    let voice = null;
    if (ev.round === 1) {
      const text = host.openPlace({ place: ev.place, rounds: this.maxRounds });
      calls.push({ method: "host", args: [text], voiced: true });
      voice = { speaker: "host", text };
    }
    const beats = [this.beat("round", ev, { calls, voice, view: { status } })];
    // place 1: the Finalists under the ceiling are grey from the start; the Host says why, once (п. 9.3)
    const capped = ev.place === 1 && ev.round === 1 ? status.contenders.filter((c) => c.blocked) : [];
    if (capped.length) {
      const text = host.ceiling({ names: capped.map((c) => this.nameOf(c.team)) });
      beats.push(this.beat("ceiling", ev, { calls: [{ method: "host", args: [text], voiced: true }], voice: { speaker: "host", text } }));
    }
    return beats;
  }

  unavailableMessage(ev) {
    this.explained.add(`${ev.place}-${ev.round}-${ev.judge}`);
    if (!this.away.includes(ev.judge)) this.away = [...this.away, ev.judge];
    const text = host.unavailableMessage({ judge: ev.judge });
    // a Stage restored after this beat names the Judge as away in its corner header
    const status = this.status ? { ...this.status, away: [...this.away] } : null;
    return [this.beat("unavailable", ev, {
      calls: [{ method: "unavailable", args: [ev.judge, { where: "message", place: ev.place, round: ev.round, error: ev.error }] },
        { method: "host", args: [text], voiced: true }],
      voice: { speaker: "host", text }, view: status ? { status } : {},
    })];
  }

  // `sealed: [places]` on a status while envelopes are sealed (nothing without envelopes)
  sealedField() {
    return this.envelopes ? { sealed: this.sealedPlaces() } : {};
  }

  // A wave of votes: the walks to the urn in the real finish order (ev.casts, from the director; the
  // engine's order when it was not seen), then the reveal in that same order (spec §7.7, owner 2026-10-21):
  // first a short beat for each Judge without a vote, then one token per voter. The result («БОЛЬШИНСТВО»,
  // or the no-majority banner) comes only after the last token: a reveal never announces it.
  // With envelopes the wave stops after the walks (and the beat of a Judge without a vote, which names
  // no team): the tokens stay sealed; a round without a majority says so without counts.
  votesWave(ev) {
    this.tallies.set(ev.place, ev);
    const beats = [];
    const isLast = ev.round >= this.maxRounds;
    const rows = this.finalistRows(ev.place);
    const away = ev.votes.filter((v) => v.team == null).map((v) => v.judge);
    this.away = away;
    const common = { place: ev.place, round: ev.round, rounds: this.maxRounds, line: ev.line, voted: ev.voted, judges: ev.judges, away };
    const status = { place: ev.place, round: ev.round, rounds: this.maxRounds, phase: "voting", contenders: rows, away, ...this.sealedField() };
    // The token carries no team and no reason: sealed until the reveal.
    const casts = ev.casts?.length ? ev.casts : ev.votes.map((v, i) => ({ judge: v.judge, at: null, unavailable: v.team == null,
      order: v.team == null ? null : ev.votes.slice(0, i).filter((x) => x.team != null).length + 1 }));
    // the Host opens every wave: the vote is secret, the tokens open when everyone has voted (with
    // envelopes: at the end, the first wave says so)
    const wave = this.envelopes
      ? host.voteWaveSealed({ line: ev.line, voted: ev.voted, first: !this.waveSaid, places: this.placesCount })
      : host.voteWave({ line: ev.line, voted: ev.voted });
    this.waveSaid = true;
    beats.push(this.beat("vote.wave", ev, { calls: [{ method: "host", args: [wave], voiced: true }], voice: { speaker: "host", text: wave } }));
    casts.forEach((c, i) => {
      const calls = [{ method: "voteCast", args: [c.judge, { place: ev.place, round: ev.round, at: c.at ?? null, order: c.order ?? null,
        of: ev.voted, unavailable: !!c.unavailable }], awaits: true }];
      if (i === 0) calls.unshift({ method: "status", args: [status] });
      beats.push(this.beat("vote.cast", ev, { calls, view: { status } }));
    });
    // the reveal order: the Judges without a vote, then the voters as they reached the urn
    const byJudge = new Map(ev.votes.map((v) => [v.judge, v]));
    const castOrder = casts.map((c) => c.judge).filter((j) => byJudge.has(j));
    for (const v of ev.votes) if (!castOrder.includes(v.judge)) castOrder.push(v.judge);
    const order = [...castOrder.filter((j) => byJudge.get(j).team == null), ...castOrder.filter((j) => byJudge.get(j).team != null)];
    const before = ev.round > 1 ? this.lastVotes.get(ev.place) : null;
    const w = { ev, casts, order, before, common, rows, isLast };
    this.waves.set(ev.place, w);
    this.revealed.set(ev.place, order);
    this.lastVotes.set(ev.place, new Map(ev.votes.map((v) => [v.judge, { round: ev.round, team: v.team }])));
    if (!this.envelopes) return [...beats, ...this.revealBeats(w, { status, casts: casts.length })];

    // sealed: a Judge without a vote still has its beat now (it names no team: п. 10.5 and the line);
    // then, without a majority before the last round, the banner and the Host's line, without counts
    if (!casts.length) beats[beats.length - 1].calls.unshift({ method: "status", args: [status] });
    for (const judge of order.filter((j) => byJudge.get(j).team == null)) beats.push(this.abstainBeat(w, judge, { sealed: true }));
    if (!ev.majority && !isLast) {
      const tally = { stage: "result", sealed: true, ...common, result: "no_majority", winner: null,
        banner: labels.noMajority(ev.round + 1, this.maxRounds), next: { place: ev.place, round: ev.round + 1 } };
      const text = host.noMajoritySealed({ round: ev.round, rounds: this.maxRounds });
      beats.push(this.beat("vote.result", ev, { calls: [{ method: "tally", args: [tally] }, { method: "host", args: [text], voiced: true }],
        voice: { speaker: "host", text }, minS: this.o.resultS }));
    }
    return beats;
  }

  // The beat of a Judge without a vote (п. 10.5): dark, «не голосует», the Host explains once per round.
  abstainBeat(w, judge, { sealed = false, index = 0, of = 0 } = {}) {
    const { ev, common } = w;
    const v = ev.votes.find((x) => x.judge === judge);
    const info = { ...common, judge, index, of: of || w.order.length, team: null, name: null, reason: null, unavailable: true, error: v?.error ?? null,
      counts: {}, teamVotes: 0, reached: false, order: null, last: false, previous: null, changed: false, ...(sealed ? { sealed: true } : {}) };
    const key = `${ev.place}-${ev.round}-${judge}`;
    const calls = [{ method: "voteReveal", args: [info], silent: true }];
    let voice = null;
    if (!this.explained.has(key)) {
      this.explained.add(key);
      const text = host.unavailableVote({ judge, line: ev.line, voted: ev.voted });
      calls.push({ method: "host", args: [text], voiced: true });
      voice = { speaker: "host", text };
    }
    return this.beat("vote", ev, { calls, voice, minS: this.o.abstainS });
  }

  // The tokens of a wave, opened in the order the Judges reached the urn, then the result. `status`
  // goes with the count's first call when the wave had no walk (a wave of Judges without a vote);
  // `reveal` = an envelope opened after the debate: the begin call carries the urn order (the Stage
  // puts the sealed tokens back in the urn) and every view says how far the reveal has come.
  revealBeats(w, { status = null, casts = 1, reveal = false } = {}) {
    const { ev, order, before, common, rows, isLast } = w;
    const beats = [];
    const byJudge = new Map(ev.votes.map((v) => [v.judge, v]));
    const voters = order.filter((j) => byJudge.get(j).team != null);
    const extra = reveal ? { reveal: true, urn: voters } : {};
    const begin = [{ method: "tally", args: [{ stage: "begin", ...common, counts: {}, contenders: rows, ...extra }] }];
    if (!casts && status) begin.unshift({ method: "status", args: [status] });
    const shown = [];
    const revealView = () => (reveal ? { status: { ...this.status, reveal: { urn: voters, shown: shown.map((x) => ({ ...x })) } } } : {});
    beats.push(this.beat("vote.begin", ev, { calls: begin, view: reveal ? revealView() : { status } }));
    const counts = {};
    let token = 0;
    order.forEach((judge, i) => {
      const v = byJudge.get(judge);
      if (v.team == null) {
        beats.push(this.abstainBeat(w, judge, { index: i, of: order.length }));
        if (reveal) beats.at(-1).view = { ...beats.at(-1).view, ...revealView() };
        return;
      }
      const info = { ...common, judge, index: i, of: order.length, team: v.team, name: v.team ? this.byTeam.get(v.team)?.name ?? null : null,
        reason: v.reason ?? null, unavailable: false, error: v.error ?? null, ...(reveal ? { reveal: true } : {}) };
      counts[v.team] = (counts[v.team] ?? 0) + 1;
      info.counts = { ...counts };
      info.teamVotes = counts[v.team];
      info.reached = counts[v.team] >= ev.line; // the bar is at the line: a fact, not an announcement
      info.order = ++token;                     // 1..voted among the tokens
      info.last = token === ev.voted;           // the wave's last token: the result comes next
      // the Judge's vote in the previous round of this place, when it voted there
      const prev = before?.get(judge);
      info.previous = prev?.team ? { round: prev.round, team: prev.team, name: this.byTeam.get(prev.team)?.name ?? null } : null;
      info.changed = !!(info.previous && info.previous.team !== v.team);
      shown.push({ judge, team: v.team });
      beats.push(this.beat("vote", ev, { calls: [{ method: "voteReveal", args: [info], voiced: true }], voice: { speaker: judge, text: v.reason ?? "" },
        view: revealView() }));
    });
    // the result, after the last token: the bar at the majority line, or the banner and the Host's bridge
    const result = ev.majority ? "majority" : isLast ? "no_majority_last" : "no_majority";
    const winner = ev.majority ? Object.keys(ev.counts)[0] : null;
    const tally = { stage: "result", ...common, counts: ev.counts, result, winner,
      banner: ev.majority ? labels.reached(ev.counts[winner], ev.voted) : isLast ? labels.noMajorityLast() : labels.noMajority(ev.round + 1, this.maxRounds),
      next: ev.majority || isLast ? null : { place: ev.place, round: ev.round + 1 }, ...(reveal ? { reveal: true } : {}) };
    const calls = [{ method: "tally", args: [tally] }];
    let voice = null;
    if (!ev.majority) {
      const args = { counts: ev.counts, voted: ev.voted, round: ev.round, nameOf: this.nameOf };
      const text = isLast ? host.noMajorityLast(args) : host.noMajority(args);
      calls.push({ method: "host", args: [text], voiced: true });
      voice = { speaker: "host", text };
    }
    beats.push(this.beat("vote.result", ev, { calls, voice, minS: this.o.resultS, view: revealView() }));
    return beats;
  }

  placement(ev) {
    this.decided++;
    if (!this.envelopes || ev.decided_by === "vacant") {
      // a vacant place is a rule over the ceiling, known before the Final: it names no pick, so it is
      // shown at once in both shows
      const beats = this.placementBeats(ev, { contenders: this.contenders(ev.place) });
      return [...beats, ...(this.envelopes ? this.revealIfAllDecided() : [])];
    }
    // sealed: the place is decided, its envelope sealed; nothing of the result is shown
    this.placements.push({ place: ev.place, team: ev.team, name: ev.name, decided_by: ev.decided_by, rounds: ev.rounds });
    // the Last Word card's rows, frozen now: place 1 = every contender (nothing is placed before it);
    // a later place = the Finalists with a vote in its deciding round and the winner, so the card does
    // not list (by leaving them out) the Finalists placed above it
    const contenders = ev.place === 1 ? this.contenders(ev.place) : this.voteGetters(ev);
    this.sealed.push({ place: ev.place, ev, contenders });
    const text = host.sealed({ place: ev.place });
    const status = { ...(this.status ?? {}), place: ev.place, round: ev.rounds, rounds: this.maxRounds, phase: "sealed",
      contenders: this.finalistRows(ev.place), away: [], sealed: this.sealedPlaces() };
    const beats = [this.beat("sealed", ev, {
      calls: [{ method: "status", args: [status] },
        { method: "envelope", args: [{ stage: "sealed", place: ev.place, envelopes: this.envelopeRow(), text, durationS: this.o.sealedS }], voiced: true }],
      voice: { speaker: "host", text }, minS: this.o.sealedS, view: { status },
    })];
    return [...beats, ...this.revealIfAllDecided()];
  }

  // the Finalists with a vote in the deciding round of `ev.place`, and its winner (rows of the Last Word card)
  voteGetters(ev) {
    const w = this.waves.get(ev.place);
    const teams = new Set([ev.team, ...(w?.ev.votes ?? []).map((v) => v.team).filter(Boolean)]);
    return this.finalists.filter((f) => teams.has(f.team)).sort((a, b) => a.rank - b.rank);
  }

  // every place's envelope: sealed, being opened, opened (the podium has it), vacant, or not decided yet
  envelopeRow(opening = null) {
    const sealed = new Set(this.sealedPlaces());
    return Array.from({ length: this.placesCount }, (_, i) => {
      const place = i + 1, p = this.podium[i];
      return { place, state: place === opening ? "opening" : sealed.has(place) ? "sealed" : p?.vacant ? "vacant" : p ? "open" : "pending" };
    });
  }

  // once every place is decided: the envelopes, from the last place to the first
  revealIfAllDecided() {
    if (this.decided < this.placesCount || !this.sealed.length) return [];
    return this.openEnvelopes();
  }

  openEnvelopes() {
    const beats = [];
    const order = [...this.sealed].sort((a, b) => b.place - a.place);
    if (!order.length) return beats;
    const intro = host.revealIntro({ places: this.placesCount });
    const status0 = { ...(this.status ?? {}), phase: "sealed", away: [], sealed: this.sealedPlaces() };
    beats.push(this.beat("reveal.intro", { place: order[0].place }, {
      calls: [{ method: "host", args: [intro], voiced: true }], voice: { speaker: "host", text: intro }, view: { status: status0 } }));
    for (const s of order) {
      const ev = s.ev;
      const w = this.waves.get(ev.place);
      this.sealed = this.sealed.filter((x) => x !== s);
      const round = w?.ev.round ?? ev.rounds;
      const evR = { place: ev.place, round };
      const text = host.openEnvelope({ place: ev.place, round, rounds: this.maxRounds });
      const status = { place: ev.place, round, rounds: this.maxRounds, phase: "reveal", contenders: this.finalistRows(ev.place),
        away: w ? w.common.away : [], sealed: this.sealedPlaces(), reveal: { urn: [], shown: [] } };
      beats.push(this.beat("reveal.open", evR, {
        calls: [{ method: "status", args: [status] },
          { method: "envelope", args: [{ stage: "open", place: ev.place, round, rounds: this.maxRounds, envelopes: this.envelopeRow(ev.place), text, durationS: this.o.openS }], voiced: true }],
        voice: { speaker: "host", text }, minS: this.o.openS, view: { status },
      }));
      if (w) beats.push(...this.revealBeats(w, { reveal: true }));
      beats.push(...this.placementBeats(ev, { contenders: s.contenders, revealed: true }));
    }
    return beats;
  }

  // The place's cards: the Last Word card when the rule decided, the verdict card, the podium step.
  placementBeats(ev, { contenders = [], revealed = false } = {}) {
    const beats = [];
    const tally = this.tallies.get(ev.place);
    const record = { place: ev.place, team: ev.team, name: ev.name, decided_by: ev.decided_by, rounds: ev.rounds };
    if (ev.decided_by === "vacant") {
      const text = host.vacant({ place: ev.place });
      const status = { place: ev.place, round: 0, rounds: this.maxRounds, phase: "decided", contenders: this.finalistRows(ev.place), ...this.sealedField() };
      beats.push(this.beat("verdict", ev, {
        view: { status },
        calls: [{ method: "status", args: [status] }, { method: "verdict", args: [{ place: ev.place, vacant: true, team: null, name: null, decided_by: "vacant", rounds: 0,
          reasons: [], against: [], absent: [], durationS: this.o.vacantS, text }], voiced: true }],
        voice: { speaker: "host", text }, minS: this.o.vacantS,
      }));
    } else {
      const f = this.byTeam.get(ev.team);
      const n = tally?.counts?.[ev.team] ?? 0;
      if (ev.decided_by === "last_word") {
        const rows = contenders.map((c) => ({ team: c.team, name: c.name, rank: c.rank, score: c.score }));
        const text = host.lastWord({ rounds: ev.rounds, name: this.nameOf(ev.team), score: f?.score, rank: f?.rank });
        beats.push(this.beat("lastword", ev, {
          calls: [{ method: "lastWord", args: [{ place: ev.place, rounds: ev.rounds, team: ev.team, name: ev.name, rank: f?.rank ?? null,
            score: f?.score ?? null, contenders: rows, rule: "10.4", text }], voiced: true }],
          voice: { speaker: "host", text }, minS: this.o.lastWordS,
        }));
      }
      // every vote of the deciding round, in the order it was revealed: the winner's reasons (all of them,
      // verbatim), the votes against (who for whom), the Judges without a vote
      const seq = this.revealed.get(ev.place) ?? (tally?.votes ?? []).map((v) => v.judge);
      const byJudge = new Map((tally?.votes ?? []).map((v) => [v.judge, v]));
      const deciding = seq.map((j) => byJudge.get(j)).filter(Boolean);
      const reasons = deciding.filter((v) => v.team === ev.team && v.reason).map((v) => ({ judge: v.judge, text: v.reason }));
      const against = deciding.filter((v) => v.team != null && v.team !== ev.team)
        .map((v) => ({ judge: v.judge, team: v.team, name: this.byTeam.get(v.team)?.name ?? null }));
      const absent = deciding.filter((v) => v.team == null).map((v) => v.judge);
      const voted = tally?.voted ?? 0;
      const text = host.verdict({ place: ev.place, name: this.nameOf(ev.team), n, voted, rounds: ev.rounds, decidedBy: ev.decided_by, against, nameOf: this.nameOf });
      const durationS = verdictDuration({ reasons: reasons.length, against: against.length, base: this.o.verdictS });
      beats.push(this.beat("verdict", ev, {
        calls: [{ method: "verdict", args: [{ place: ev.place, team: ev.team, name: ev.name, rank: f?.rank ?? null, score: f?.score ?? null,
          decided_by: ev.decided_by, votes: n, voted, judges: tally?.judges ?? null, rounds: ev.rounds, reasons, against, absent,
          line: tally ? tally.line : null, durationS, text }], voiced: true }],
        voice: { speaker: "host", text }, minS: durationS,
      }));
    }
    if (!revealed) this.placements.push(record);
    this.podium[ev.place - 1] = ev.decided_by === "vacant" ? { place: ev.place, team: null, name: null, vacant: true, decided_by: "vacant" } : { ...record };
    const status = { ...(this.status ?? {}), phase: "decided", place: ev.place, ...this.sealedField() };
    if (status.reveal) delete status.reveal;
    beats.push(this.beat("podium", ev, {
      calls: [{ method: "podium", args: [{ filled: ev.place, places: this.podium.map((p) => (p ? { ...p } : null)) }] }],
      minS: this.o.podiumS, view: { status },
    }));
    return beats;
  }

  final(ev) {
    // an engine that ended with envelopes still sealed (fewer places than planned): open them first
    const opened = this.envelopes && this.sealed.length ? this.openEnvelopes() : [];
    const podium = this.podium.map((p, i) => p ?? { place: i + 1, team: null, name: null, vacant: true });
    const text = host.final({ podium, nameOf: this.nameOf });
    const status = { ...(this.status ?? {}), phase: "done" };
    return [...opened, this.beat("final", ev, {
      calls: [{ method: "status", args: [status] },
        { method: "final", args: [{ podium, text }], voiced: true }],
      voice: { speaker: "host", text }, view: { status },
    })];
  }
}
