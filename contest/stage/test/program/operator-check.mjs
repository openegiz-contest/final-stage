// The operator's keys on show.html (ui/operator.js), headless on the real GPU, one browser:
//   node contest/stage/test/program/operator-check.mjs
// 1. Space pauses: the show clock (window.__stage.time) and the voice's audio clock stand for 3 s, the
//    AudioContext is suspended; Space again: both run on, together (the intro with a test tone as audio)
// 2. the show holds after the intro and after a Finalist's minute (time runs, the segment stays) until
//    → or Space; then the next segment
// 3. ← / → before the debate: next, previous, the same segment again, and a reload into a segment this
//    page did not schedule; a reload while paused comes back paused
// 4. the debate on the real replay: pause + resume skips no beat, ← replays the previous beat (the
//    director waits), → steps on; every beat played once, in order
// 5. ?air=1: no indicator in the DOM, the keys still work; ?hold=0: no holds
// 6. a Finalist's Stand video (when the programme has one) stands with the pause
// 7. a reload (⌘R) comes back to the same place: mid-Finalist under a stale ?segment=title, paused in a
//    hold, mid-line in the debate under a stale ?from=0 (segment, line, time ±1 s); ?restart=1 starts over
// Options: --program <url> (default test/program/fixture/program.json), --gfx lite, --only 1,4,5,6,7 (1 runs 1-3).
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { extname, join, dirname, sep, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const STAGE = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SITE_3D = join(dirname(STAGE), "site", "assets", "3d");
const argv = process.argv.slice(2);
const opt = (k, d) => argv.flatMap((a, i) => (a === `--${k}` ? [argv[i + 1]] : []))[0] ?? d;
const programUrl = opt("program", "test/program/fixture/program.json");
const REAL = "test/replays/real-live-probe-20261021b.jsonl";
const SYNTH = "test/replays/synthetic-full.jsonl";
const lite = opt("gfx", "full") === "lite";
const only = opt("only", null); // e.g. --only 4: one part
const part = (n) => !only || only.split(",").includes(String(n));

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
  throw new Error("playwright-core not found (set PLAYWRIGHT_CORE)");
}

// a test tone for the intro: 20 s of 220 Hz, so the voice has an audio clock to stop
function toneWav(seconds = 20, rate = 24000) {
  const n = seconds * rate, out = Buffer.alloc(44 + n * 2);
  out.write("RIFF", 0); out.writeUInt32LE(36 + n * 2, 4); out.write("WAVEfmt ", 8); out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20); out.writeUInt16LE(1, 22); out.writeUInt32LE(rate, 24); out.writeUInt32LE(rate * 2, 28);
  out.writeUInt16LE(2, 32); out.writeUInt16LE(16, 34); out.write("data", 36); out.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) out.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 220 * i) / rate) * 0.3 * 32767), 44 + i * 2);
  return out;
}
const TONE = toneWav();
const fixture = JSON.parse(await readFile(join(STAGE, programUrl), "utf8"));
const fixtureDir = "/" + dirname(programUrl) + "/";
const rebase = (p) => new URL(p, `http://x${fixtureDir}`).pathname; // the fixture's paths, served from /opfx/
const withAudio = {
  ...fixture,
  built_at: `${fixture.built_at}-operator-audio`,
  intro: { ...fixture.intro, audio: "/opfx/tone.wav" },
  finalists: fixture.finalists.map((f) => ({ ...f, images: (f.images ?? []).map(rebase), ...(f.video ? { video: rebase(f.video) } : {}) })),
};

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".png": "image/png", ".jpg": "image/jpeg",
  ".json": "application/json", ".jsonl": "application/x-ndjson", ".woff2": "font/woff2", ".svg": "image/svg+xml", ".md": "text/plain; charset=utf-8", ".glb": "model/gltf-binary", ".mp4": "video/mp4" };
// a file, or the byte range the request asks for (a Stand video seeks with ranges)
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
    if (url.startsWith("/run/")) return res.writeHead(502).end();
    if (url === "/opfx/program.json") return res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify(withAudio));
    if (url === "/opfx/tone.wav") return res.writeHead(200, { "content-type": "audio/wav", "cache-control": "no-store" }).end(TONE);
    const [root, rest] = url.startsWith("/vendor/three/") ? [join(SITE_3D, "three"), url.slice(14)]
      : url.startsWith("/vendor/mine/") ? [SITE_3D, url.slice(13)] : [STAGE, url.slice(1)];
    const path = resolve(root, rest);
    if (!path.startsWith(root + sep)) throw new Error("outside root");
    sendFile(req, res, await readFile(path), { "content-type": TYPES[extname(path)] || "application/octet-stream", "cache-control": "no-store" });
  } catch {
    if (!res.headersSent) res.writeHead(404).end();
  }
}).listen(0);
const base = `http://localhost:${server.address().port}`;
const { chromium } = playwright();
const browser = await chromium.launch({ channel: "chrome", args: ["--headless=new", "--ignore-gpu-blocklist", "--enable-gpu", "--use-angle=metal", "--autoplay-policy=no-user-gesture-required"] });
const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
const tab = await ctx.newPage();
const errors = [];
let ttsRefused = 0; // the audio part runs without ?voice=estimate: the launch line asks the absent TTS service
const ttsAbsent = (m) => /ERR_CONNECTION_REFUSED/.test(m.text()) && (m.location()?.url ?? "").includes("/synth?");
tab.on("console", (m) => (m.type() === "error" ? (ttsAbsent(m) ? ttsRefused++ : errors.push(m.text())) : m.type() === "warning" && !/voice for host failed|TTS|synth/.test(m.text()) && console.log("  [warn]", m.text())));
tab.on("pageerror", (e) => errors.push(e.message));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = false;
const expect = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failed = true;
};
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const r2 = (x) => (Number.isFinite(x) ? Math.round(x * 100) / 100 : x);
const open = async (query) => {
  await tab.goto(`${base}/show.html?${[...query, lite && "gfx=lite"].filter(Boolean).join("&")}`);
  await tab.waitForFunction(() => window.__operator && window.__stage?.ready, null, { timeout: 180000 });
};
const op = () => tab.evaluate(() => {
  const s = window.__operator.state;
  const P = window.__program;
  return { ...s, at: P.segmentAt(window.__stage.time), feed: P.feedAt(window.__stage.time), time: window.__stage.time,
    indicator: document.getElementById("operator")?.textContent ?? null };
});
const seg = (id) => tab.evaluate((id) => window.__program.segments.find((s) => s.id === id), id);
const key = async (k, wait = 600) => (await tab.keyboard.press(k), await sleep(wait));

if (part(1)) { // parts 1-3 run on one page
// ---- 1. pause: the show clock and the audio clock stand, then run on together
await open([`program=/opfx/program.json`, `replay=${SYNTH}`, "segment=intro"]);
await tab.evaluate(() => localStorage.clear());
await sleep(3500);
const audio = () => tab.evaluate(() => {
  const v = window.__program.voice;
  const p = v.plays.find((x) => x.prepared.audioUrl && x.source);
  return { time: window.__stage.time, state: v.audioState, pos: p ? v.audioPosition(p) : null, at: p?.at ?? null };
});
const a0 = await audio();
console.log("playing:", JSON.stringify(a0));
expect(a0.state === "running" && a0.pos > 1, "the intro's tone is playing on the audio clock");
await key("Space", 300);
const a1 = await audio();
await sleep(3000);
const a2 = await audio();
const s2 = await op();
console.log("paused:", JSON.stringify({ a1, a2, indicator: s2.indicator }));
expect(s2.paused && a1.time === a2.time, `Space: window.__stage.time stands for 3 s (${r2(a1.time)} → ${r2(a2.time)})`);
expect(a2.state === "suspended" && near(a1.pos, a2.pos, 0.02), `the audio clock stands too (${a2.state}, ${r2(a1.pos)} → ${r2(a2.pos)} s into the line)`);
expect(/ПАУЗА/.test(s2.indicator ?? ""), "the indicator says ПАУЗА");
await key("Space", 2000);
const a3 = await audio();
console.log("resumed:", JSON.stringify(a3));
expect(!(await op()).paused && near(a3.time - a2.time, 2, 0.4), `Space again: the clock runs on (+${r2(a3.time - a2.time)} s)`);
// the audio clock's own lag behind the show clock (the AudioContext starts late) is there before the pause;
// the pause must not add to it
const lag0 = a0.time - a0.at - a0.pos, lag3 = a3.time - a3.at - a3.pos;
// (resume reschedules the voices on the show clock: the lag may shrink, never grow)
expect(a3.state === "running" && lag3 <= Math.max(lag0, 0) + 0.04 && lag3 > -0.04, `the voice runs on with it, in step (audio behind the show clock by ${r2(lag0)} s before the pause, ${r2(lag3)} s after)`);

// ---- 2. the holds: after the intro, after a Finalist
const intro = await seg("intro");
expect(intro.hold && intro.hold.from === intro.to, "the plan has a hold after the intro");
await tab.evaluate((t) => window.__operator.jump(t), intro.to - 1.5);
await sleep(3000);
const h1 = await op();
await sleep(3000);
const h2 = await op();
console.log("hold:", JSON.stringify({ h1, h2 }));
expect(h1.holding === "intro" && h2.holding === "intro" && h2.segment === "intro" && h2.time > h1.time + 2.5, "the intro holds: time runs, the segment stays");
expect(/ДЕРЖИМ/.test(h2.indicator ?? ""), "the indicator says ДЕРЖИМ");
if (opt("shot", null)) await tab.screenshot({ path: opt("shot") });
const f10 = await seg("finalist-10");
await key("ArrowRight", 1000);
const h3 = await op();
const j3 = await tab.evaluate(() => window.__operator.lastJump);
expect(h3.at === "finalist-10" && !h3.holding && j3.to === f10.from && h3.feed.startsWith(`finalist:${f10.team}`), `→ ends the hold: finalist-10 from its start (${h3.feed})`);
await tab.evaluate((t) => window.__operator.jump(t), f10.to - 1.5);
await sleep(3000);
const h4 = await op();
expect(h4.holding === "finalist-10" && h4.feed.startsWith(`finalist:${f10.team}`), "the show holds after finalist-10, its page on the wall");
await key("Space", 1000);
const h5 = await op();
expect(h5.at === "finalist-9" && !h5.paused, "Space on a hold goes on: finalist-9");

// ---- 3. ← / → between segments, paused: a key's latency moves no clock, so every target is exact
// (the rule's 3 s from a segment's start is set with jump, not waited for)
const f9 = await seg("finalist-9"), f8 = await seg("finalist-8"), introS = await seg("intro");
await key("Space", 300);
const at = async (k) => (await key(k, 300), await op());
let s = await at("ArrowRight");
expect(s.paused && s.at === "finalist-8" && s.time === f8.from, `→: finalist-8 from its start (${r2(s.time - f8.from)} s in)`);
await tab.evaluate((t) => window.__operator.jump(t), f8.from + 1);
s = await at("ArrowLeft");
expect(s.at === "finalist-9" && s.time === f9.from, "← within 3 s of the start: finalist-9");
await tab.evaluate((t) => window.__operator.jump(t), f9.from + 4);
s = await at("ArrowLeft");
expect(s.at === "finalist-9" && s.time === f9.from, "← later in the segment: finalist-9 again from its start");
await at("ArrowLeft");
s = await at("ArrowLeft");
expect(s.at === "intro" && s.time === introS.from, "← ← : finalist-10, the intro");
// still paused, ← to a segment this page did not schedule (it started at the intro): a reload
const nav = tab.waitForEvent("framenavigated");
await key("ArrowLeft", 0);
await nav;
await tab.waitForFunction(() => window.__operator && window.__stage?.ready, null, { timeout: 180000 });
await sleep(400);
const r1 = await op();
await sleep(2000);
const r2s = await op();
const startId = await tab.evaluate(() => window.__program.startId);
console.log("after the reload:", JSON.stringify({ startId, r1: { paused: r1.paused, time: r1.time, at: r1.at }, r2: { time: r2s.time } }));
expect(startId === "title" && r1.at === "title", "← before the first scheduled segment reloads into it (the title)");
expect(r1.paused && r1.time === r2s.time, "a reload while paused comes back paused");
await key("Space", 1000);
expect(!(await op()).paused, "Space: on air again");

}
if (part(4)) {
// ---- 4. the debate on the real replay
await open([`program=${programUrl}`, `replay=${REAL}`, "voice=estimate", "segment=debate", "from=0"]);
await tab.waitForFunction(() => window.__live?.played?.beats?.length >= 3, null, { timeout: 180000, polling: 200 });
const dbg = () => tab.evaluate(() => {
  const L = window.__live, t = window.__stage.time, qd = L.director.queue;
  const say = L.played.says.find((x) => x.t0 <= t && t < x.end) ?? null;
  return { t, beats: L.played.beats.length, lastN: L.played.beats.at(-1)?.n, cursor: L.director.cursor, cur: qd.current ? { n: qd.current.beat.n, end: qd.current.end } : null,
    starts: [...new Set(L.played.beats.map((b) => b.at))].sort((a, b) => a - b), say: say && { n: say.n, t0: say.t0 }, subs: document.querySelector(".subs")?.textContent ?? "" };
});
await key("Space", 200);
const d1 = await dbg();
await sleep(3000);
const d2 = await dbg();
expect(d1.t === d2.t && d1.beats === d2.beats && d1.cursor === d2.cursor, `debate paused: the clock and the beats stand for 3 s (${d2.beats} beats, cursor ${d2.cursor})`);
await key("Space", 500);
// on through a few beats with →
for (let i = 0; i < 6; i++) await key("ArrowRight", 900);
const d3 = await dbg();
console.log("after → ×6:", JSON.stringify({ beats: d3.beats, cursor: d3.cursor, cur: d3.cur }));
expect(d3.beats >= d2.beats + 4, `→ steps on beat by beat (${d2.beats} → ${d3.beats} beats)`);
await sleep(2500); // well into the current beat
// ← lands on a beat start chosen from the beats at the press (ui/operator.js prev): the target is
// checked exactly (window.__operator.lastJump), the clock after it within the wall time since the press
const BEAT_BACK_S = 2;
const back = async () => {
  const before = await dbg();
  const w0 = Date.now();
  await key("ArrowLeft", 300);
  const after = await dbg();
  const wall = (Date.now() - w0) / 1000;
  const jumped = await tab.evaluate(() => window.__operator.lastJump);
  const starts = before.starts.filter((a) => a <= jumped.from + 1e-6);
  const cur = starts.at(-1);
  const want = jumped.from - cur > BEAT_BACK_S || starts.length < 2 ? cur : starts.at(-2);
  const ran = after.t - jumped.to;
  return { before, after, jumped, cur, want, ok: Math.abs(jumped.to - want) < 1e-6 && ran >= 0 && ran <= wall + 0.05, ran, wall };
};
const b1 = await back();
expect(b1.ok && b1.want === b1.cur, `← later in a beat: that beat again from its start (${r2(b1.jumped.to)} = ${r2(b1.cur)}, on ${r2(b1.ran)} s in ${r2(b1.wall)} s)`);
const cur4 = b1.cur, d4 = b1.before;
const b2 = await back();
const prev = d4.starts.filter((a) => a < cur4).at(-1);
expect(b2.ok && b2.want === prev, `← again: the previous beat (${r2(b2.jumped.to)} = ${r2(prev)}, on ${r2(b2.ran)} s in ${r2(b2.wall)} s)`);
await sleep(1500);
const d7 = await dbg();
expect(d7.beats === d4.beats && d7.cursor === d4.cursor, "while the picture replays the director waits: no new beat");
if (d7.say) expect(d7.say.t0 >= prev - 0.01 && d7.say.t0 <= cur4, `the replayed line is on screen (beat ${d7.say.n}: «${d7.subs.slice(0, 60)}…»)`);
await key("ArrowRight", 300);
const j8 = await tab.evaluate(() => window.__operator.lastJump);
expect(Math.abs(j8.to - cur4) < 1e-6, "→ after ←: the next beat already played");
for (let i = 0; i < 8; i++) await key("ArrowRight", 700);
await sleep(1000);
const check = await tab.evaluate(() => {
  const ns = window.__live.played.beats.map((b) => b.n);
  return { beats: ns.length, first: ns[0], last: ns.at(-1), inOrder: ns.every((n, i) => n === ns[0] + i), once: new Set(ns).size === ns.length, planned: window.__live.director.planner.n };
});
console.log("debate:", JSON.stringify(check));
expect(check.first === 0 && check.inOrder && check.once && check.last < check.planned, "every beat played once, in order, none skipped, none past what the engine produced");

}
if (part(5)) {
// ---- 5. on air: no indicator, the keys still work
await open([`program=${programUrl}`, `replay=${SYNTH}`, "voice=estimate", "segment=finalist-5", "air=1"]);
const e1 = await tab.evaluate(() => ({ el: !!document.getElementById("operator"), text: document.body.innerText.includes("ПАУЗА") || document.body.innerText.includes("Пробел") }));
await key("Space", 300);
const e2 = await op();
expect(!e1.el && !e1.text && e2.indicator === null, "?air=1: no operator indicator in the DOM");
expect(e2.paused, "?air=1: Space still pauses");
await key("Space", 200);
await open([`program=${programUrl}`, `replay=${SYNTH}`, "voice=estimate", "segment=intro", "hold=0"]);
const noHolds = await tab.evaluate(() => window.__program.segments.every((s) => !s.hold) && window.__program.segments.find((s) => s.id === "finalist-10").from === window.__program.segments.find((s) => s.id === "intro").to);
expect(noHolds, "?hold=0: no holds, the old automatic timeline");
}
// ---- 6. a Stand video (program.json finalists[i].video, the minute v2) stands with the pause
if (part(6)) {
  const vf = fixture.finalists.find((f) => f.video);
  if (!vf) console.log("skip a Stand video under the pause: no finalist with `video` in the programme");
  else {
    await open([`program=${programUrl}`, `replay=${SYNTH}`, "voice=estimate", `segment=finalist-${vf.rank}`]);
    await sleep(5000);
    const vid = () => tab.evaluate(() => {
      // stage-tv: the video on the big screen (its <video> is hidden; the TV's items say which plays)
      const it = window.__program.vt.items.find((x) => x.kind === "video" && x.ready > 0);
      if (it) return { paused: it.paused, at: it.at, time: window.__stage.time };
      const v = [...document.querySelectorAll("video")].find((x) => x.readyState > 0 && x.offsetParent !== null) ?? document.querySelector("video");
      return v && { paused: v.paused, at: v.currentTime, time: window.__stage.time };
    });
    const v0 = await vid();
    await key("Space", 300);
    const v1 = await vid();
    await sleep(3000);
    const v2 = await vid();
    console.log("video:", JSON.stringify({ v0, v1, v2 }));
    expect(v0 && !v0.paused && v2.paused && near(v1.at, v2.at, 0.01), `Space: the Stand video stands too (${r2(v1?.at)} → ${r2(v2?.at)} s)`);
    await key("Space", 1500);
    const v3 = await vid();
    expect(v3 && !v3.paused && v3.at > v2.at + 1, "Space again: the video plays on");
  }
}

// ---- 7. a reload comes back where the show was
if (part(7)) {
  const ready = () => tab.waitForFunction(() => window.__operator && window.__stage?.ready, null, { timeout: 180000 });
  const reload = async () => (await tab.reload(), await ready());
  // a) mid-Finalist, the URL still says ?segment=title (the rehearsal's ⌘R)
  await open([`program=${programUrl}`, `replay=${SYNTH}`, "voice=estimate", "segment=title"]);
  await tab.evaluate(() => localStorage.clear());
  let f8 = await seg("finalist-8");
  await tab.evaluate((t) => window.__operator.jump(t), f8.from + 5);
  await sleep(1500);
  const a0 = await op();
  const into0 = a0.time - f8.from;
  await reload();
  f8 = await seg("finalist-8");
  const a1 = await op(), j1 = await tab.evaluate(() => window.__operator.lastJump);
  console.log("reload mid-Finalist:", JSON.stringify({ before: { seg: a0.segment, into: r2(into0) }, after: { seg: a1.segment, into: r2(j1?.to - f8.from) } }));
  expect(a1.segment === "finalist-8" && j1 && near(j1.to - f8.from, into0, 1), `⌘R mid-Finalist under ?segment=title: finalist-8 again, ${r2(j1?.to - f8.from)} s in (was ${r2(into0)} s)`);
  // b) paused in the hold after it
  await tab.evaluate((t) => window.__operator.jump(t), f8.to + 4);
  await tab.evaluate(() => window.__operator.pause()); // Space on a hold goes on, so the pause is the API's
  await sleep(400);
  const b0 = await op(), hold0 = b0.time - f8.to;
  await reload();
  f8 = await seg("finalist-8");
  await sleep(1000);
  const b1 = await op();
  await sleep(1500);
  const b2 = await op();
  console.log("reload in a paused hold:", JSON.stringify({ before: { paused: b0.paused, holding: b0.holding, into: r2(hold0) }, after: { paused: b1.paused, holding: b1.holding, into: r2(b1.time - f8.to), stands: b1.time === b2.time } }));
  expect(b1.paused && b1.holding === "finalist-8" && near(b1.time - f8.to, hold0, 1) && b1.time === b2.time,
    `⌘R paused in the hold: paused, holding finalist-8, ${r2(b1.time - f8.to)} s into the hold (was ${r2(hold0)} s), the clock stands`);
  await key("Space", 300);
  // c) ?restart=1: from the start of what the URL asks, and the flag leaves the URL
  await open([`program=${programUrl}`, `replay=${SYNTH}`, "voice=estimate", "segment=title", "restart=1"]);
  const c1 = await op();
  const search = await tab.evaluate(() => location.search);
  expect(c1.segment === "title" && !c1.paused && !/restart/.test(search), `?restart=1: the title, playing, and the flag gone from the URL (${search.slice(0, 40)}…)`);
  // Shift+R twice: the same from the keys (the OBS source's URL has no flags to edit)
  await tab.evaluate((t) => window.__operator.jump(t), (await seg("finalist-8")).from + 5);
  await key("Shift+R", 300);
  const navR = tab.waitForEvent("framenavigated");
  await key("Shift+R", 0);
  await navR;
  await ready();
  const c2 = await op();
  expect(c2.segment === "title" && !/restart/.test(await tab.evaluate(() => location.search)), "Shift+R twice: the show from the title");
  // d) the debate, mid-line, the URL still says ?from=0
  await open([`program=${programUrl}`, `replay=${REAL}`, "voice=estimate", "segment=debate", "from=0"]);
  await tab.waitForFunction(() => window.__live?.played?.beats?.length >= 3, null, { timeout: 180000, polling: 200 });
  for (let i = 0; i < 4; i++) await key("ArrowRight", 700);
  await tab.waitForFunction(() => { const c = window.__live.director.queue.current; return c && c.beat.type === "message" && Number.isFinite(c.end) && c.end - window.__stage.time > 6; }, null, { timeout: 120000, polling: 200 }).catch(() => {});
  await sleep(3000);
  const d0 = await tab.evaluate(() => { const c = window.__live.director.queue.current; return { n: c?.beat.n, into: window.__stage.time - c?.start, type: c?.beat.type }; });
  await reload();
  await tab.waitForFunction(() => window.__live && window.__operator.pendingBeat === null && window.__operator.lastJump, null, { timeout: 180000, polling: 200 });
  await sleep(300);
  const d1 = await tab.evaluate(() => {
    const L = window.__live, j = window.__operator.lastJump, c = L.director.queue.current;
    const b = L.played.beats.find((x) => x.n === c?.beat.n);
    return { n: c?.beat.n, first: L.played.beats[0]?.n, restored: L.played.restored, into: b ? j.to - b.at : null };
  });
  console.log("reload mid-line:", JSON.stringify({ before: d0, after: d1 }));
  expect(d1.n === d0.n && d1.first === d0.n && near(d1.into, d0.into, 1), `⌘R mid-line under ?from=0: line ${d1.n} again (was ${d0.n}), ${r2(d1.into)} s in (was ${r2(d0.into)} s)`);
}

if (ttsRefused) console.log(`(${ttsRefused} requests to the absent TTS service not counted)`);
console.log(errors.length ? `console errors (${errors.length}):\n  ${errors.join("\n  ")}` : "console errors: 0");
if (errors.length) failed = true;
await browser.close();
server.close();
process.exit(failed ? 1 : 0);
