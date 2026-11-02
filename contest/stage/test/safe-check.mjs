// Stills of the on-screen text layer of show.html and the ?cams=1 check, on the real GPU (one browser):
//   node contest/stage/test/safe-check.mjs --program <url of program.json> [--replay <url>] [--out <dir>] [--sweep-only]
// Finds the moments in the planned broadcast (?t=, virtual): a Judge's speech line in its close shot
// (both vendors), a Judge's line in the bottom bar, the Host's minute with a Stand video (when a programme
// still has one), a minute with only the Finalist's name on the wall, every shot of a minute on the big
// screen (stage-tv, on air: the screenshots, no beats: room, tv, tv-close; a change of screenshot halfway
// through its cross-fade and push in; a one-screenshot minute's default push in; host when beats ask),
// the hash check on the wall, the launch terminal, the verdict card with its «Против» line, an envelope
// opening, the final screen. Renders each at 1920×1080 without and with ?cams=1, and at 1600×1000 (a
// window of another shape: the frame letterboxes). Under ?cams=1 every visible text element of the 2D
// layer and every text box drawn on the dispatch wall (projected to the frame) must keep clear of the
// two webcam circles (ui/safe.js); so must every shot before the debate (each cut swept) and every kind
// of shot of the operator's holds (?hold=1, stills of each); exit 1 otherwise, or on a console error.
import { createServer } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { extname, join, dirname, sep, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const STAGE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SITE_3D = join(dirname(STAGE), "site", "assets", "3d");
const argv = process.argv.slice(2);
const opt = (k, d) => argv.flatMap((a, i) => (a === `--${k}` ? [argv[i + 1]] : []))[0] ?? d;
const programUrl = opt("program", "test/program/fixture/program.json");
const replayUrl = opt("replay", "test/replays/real-live-probe-20261021b.jsonl");
const out = resolve(opt("out", join(STAGE, "out", "v7-subtitles")));
const sweepOnly = argv.includes("--sweep-only"); // only part 3: every programme and hold shot under ?cams=1

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
  ".json": "application/json", ".jsonl": "application/x-ndjson", ".woff2": "font/woff2", ".svg": "image/svg+xml", ".glb": "model/gltf-binary", ".mp4": "video/mp4", ".mp3": "audio/mpeg" };
const server = createServer(async (req, res) => {
  if (req.url === "/favicon.ico") return res.writeHead(204).end();
  try {
    const url = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (url.startsWith("/run/")) return res.writeHead(502).end();
    const [root, rest] = url.startsWith("/vendor/three/") ? [join(SITE_3D, "three"), url.slice(14)]
      : url.startsWith("/vendor/mine/") ? [SITE_3D, url.slice(13)] : [STAGE, url.slice(1)];
    const path = resolve(root, rest);
    if (!path.startsWith(root + sep)) throw new Error("outside root");
    const body = await readFile(path), headers = { "content-type": TYPES[extname(path)] || "application/octet-stream", "accept-ranges": "bytes" };
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
    if (!m || !(m[1] || m[2])) return res.writeHead(200, headers).end(body);
    const a = m[1] ? Number(m[1]) : Math.max(0, body.length - Number(m[2])), b = m[1] && m[2] ? Math.min(Number(m[2]), body.length - 1) : body.length - 1;
    res.writeHead(206, { ...headers, "content-range": `bytes ${a}-${b}/${body.length}` }).end(body.subarray(a, b + 1));
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
tab.on("console", (m) => (m.type() === "error" ? errors.push(m.text()) : m.type() === "warning" && console.log("  [warn]", m.text())));
tab.on("pageerror", (e) => errors.push(e.message));
await mkdir(out, { recursive: true });
let failed = false;
const expect = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failed = true;
};

async function open(extra = []) {
  const q = [`program=${programUrl}`, `replay=${replayUrl}`, "voice=estimate", "t=0", ...extra].join("&");
  await tab.goto(`${base}/show.html?${q}`);
  await tab.waitForFunction(() => window.__stage?.ready === true, null, { timeout: 240000 });
}

// ---- in the page: what is on screen
const PAGE = {
  // the subtitles' look and speaker, the cards on screen
  state: () => {
    const on = (el) => {
      for (let e = el; e && e.id !== "overlay"; e = e.parentElement) {
        const cs = getComputedStyle(e);
        if (cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) < 0.05) return false;
      }
      return true;
    };
    const q = (s) => [...document.querySelectorAll(s)].some((e) => on(e) && e.offsetWidth);
    const say = document.querySelector(".say");
    return {
      subs: window.__program.subs.shown,
      vendor: say && on(say) && say.childElementCount ? [...say.classList].find((c) => /say-(anthropic|openai)/.test(c)) : null,
      shot: window.__frame.stage.camera.shotAt(window.__stageT ?? 0),
      verdict: q(".cd-verdict"), against: q(".cd-v-against"), envOpening: q(".cd-env-opening"), env: q(".cd-env"), final: q(".cd-final"),
      video: !!window.__program.vt.onScreen, minute: q(".cd-minute"), banner: q(".cd-banner"), // stage-tv: the big screen
    };
  },
  // every visible text box (frame px) of the 2D layer and of the wall
  boxes: () => {
    const ov = document.getElementById("overlay"), o = ov.getBoundingClientRect(), fit = o.width / 1920;
    const on = (el) => {
      for (let e = el; e && e !== ov.parentElement; e = e.parentElement) {
        const cs = getComputedStyle(e);
        if (cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) < 0.02) return false;
      }
      return true;
    };
    const out = [];
    const walker = document.createTreeWalker(ov, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (!n.textContent.trim() || !on(n.parentElement)) continue;
      const r = document.createRange();
      r.selectNodeContents(n);
      for (const b of r.getClientRects()) {
        if (b.width < 1 || b.height < 1) continue;
        out.push({ where: "2d", cls: n.parentElement.className, text: n.textContent.trim().slice(0, 40), left: (b.left - o.left) / fit, top: (b.top - o.top) / fit, right: (b.right - o.left) / fit, bottom: (b.bottom - o.top) / fit });
      }
    }
    for (const b of window.__program.wallText()) if (!b.behind && b.right > 0 && b.left < 1920 && b.bottom > 0 && b.top < 1080) out.push({ where: "wall", cls: "wall", ...b, text: b.text.slice(0, 40) });
    return { boxes: out, fit, ov: [o.left, o.top, o.width, o.height] };
  },
};
const seek = (t) => tab.evaluate(async (t) => ((window.__stageT = t), await window.__stage.seek(t)), t);
const state = () => tab.evaluate(PAGE.state);

// ---- 1) the moments, found in the plan (1920×1080, no cams)
await open();
const plan = await tab.evaluate(() => ({
  duration: window.__frame.duration, marks: window.__program.marks, segs: window.__program.segments,
  vt: window.__program.vt.items,
  cuts: window.__frame.stage.camera.list(),
  minuteShots: window.__program.minuteShots, // stage-tv
}));
const mark = (id) => plan.marks.find((m) => m.id === id)?.from;
const D = mark("debate");
console.log(`duration ${plan.duration} s, debate from ${D}`);
async function scan(from, to, step, pred, label) {
  for (let t = from; t < to; t += step) {
    const r = Math.round(t * 100) / 100;
    await seek(r);
    const s = await state();
    if (pred(s)) return console.log(`  ${label}: t=${r}`), r;
  }
  console.log(`  ${label}: not found in ${from}…${to}`);
  return null;
}
const moments = [];
if (!sweepOnly) {
const vtItem = plan.vt.find((v) => v.kind === "video");
if (vtItem) moments.push(["minute-video", Math.round((vtItem.start + 21.5) * 100) / 100]);
// stage-tv: a minute of four screenshots, each shot kind at its first use (room 2.5 s in, the screen
// faded in; a cut 1.2 s after it, a move 0.8 s after it lands), its first change of screenshot halfway
// through the cross-fade (the push in under way); a one-screenshot minute's default push in landed; a
// host shot only when a programme still has beats
{
  const r2 = (x) => Math.round(x * 100) / 100;
  const teamAt = (t) => plan.segs.find((s) => s.kind === "finalist" && s.from <= t && t < s.to)?.team;
  const four = plan.vt.filter((v) => v.kind === "stills").sort((a, b) => b.changes.length - a.changes.length)[0];
  const team = four && teamAt(four.from);
  const at = (sh) => r2(sh.t + (sh === plan.minuteShots.find((x) => x.team === sh.team) ? 2.5 : (sh.move ?? 0) + (sh.move ? 0.8 : 1.2)));
  for (const kind of ["room", "tv", "tv-close", "host"]) {
    const sh = plan.minuteShots.find((s) => s.team === team && s.shot === kind) ?? (kind === "host" ? plan.minuteShots.find((s) => s.shot === kind) : null);
    if (sh) moments.push([`tv-${kind}`, at(sh)]);
  }
  if (four?.changes.length) moments.push(["tv-stills-fade", r2(four.changes[0] + 1.6 / 2)]);
  const one = plan.vt.find((v) => v.kind === "stills" && v.n === 1);
  const oneClose = one && plan.minuteShots.find((s) => s.team === teamAt(one.from) && s.shot === "tv-close");
  if (oneClose) moments.push(["tv-default-close", at(oneClose)]);
}
const wallMinute = plan.segs.find((s) => s.kind === "finalist" && !plan.vt.some((v) => v.from >= s.from && v.from < s.to));
if (wallMinute) moments.push(["minute-wall", await scan(wallMinute.from + 8, wallMinute.to, 0.5, (s) => s.minute && s.subs, "minute on the wall")]);
const l0 = mark("launch:started");
if (l0 != null) moments.push(["launch", Math.round((l0 + 2) * 100) / 100]); // the wall's terminal, the run started
const h0 = mark("intro:hashes");
if (h0 != null) moments.push(["hashes", Math.round((h0 + 3.6) * 100) / 100]);
// every framing of the dispatch wall before the debate, a second into its first cut (the hash check, the minutes)
for (const name of ["wall", "compare", "compare2", "visual"]) {
  const c = plan.cuts.find((x) => x.name === name && x.t < D);
  if (c) moments.push([`wall-${name}`, Math.round((c.t + 1.2) * 100) / 100]);
}
moments.push(["say-anthropic", await scan(D, plan.duration, 0.5, (s) => s.subs?.mode === "say" && s.vendor === "say-anthropic", "speech line, Anthropic")]);
moments.push(["say-openai", await scan(D, plan.duration, 0.5, (s) => s.subs?.mode === "say" && s.vendor === "say-openai", "speech line, OpenAI")]);
const bFrom = await scan(D, plan.duration, 0.5, (s) => s.subs?.mode === "bar" && s.subs.id !== "host", "bottom bar, a Judge off its own shot");
moments.push(["bar-judge", bFrom == null ? null : bFrom + 1.0]);
const vFrom = await scan(D, plan.duration, 1, (s) => s.against, "verdict card with «Против»");
moments.push(["verdict", vFrom == null ? null : vFrom + 1.5]);
const eFrom = await scan(D, plan.duration, 0.5, (s) => s.envOpening, "envelope opening");
moments.push(["envelope", eFrom == null ? null : eFrom + 1.5]);
moments.push(["final", plan.duration - 2]);
}
const shots = moments.filter(([, t]) => t != null);
if (!sweepOnly) expect(shots.length === moments.length, `every moment found (${shots.map(([n]) => n).join(", ")})`);

// ---- 2) the stills and the cam-zone check
const CONFIGS = [
  { name: "1920", size: [1920, 1080], q: [] },
  { name: "1920-cams", size: [1920, 1080], q: ["cams=1"], cams: true },
  { name: "1600x1000-cams", size: [1600, 1000], q: ["cams=1"], cams: true },
];
const R = 150, C = [[190, 190], [1730, 190]]; // ui/safe.js: 300 px circles 40 px from the edges
const hits = (b) => C.some(([cx, cy]) => {
  const x = Math.max(b.left, Math.min(cx, b.right)), y = Math.max(b.top, Math.min(cy, b.bottom));
  return (x - cx) ** 2 + (y - cy) ** 2 < R * R;
});
const report = [];
for (const cf of sweepOnly ? [] : CONFIGS) {
  await tab.setViewportSize({ width: cf.size[0], height: cf.size[1] });
  await open(cf.q);
  for (const [name, t] of shots) {
    await seek(t);
    const file = join(out, `${name}-${cf.name}.png`);
    if (cf.cams) {
      // the circles drawn over the still, as OBS will composite them (only in the picture, not in the check)
      await tab.evaluate(() => {
        const ov = document.getElementById("overlay");
        for (const x of [40, 1580]) {
          const d = document.createElement("div");
          d.className = "__cam";
          Object.assign(d.style, { position: "absolute", left: `${x}px`, top: "40px", width: "300px", height: "300px", borderRadius: "50%", background: "rgba(90, 140, 200, 0.55)", boxShadow: "0 0 0 4px #fff", zIndex: 99 });
          ov.append(d);
        }
      });
    }
    await tab.screenshot({ path: file });
    await tab.evaluate(() => document.querySelectorAll(".__cam").forEach((e) => e.remove()));
    const s = await state();
    const { boxes, fit, ov } = await tab.evaluate(PAGE.boxes);
    const bad = cf.cams ? boxes.filter(hits) : [];
    // the frame is whole in the window: letterboxed, never cropped
    const whole = ov[0] >= -0.5 && ov[1] >= -0.5 && ov[0] + ov[2] <= cf.size[0] + 0.5 && ov[1] + ov[3] <= cf.size[1] + 0.5;
    report.push({ config: cf.name, name, t, file, subs: s.subs?.mode ?? null, text: boxes.length, wall: boxes.filter((b) => b.where === "wall").length, bad: bad.map((b) => `${b.where}:${b.cls}:«${b.text}» [${[b.left, b.top, b.right, b.bottom].map(Math.round).join(",")}]`), fit: Math.round(fit * 1000) / 1000, whole });
    console.log(`${cf.name.padEnd(15)} ${name.padEnd(14)} t=${String(t).padEnd(8)} subs=${String(s.subs?.mode ?? "-").padEnd(4)} text boxes ${boxes.length} (wall ${boxes.filter((b) => b.where === "wall").length})${cf.cams ? `  under the cams: ${bad.length}` : ""}  fit ${fit.toFixed(3)}${whole ? "" : "  CROPPED"}`);
    for (const b of bad) console.log(`      ${b.where} ${b.cls} «${b.text}» [${[b.left, b.top, b.right, b.bottom].map(Math.round).join(", ")}]`);
    if (bad.length) failed = true;
    if (!whole) failed = true;
  }
}
// ---- 3) ?cams=1, every shot before the debate (a second into each cut, the end of each move) and, with
// ?hold=1, every kind of shot of the operator's holds (after the intro, after a minute with its
// screenshots, after one with only the name, after a video's when a programme still has one): no text
// box on the wall or in the 2D layer under the circles
await tab.setViewportSize({ width: 1920, height: 1080 });
const sweep = [];
async function sweepCuts(label, cuts, still) {
  const seen = new Set();
  for (const c of cuts) {
    await seek(c.at);
    const { boxes } = await tab.evaluate(PAGE.boxes);
    const bad = boxes.filter(hits);
    const kind = `${c.kind}${c.name ? ":" + c.name : ""}`;
    let file = null;
    if (still && !seen.has(`${c.where}|${kind}`)) {
      seen.add(`${c.where}|${kind}`);
      file = join(out, `${c.where}-${kind.replace(":", "-")}-1920-cams.png`);
      await tab.screenshot({ path: file });
    }
    sweep.push({ label, where: c.where, t: c.at, kind, wall: boxes.filter((b) => b.where === "wall").length, file, bad: bad.map((b) => `${b.where}:${b.cls}:«${b.text}» [${[b.left, b.top, b.right, b.bottom].map(Math.round).join(",")}]`) });
    if (bad.length) {
      failed = true;
      console.log(`FAIL ${label} ${c.where} ${kind} t=${c.at}: ${bad.length} under the cams`);
      for (const b of bad) console.log(`      ${b.where} ${b.cls} «${b.text}» [${[b.left, b.top, b.right, b.bottom].map(Math.round).join(", ")}]`);
    }
  }
}
const cutTimes = (list, from, to) => list.filter((c) => c.t >= from && c.t < to).map((c, i, a) => {
  const next = a[i + 1]?.t ?? to;
  return { ...c, at: Math.round(Math.min(c.t + Math.max(1.0, c.move ?? 0), (c.t + next) / 2) * 100) / 100 };
});
await open(["cams=1"]);
{
  const list = await tab.evaluate(() => window.__frame.stage.camera.list());
  const segs = plan.segs;
  const where = (t) => segs.filter((s) => s.from <= t).at(-1)?.id ?? "title";
  const cuts = cutTimes(list, 0, D).map((c) => ({ ...c, where: where(c.t) }));
  await sweepCuts("programme", cuts, false);
  console.log(`programme sweep (?cams=1): ${cuts.length} cuts before the debate, ${sweep.filter((x) => x.bad.length).length} with text under the cams`);
}
await open(["cams=1", "hold=1"]);
{
  const h = await tab.evaluate(() => ({ list: window.__frame.stage.camera.list(), segs: window.__program.segments, vt: window.__program.vt.items }));
  const holds = h.segs.filter((s) => s.hold);
  const tvOf = (s, kind) => h.vt.some((v) => v.kind === kind && v.from >= s.from && v.from < s.to);
  const video = holds.find((s) => s.kind === "finalist" && tvOf(s, "video"));
  const stills = holds.find((s) => s.kind === "finalist" && tvOf(s, "stills")); // stage-tv
  const plain = holds.find((s) => s.kind === "finalist" && !tvOf(s, "video") && !tvOf(s, "stills"));
  const picked = [holds.find((s) => s.kind === "intro"), video, stills, plain].filter(Boolean);
  const before = sweep.length;
  for (const s of picked) {
    const cuts = cutTimes(h.list, s.hold.from, s.hold.from + 60).map((c) => ({ ...c, where: `hold-${s.id}` }));
    await sweepCuts("hold", cuts, true);
  }
  const mine = sweep.slice(before);
  console.log(`hold sweep (?cams=1&hold=1): ${picked.map((s) => s.id).join(", ")}: ${mine.length} cuts (${[...new Set(mine.map((x) => x.kind))].join(", ")}), ${mine.filter((x) => x.bad.length).length} with text under the cams`);
  expect(picked.length >= 3 && mine.length >= 8, `the holds after the intro, a screenshot minute, a name minute (and a video minute when there is one) are swept (${picked.length})`);
}
expect(sweep.every((x) => !x.bad.length), "?cams=1: no text under the circles in any programme or hold shot");

await writeFile(join(out, "safe-check.json"), JSON.stringify({ programUrl, replayUrl, moments, report, sweep }, null, 1));
if (!sweepOnly) {
  expect(report.filter((r) => r.config.includes("cams")).every((r) => !r.bad.length), "?cams=1: no text box under the webcam circles");
  expect(report.every((r) => r.whole), "every window shows the whole frame (letterboxed)");
}
console.log(errors.length ? `console errors (${errors.length}):\n  ${errors.join("\n  ")}` : "console errors: 0");
if (errors.length) failed = true;
await browser.close();
server.close();
process.exit(failed ? 1 : 0);
