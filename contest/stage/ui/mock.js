// MOCK, for the style frame only: the one place with invented data (robots/README.md). A scripted
// minute of the Final on the show clock, driven through the same sink calls the director makes
// (ui/show.js) and cut with the same grammar a live shot planner uses (ui/shots.js), so everything
// it exercises is what live data will drive. Invented here: the Judges' messages and reasons, the
// activity items and their timing (two message turns overlap so both can be seen working), the
// vote, the order the vote turns end in and the reveal order. Real: the files on the consoles (the
// fixture's SUBMISSION.md and build_report.json of team-003, copied to assets/mock/, and of team-011,
// copied to ui/fixture/), the Finalists (the fixture's state.json), the Host's lines
// (director/host.js templates, themselves proposals for the owner).
//
// The shot list is in `marks`, `report.shots` and the report of the build; in short (v4.1, ≈ 65 s):
//   wide (the Host opens the place), the board wide (the dispatch wall) → over Sonnet's shoulder
//   (team-011's build report), over astra's shoulder (team-011's SUBMISSION.md) → Opus speaks:
//   medium, its monitor, a second angle → vote turns: astra's vote in full: it decides at its desk
//   (screen dims, head up, token, the turn), walks, the slot → the Host on Fable: Fable's dark desk,
//   its face, the tubes («3 из 4») → Sonnet, sol, Opus decide (1.7 s each, cut in as the console
//   dims) → their drops, one insert each (≈ 2–3 s, held until the Judge turns away) → per vote: the
//   card (the voter from the front, its token open beside it, ≥ 2.5 s), the token into its tube;
//   Sonnet, astra (the one vote for «Штрек»: 1–1), sol, Opus → the line is reached: tight on the tube, the wide (≤ 2.4 s), the Host reads the verdict.
import { host as H } from "/director/host.js";
import { estimateTiming } from "/director/voice.js";
import { voteShots, decideShot, slotShot, revealShots, lineShots, screenTime } from "/ui/shots.js";

// the fixture's Finalists (state.json finalists), in rank order
export const FINALISTS = [
  ["team-003", "Горный поток"], ["team-011", "Штрек"], ["team-007", "Карьер-Ай"], ["team-002", "Забой"], ["team-014", "Недра"],
  ["team-009", "Рудник 4.0", true], ["team-001", "Шахтёр"], ["team-005", "Глубина", true], ["team-006", "Отвал"], ["team-012", "Квершлаг"],
].map(([team, name, ceiling], i) => ({ team, name, rank: i + 1, ceiling: !!ceiling }));

const SUB = "teams/team-003/source/src/SUBMISSION.md";
const REPORT = "publication/solutions/team-003/build_report.json";
const SUB11 = "teams/team-011/source/src/SUBMISSION.md";
const REPORT11 = "publication/solutions/team-011/build_report.json";

const OPUS = "Отчёт сборки «Горного потока»: стенд поднялся с первой команды, обе проверки прошли.";
const REASONS = {
  "gpt-6.1-sol": ["team-003", "Стенд поднялся с первой команды."],
  "gpt-6-astra": ["team-011", "У «Штрека» точнее охват."],
  "sonnet-5.5": ["team-003", "Оба модуля есть в отчёте сборки."],
  "opus-5.5": ["team-003", "Самая цельная работа из прочитанных."],
};
// the vote turn shown in full (it ends first), then the other three Judges in the vote
const FULL = "gpt-6-astra";
const QUICK = ["sonnet-5.5", "gpt-6.1-sol", "opus-5.5"];
// the other three after it, in shot order: D = its decision at the desk (the vote turn ends), X = its
// drop at the slot. A drop comes 6–8 s after the decision (Sonnet quickest, Opus slowest) and a Judge
// stays at the box ≈ 2 s after it; in this order the drops land ≈ 2.6 s apart, Sonnet's (far right)
// before sol's (far left), and each insert holds until its Judge has turned away from the box.
const VOTES = [["D", "sonnet-5.5"], ["D", "gpt-6.1-sol"], ["D", "opus-5.5"], ["X", "sonnet-5.5"], ["X", "gpt-6.1-sol"], ["X", "opus-5.5"]];
// the reveal order. Opus walks back past astra's desk until ≈ 41.6 s, through astra's card lens, so
// astra's card is the second; Sonnet (back at its post since ≈ 37 s) opens the count
const REVEALS = ["sonnet-5.5", "gpt-6-astra", "gpt-6.1-sol", "opus-5.5"];
const OTS_S = 3.2; // an over-the-shoulder work shot: the file reads, the name's lower third
const DECIDE_S = 1.7; // a quick vote's decision shot: the screen dims, the head comes up
const DROP_LEAD = 1.2, DROP_TAIL = 0.8, DROP_MIN = 0.8; // a drop's insert: from before the token reaches the slot until it has gone in

const text = async (url) => (await fetch(url)).text();

/** Schedule the whole sequence on `show` (ui/show.js) and `stage.camera`. Returns { duration, marks, report }. */
export async function playMock(show, stage, caps) {
  const [submission, report, sub11, report11] = await Promise.all(
    ["/assets/mock/SUBMISSION.md", "/assets/mock/build_report.json", "/ui/fixture/team-011-SUBMISSION.md", "/ui/fixture/team-011-build_report.json"].map(text));
  const cam = stage.camera, at = (t) => ({ at: t });
  const item = (kind, label, path, t, content) => ({ kind, label, path, at: t, ...(content ? { content } : {}) });
  const marks = {};

  // ---- before the first frame: everyone where the moment finds them
  const T0 = -10;
  show.judge("fable-5.1", { status: "недоступен", activity: [] }, at(T0));
  const opusLog = [item("open", "Read", SUB, T0 - 30, { text: submission }), item("open", "Read", REPORT, T0 - 20, { text: report, from: 1, to: 40 })];
  show.judge("opus-5.5", { status: "пишет", since: T0 - 40, activity: opusLog, turn: { kind: "message", running: true } }, at(T0 - 12));
  show.judge("opus-5.5", { status: "ждёт", activity: opusLog }, at(T0));
  show.judge("gpt-6.1-sol", { status: "ждёт", activity: [item("open", "read_file", SUB, T0 - 30, { text: submission })] }, at(T0));
  // Sonnet reads the other Finalist's build report (the modules block), astra its Concept
  const sonnetLog = [item("open", "Read", REPORT, T0 - 14, { text: report }), item("open", "Read", REPORT11, T0 - 2, { text: report11, from: 28, to: 41 })];
  show.judge("sonnet-5.5", { status: "пишет", since: T0 - 20, activity: sonnetLog, turn: { kind: "message", running: true } }, at(T0));
  const astraLog = [item("list", "list_dir", "teams/team-011/source/src/", T0 - 6), item("open", "read_file", SUB11, T0 - 1, { text: sub11 })];
  show.judge("gpt-6-astra", { status: "пишет", since: T0 - 12, activity: astraLog, turn: { kind: "message", running: true } }, at(T0));

  // the place is open: its round's tubes stand from the start, every voter's token on its desk
  const contenders = FINALISTS.map(({ team, name, rank, ceiling }) => ({ team, name, rank, ceiling }));
  show.tally({ stage: "begin", place: 1, round: 1, rounds: 3, line: 3, voted: 4, contenders }, at(T0));

  // ---- the Host opens the place: the wide, then the room from its corner (the dispatch board)
  const opening = H.openPlace({ place: 1, rounds: 3 });
  const openTiming = estimateTiming(opening);
  cam.cut({ kind: "wide" }, T0);
  const openEnd = show.host(opening, openTiming, at(0.5));
  lineShots(cam, opening, openTiming, 0.5, [null, { kind: "board" }]);
  marks.wide = 1.4;
  marks.board = openEnd - 0.3;

  // ---- at work: over Sonnet's shoulder, then over astra's
  const tWork = openEnd + 0.15;
  show.quiet(tWork);
  cam.cut({ kind: "ots", id: "sonnet-5.5" }, tWork);
  caps?.introduce("sonnet-5.5", tWork + 0.3, "lower", { dur: OTS_S - 0.6 });
  const tAstra = tWork + OTS_S;
  cam.cut({ kind: "ots", id: "gpt-6-astra" }, tAstra);
  caps?.introduce("gpt-6-astra", tAstra + 0.3, "lower", { dur: OTS_S - 0.5 });
  marks.otsSonnet = tWork + 1.6;
  marks.otsAstra = tAstra + 1.8;

  // ---- Opus speaks: medium, its monitor (what it talks about), a second angle
  const tSay = tAstra + OTS_S + 0.1 + 0.35;
  cam.cut({ kind: "medium", id: "opus-5.5", side: 1 }, tSay - 0.35); // as its turn to the room ends
  const opusTiming = estimateTiming(OPUS);
  const opusEnd = show.say("opus-5.5", OPUS, opusTiming, at(tSay));
  caps?.introduce("opus-5.5", tSay - 0.25, "lower", { dur: 1.8 });
  cam.cut({ kind: "screen", id: "opus-5.5", dy: 0.1 }, tSay + 1.6);
  cam.cut({ kind: "medium", id: "opus-5.5", side: -2.6, low: true, dist: 2.9, fov: 30 }, tSay + 3.5);
  marks.speaker = tSay + 1.0;
  marks.screen = tSay + 2.6;
  marks.speaker2 = tSay + 4.2;

  // ---- the vote turns (no tools: the consoles show the ballot sheet); sol's ends first and is
  // shown in full: decision at its desk, walk, the slot
  const tv = opusEnd + 0.3;
  show.judge("sonnet-5.5", { status: "ждёт", activity: sonnetLog }, at(tv - 0.01));
  show.judge("gpt-6-astra", { status: "ждёт", activity: astraLog }, at(tv - 0.01));
  for (const id of [FULL, ...QUICK]) show.judge(id, { status: "голосует", since: tv, activity: [], turn: { kind: "vote", running: true } }, at(tv));
  const plans = {};
  const ended = (id, t) => (plans[id] = show.judge(id, { status: "ждёт", since: tv, activity: [], turn: { kind: "vote", running: false, outcome: "ok" } }, at(t)));
  ended(FULL, tv + 0.25);
  let end = voteShots(cam, caps, FULL, plans[FULL], { from: tv + 0.05, side: -1, walkSide: 1 });
  Object.assign(marks, { decide: plans[FULL].dimAt + 0.9, walk: plans[FULL].walkAt + 1.0, slot: plans[FULL].dropAt - 0.05 });

  // ---- while the other three still vote, the Host speaks about Fable, cut at its sentences to
  // what each is about: Fable's dark desk from behind, then (≤ 3 s) its face from the front, so the
  // viewer sees the robot and that it is off; «3 из 4» over the tubes; its last sentence (the tie
  // rule) runs over the next decision
  const hostLine = H.unavailableVote({ judge: "Fable 5.1", line: 3, voted: 4 });
  const hostTiming = estimateTiming(hostLine);
  const tHost = end + 0.05;
  const hostEnd = show.host(hostLine, hostTiming, at(tHost));
  const starts = lineShots(cam, hostLine, hostTiming, tHost, [{ kind: "dark", id: "fable-5.1", side: 1 }]);
  const tFace = tHost + 0.8, tTally = starts[1] + 0.3;
  cam.cut({ kind: "front", id: "fable-5.1" }, tFace);
  cam.cut({ kind: "tally" }, tTally);
  caps?.introduce("fable-5.1", tFace + 0.1, "lower", { dur: tTally - tFace - 0.3 });
  marks.fable = tHost + 0.4;
  marks.face = tFace + 1.0;
  marks.tally = tTally + 0.6;
  end = tTally + 1.6;

  // ---- the other three: decisions and drops interleaved (VOTES), so each drop's insert has the box
  // to one Judge: a decision takes DECIDE_S (cut in before its console dims: the light leaves the
  // face, the head comes up) and ends that vote turn; a drop's insert runs from DROP_LEAD before the
  // token goes in to DROP_TAIL after, a wait before it goes to the insert (≤ 1.6 s) or the box
  const order = { D: 0, X: 0 };
  VOTES.forEach(([kind, id], i) => {
    if (kind === "D") {
      ended(id, end - 0.3);
      end = decideShot(cam, caps, id, plans[id], { from: end, side: order.D % 2 ? 1 : -1, dur: DECIDE_S, lead: 0.5, introduce: false });
      marks[`decide${++order.D + 1}`] = plans[id].dimAt + 0.8;
      return;
    }
    const p = plans[id], d = p.dropAt;
    if (d < end + 0.3) console.warn(`mock: ${id}'s drop at ${d.toFixed(2)} falls before its insert (${end.toFixed(2)})`);
    let lead = DROP_LEAD;
    if (d - lead - end > 1.6) cam.cut({ kind: "box", side: order.X % 2 ? 1 : -1 }, end);
    else lead = Math.max(lead, d - end);
    // the insert holds until this Judge has turned away from the box, unless the next drop needs the cut
    const [nk, nid] = VOTES[i + 1] ?? [];
    const tail = nk === "X" ? Math.max(DROP_TAIL, Math.min(p.leaveAt + 0.4 - d, plans[nid].dropAt - DROP_MIN - d)) : DROP_TAIL + 0.1;
    end = slotShot(cam, id, p, { from: end, lead, tail });
    marks[`slot${++order.X + 1}`] = d;
  });
  if (hostEnd + 0.15 > end + 1.0) {
    cam.cut({ kind: "host" }, end); // the Host finishes its line on its own shot
    end = hostEnd + 0.15;
  }
  show.quiet(end);

  // ---- the count: token by token, each with its voter
  // (a Judge's card waits until it is back at its post, facing the room)
  let t = end;
  const counts = {};
  const cards = [];
  let last = null, from = end;
  REVEALS.forEach((id, i) => {
    t = Math.max(t, plans[id].end - 0.4);
    const [team, reason] = REASONS[id];
    counts[team] = (counts[team] ?? 0) + 1;
    const reached = counts[team] === 3;
    const r = show.voteReveal({ place: 1, round: 1, line: 3, voted: 4, judge: id, index: i, of: REVEALS.length, team, reason, counts: { ...counts }, reached }, estimateTiming(reason), at(t));
    // the first card is cut to before its token leaves the slot (no token rises in the last drop's insert)
    const next = revealShots(cam, caps, r, { from, reached, wideHold: 2.4, ...(i === 0 ? { cardAt: t } : {}) });
    cards.push({ id, team, shot: Math.max(r.shots.card, from), reads: r.reads, closes: r.closes, readable: Math.round((r.closes - r.reads) * 100) / 100 });
    marks[`card${i + 1}`] = r.reads + 1.2;
    if (i === 0) marks.tube = r.lands + 0.2;
    if (reached) marks.majority = r.lands + 0.9;
    last = r;
    from = next;
    t = Math.max(next - 0.5, r.end + 0.3 - 0.5);
  });

  // ---- the verdict: over the pull-out to the wide (≤ 3 s), then the Host
  const tVerdict = last.lands + 0.8;
  const verdict = H.verdict({ place: 1, name: "«Горный поток»", n: 3, voted: 4, rounds: 1 });
  const vEnd = show.verdict({ place: 1, team: "team-003", name: "Горный поток", text: verdict }, estimateTiming(verdict), at(tVerdict));
  cam.cut({ kind: "host" }, from);
  marks.wideEnd = tVerdict + 1.8;
  marks.hostEnd = from + 1.0;
  const duration = Math.ceil(Math.max(vEnd + 0.7, from + 1.5));
  const shots = cam.list().filter((s) => s.t < duration);
  const r2 = (x) => Math.round(x * 100) / 100;
  const walks = Object.fromEntries(Object.entries(plans).map(([id, p]) => [id, { decideAt: r2(p.decideAt), dimAt: r2(p.dimAt), walkAt: r2(p.walkAt), arriveAt: r2(p.arriveAt), dropAt: r2(p.dropAt), leaveAt: r2(p.leaveAt), backAt: r2(p.backAt), end: r2(p.end) }]));
  return { duration, marks, report: { shots, screen: screenTime(shots, duration), cards, walks } };
}
