// Headless checks of idle.html (the broadcast's live background) on the real GPU (Metal), one browser:
//   node contest/stage/test/idle-check.mjs [--program <dir with program.json>] [--out <dir>] [--only soon,host,...]
// For every mode (soon, host, break, end): 1920×1080 stills at three times across the camera's loop and
// at its wrap (t = LOOP_S − 0.1 and t = 0.1: the wrap's jump must be no larger than an ordinary 0.2 s step
// at the same place of the loop); the countdown at two times and after zero; mode=end: no text under the
// cams' circles (ui/safe.js) in any still; mode=host: no text in the camera's rect, the plaque under it at
// x=100. Live (no ?t=): no audio (no <audio>/<video>, no AudioContext, no audio or TTS request), the frame
// rate capped at 30. Bench: ms per frame (GPU-synced, lib/clock.js bench), the median of 4 times ≤ 20.
// Zero console errors throughout. Stills go to contest/stage/out/idle/.
// GPU checks run one at a time on the Mac: take /tmp/openegiz-stage-gpu.lock around this script.
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
const PROGRAM = resolve(opt("program", join(STAGE, "test", "program", "fixture")));
const OUT = resolve(opt("out", join(STAGE, "out", "idle")));
const ONLY = opt("only", "soon,host,break,end").split(",");
const AT = "2026-10-31T15:00:00+05:00";

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
  throw new Error("playwright-core not found: npm i -g playwright-core, or set PLAYWRIGHT_CORE to its folder");
}

// the routes of server.py: the Stage, three, and /program/ → the programme's folder
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".png": "image/png", ".jpg": "image/jpeg",
  ".json": "application/json", ".woff2": "font/woff2", ".svg": "image/svg+xml", ".glb": "model/gltf-binary", ".mp3": "audio/mpeg" };
const server = createServer(async (req, res) => {
  if (req.url === "/favicon.ico") return res.writeHead(204).end();
  try {
    const url = decodeURIComponent(new URL(req.url, "http://x").pathname);
    const [root, rest] = url.startsWith("/vendor/three/") ? [join(SITE_3D, "three"), url.slice(14)]
      : url.startsWith("/vendor/mine/") ? [SITE_3D, url.slice(13)]
      : url.startsWith("/program/") ? [PROGRAM, url.slice(9)] : [STAGE, url.slice(1)];
    const path = resolve(root, rest);
    if (!path.startsWith(root + sep)) throw new Error("outside root");
    res.writeHead(200, { "content-type": TYPES[extname(path)] || "application/octet-stream", "cache-control": "no-store" }).end(await readFile(path));
  } catch {
    res.writeHead(404).end();
  }
}).listen(0);
const base = `http://localhost:${server.address().port}`;

const { chromium } = playwright();
const browser = await chromium.launch({
  channel: process.env.CHROME ? undefined : "chrome",
  executablePath: process.env.CHROME,
  args: ["--headless=new", "--ignore-gpu-blocklist", "--enable-gpu", "--use-angle=metal", "--autoplay-policy=no-user-gesture-required"],
});
const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
// count every way a page could make sound
await ctx.addInitScript(() => {
  window.__audioMade = 0;
  for (const k of ["AudioContext", "webkitAudioContext", "OfflineAudioContext"]) {
    const C = window[k];
    if (C) window[k] = class extends C { constructor(...a) { super(...a); window.__audioMade++; } };
  }
  const A = window.Audio;
  window.Audio = function (...a) { window.__audioMade++; return new A(...a); };
});
const tab = await ctx.newPage();
const errors = [], audioRequests = [];
tab.on("console", (m) => m.type() === "error" && errors.push(`${m.text()} (${m.location()?.url ?? ""})`));
tab.on("pageerror", (e) => errors.push(e.message));
tab.on("request", (r) => {
  const u = r.url();
  if (/\.(mp3|wav|ogg|m4a|aac|opus|flac)(\?|$)/i.test(u) || /\/synth\b|:8790\//.test(u) || r.resourceType() === "media") audioRequests.push(u);
});

let failed = false;
const results = [];
const expect = (ok, what) => {
  results.push({ ok: !!ok, what });
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failed = true;
};
await mkdir(OUT, { recursive: true });

const url = (query) => `${base}/idle.html?${query}`;
async function open(query) {
  await tab.goto(url(query));
  await tab.waitForFunction(() => window.__stage?.ready === true, null, { timeout: 120000 });
}
async function still(query, name) {
  await open(query);
  const file = join(OUT, `${name}.png`);
  const png = await tab.screenshot({ path: file });
  const boxes = await tab.evaluate(() => window.__idle.textBoxes());
  // the 3D alone (the 2D layer hidden): the loop's seam is measured on it, the countdown's numbers aside
  await tab.evaluate(() => (document.getElementById("overlay").style.visibility = "hidden"));
  const world = await tab.screenshot();
  await tab.evaluate(() => (document.getElementById("overlay").style.visibility = ""));
  return { file, png, world, boxes };
}
// mean absolute difference of two stills (0..255), on a 240×135 grey copy (the film grain averaged out)
async function diff(a, b) {
  return tab.evaluate(async ([x, y]) => {
    const grey = async (b64) => {
      const img = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
      const c = new OffscreenCanvas(240, 135), g = c.getContext("2d");
      g.drawImage(img, 0, 0, 240, 135);
      const d = g.getImageData(0, 0, 240, 135).data, out = new Float32Array(240 * 135);
      for (let i = 0; i < out.length; i++) out[i] = 0.2126 * d[4 * i] + 0.7152 * d[4 * i + 1] + 0.0722 * d[4 * i + 2];
      return out;
    };
    const [p, q] = await Promise.all([grey(x), grey(y)]);
    let s = 0;
    for (let i = 0; i < p.length; i++) s += Math.abs(p[i] - q[i]);
    return s / p.length;
  }, [a.toString("base64"), b.toString("base64")]);
}
const hit = (boxes) => tab.evaluate((b) => window.__idle.hitsCams(b), boxes);
const inRect = (b, r) => b.right > r.x && b.left < r.x + r.w && b.bottom > r.y && b.top < r.y + r.h;

const MODES = {
  soon: `mode=soon&at=${encodeURIComponent(AT)}&now=${encodeURIComponent("2026-10-31T14:52:40+05:00")}`,
  host: `mode=host&name=${encodeURIComponent("Алихан Амирханов")}&role=${encodeURIComponent("Соведущий")}`,
  break: "mode=break",
  end: "mode=end",
};
await open(`${MODES.break}&t=0`);
const LOOP = await tab.evaluate(() => window.__idle.LOOP_S);
const CAM_RECT = await tab.evaluate(() => window.__idle.CAM_RECT);
const TIMES = [0.18, 0.47, 0.76].map((k) => Math.round(LOOP * k * 10) / 10);
const report = { loop: LOOP, modes: {}, countdown: [], bench: {} };

for (const mode of Object.keys(MODES).filter((m) => ONLY.includes(m))) {
  const r = (report.modes[mode] = { stills: [], wrap: null });
  const shots = {};
  for (const t of [...TIMES, LOOP - 0.1, 0.1, 0.3]) {
    const s = await still(`${MODES[mode]}&t=${t}`, `${mode}-t${t}`);
    shots[t] = s;
    r.stills.push(s.file);
    if (mode === "end") {
      const under = await hit(s.boxes);
      expect(!under.length, `end t=${t}: no text under the cams' circles${under.length ? `: ${under.map((b) => b.text).join(" | ")}` : ""}`);
    }
    if (mode === "host") {
      const inside = s.boxes.filter((b) => b.src === "2d" && inRect(b, CAM_RECT)); // the room's own wall may pass behind it
      expect(!inside.length, `host t=${t}: no 2D text in the camera's rect${inside.length ? `: ${inside.map((b) => b.text).join(" | ")}` : ""}`);
    }
  }
  // the wrap: t = LOOP − 0.1 → t = 0.1 is no bigger a jump than 0.1 → 0.3 (the same 0.2 s of the loop)
  const jump = await diff(shots[LOOP - 0.1].world, shots[0.1].world), step = await diff(shots[0.1].world, shots[0.3].world);
  r.wrap = { jump: +jump.toFixed(2), step: +step.toFixed(2) };
  expect(jump <= Math.max(1.5 * step, step + 1.5), `${mode}: the loop's wrap is seamless (the 3D: jump ${jump.toFixed(2)} vs a 0.2 s step ${step.toFixed(2)}, mean |Δluma| on 240×135)`);
  if (mode === "host") {
    const p = await tab.evaluate(() => {
      const b = document.querySelector(".id-plaque").getBoundingClientRect();
      return { left: b.left, top: b.top, bottom: b.bottom, name: document.querySelector(".id-plaque-name").textContent, role: document.querySelector(".id-plaque-role").textContent };
    });
    r.plaque = p;
    expect(Math.abs(p.left - 100) < 1 && p.top >= CAM_RECT.y + CAM_RECT.h + 10 && p.top <= 850 && p.bottom <= 1040, `host: the plaque under the camera at x=100, top ${p.top} («${p.name}», «${p.role}»)`);
    await open("mode=host&t=5");
    const d = await tab.evaluate(() => [document.querySelector(".id-plaque-name").textContent, document.querySelector(".id-plaque-role").textContent]);
    expect(d[0] === "Алихан Амирханов" && d[1] === "Соведущий", `host: defaults without name/role (${d.join(", ")})`);
  }
}

// the countdown: two times, and after zero
if (ONLY.includes("soon")) {
  for (const [now, t, want] of [["2026-10-31T14:52:40+05:00", 10, "07:10"], ["2026-10-31T13:30:00+05:00", 5, "01:29:55"], ["2026-10-31T14:59:50+05:00", 12, "Начинаем"]]) {
    const name = `soon-countdown-${want.replace(/:/g, "")}`;
    await still(`mode=soon&at=${encodeURIComponent(AT)}&now=${encodeURIComponent(now)}&t=${t}`, name);
    const got = await tab.evaluate(() => [document.querySelector(".id-count-digits")?.textContent, getComputedStyle(document.querySelector(".id-count-label")).display]);
    report.countdown.push({ now, t, got: got[0], file: join(OUT, `${name}.png`) });
    expect(got[0] === want && (want === "Начинаем") === (got[1] === "none"), `soon: ${now} + ${t} s shows «${got[0]}» (want «${want}»)`);
  }
}

// live: no audio, ≤ 30 fps, no errors, for each mode; and the bench
for (const mode of Object.keys(MODES).filter((m) => ONLY.includes(m))) {
  await tab.goto(url(MODES[mode].replace(/&now=[^&]+/, "")));
  await tab.waitForFunction(() => window.__stage?.ready === true, null, { timeout: 120000 });
  const fps = await tab.evaluate(async () => {
    const n0 = window.__idle.frames, t0 = performance.now();
    await new Promise((r) => setTimeout(r, 3000));
    return ((window.__idle.frames - n0) * 1000) / (performance.now() - t0);
  });
  const a = await tab.evaluate(() => ({ made: window.__audioMade, media: document.querySelectorAll("audio, video").length }));
  expect(fps <= 31, `${mode} live: ${fps.toFixed(1)} frames/s (cap 30)`);
  expect(!a.made && !a.media, `${mode} live: no audio (AudioContext/Audio made: ${a.made}, <audio>/<video>: ${a.media})`);
  const ms = [];
  for (const t of [0.12, 0.37, 0.62, 0.87].map((k) => k * LOOP)) {
    await open(`${MODES[mode]}&t=${t.toFixed(1)}`);
    ms.push((await tab.evaluate(() => window.__stage.bench(120))).msPerFrame);
  }
  ms.sort((x, y) => x - y);
  const median = (ms[1] + ms[2]) / 2;
  report.bench[mode] = { median: +median.toFixed(2), max: +ms[3].toFixed(2), all: ms.map((x) => +x.toFixed(2)) };
  expect(median <= 20, `${mode} bench: median ${median.toFixed(2)} ms/frame (max ${ms[3].toFixed(2)}) at 1920×1080`);
}
const gpu = await tab.evaluate(() => window.__stage.info.gpu);
expect(!/swiftshader|llvmpipe|software/i.test(gpu), `GPU: ${gpu}`);
expect(!audioRequests.length, `no audio or TTS request${audioRequests.length ? `: ${audioRequests.join(", ")}` : ""}`);
expect(!errors.length, `0 console errors${errors.length ? `:\n  ${errors.join("\n  ")}` : ""}`);
report.results = results;
await writeFile(join(OUT, "idle-check.json"), JSON.stringify(report, null, 2));
console.log(`report: ${join(OUT, "idle-check.json")}`);
await browser.close();
server.close();
process.exit(failed ? 1 : 0);
