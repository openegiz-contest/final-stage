// Record ~60 s of a Finalist's working Stand for the preshow: the main screen, one action its README
// describes, the result. One take, no editing: whatever the Stand shows (slow, broken) is in the video.
//
//   node contest/stage/tools/record_stand.mjs team-041 --out /tmp/stand-videos \
//        [--proxy socks5://127.0.0.1:1041] [--sh "<wrapper> sh team-041"] \
//        [--plans contest/stage/tools/record_stand.plans.json] [--seconds 60] [--no-warm]
//
// Usually run through a private wrapper script (not published), which opens the tunnel
// and passes --proxy and --sh. --proxy: a SOCKS5 proxy whose connections leave inside the Stand's VM,
// so http://localhost:<port> in a plan is the Stand's own localhost (loopback goes through it too).
//
// Output (the interface the Stage consumes): <out>/<team>.mp4, H.264 High, 1920×1080, 30 fps CFR,
// exactly --seconds long, no audio, yuv420p, +faststart, ≤ ~15 MB; and <out>/<team>.json (what each
// plan step did, timings, and per step "box": {x,y,w,h} of its element in frame px, or null;
// top-level "frame": {w,h}). Exit 1 if the page never loaded or encoding failed; a step that fails
// (no such button) is logged and the recording goes on.
//
// The plan (record_stand.plans.json, keyed by team) comes from the Solution's README:
//   { "readme": "where in the README this comes from", "url": "http://localhost:8088",
//     "steps": [ {"at": 14, "click": "text=Сценарии"},            Playwright selector; the pointer glides there
//                {"at": 20, "sh": "cd ~/solution && make storm"}, a README command in the VM (needs --sh)
//                {"at": 34, "goto": "http://localhost:3000/d/x"}, {"at": 40, "scroll": 500},
//                {"at": 42, "fill": ["#q", "text"]}, {"at": 43, "press": "Enter"}, {"at": 44, "hover": "css"} ] }
// `at` is seconds from the start of the take (the main URL starts loading at 0). Steps run in order.
// "cleanup": steps of the same kind run after the take, off camera (cancel the scenario it started).
// A team without a plan gets the main URL only if --url is given.
// Before the take the page is loaded once untimed (--no-warm skips it) so the take starts from the
// browser's cache, the way a viewer's second visit would.
import { execFileSync, spawn } from "node:child_process";
import { mkdir, writeFile, readFile, rm, mkdtemp } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { stepBox } from "./record_stand.box.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const W = 1920, H = 1080, FPS = 30;

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

const argv = process.argv.slice(2);
const team = argv[0];
const opt = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i > 0 ? argv[i + 1] : d;
};
if (!/^team-\d{3}$/.test(team || "")) {
  console.error("usage: record_stand.mjs team-NNN --out DIR [--proxy socks5://host:port] [--sh CMD] [--plans FILE] [--url URL] [--seconds 60] [--no-warm]");
  process.exit(2);
}
const OUT = resolve(opt("out", "/tmp/stand-videos"));
const SECONDS = Number(opt("seconds", 60));
const proxy = opt("proxy");
const shPrefix = opt("sh");
const plans = JSON.parse(await readFile(resolve(opt("plans", join(HERE, "record_stand.plans.json"))), "utf8"));
const plan = plans[team] || (opt("url") ? { url: opt("url"), steps: [] } : null);
if (!plan) throw new Error(`no plan for ${team} in the plans file, and no --url`);
if (opt("url")) plan.url = opt("url");

// A visible pointer: headless Chrome draws none, and the viewer should see what is clicked.
const POINTER = `(() => {
  const add = () => {
    if (document.getElementById("__rs_ptr")) return;
    const d = document.createElement("div");
    d.id = "__rs_ptr";
    d.style.cssText = "position:fixed;left:-40px;top:-40px;width:22px;height:22px;margin:-11px 0 0 -11px;border-radius:50%;" +
      "background:rgba(255,255,255,.85);border:3px solid #ff3b30;box-shadow:0 0 0 2px rgba(0,0,0,.35);z-index:2147483647;" +
      "pointer-events:none;transition:transform .12s";
    document.documentElement.appendChild(d);
    addEventListener("mousemove", (e) => { d.style.left = e.clientX + "px"; d.style.top = e.clientY + "px"; }, true);
    addEventListener("mousedown", () => { d.style.transform = "scale(1.8)"; }, true);
    addEventListener("mouseup", () => { d.style.transform = "scale(1)"; }, true);
  };
  if (document.documentElement) add(); else addEventListener("DOMContentLoaded", add);
})();`;

const { chromium } = playwright();
const args = ["--headless=new", "--ignore-gpu-blocklist", "--enable-gpu", "--use-angle=metal", "--hide-scrollbars"];
if (proxy) args.push(`--proxy-server=${proxy}`, "--proxy-bypass-list=<-loopback>");
const browser = await chromium.launch({ channel: process.env.CHROME ? undefined : "chrome", executablePath: process.env.CHROME, args });
const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1, ignoreHTTPSErrors: true, locale: "ru-RU" });
await ctx.addInitScript(POINTER);
const page = await ctx.newPage();
// Frame = viewport at deviceScaleFactor 1 (screencast maxWidth W): CSS px are frame px, no offset.
const FRAME_MAP = { scale: 1, dx: 0, dy: 0 };
const log = { team, frame: { w: W, h: H }, url: plan.url, readme: plan.readme || "", seconds: SECONDS, proxy: proxy || null, started: new Date().toISOString(), steps: [], console_errors: [] };
page.on("console", (m) => m.type() === "error" && log.console_errors.length < 30 && log.console_errors.push(m.text().slice(0, 300)));
page.on("pageerror", (e) => log.console_errors.length < 30 && log.console_errors.push(String(e).slice(0, 300)));

if (!argv.includes("--no-warm")) {
  const t0 = Date.now();
  try {
    await page.goto(plan.url, { waitUntil: "load", timeout: 90_000 });
    await page.waitForTimeout(5000);
    log.warm_s = (Date.now() - t0) / 1000;
  } catch (e) {
    log.warm_error = String(e).slice(0, 300);
  }
  await page.goto("about:blank");
}

// The take: screencast frames (sent when the picture changes) with their timestamps.
const frames = [];
const dir = await mkdtemp(join(tmpdir(), `record-stand-${team}-`));
const cdp = await ctx.newCDPSession(page);
let n = 0;
cdp.on("Page.screencastFrame", async ({ data, metadata, sessionId }) => {
  const f = join(dir, `f${String(n++).padStart(6, "0")}.jpg`);
  frames.push({ f, t: metadata.timestamp, write: writeFile(f, Buffer.from(data, "base64")) });
  cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
});
await cdp.send("Page.startScreencast", { format: "jpeg", quality: 88, maxWidth: W, maxHeight: H, everyNthFrame: 1 });
const T0 = Date.now() / 1000;
const el = () => Date.now() / 1000 - T0;

let loaded = false;
const nav = page.goto(plan.url, { waitUntil: "load", timeout: SECONDS * 1000 })
  .then(() => { loaded = true; log.load_s = +el().toFixed(2); })
  .catch((e) => { log.load_error = String(e).slice(0, 300); });

async function glide(locator) {
  const box = await locator.boundingBox({ timeout: 5000 });
  if (!box) throw new Error("not visible");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 20 });
  await page.waitForTimeout(250);
}

const pending = [];
async function runStep(i, s, rec) {
  // Where the acted element is, right before the action (the montage zooms onto it); null if none.
  rec.box = await stepBox((sel) => page.locator(sel).first(), s, FRAME_MAP);
  try {
    if (s.click) {
      const l = page.locator(s.click).first();
      await glide(l);
      await l.click({ timeout: 5000 });
    } else if (s.hover) await glide(page.locator(s.hover).first());
    else if (s.goto) await page.goto(s.goto, { waitUntil: "commit", timeout: 15000 });
    else if (s.scroll) await page.mouse.wheel(0, s.scroll);
    else if (s.fill) await page.locator(s.fill[0]).first().fill(s.fill[1], { timeout: 5000 });
    else if (s.press) await page.keyboard.press(s.press);
    else if (s.sh) {
      if (!shPrefix) throw new Error("sh step without --sh");
      // In the background: the take does not wait for a README command.
      pending.push(new Promise((res) => {
        const p = spawn("bash", ["-c", `${shPrefix} "$1"`, "sh", s.sh], { stdio: ["ignore", "pipe", "pipe"] });
        let out = "";
        p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (out += d));
        p.on("close", (code) => { rec.exit = code; rec.output = out.slice(-500); res(); });
      }));
    }
    rec.ok = true;
  } catch (e) {
    rec.ok = false;
    rec.error = String(e).split("\n")[0].slice(0, 300);
  }
}

for (const [i, s] of (plan.steps || []).entries()) {
  const wait = s.at - el();
  if (wait > 0) await page.waitForTimeout(wait * 1000);
  if (el() >= SECONDS - 0.5) break;
  const rec = { i, ...s, t: +el().toFixed(2) };
  await runStep(i, s, rec);
  rec.done_t = +el().toFixed(2);
  log.steps.push(rec);
}
const rest = SECONDS + 0.4 - el();
if (rest > 0) await page.waitForTimeout(rest * 1000);
await cdp.send("Page.stopScreencast").catch(() => {});
await Promise.race([nav, page.waitForTimeout(1000)]);
// Off camera: undo the action (cancel the scenario), so the hosts find the Stand as it was.
log.cleanup = [];
for (const [i, s] of (plan.cleanup || []).entries()) {
  const rec = { i, ...s };
  await runStep(i, s, rec);
  log.cleanup.push(rec);
  await page.waitForTimeout(1000);
}
await Promise.race([Promise.all(pending), page.waitForTimeout(15000)]);
await Promise.all(frames.map((x) => x.write));
await browser.close();
log.loaded = loaded;
log.frames = frames.length;

// Variable-rate frames → constant 30 fps: each frame lasts until the next one; the last fills the take.
let encoded = false;
if (frames.length) {
  const lines = ["ffconcat version 1.0"];
  for (let k = 0; k < frames.length; k++) {
    // A first frame that arrived after 0 s is shown from 0 s (the page was blank until then anyway).
    const start = k === 0 ? 0 : Math.max(frames[k].t, T0) - T0;
    const end = (k + 1 < frames.length ? Math.max(frames[k + 1].t, T0) - T0 : SECONDS + 0.2);
    lines.push(`file '${frames[k].f}'`, `duration ${Math.max(0.001, end - start).toFixed(4)}`);
  }
  lines.push(`file '${frames[frames.length - 1].f}'`);
  const list = join(dir, "frames.ffconcat");
  await writeFile(list, lines.join("\n") + "\n");
  await mkdir(OUT, { recursive: true });
  const mp4 = join(OUT, `${team}.mp4`);
  try {
    execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", list,
      "-vf", `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,fps=${FPS},scale=in_range=pc:out_range=tv,format=yuv420p`,
      "-c:v", "libx264", "-profile:v", "high", "-preset", "medium", "-crf", "22", "-maxrate", "1600k", "-bufsize", "3200k",
      "-g", String(FPS * 2), "-r", String(FPS), "-t", String(SECONDS), "-an", "-pix_fmt", "yuv420p", "-color_range", "tv", "-movflags", "+faststart", mp4], { stdio: "inherit" });
    encoded = true;
    log.mp4 = mp4;
  } catch (e) {
    log.encode_error = String(e).slice(0, 300);
  }
}
await rm(dir, { recursive: true, force: true });
log.finished = new Date().toISOString();
await mkdir(OUT, { recursive: true });
await writeFile(join(OUT, `${team}.json`), JSON.stringify(log, null, 2) + "\n");
const failed = log.steps.filter((s) => !s.ok).length;
console.log(`${team}: ${encoded ? log.mp4 : "NO VIDEO"}; loaded ${loaded ? `in ${log.load_s} s` : "NO"}; ${frames.length} frames; ` +
  `${log.steps.length - failed}/${log.steps.length} steps ok; ${log.console_errors.length} console errors`);
process.exit(encoded && loaded ? 0 : 1);
