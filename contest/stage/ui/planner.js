// The automatic camera of the live show (spec §7.7): from the sink calls and the times they return
// (ui/show.js), the shot list stage.camera plays, in the approved grammar (ui/shots.js, ui/mock.js):
//
//   a speaking Judge    the medium as it turns to the room, a second angle at a sentence (no hold
//                       over 6 s); its monitor when a sentence names what it read; once per long
//                       line a cutaway over the shoulder of the Judge who works on the next message
//   between beats       over the shoulder of a working Judge, its console showing what it read
//                       (activity `content`), the one with the least screen time first; else the
//                       wides (the room, the dispatch board, the tubes) as connective tissue
//   a vote wave         per voteCast in the real finish order: the decision at the desk, the walk,
//                       the drop as an insert at the slot; the first in full, the others' decisions
//                       cut in between the drops, never over one (voteCast's end paces the wave).
//                       Only the show's first wave; later ones are compact: the Judges decide
//                       together, a wide as they set off, the first drop, the box, the last drop
//   a reveal            the card (the voter from the front, its open token beside it), the tube;
//                       the token that reaches the line: tight on its tube, then the pull-out
//   the Host            its shot; the place's opener over the wide and the board; an unavailable
//                       Judge's dark desk and face, then the tubes («3 из 4») or the Host
//   cards               the shots ui/cards.js returns, as they are
//
// Segments, not cuts: every beat lays a segment {from, to, pri, shots}; commit(t) turns the
// segments up to t into cuts on stage.camera (the camera is a pure function of its cuts, so a cut is
// only ever made for a time not yet drawn). Where segments overlap the higher priority holds the
// camera (a drop's insert over a walk); between segments the last shot holds GRACE s, then the
// connective shots run. Everything is a function of the calls and their times: the same replay gives
// the same shot list, ticked live or in one pass.
import { sentenceStarts } from "/ui/shots.js";
import { JUDGE_IDS } from "/robots/roster.js";
import { Track } from "/world/timeline.js";

export const PACE = {
  MAX_HOLD: 6, // s: no shot holds longer
  GRACE: 1.0, // s the last shot holds into a pause before the connective shots
  FILL_S: 3.6, // an over-the-shoulder work shot
  WIDE_S: 4.4, // a connective wide
  MIN_CUT: 2.2, // the shortest shot inside a line
  MIN_SHOT: 0.9, // a shot the next planned cut would replace sooner is not cut to (a flash)
  ANGLE_S: 3.6, // a line changes angle at the first sentence after this long
  SCREEN_S: 2.8, // the speaker's monitor when it names what it read
  AWAY_S: 3.0, // the cutaway to the Judge working on the next message
  DECIDE_S: 1.7, // a decision at the desk after the wave's first (the screen dims, the head comes up)
  FIRST_DECIDE_S: 3.0, // the wave's first decision, before the wide of its walk
  CAST_GAP: 0.4, // a compact wave: s between two Judges' decisions
  SLOT_LEAD: 1.0, SLOT_LEAD_FIRST: 0.7, SLOT_TAIL: 0.5, // a drop's insert around the drop
  TALLY_S: 2.4, // the tubes when the count begins
  WIDE_HOLD: 2.8, // the wide after the line is reached
};
const PRI = { fill: 0, tally: 2, walk: 3, line: 4, decide: 5, reveal: 5, card: 5, slot: 6 };
export const SHOT_KINDS = new Set(["wide", "board", "card", "medium", "close", "ots", "screen", "decide", "front", "dark", "walk", "slot", "box", "token", "tube", "tally", "host"]);
const ROOM_KINDS = ["wide", "board", "tally"];

// what a sentence calls a file the Judge read (Russian names of the publication's files)
const ALIASES = [
  [/build_report/i, /отч[её]т\S*\s+сборк|build[_ ]report|стенд/i],
  [/SUBMISSION/i, /замыс|концепц|submission/i],
  [/README/i, /readme|ридми/i],
  [/\.(png|jpe?g|webp|gif)$|screenshot/i, /скриншот|снимк|экран/i],
  [/scores?\//i, /оценк|балл/i],
  [/presentation/i, /презентац/i],
  [/results\.json/i, /результат|рейтинг/i],
];
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function namesOf(item) {
  const path = String(item.path ?? "");
  const base = path.split("/").filter(Boolean).at(-1) ?? "";
  const stem = base.replace(/\.[a-z0-9]+$/i, "");
  const res = ALIASES.filter(([p]) => p.test(path)).map(([, re]) => re);
  if (stem.length >= 4) res.push(new RegExp(escapeRe(stem), "i"));
  return res;
}
/** The console content of an activity item (stage.js does the same for the live layer). */
const contentOf = (a) => (a.content?.image
  ? { kind: "image", label: a.label, path: a.path, src: a.content.image }
  : { kind: "text", label: a.label, path: a.path, text: a.content?.text ?? "", from: a.content?.from, to: a.content?.to });
const hasContent = (a) => !!(a?.content && (a.content.image || (a.content.text ?? "").trim()));

// startAt: the show time the planner takes the camera over (show.html: after the programme's own
// shots, ui/program.js); it cuts nothing before it.
export function createPlanner({ stage, caps = null, quiet = null, judges = JUDGE_IDS, tubes = () => true, startAt = null }) {
  const cam = stage.camera;
  const segs = [];
  const trace = []; // every segment laid, for checks
  let seq = 0;
  let committed = startAt ?? -1; // shots are cut for t <= committed
  const cur = { key: null, t: -Infinity, shot: null, seg: null, variant: 0 };
  let gap = { next: startAt ?? 0 }; // between segments: the next connective cut
  const liveOf = Object.fromEntries(judges.map((id) => [id, new Track()])); // { status, items, item }
  const turnItems = new Map(); // tid -> the console items of that turn with content (what it read for a message)
  const lines = []; // { from, to } spoken lines (subtitles)
  const onAir = Object.fromEntries(judges.map((id) => [id, 0]));
  const log = []; // the cuts: { t, kind, id?, team?, move?, tag }
  const rounds = []; // { place, round, from }
  let wave = null;
  let opened = false; // the show's first wide introduces the Judges by name
  let says = 0, decides = 0, lastUnavailable = null, roomTurn = 0, final = false, fullShown = false;

  // ---- segments
  function add(seg) {
    seg.from = Math.max(seg.from, committed + 1e-4); // never a cut in a frame already drawn
    if (!(seg.to > seg.from)) return null;
    seg.shots = seg.shots.filter((s) => s.t < seg.to).sort((a, b) => a.t - b.t);
    if (!seg.shots.length) return null;
    // booked now, just after a cut: it starts once that shot has been on for MIN_SHOT (no flash)
    const nf = cur.t + PACE.MIN_SHOT;
    if (cur.shot && !seg.hold && seg.from < nf && seg.from <= committed + 0.25 && seg.to - nf >= PACE.MIN_SHOT) {
      const on = seg.shots.filter((x) => x.t <= nf).at(-1) ?? seg.shots[0];
      seg.shots = [{ ...on, t: nf }, ...seg.shots.filter((x) => x.t > nf)];
      seg.from = nf;
    }
    if (seg.shots[0].t > seg.from) seg.shots[0].t = seg.from;
    seg.n = seq++;
    segs.push(seg);
    trace.push({ n: seg.n, from: seg.from, to: seg.to, pri: seg.pri, tag: seg.tag, shots: seg.shots.map((x) => [Math.round(x.t * 100) / 100, x.shot.kind, x.shot.id ?? x.shot.team ?? "", x.shot.side ?? ""]) });
    return seg;
  }
  const shot = (t, s, extra = {}) => ({ t, shot: s, ...extra });

  function pick(t) {
    let best = null;
    for (const s of segs) {
      if (s.from > t + 1e-9 || s.to <= t + 1e-9) continue;
      if (!best || s.pri > best.pri || (s.pri === best.pri && s.n > best.n)) best = s;
    }
    return best;
  }
  const shotIndex = (seg, t) => {
    let i = 0;
    while (i + 1 < seg.shots.length && seg.shots[i + 1].t <= t + 1e-9) i++;
    return i;
  };

  function nextBoundary(t, segsOnly = false) {
    let b = Infinity;
    for (const s of segs) {
      if (s.to <= t) continue;
      if (s.from > t) b = Math.min(b, s.from);
      else {
        b = Math.min(b, s.to);
        for (const x of s.shots) if (x.t > t) { b = Math.min(b, x.t); break; }
      }
    }
    if (segsOnly) return b;
    if (gap && gap.next > t) b = Math.min(b, gap.next);
    if (!cur.seg?.hold && cur.t + PACE.MAX_HOLD > t) b = Math.min(b, cur.t + PACE.MAX_HOLD);
    return b;
  }

  // another angle on the same subject, for a hold that would pass MAX_HOLD
  function vary(s, n) {
    const k = s.side ?? 1;
    switch (s.kind) {
      case "medium": return n % 2 ? { kind: "medium", id: s.id, side: -2.6 * Math.sign(k || 1), low: true, dist: 2.9, fov: 30 } : { kind: "close", id: s.id, side: -Math.sign(k || 1) };
      case "close": return { kind: "medium", id: s.id, side: Math.sign(k || 1) };
      case "ots": return { kind: "screen", id: s.id, dy: 0.1 };
      case "screen": return { kind: "ots", id: s.id, side: -1 };
      case "host": return n % 2 ? { kind: "wide" } : { kind: "tally" };
      case "wide": return { kind: "board" };
      case "board": return { kind: "wide" };
      case "tally": return { kind: "wide" };
      case "dark": return { kind: "front", id: s.id };
      case "front": return { kind: "dark", id: s.id, side: 1 };
      case "box": return { kind: "tally" };
      default: return n % 2 ? { kind: "wide" } : { kind: "board" };
    }
  }

  function lineAt(t) {
    return lines.some((l) => l.from <= t + 0.05 && t < l.to + 0.05);
  }

  function cut(entry, b, key, seg) {
    let s = entry.shot;
    if (entry.writer) {
      // the Judge writing the next message at b, its console with what it read; else stay on the speaker
      const w = judges.filter((j) => j !== entry.writer && working(j, b)?.status === "пишет" && working(j, b).item).sort((a, c) => onAir[a] - onAir[c])[0];
      if (w) entry = { ...entry, shot: (s = { kind: "ots", id: w, side: -1 }) };
      else {
        // nobody writes: closer on the speaker (or, where both closes put a monitor behind the header,
        // its low angle from the other side)
        const k = -Math.sign(cur.shot?.side || 1);
        const alts = [{ kind: "close", id: entry.writer, side: k }, { kind: "close", id: entry.writer, side: -k }, { kind: "medium", id: entry.writer, side: 2.6 * k, low: true, dist: 2.9, fov: 30 }];
        entry = { ...entry, shot: (s = clearOfHud(alts.filter((x) => JSON.stringify(x) !== JSON.stringify(cur.shot)), b)) };
      }
    }
    if (!SHOT_KINDS.has(s.kind)) {
      console.warn(`planner: unknown shot kind ${s.kind}, cutting to the wide`);
      s = { kind: "wide" };
    }
    const sameShot = cur.shot && JSON.stringify(cur.shot) === JSON.stringify(s);
    if (cur.shot?.id && onAir[cur.shot.id] !== undefined && !sameShot) onAir[cur.shot.id] += b - cur.t;
    if (!sameShot || entry.move) {
      if (entry.move) cam.move(s, b, entry.move);
      else cam.cut(s, b);
      log.push({ t: Math.round(b * 100) / 100, kind: s.kind, ...(s.id ? { id: s.id } : {}), ...(s.team ? { team: s.team } : {}), ...(entry.move ? { move: entry.move } : {}), tag: seg?.tag ?? "fill" });
      if (entry.show && stage.desks[s.id]) stage.desks[s.id].show(entry.show, b - 0.05);
      if (entry.cap && caps) caps.introduce(entry.cap, b + 0.25, "lower", { dur: entry.capDur ?? 2.2 });
      if (entry.tags && caps) entry.tags.forEach((id, i) => caps.introduce(id, b + 0.4 + i * 0.12, "tag", { dur: entry.tagDur ?? 4.5, row: i % 2 }));
      if (!lineAt(b)) quiet?.(b); // a cut away from a finished line clears its subtitle
    }
    // the same picture continues: its hold goes on counting from its first frame
    Object.assign(cur, { key, t: sameShot && !entry.move ? cur.t : b, shot: s, seg, variant: key === cur.key ? cur.variant : 0 });
  }

  // when the shot of `key` from b would be replaced by the next planned cut (Infinity: not within MIN_SHOT;
  // a pause holds the shot, so it is not a cut)
  function replacedAt(b, key) {
    for (let x = b, k = 0; k < 20; k++) {
      const nb = nextBoundary(x, true);
      if (!(nb < b + PACE.MIN_SHOT)) return Infinity;
      const s = pick(nb);
      if (!s) return Infinity;
      if (`${s.n}:${shotIndex(s, nb)}` !== key) return nb;
      x = nb;
    }
    return Infinity;
  }

  function decide(b) {
    if (final && cur.seg?.hold) return;
    const seg = pick(b);
    if (seg) {
      gap = null;
      const i = shotIndex(seg, b), key = `${seg.n}:${i}`;
      if (key !== cur.key) {
        // a flash: the current shot runs on to the cut after it, unless that breaks the hold limit
        const nb = cur.shot && !seg.shots[i].move ? replacedAt(b, key) : Infinity;
        if (nb < Infinity && (cur.seg?.hold || nb - cur.t <= PACE.MAX_HOLD)) return;
        return cut(seg.shots[i], b, key, seg);
      }
      if (!seg.hold && b - cur.t >= PACE.MAX_HOLD - 1e-6) {
        let v = cur.variant + 1, alt = vary(seg.shots[i].shot, v);
        for (let k = 0; k < 3 && JSON.stringify(alt) === JSON.stringify(cur.shot); k++) alt = vary(seg.shots[i].shot, ++v);
        if (alt.kind === "close" && JSON.stringify({ ...alt, side: -alt.side }) !== JSON.stringify(cur.shot)) alt = clearOfHud([alt, { ...alt, side: -alt.side }], b);
        cut({ shot: alt }, b, key, seg);
        cur.variant = v;
      }
      return;
    }
    if (!gap) gap = { next: b - cur.t >= PACE.MAX_HOLD - PACE.GRACE ? b : b + PACE.GRACE };
    if (b >= gap.next - 1e-9 || b - cur.t >= PACE.MAX_HOLD - 1e-6) {
      // a planned shot about to start: the pause holds on to it rather than flash a connective shot
      const nb = nextBoundary(b, true);
      if (nb - b < PACE.MIN_SHOT + 0.3 && nb - cur.t <= PACE.MAX_HOLD) return;
      const f = filler(b);
      cut(f, b, `fill:${b.toFixed(3)}`, null);
      gap.next = b + f.dur;
    }
  }

  /** Cut the planned shots up to time t into stage.camera. Call before drawing the frame of t. */
  function commit(t) {
    if (!(t > committed)) return;
    let x = committed;
    for (let guard = 0; guard < 100000; guard++) {
      const b = nextBoundary(x);
      if (!(b <= t)) break;
      decide(b);
      x = b;
    }
    committed = t;
    // segments that ended long ago are done
    for (let i = segs.length - 1; i >= 0; i--) if (segs[i].to < committed - 1) segs.splice(i, 1);
  }

  // ---- the live layer: who works, and what its console shows
  function liveAt(id, t) {
    return liveOf[id]?.current(t) ?? null;
  }
  const working = (id, t) => {
    const s = liveAt(id, t);
    return s && (s.status === "пишет" || s.status === "голосует") ? s : null;
  };

  function filler(b) {
    // a working Judge whose console shows what it read: the one with the least screen time
    const cands = judges.filter((id) => working(id, b)?.item);
    if (cands.length) {
      const sameOts = cur.shot?.kind === "ots" ? cur.shot.id : null;
      const pool = cands.length > 1 ? cands.filter((id) => id !== sameOts) : cands;
      const id = pool.slice().sort((a, c) => onAir[a] - onAir[c] || judges.indexOf(a) - judges.indexOf(c))[0];
      if (id === sameOts) return { shot: { kind: "screen", id, dy: 0.1 }, dur: PACE.FILL_S };
      return { shot: { kind: "ots", id, side: onAir[id] % 2 < 1 ? -1 : 1 }, dur: PACE.FILL_S };
    }
    // the room
    const kinds = ROOM_KINDS.filter((k) => k !== cur.shot?.kind && (k !== "tally" || tubes()));
    const kind = kinds[roomTurn++ % kinds.length] ?? "wide";
    return { shot: { kind }, dur: PACE.WIDE_S };
  }

  // ---- cut points inside a line
  function cutPoints(text, timing, t0) {
    const sent = sentenceStarts(text, timing).map((s) => t0 + s);
    const pause = [], words = [];
    timing.words.forEach((w, i) => {
      if (!i) return;
      words.push(t0 + w.start_s);
      const prev = text.slice(timing.words[i - 1].start_char, timing.words[i - 1].end_char);
      if (/[,;:—–]$/.test(prev)) pause.push(t0 + w.start_s);
    });
    return { sent, pause, words };
  }
  // the sentences of a line, each with its text
  function sentences(text, timing, t0) {
    const out = [];
    let cur = null;
    timing.words.forEach((w, i) => {
      if (!cur) cur = { t: t0 + w.start_s, from: w.start_char, to: w.end_char };
      cur.to = w.end_char;
      const word = text.slice(w.start_char, w.end_char);
      if (/[.!?…]$/.test(word) || i === timing.words.length - 1) {
        out.push({ ...cur, text: text.slice(cur.from, cur.to) });
        cur = null;
      }
    });
    return out;
  }
  // make sure no shot in `shots` (sorted, ending at `end`) holds longer than MAX_HOLD: cut to another
  // angle at a sentence, else a pause, else a word near the middle
  function enforceHold(shots, end, points, alt) {
    const out = [];
    for (let i = 0; i < shots.length; i++) {
      out.push(shots[i]);
      let from = shots[i].t;
      const to = i + 1 < shots.length ? shots[i + 1].t : end;
      let n = 0;
      while (to - from > PACE.MAX_HOLD - 0.2 && n++ < 20) {
        const lo = from + PACE.MIN_CUT, hi = Math.min(from + PACE.MAX_HOLD - 0.4, to - 1.2);
        const inRange = (xs) => xs.filter((x) => x >= lo && x <= hi);
        const c = inRange(points.sent).at(-1) ?? inRange(points.pause).at(-1) ?? inRange(points.words).at(-1) ?? Math.min(from + 4.5, to - 1.2);
        if (!(c > from + 1)) break;
        out.push(shot(c, alt(out.at(-1).shot)));
        from = c;
      }
    }
    return out;
  }

  // the first of `shots` that puts no monitor behind the header box, else the one that puts the least
  function clearOfHud(shots, t) {
    if (!cam.clash) return shots[0];
    const c = shots.map((x) => cam.clash(x, t));
    if (c[0] < 0.02) return shots[0];
    const i = c.indexOf(Math.min(...c));
    return c[i] < c[0] - 0.02 ? shots[i] : shots[0];
  }

  // A speaker's two angles: A from side k, B from the other side, low. The side alternates from line to
  // line, unless that puts a console's monitor (its text) behind the show's header box in the top-left
  // corner (red team 2:30, 7:24): then the other side, if it clashes less.
  function speakerAngles(id, k0, t) {
    const angles = (k) => ({ k, A: { kind: "medium", id, side: k }, B: { kind: "medium", id, side: -2.6 * k, low: true, dist: 2.9, fov: 30 } });
    const clash = (a) => (cam.clash ? Math.max(cam.clash(a.A, t), cam.clash(a.B, t)) : 0);
    const a = angles(k0), b = angles(-k0);
    const ca = clash(a);
    if (ca < 0.02) return a;
    return clash(b) < ca - 0.02 ? b : a;
  }

  // A compact vote wave (every wave after the show's first, which shows the whole choreography once):
  // every voteCast still plays, in the real finish order, but the Judges decide CAST_GAP s apart, so
  // they rise, take their tokens and walk together, and the wave is one wide (the room as they set
  // off), the first drop at the slot, the box as the others come to it, the last drop (red team:
  // four times the same 25 s without a word).
  function castCompact(r) {
    const P = PACE, p = r.plan, id = r.id;
    const first = wave.casts++ === 0;
    const last = r.order != null && r.order === r.of;
    const slot = { from: p.dropAt - P.SLOT_LEAD, to: p.dropAt + P.SLOT_TAIL };
    wave.slots.push(slot);
    const insert = () => add({ from: slot.from, to: slot.to, pri: PRI.slot, tag: `slot:${id}`, judge: id, shots: [shot(slot.from, { kind: "slot", id, side: 1 })] });
    if (first) {
      add({ from: r.t, to: slot.from, pri: PRI.walk, tag: "wave:wide", shots: [shot(r.t, { kind: "wide" })] });
      insert();
      wave.boxFrom = slot.to;
    } else {
      add({ from: wave.boxFrom, to: last ? slot.from : slot.to, pri: PRI.walk, tag: "wave:box", shots: [shot(wave.boxFrom, { kind: "box" })] });
      if (last) insert();
    }
    if (last || r.of === 1) return Math.max(...wave.slots.map((s) => s.to));
    return r.t + P.CAST_GAP;
  }

  // ---- the red team's trust fixes (2026-10-21): the Judge without a vote, the ceiling line
  let ceilingTeams = []; // place 1's Finalists under the ceiling (the status' blocked rows)
  // a Judge without a vote: its dark desk, then its dark face, no lower third (it does not speak;
  // the 2D note names it); the beat lasts until r.end
  function abstainShots(r) {
    wave ??= { casts: 0, slots: [], reveals: 0, reached: false, unavailable: null };
    wave.unavailable = r.id;
    const end = Number.isFinite(r.end) ? r.end : r.t;
    if (end > r.t) add({ from: r.t, to: end, pri: PRI.reveal, tag: `abstain:${r.id}`, judge: r.id,
      shots: [shot(r.t, { kind: "dark", id: r.id, side: 1 }), shot(r.t + 0.9, { kind: "front", id: r.id })] });
    return end;
  }
  // the ceiling line at place 1: the grey, lidded tube of the (first) capped Finalist, then the Host
  function ceilingShots(t0, end, starts) {
    const shots = [];
    if (ceilingTeams.length) shots.push(shot(t0, { kind: "tube", team: ceilingTeams[0] }));
    const s1 = starts[1] ?? null;
    shots.push(shot(s1 && s1 < end - 1 && s1 > t0 + 2 ? s1 : Math.min(t0 + 3.5, Math.max(t0, end - 1)), { kind: "host" }));
    return shots;
  }

  // ---- beats
  return {
    PACE,
    commit,
    trace,
    liveAt,
    /** The live layer: a Judge's status and console items at t. */
    live(id, p, t) {
      if (!liveOf[id]) return;
      const items = p.activity ?? [];
      const item = [...items].reverse().find(hasContent) ?? null;
      liveOf[id].add(t, { status: p.status, items, item, turn: p.turn });
      if (p.turn?.tid) turnItems.set(p.turn.tid, items.filter(hasContent));
    },
    status(s, meta) {
      if (s.phase === "discussion") {
        rounds.push({ place: s.place, round: s.round, from: meta.at });
        ceilingTeams = (s.contenders ?? []).filter((c) => c.blocked).map((c) => c.team);
        wave = null;
      } else if (s.phase === "voting") {
        wave = { casts: 0, slots: [], reveals: 0, reached: false, unavailable: null, lastSlotEnd: -Infinity, place: s.place, round: s.round };
      } else if (s.phase === "reveal") {
        // an envelope opened after the debate (owner 2026-10-28): its tokens come out as a wave's reveal
        rounds.push({ place: s.place, round: s.round, from: meta.at, reveal: true });
        wave = { casts: 0, slots: [], reveals: 0, reached: false, unavailable: null, lastSlotEnd: -Infinity, place: s.place, round: s.round, reveal: true };
      }
    },

    /** A Judge's message: r = show.say()'s return. */
    say(r, meta) {
      const { id, t0, end, text, timing } = r;
      // the line's shot opens once the Judge faces the lens (show.say faceAt), not on the back it turns
      // from; until then the shot before it holds (the last speaker still faces the room)
      const turnAt = Math.max(r.turnAt, Math.min(r.faceAt ?? r.turnAt, t0));
      const { k, A, B } = speakerAngles(id, says++ % 2 ? -1 : 1, t0);
      const alt = (s) => (s.kind === "medium" && s.side === k ? B : A);
      const points = cutPoints(text, timing, t0);
      const shots = [shot(turnAt, A, { cap: id, capDur: 2.4 })];
      // what it read for this message (its message turn, the last attempt), named in a sentence: its
      // monitor shows that file
      const base = `p${meta.place}-r${meta.round}-message-${id}`;
      let items = [];
      for (let a = 1; a <= 6; a++) {
        const got = turnItems.get(a === 1 ? base : `${base}-a${a}`);
        if (got) items = got;
      }
      // the first word that names a file it read: the cut to its monitor comes on that word
      let mention = null;
      for (const w of timing.words) {
        if (mention) break;
        const sent = sentences(text, timing, t0).find((x) => w.start_char >= x.from && w.end_char <= x.to);
        for (const it of items.slice().reverse()) {
          for (const re of namesOf(it)) {
            const m = re.exec(sent?.text ?? "");
            if (m && sent.from + m.index < w.end_char && sent.from + m.index >= w.start_char - 1) mention = { t: t0 + w.start_s, item: it };
          }
          if (mention) break;
        }
      }
      // the inserts: its monitor on the mention; once in a long line, the Judge who works on the next
      // message (whoever writes at that moment: resolved when the cut is made)
      const free = (x, len) => x >= turnAt + PACE.MIN_CUT && x + len <= end - 1.0 && shots.every((c) => c.t <= x - PACE.MIN_CUT || c.t >= x + len + PACE.MIN_CUT || c.t === x + len);
      if (mention) {
        const x = Math.max(mention.t, turnAt + PACE.MIN_CUT);
        if (free(x, PACE.SCREEN_S)) {
          shots.push(shot(x, { kind: "screen", id, dy: 0.1 }, { show: contentOf(mention.item) }));
          shots.push(shot(x + PACE.SCREEN_S, A));
        }
      }
      if (end - turnAt > 9) {
        const x = points.sent.find((s) => s - turnAt > 4 && free(s, PACE.AWAY_S));
        if (x !== undefined) {
          shots.push(shot(x, { kind: "medium", id, side: k }, { writer: id, capDur: PACE.AWAY_S - 0.6 }));
          shots.push(shot(x + PACE.AWAY_S, A));
        }
      }
      shots.sort((a, b) => a.t - b.t);
      // a new angle at a sentence once a shot has run ANGLE_S
      for (const s of points.sent) {
        if (s > end - 2.2) break;
        const prev = shots.filter((c) => c.t <= s).at(-1), next = shots.find((c) => c.t > s);
        if (s - prev.t >= PACE.ANGLE_S && (!next || next.t - s >= PACE.MIN_CUT) && prev.shot.kind === "medium" && !prev.writer) {
          shots.push(shot(s, A));
          shots.sort((a, b) => a.t - b.t);
        }
      }
      shots.sort((a, b) => a.t - b.t);
      // the speaker's own shots alternate between its two angles, in time order
      const all = enforceHold(shots, end + 0.3, points, alt);
      let n = 0;
      for (const x of all) if (x.shot.kind === "medium" && x.shot.id === id && !x.writer) x.shot = n++ % 2 ? B : A;
      add({ from: turnAt, to: end + 0.3, pri: PRI.line, tag: `say:${id}`, judge: id, shots: all });
      lines.push({ from: t0, to: end });
    },

    /** A Host line: r = show.host()'s return; meta.type says which beat it belongs to. */
    host(r, meta) {
      const { t0, end, text, timing } = r;
      const starts = sentenceStarts(text, timing).map((s) => t0 + s);
      const s1 = starts[1] ?? null, s2 = starts[2] ?? null;
      const shots = [];
      const type = meta.type;
      if (type === "round") {
        const tags = !opened ? judges : null;
        opened = true;
        shots.push(shot(t0, { kind: "wide" }, tags ? { tags, tagDur: Math.max(3.5, end - t0 + 1) } : {}));
        if (s1 && s1 < end - 1) shots.push(shot(s1, { kind: "board" }));
        else if (!tags && end - t0 > 3.5) shots.push(shot(t0 + 2.5, { kind: "host" }));
      } else if (type === "ceiling") {
        shots.push(...ceilingShots(t0, end, starts));
      } else if (type === "unavailable" || (type === "vote" && wave?.unavailable)) {
        // its dark desk from behind, then its dark face; a Judge that goes dark now first turns to its
        // desk, over the Host's first words. No lower third: the Host speaks, not the dark Judge (the
        // corner header and the reveal's note name it)
        const id = type === "vote" ? wave.unavailable : lastUnavailable;
        const d = type === "unavailable" ? 1.3 : 0;
        if (d) shots.push(shot(t0, { kind: "host" }));
        shots.push(shot(t0 + d, { kind: "dark", id, side: 1 }));
        shots.push(shot(t0 + d + 1.0, { kind: "front", id }));
        const next = s1 && s1 > t0 + d + 2.6 && s1 < t0 + d + 4.2 ? s1 : t0 + d + 3.6;
        shots.push(shot(next, type === "vote" ? { kind: "tally" } : { kind: "host" }));
        if (type === "vote" && s2 && s2 > next + 2) shots.push(shot(s2, { kind: "host" }));
      } else if (type === "vote.result") {
        shots.push(shot(t0, { kind: "tally" }));
        shots.push(shot(s1 && s1 > t0 + 2 ? s1 : t0 + Math.min(3, Math.max(2, (end - t0) / 2)), { kind: "host" }));
      } else {
        shots.push(shot(t0, { kind: "host" }));
      }
      const points = cutPoints(text, timing, t0);
      add({ from: t0, to: end + 0.3, pri: PRI.line, tag: `host:${type}`, shots: enforceHold(shots, end + 0.3, points, (s) => vary(s, 1)) });
      lines.push({ from: t0, to: end });
    },

    unavailable(r) {
      lastUnavailable = r.id;
    },

    /** A Judge's walk: r = show.voteCast()'s return. Returns when the next voteCast may start. */
    cast(r) {
      if (r.unavailable || !r.plan) return r.t;
      const P = PACE, p = r.plan, id = r.id;
      wave ??= { casts: 0, slots: [], reveals: 0, reached: false, unavailable: null };
      // the show's first wave in full; every later one compact (castCompact)
      if (wave.full === undefined) wave.full = r.compact !== undefined ? !r.compact : !fullShown && !(wave.place > 1 || wave.round > 1);
      fullShown ||= wave.full;
      if (!wave.full) return castCompact(r);
      const first = wave.casts++ === 0;
      const side = decides++ % 2 ? 1 : -1;
      const dFrom = Math.max(r.t, p.dimAt - 0.5);
      // the wave's first voter: its decision, then the room as it walks to the box (the wide, so the
      // first voter, the same Judge in most waves, does not take the wave's screen time)
      const dTo = first ? Math.max(Math.min(p.walkAt - 0.25, dFrom + P.FIRST_DECIDE_S), dFrom + 1.6) : Math.min(p.dimAt + P.DECIDE_S - 0.5, p.walkAt - 0.25);
      add({ from: dFrom, to: dTo, pri: PRI.decide, tag: `decide:${id}`, judge: id,
        shots: [shot(dFrom, { kind: "decide", id, side, dimAt: p.dimAt })] }); // no lower third: it does not speak
      const lead = first ? P.SLOT_LEAD_FIRST : P.SLOT_LEAD;
      const slot = { from: p.dropAt - lead, to: p.dropAt + P.SLOT_TAIL };
      if (first) add({ from: dTo, to: slot.from, pri: PRI.walk, tag: `walk:${id}`, shots: [shot(dTo, { kind: "wide" })] });
      else add({ from: p.walkAt - 0.25, to: slot.from, pri: PRI.walk - wave.casts * 0.001, tag: `walk:${id}`, judge: id, shots: [shot(p.walkAt - 0.25, { kind: "walk", id, side: 1 })] });
      add({ from: slot.from, to: slot.to, pri: PRI.slot, tag: `slot:${id}`, judge: id, shots: [shot(slot.from, { kind: "slot", id, side: 1 })] });
      wave.slots.push(slot);
      if (first) return slot.to;
      if (r.order != null && r.order === r.of) return Math.max(...wave.slots.map((s) => s.to));
      // the next decision: the earliest time after this one that no drop's insert needs
      const clash = (x) => wave.slots.some((s) => x < s.to + 0.15 && x + P.DECIDE_S > s.from - 0.15);
      let x = dTo;
      for (let i = 0; i < 400 && clash(x); i++) x += 0.05;
      return x;
    },

    /** The count begins: the tubes. */
    tally(r, meta) {
      if (r.stage !== "begin") return;
      add({ from: meta.at, to: meta.at + PACE.TALLY_S, pri: PRI.tally, tag: "tally", shots: [shot(meta.at, { kind: "tally" })] });
    },

    /** One vote revealed: r = show.voteReveal()'s return. Returns when the next beat may start. */
    reveal(r, v) {
      wave ??= { casts: 0, slots: [], reveals: 0, reached: false, unavailable: null };
      if (r.unavailable) return abstainShots(r);
      wave.unavailable = null;
      const first = wave.reveals++ === 0;
      // the first card is cut to before its token leaves the slot; a Judge back at its desk (the engine
      // has it on the next turn) is seen turning round to its card
      // (the cut comes 0.9 s into that turn, once it faces the lens more than its back: red team fix 8)
      const cardAt = Math.min(first ? r.t : r.shots.card, r.turns != null ? r.turns + 0.9 : Infinity);
      add({ from: cardAt, to: r.shots.tube, pri: PRI.reveal, tag: `card:${r.id}`, judge: r.id, shots: [shot(cardAt, { kind: "card", id: r.id, side: r.side })] });
      let end = r.shots.next;
      // every token into its tube the same way: the token that reaches the line gets no shot of its own,
      // the majority is the result's, after the last token (owner 2026-10-21)
      if (r.team) {
        add({ from: r.shots.tube, to: r.shots.next, pri: PRI.reveal, tag: `tube:${r.team}`, shots: [shot(r.shots.tube, { kind: "tube", team: r.team, side: -r.side })] });
      }
      // a long reason: back to the voter until it has said it
      if (r.end + 0.3 > end) {
        add({ from: end, to: r.end + 0.3, pri: PRI.line, tag: `reason:${r.id}`, judge: r.id, shots: [shot(end, { kind: "medium", id: r.id, side: -r.side })] });
        end = r.end + 0.3;
      }
      lines.push({ from: r.reads, to: r.end });
      return end;
    },

    /** Shots a cards call returned ({ end, shots: [{ kind, from, to, target? }] }). */
    cards(res, meta, { last = false } = {}) {
      final ||= last;
      for (const s of res?.shots ?? []) {
        const tgt = s.target;
        const extra = tgt == null ? {} : typeof tgt === "object" ? tgt : s.kind === "tube" ? { team: tgt } : { id: tgt };
        const { kind, from, to, target, move, ...rest } = s;
        const isLast = last && s === res.shots.at(-1);
        if (kind === "card") rest.portrait = true; // a cards beat's card frame has no token: the lens on the Judge (world/camera.js)
        add({ from, to: isLast ? Infinity : to, pri: PRI.card, tag: `cards:${meta.type}`, hold: isLast, shots: [shot(from, { kind, ...rest, ...extra }, move ? { move } : {})] });
      }
      if (res?.end) lines.push({ from: meta.at, to: res.end });
    },

    /** The cuts so far, screen time per Judge (overall and per round) and the longest holds. */
    report(end = committed) {
      const cuts = log.filter((c) => c.t <= end);
      const screen = {}, perRound = rounds.map((r) => ({ place: r.place, round: r.round, from: r.from, screen: {} }));
      const holds = [];
      cuts.forEach((c, i) => {
        const t1 = Math.min(end, i + 1 < cuts.length ? cuts[i + 1].t : end), t0 = c.t;
        if (t1 <= t0) return;
        const who = c.id ?? (c.kind === "tube" || c.kind === "tally" ? "tubes" : c.kind === "host" ? "host" : "room");
        screen[who] = (screen[who] ?? 0) + (t1 - t0);
        // a pull-out (move) belongs to the shot before it
        if (!c.move && !(final && i === cuts.length - 1)) holds.push({ t: t0, dur: t1 - t0, kind: c.kind, id: c.id ?? null });
        for (const r of perRound) {
          const next = perRound[perRound.indexOf(r) + 1]?.from ?? Infinity;
          const a = Math.max(t0, r.from), b = Math.min(t1, next);
          if (b > a) r.screen[who] = (r.screen[who] ?? 0) + (b - a);
        }
      });
      const r2 = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Math.round(v * 10) / 10]));
      holds.sort((a, b) => b.dur - a.dur);
      return { cuts, screen: r2(screen), rounds: perRound.map((r) => ({ ...r, screen: r2(r.screen) })), longest: holds.slice(0, 8).map((h) => ({ ...h, dur: Math.round(h.dur * 100) / 100 })) };
    },
  };
}
