// ui/minute-shots.js: a Finalist's minute as an edit: the screenshots' changes (on air), the montage's beats (dormant), or the default edit (stage-tv).
import { test } from "node:test";
import assert from "node:assert/strict";
import { planMinute, cleanBeats, moveOnChanges, stillChanges, EDIT, SHOT_KINDS } from "../../ui/minute-shots.js";

const holds = (plan, to) => plan.map((s, i) => (plan[i + 1]?.t ?? to) - s.t);

test("beats: one shot per beat on the show clock, tv ↔ tv-close moves, the rest cuts", () => {
  const beats = [
    { t: 0, shot: "room", label: "the Host opens" },
    { t: 6, shot: "tv", label: "the dashboard" },
    { t: 12, shot: "tv-close", label: "a truck turns red" },
    { t: 19, shot: "tv", label: "back" },
    { t: 26, shot: "host", label: "the idea" },
    { t: 33, shot: "tv-close", label: "the forecast" },
    { t: 41, shot: "room", label: "closing" },
  ];
  const plan = planMinute({ from: 100, to: 150, zero: 101, beats });
  assert.deepEqual(plan.map((s) => s.shot), ["room", "tv", "tv-close", "tv", "host", "tv-close", "room"]);
  assert.deepEqual(plan.map((s) => s.t), [100, 107, 113, 120, 127, 134, 142]);
  assert.equal(plan[2].move, EDIT.push);
  assert.equal(plan[3].move, EDIT.pull);
  assert.equal(plan[5].move, undefined); // host → tv-close: a cut
  assert.equal(plan[2].label, "a truck turns red");
});

test("no shot shorter than minCut: a late beat waits, or goes when the next one is due first", () => {
  const beats = [{ t: 0, shot: "tv" }, { t: 1.0, shot: "tv-close" }, { t: 9, shot: "host" }, { t: 10, shot: "room" }, { t: 11, shot: "tv" }];
  const plan = planMinute({ from: 0, to: 40, zero: 0, beats, minCut: 3.2 });
  for (const h of holds(plan, 40)) assert.ok(h >= 3.2 - 1e-9, `hold ${h}`);
  assert.equal(plan[0].shot, "tv"); // the first beat inside minCut of the start opens the minute
  assert.equal(plan[1].shot, "tv-close");
  assert.equal(plan[1].t, 3.2); // waited for minCut
  assert.ok(!plan.some((s) => s.shot === "room"), "room at 10 dropped: tv is due at 11, before it could end");
});

test("beats near the end and unknown kinds are left out; the same shot twice is one shot", () => {
  const beats = [{ t: 2, shot: "room" }, { t: 8, shot: "wide" }, { t: 9, shot: "tv" }, { t: 14, shot: "tv" }, { t: 28.5, shot: "host" }, { t: "x", shot: "tv" }];
  assert.equal(cleanBeats(beats).length, 4);
  const plan = planMinute({ from: 0, to: 30, zero: 0, beats });
  assert.deepEqual(plan.map((s) => s.shot), ["room", "tv"]);
});

test("without beats: room → tv → tv-close at the middle → room, on sentence starts", () => {
  const starts = [1.6, 7.0, 13.0, 21.0, 30.5, 38.0, 44.0, 52.5];
  const plan = planMinute({ from: 0, to: 60, starts });
  assert.deepEqual(plan.map((s) => s.shot), ["room", "tv", "tv-close", "room"]);
  assert.equal(plan[1].t, 7.0);
  assert.equal(plan[2].t, 30.5);
  assert.equal(plan[2].move, EDIT.push);
  assert.equal(plan[3].t, 52.5);
  for (const h of holds(plan, 60)) assert.ok(h >= EDIT.minCut);
});

test("without beats or sentences, and short minutes", () => {
  const plan = planMinute({ from: 10, to: 55 });
  assert.deepEqual(plan.map((s) => s.shot), ["room", "tv", "tv-close", "room"]);
  for (const h of holds(plan, 55)) assert.ok(h >= EDIT.minCut);
  assert.deepEqual(planMinute({ from: 0, to: 10 }).map((s) => s.shot), ["room", "tv-close"]);
  assert.deepEqual(planMinute({ from: 0, to: 5 }).map((s) => s.shot), ["room"]);
  assert.deepEqual(SHOT_KINDS, ["room", "tv", "tv-close", "host"]);
});

test("the screenshots' long tv shot moves to tv-close and back at each change; a change near a cut takes the cut", () => {
  // a screenshots minute with text beats (dormant since 2026-10-28 evening): host, tv over the screenshots, host
  const plan = planMinute({ from: 0, to: 63, zero: 1.6, beats: [{ t: 0, shot: "host" }, { t: 7.36, shot: "tv" }, { t: 55.5, shot: "host" }] });
  assert.deepEqual(plan.map((s) => s.shot), ["host", "tv", "host"]);
  const moved = moveOnChanges(plan, [14.0, 28.0, 42.0, 56.5, 9.5], { to: 63 });
  // 9.5 (0.54 s into the tv shot) takes the cut to tv; 56.5 (0.6 s before the cut to host) takes that cut
  assert.deepEqual(moved.map((s) => [s.shot, s.t]), [["host", 0], ["tv", 9.5], ["tv-close", 14], ["tv", 28], ["tv-close", 42], ["host", 56.5]]);
  assert.equal(moved[2].move, EDIT.push);
  assert.equal(moved[3].move, EDIT.pull);
  assert.equal(moved[5].move, undefined); // tv-close → host stays a cut
  for (const h of holds(moved, 63)) assert.ok(h >= EDIT.minCut);
});

test("on air (screenshots, no beats): room → tv, a push or a pull at every change on a sentence start, → room", () => {
  // a 62 s minute, 4 screenshots from 0.6 s to 61.8 s, the Host's sentences every ~5 s
  const starts = [1.6, 6.4, 11.9, 15.8, 21.0, 26.3, 31.1, 36.2, 41.0, 46.9, 52.2, 56.0];
  const changes = stillChanges({ from: 0.6, end: 61.8, n: 4, starts, stillS: 7.5, fade: 1.6 });
  assert.deepEqual(changes, [15.6, 30.9, 46.7]); // the even spread (14.3, 29.6, 44.9) moved to sentences
  const plan = planMinute({ from: 0, to: 62, starts, changes });
  assert.deepEqual(plan.map((s) => s.shot), ["room", "tv", "tv-close", "tv", "tv-close", "room"]);
  assert.deepEqual(plan.slice(2, 5).map((s) => s.t), changes);
  assert.deepEqual(plan.map((s) => s.move), [undefined, undefined, EDIT.push, EDIT.pull, EDIT.push, undefined]);
  for (const h of holds(plan, 62)) assert.ok(h >= EDIT.minCut);
  // one screenshot: no change, the default push at the middle
  assert.deepEqual(planMinute({ from: 0, to: 62, starts, changes: [] }).map((s) => s.shot), ["room", "tv", "tv-close", "room"]);
});

test("short minutes on screenshots: every change shows, as a move or on a cut", () => {
  // changes at 7.1 (just after the cut to tv at 5.5) and 23.4 (just before the cut to room at 26.4)
  const plan = planMinute({ from: 0, to: 33.4, starts: [1.6, 5.5, 10.6, 15.4, 26.4], changes: [7.1, 15.2, 23.4] });
  assert.deepEqual(plan.map((s) => [s.shot, s.t]), [["room", 0], ["tv", 7.1], ["tv-close", 15.2], ["room", 23.4]]);
  for (const h of holds(plan, 33.4)) assert.ok(h >= EDIT.minCut);
  const changes = stillChanges({ from: 0.6, end: 25.2, n: 3, starts: [1.6, 8.2, 10.9, 13.6, 20.2] });
  for (const [a, b] of [[0.6, changes[0]], [changes[0], changes[1]], [changes[1], 25.2]]) assert.ok(b - a >= 7.5 - 1.6 - 1e-9, `${a}..${b}`);
});
