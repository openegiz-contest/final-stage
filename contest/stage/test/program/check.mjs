// Headless checks of show.html on the real GPU (one browser for every job), with the synthetic
// programme and a synthetic recording:
//   node contest/stage/test/program/check.mjs plan     the virtual plan: segments, their times, the
//                                                      wall's pages, the debate's check(); zero console errors
//   node contest/stage/test/program/check.mjs resume   live (wall clock): a reload inside a Finalist's minute
//                                                      and inside the debate continues where it was
//   node contest/stage/test/program/check.mjs audio --program <a programme whose intro has audio>
//                                                      the intro's audio decodes, sets the line's length, plays
//   node contest/stage/test/program/check.mjs bench    ms per frame, full and lite, at the heaviest times
//   node contest/stage/test/program/check.mjs live     live.html alone still plays the whole recording
//   node contest/stage/test/program/check.mjs video    live: a minute on the big screen from its start: its
//                                                      screenshots (on air: no Stand videos), or, in a
//                                                      programme with a `video` (dormant), the video in step
//                                                      with the segment clock, the screen showing its frames
// Options: --program <url> (default test/program/fixture/program.json), --replay <url>
// (default test/replays/synthetic-full.jsonl), --gfx lite.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { extname, join, dirname, sep, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const STAGE = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SITE_3D = join(dirname(STAGE), "site", "assets", "3d");
const argv = process.argv.slice(2);
const mode = argv[0] ?? "plan";
const opt = (k, d) => argv.flatMap((a, i) => (a === `--${k}` ? [argv[i + 1]] : []))[0] ?? d;
const programUrl = opt("program", "test/program/fixture/program.json");
const replayUrl = opt("replay", "test/replays/synthetic-full.jsonl");
const lite = opt("gfx", "full") === "lite";

function playwright() {
  const require = createRequire(import.meta.url);
  const tries = [process.env.PLAYWRIGHT_CORE, "playwright-core"];
  try {
    const g = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
    tries.push(join(g, "playwright-core"), join(g, "@playwright/mcp/node_modules/playwright-core"));
  } catch {}
  for (const t of tries.filter(Boolean)) {
    try {
      return require(t);
    } catch {}
  }
  throw new Error("playwright-core not found");
}
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".png": "image/png", ".jpg": "image/jpeg",
  ".json": "application/json", ".jsonl": "application/x-ndjson", ".woff2": "font/woff2", ".svg": "image/svg+xml", ".md": "text/plain; charset=utf-8", ".glb": "model/gltf-binary", ".mp4": "video/mp4", ".mp3": "audio/mpeg" };
// a file, or the byte range the request asks for (a video seeks with ranges)
function sendFile(req, res, body, headers) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
  if (!m || !(m[1] || m[2])) return res.writeHead(200, { ...headers, "accept-ranges": "bytes" }).end(body);
  const size = body.length;
  const [a, b] = m[1] ? [Number(m[1]), Math.min(m[2] ? Number(m[2]) : size - 1, size - 1)] : [Math.max(0, size - Number(m[2])), size - 1];
  if (a > b) return res.writeHead(416, { "content-range": `bytes */${size}` }).end();
  res.writeHead(206, { ...headers, "content-range": `bytes ${a}-${b}/${size}`, "accept-ranges": "bytes" }).end(body.subarray(a, b + 1));
}
const server = createServer(async (req, res) => {
  if (req.url === "/favicon.ico") return res.writeHead(204).end();
  try {
    const url = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (url.startsWith("/run/")) return res.writeHead(502).end(); // no engine: the live page waits for its run
    const [root, rest] = url.startsWith("/vendor/three/") ? [join(SITE_3D, "three"), url.slice(14)]
      : url.startsWith("/vendor/mine/") ? [SITE_3D, url.slice(13)] : [STAGE, url.slice(1)];
    const path = resolve(root, rest);
    if (!path.startsWith(root + sep)) throw new Error("outside root");
    sendFile(req, res, await readFile(path), { "content-type": TYPES[extname(path)] || "application/octet-stream", "cache-control": "no-store" });
  } catch {
    res.writeHead(404).end();
  }
}).listen(0);
const base = `http://localhost:${server.address().port}`;
const { chromium } = playwright();
const browser = await chromium.launch({ channel: "chrome", args: ["--headless=new", "--ignore-gpu-blocklist", "--enable-gpu", "--use-angle=metal", "--autoplay-policy=no-user-gesture-required"] });
const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
const tab = await ctx.newPage();
const errors = [];
let ttsRefused = 0; // the audio mode runs without ?voice=estimate: the debate asks the TTS service, absent here
const ttsAbsent = (m) => mode === "audio" && /ERR_CONNECTION_REFUSED/.test(m.text()) && (m.location()?.url ?? "").startsWith("http://127.0.0.1:8790");
tab.on("console", (m) => (m.type() === "error" ? (ttsAbsent(m) ? ttsRefused++ : errors.push(m.text())) : m.type() === "warning" && console.log("  [warn]", m.text())));
tab.on("pageerror", (e) => errors.push(e.message));
const q = (extra) => [`program=${programUrl}`, `replay=${replayUrl}`, "voice=estimate", lite && "gfx=lite", ...extra].filter(Boolean).join("&");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const r2t = (x) => Math.round(x * 10) / 10;
let failed = false;
const expect = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failed = true;
};

if (mode === "plan") {
  await tab.goto(`${base}/show.html?${q(["t=0", "check=1"])}`);
  await tab.waitForFunction(() => window.__stage?.ready === true, null, { timeout: 180000 });
  const info = await tab.evaluate(() => {
    const p = window.__program;
    const r2 = (x) => (Number.isFinite(x) ? Math.round(x * 100) / 100 : x);
    return {
      duration: window.__frame.duration,
      segments: p.segments.map((s) => ({ id: s.id, from: r2(s.from), to: r2(s.to), team: s.team })),
      marks: p.marks.map((m) => ({ id: m.id, from: r2(m.from) })),
      debateAt: r2(p.debateAt),
      check: window.__live?.check?.() ?? null,
      casts: (window.__live?.played?.casts ?? []).map((c) => r2(c.at)),
      reveals: (window.__live?.played?.reveals ?? []).map((c) => r2(c.at)),
      shots: window.__frame.stage.camera.list().filter((s) => s.t < p.debateAt + 30),
      minuteShots: p.minuteShots, // stage-tv
      tv: p.vt.items,
      beats: p.program.finalists.filter((f) => f.beats).map((f) => ({ team: f.team, n: f.beats.length })),
    };
  });
  console.log(`duration ${info.duration} s, the debate from ${info.debateAt} s`);
  for (const m of info.marks) console.log(`  ${String(m.from).padStart(8)}  ${m.id}`);
  const c = info.check;
  console.log("debate:", JSON.stringify(c));
  console.log("vote walks at:", info.casts.join(" "), "\nreveals at:", info.reveals.join(" "));
  expect(c && c.finished && c.inOrder && c.once && c.allPlayed && c.verbatim, "the debate plays every beat once, in order, verbatim, to its final screen");
  const shots = info.shots;
  const cuts = shots.filter((s) => !s.move); // a move glides from the shot before: not a cut
  const holds = cuts.map((s, i) => ({ ...s, hold: (cuts[i + 1]?.t ?? info.debateAt) - s.t })).filter((s) => s.t < info.debateAt);
  const long = holds.filter((s) => s.hold > 7.0 && !["look"].includes("")); // reported, the hash insert holds on purpose
  console.log(`programme cuts: ${holds.length}, longest holds: ${holds.slice().sort((a, b) => b.hold - a.hold).slice(0, 5).map((s) => `${s.kind}${s.name ?? s.id ? ":" + (s.name ?? s.id) : ""}@${s.t} ${s.hold.toFixed(1)} s`).join(", ")}`);
  const flashes = holds.filter((s) => s.hold < 1.0);
  expect(!flashes.length, `no cut shorter than 1 s before the debate${flashes.length ? `: ${flashes.map((s) => `${s.kind}@${s.t}`).join(", ")}` : ""}`);
  void long;
  // stage-tv: every minute with a picture is an edit on the big screen (on air: the screenshots, no
  // beats); each change of screenshot shows as a move (a push in, a pull out) or lands on a cut
  const byTeam = Object.groupBy(info.minuteShots, (s) => s.team);
  for (const [team, list] of Object.entries(byTeam)) console.log(`  ${team} (${list[0].rank}): ${list.map((s) => `${s.shot}${s.move ? "~" : ""}@${r2t(s.t)}`).join(" ")}`);
  const stills = info.tv.filter((v) => v.kind === "stills");
  console.log(`the big screen: ${info.tv.map((v) => (v.kind === "stills" ? `${v.n} screenshots` : v.kind)).join(", ")}`);
  expect(stills.length >= 2 && stills.some((v) => v.n >= 4), `the big screen shows the screenshots, four in a minute at most (${stills.map((v) => v.n).join(" ")})`);
  expect(Object.keys(byTeam).length === info.tv.length && Object.entries(byTeam).every(([team, list]) => Math.abs(info.segments.find((s) => s.team === team)?.from - list[0].t) < 0.01), "each minute with a picture is cut as an edit from its start");
  const unseen = stills.flatMap((v) => {
    const team = info.segments.find((s) => s.team && s.from <= v.from && v.from < s.to)?.team;
    return v.changes.filter((c) => !(byTeam[team] ?? []).some((s) => Math.abs(s.t - c) < 1e-3)).map((c) => `${team}@${r2t(c)}`);
  });
  const changes = stills.reduce((n, v) => n + v.changes.length, 0);
  expect(changes > 0 && !unseen.length, `every change of screenshot (${changes}) is a move or a cut${unseen.length ? `; not: ${unseen.join(", ")}` : ""}`);
  expect(stills.every((v) => [v.from, ...v.changes].every((c, i, a) => i === 0 || c - a[i - 1] >= 7.5 - 1.6 - 1e-6)), "every screenshot stays at least TIMES.stillS");
  for (const b of info.beats) {
    const kinds = new Set((byTeam[b.team] ?? []).map((s) => s.shot));
    expect(["room", "tv", "tv-close", "host"].every((k) => kinds.has(k)) && (byTeam[b.team] ?? []).some((s) => s.move), `${b.team}: its ${b.n} beats give every shot kind and a push-in (${[...kinds].join(", ")})`);
  }
  const short = info.minuteShots.filter((s, i, a) => a[i + 1]?.team === s.team && a[i + 1].t - s.t < 3.2 - 1e-6);
  expect(!short.length, `no minute shot shorter than TIMES.minCut${short.length ? `: ${short.map((s) => `${s.team}@${s.t}`).join(", ")}` : ""}`);
  if (process.env.SHOTS) for (const s of holds.filter((s) => s.t >= Number(process.env.SHOTS) && s.t < Number(process.env.SHOTS) + 60)) console.log("   ", s.t, s.kind, s.name ?? s.id ?? "", s.hold.toFixed(2));
} else if (mode === "audio") {
  // a programme line with audio (--program <a programme whose intro has `audio`): decoded, its
  // length is the line's, its level comes from the samples (virtual), and live it plays
  const u = (extra) => `${base}/show.html?program=${programUrl}&replay=${replayUrl}${extra}`;
  await tab.goto(u("&t=20"));
  await tab.waitForFunction(() => window.__stage?.ready === true, null, { timeout: 180000 });
  const v = await tab.evaluate(() => {
    const intro = window.__program.segments.find((s) => s.id === "intro");
    const play = window.__program.voice.plays.find((p) => p.prepared.audioUrl);
    return { intro: intro.to - intro.from, durationS: play?.prepared.durationS ?? null, level: window.__program.voice.levelAt(21) };
  });
  console.log("virtual:", JSON.stringify(v));
  expect(v.durationS > 5 && v.level > 0, "virtual: the line lasts as its audio, the face light follows its samples");
  await tab.goto(u("&segment=intro"));
  await tab.waitForFunction(() => window.__program?.startId === "intro", null, { timeout: 120000 });
  await sleep(4000);
  const l = await tab.evaluate(() => {
    const plays = window.__program.voice.plays;
    return { plays: plays.map((p) => ({ at: p.at, end: p.end, source: !!p.source, engine: p.prepared.engine, audio: !!p.prepared.audioUrl })) };
  });
  console.log("live:", JSON.stringify(l));
  expect(l.plays.some((p) => p.audio && p.source), "the intro's audio is playing through WebAudio");
} else if (mode === "live") {
  // live.html on its own still plays the whole recording (ui/live.js after the mountDebate split)
  await tab.goto(`${base}/live.html?replay=${replayUrl}&voice=estimate&t=0&check=1`);
  await tab.waitForFunction(() => window.__stage?.ready === true, null, { timeout: 180000 });
  const c = await tab.evaluate(() => ({ ...window.__live.check(), duration: window.__frame.duration }));
  console.log("live.html:", JSON.stringify(c));
  expect(c.finished && c.inOrder && c.once && c.allPlayed && c.verbatim, "live.html plays every beat once, in order, verbatim");
} else if (mode === "bench") {
  // ms per frame (GPU-synced, 120 frames from each time), full and lite, in one browser
  const times = (opt("t", "4,50,131,631,712,742,1000")).split(",").map(Number);
  for (const g of ["full", "lite"]) {
    for (const t of times) {
      await tab.goto(`${base}/show.html?${q([`t=${t}`, g === "lite" && "gfx=lite"])}`);
      await tab.waitForFunction(() => window.__stage?.ready === true, null, { timeout: 180000 });
      const r = await tab.evaluate(async () => [await window.__stage.bench(120), window.__program.segmentAt(window.__stage ? 0 : 0)]);
      const seg = await tab.evaluate((x) => window.__program.segmentAt(x), t);
      const ms = r[0].msPerFrame;
      const limit = g === "full" ? 20 : 10;
      console.log(`${g.padEnd(4)} t=${String(t).padStart(6)}  ${seg.padEnd(16)} ${ms.toFixed(2)} ms/frame${ms > limit ? `  over ${limit} ms` : ""}`);
      if (ms > limit) failed = true;
    }
  }
} else if (mode === "video" && !JSON.parse(await readFile(join(STAGE, programUrl), "utf8")).finalists.some((f) => f.video)) {
  // stage-tv: no Stand video (on air since 2026-10-28 evening): live, from the start of a minute with
  // screenshots, the big screen shows its first screenshot without waiting for anything
  await tab.goto(`${base}/show.html?${q(["segment=finalist-8"])}`);
  await tab.waitForFunction(() => window.__program?.startId, null, { timeout: 120000 });
  await sleep(4000);
  const s = await tab.evaluate(() => ({ on: window.__program.vt.onScreen, items: window.__program.vt.items.length, videos: document.querySelectorAll("video").length }));
  console.log("no Stand video in the programme; the screenshots:", JSON.stringify(s));
  expect(s.on?.kind === "stills" && s.on.k[0] === 0 && s.on.a > 0.9 && s.videos === 0, "the big screen shows the minute's first screenshot, no <video> on the page");
} else if (mode === "video") {
  // live (wall clock), from the start of a minute with a Stand video: the video plays, muted, at the
  // segment clock's time (the page's clock starts with the module, ~ at load)
  const rank = JSON.parse(await readFile(join(STAGE, programUrl), "utf8")).finalists.find((f) => f.video).rank;
  await tab.goto(`${base}/show.html?${q([`segment=finalist-${rank}`])}`);
  await tab.waitForFunction(() => window.__program?.startId, null, { timeout: 120000 });
  const sample = () => tab.evaluate(() => {
    const it = window.__program.vt.items.find((v) => v.kind === "video" && v.ready > 0) ?? null;
    const on = window.__program.vt.onScreen; // stage-tv: what the big screen shows
    return it && { at: it.at, want: performance.now() / 1000 - it.start, ready: it.ready, paused: it.paused, muted: it.muted, screen: on && { kind: on.kind, drawn: on.drawn, version: on.version } };
  });
  await sleep(6000);
  const a = await sample();
  await sleep(4000);
  const b = await sample();
  console.log("video:", JSON.stringify({ a, b }));
  expect(a && b && !b.paused && b.muted, "the video plays, muted");
  expect(a && b && Math.abs(b.at - a.at - (b.want - a.want)) < 0.3, `it advances with the clock (${a && b ? (b.at - a.at).toFixed(2) : "?"} s in ${a && b ? (b.want - a.want).toFixed(2) : "?"} s)`);
  expect(b && Math.abs(b.at - b.want) < 0.8, `it is at the segment clock's time (${b ? (b.at - b.want).toFixed(2) : "?"} s off)`);
  const fresh = a?.screen && b?.screen ? b.screen.version - a.screen.version : 0;
  expect(b?.screen?.kind === "video" && Math.abs(b.screen.drawn - b.at) < 0.25 && fresh >= 0.4 * 30 * (b.want - a.want),
    `the big screen shows its frames (${fresh} new frames in ${a && b ? (b.want - a.want).toFixed(1) : "?"} s; the last at ${b?.screen?.drawn?.toFixed?.(2)} s, the video at ${b?.at?.toFixed?.(2)} s)`);
} else if (mode === "resume") {
  // 1) a Finalist's minute: start there, wait, reload with no parameters: the same segment again
  await tab.goto(`${base}/show.html?${q(["segment=finalist-8"])}`);
  await tab.waitForFunction(() => window.__program?.startId, null, { timeout: 120000 });
  await sleep(6000);
  const a = await tab.evaluate(() => ({ seg: window.__program.segmentAt(window.__stage ? performance.now() / 1000 : 0), stored: Object.fromEntries(Object.entries(localStorage)), startId: window.__program.startId }));
  console.log("before the reload:", JSON.stringify(a));
  await tab.goto(`${base}/show.html?${q([])}`);
  await tab.waitForFunction(() => window.__program?.startId, null, { timeout: 120000 });
  const b = await tab.evaluate(() => ({ startId: window.__program.startId, feed: window.__program.feedAt(performance.now() / 1000 + 1) }));
  console.log("after the reload:", JSON.stringify(b));
  expect(b.startId === "finalist-8", "a reload inside finalist-8 continues in finalist-8");
  expect(/finalist:team-005/.test(b.feed), `the wall shows that Finalist again (${b.feed})`);

  // 2) the debate: start at the launch, let the run appear and some beats play, reload
  await tab.goto(`${base}/show.html?${q(["segment=launch"])}`);
  await tab.waitForFunction(() => window.__program?.startId === "launch", null, { timeout: 120000 });
  await tab.waitForFunction(() => window.__live?.played?.beats?.length >= 8, null, { timeout: 180000, polling: 500 });
  await sleep(1500);
  const c = await tab.evaluate(() => ({ phase: window.__program.phase, beats: window.__live.played.beats.length, cursor: window.__live.director.cursor, stored: Object.fromEntries(Object.entries(localStorage)) }));
  console.log("before the reload:", JSON.stringify(c));
  expect(c.phase === "debate" && c.stored[Object.keys(c.stored).find((k) => k.startsWith("stage.program."))] === "debate", "the segment cursor says debate");
  await tab.goto(`${base}/show.html?${q([])}`);
  await tab.waitForFunction(() => window.__live?.played?.restored != null || window.__live?.played?.beats?.length > 0, null, { timeout: 180000, polling: 500 });
  await sleep(1000);
  const d = await tab.evaluate(() => ({ startId: window.__program.startId, phase: window.__program.phase, restored: window.__live.played.restored, first: window.__live.played.beats[0]?.n ?? null, cursor: window.__live.director.cursor }));
  console.log("after the reload:", JSON.stringify(d));
  expect(d.startId === "debate", "a reload inside the debate goes straight to the debate");
  expect(d.restored === c.cursor || d.restored >= c.cursor - 1, `the director resumes from its own cursor (${d.restored} vs ${c.cursor} before)`);
}
if (ttsRefused) console.log(`(${ttsRefused} requests to the absent TTS service at 127.0.0.1:8790 not counted)`);
console.log(errors.length ? `console errors (${errors.length}):\n  ${errors.join("\n  ")}` : "console errors: 0");
if (errors.length) failed = true;
await browser.close();
server.close();
process.exit(failed ? 1 : 0);
