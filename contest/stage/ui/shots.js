// The Stage's cutting grammar: which shots a beat gets, from the times the sink returns (ui/show.js).
// The style frame (ui/mock.js) cuts with it; a live shot planner calls the same functions with the
// director's beats. Rules it keeps (red teams, style frames v2 and v3):
//   - the camera goes to whoever acts; a line over a walk cuts to what the line is about, not to
//     the walker (captions match the picture);
//   - no static hold longer than 6 s; different speakers get different angles;
//   - cut from a speaker to what it talks about (its monitor, the tube);
//   - the decision is seen: the Judge's screen dims and its head comes up, in its own shot;
//   - the walk is framed from the walker's front three-quarter, the drop as an insert at the slot;
//   - a revealed vote is shown with its voter: the Judge from the front, its open token beside it,
//     never another Judge as the figure; the card stays readable ≥ 2.5 s;
//   - names come once per close shot as a lower third, never as floating labels.
//
// Each function takes the director camera (stage.camera) and the captions (createCaptions) and
// returns the time its last shot ends, so beats chain: next = fn(..., { from: previousEnd }).

/** The decision at the desk: from `lead` s before the screen dims; `dur` long (default: until the walk). */
export function decideShot(cam, caps, id, plan, { from = -Infinity, side = -1, dur = null, lead = 0.4, introduce = false } = {}) {
  const dimAt = plan.dimAt ?? plan.decideAt + 0.5;
  const t = Math.max(dimAt - lead, from);
  cam.cut({ kind: "decide", id, side, dimAt }, t); // dimAt: the camera rides its iris on the dim
  const end = dur ? t + dur : Math.max((plan.walkAt ?? plan.t0 + 1.2) - 0.25, t + 1.6);
  if (introduce) caps?.introduce(id, t + 0.25, "lower", { dur: end - t - 0.3 }); // the name leaves with its shot
  return end;
}

/** The drop as an insert at the slot: from `lead` s before the drop until `tail` s after it. */
export function slotShot(cam, id, plan, { from = -Infinity, lead = 0.8, tail = 0.6, side = 1 } = {}) {
  cam.cut({ kind: "slot", id, side }, Math.max(plan.dropAt - lead, from));
  return plan.dropAt + tail;
}

/** The vote on foot of one Judge in full: decision at its desk, walk, drop. `plan` = show.judge()'s return. */
export function voteShots(cam, caps, id, plan, { from = -Infinity, side = -1, walkSide = 1, introduce = true } = {}) {
  const walk = decideShot(cam, caps, id, plan, { from, side, introduce });
  cam.cut({ kind: "walk", id, side: walkSide }, walk);
  // the slot insert from the side away from the walker's arm
  return slotShot(cam, id, plan, { from: walk + 1.2, side: walkSide, lead: 0.7, tail: 0.45 });
}

/**
 * One vote's reveal: the card (the Judge who cast it from the front, its token opening beside it,
 * the reason read under it), then the token into its team's tube. `r` = show.voteReveal()'s return.
 * `cardAt`: the cut to the card (default r.shots.card; r.t cuts before the token leaves the slot).
 * `reached`: this token brings the team to the line: the tube shot is tight and held, then the
 * camera pulls out to the wide (held at most `wideHold` s).
 */
export function revealShots(cam, caps, r, { from = -Infinity, reached = false, introduce = false, wideHold = 2.8, cardAt = r.shots.card } = {}) {
  const t = Math.max(cardAt, from);
  cam.cut({ kind: "card", id: r.id, side: r.side }, t);
  if (introduce) caps?.introduce(r.id, t + 0.2, "lower", { dur: 1.6 });
  if (!r.team) return r.shots.next;
  if (!reached) {
    cam.cut({ kind: "tube", team: r.team, side: -r.side }, r.shots.tube);
    return r.shots.next;
  }
  cam.cut({ kind: "tube", team: r.team, tight: true }, r.shots.tube);
  const wideAt = r.lands + 1.3;
  cam.move({ kind: "wide" }, wideAt, 2.2);
  return wideAt + Math.min(wideHold, 2.2 + 0.6);
}

/** A spoken line cut at its sentences: shots[i] covers sentence i (or the rest of the line). */
export function lineShots(cam, text, timing, t0, shots) {
  const starts = sentenceStarts(text, timing).map((s) => t0 + s);
  shots.forEach((shot, i) => {
    if (!shot || i >= starts.length) return;
    cam.cut(shot, i === 0 ? Math.min(starts[0], t0) : starts[i]);
  });
  return starts;
}

/** Seconds from a line's start at which each sentence's first word is spoken. */
export function sentenceStarts(text, timing) {
  const out = [0];
  timing.words.forEach((w, i) => {
    if (i && /[.!?…]$/.test(text.slice(timing.words[i - 1].start_char, timing.words[i - 1].end_char))) out.push(w.start_s);
  });
  return out;
}

/**
 * Screen time per figure from a shot list (camera.list() plus the sequence's end): the seconds each
 * shot is on air, credited to the Judge it is about (its id), the rest to "room"/"tubes"/"host".
 */
export function screenTime(list, end) {
  const out = {};
  list.forEach((s, i) => {
    const t1 = i + 1 < list.length ? list[i + 1].t : end;
    const t0 = Math.max(0, s.t);
    if (t1 <= t0) return;
    const who = s.id ?? (s.kind === "tube" || s.kind === "tally" ? "tubes" : s.kind === "host" ? "host" : "room");
    out[who] = (out[who] ?? 0) + (t1 - t0);
  });
  for (const k of Object.keys(out)) out[k] = Math.round(out[k] * 100) / 100;
  return out;
}
