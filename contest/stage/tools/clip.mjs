// A Stage page as a video on virtual time: one browser, every frame sought on the show clock
// (window.__stage.seek), screenshotted and piped to ffmpeg. Frame-exact and independent of how
// fast the machine renders.
//   node contest/stage/tools/clip.mjs <page> [--from 0] [--to 60] [--fps 30] [--out file.mp4]
//        [--gfx lite] [--query k=v] [--bitrate 6M] [--small 700k]
// Defaults: the whole page (window.__frame.duration when the page sets it), 30 fps, 6 Mbit/s H.264
// (what YouTube gets at 1080p30), contest/stage/out/<page>.mp4, plus <page>-360p.mp4 at 640×360 and
// --small bit/s (700k; --small 0 skips it): the phone check.
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { execFileSync, spawn } from "node:child_process";
import { basename, extname, join, dirname, sep, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const STAGE = dirname(dirname(fileURLToPath(import.meta.url)));
const SITE_3D = join(dirname(STAGE), "site", "assets", "3d");
const W = 1920, H = 1080;
const FFMPEG = process.env.FFMPEG || "/opt/homebrew/bin/ffmpeg";

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
const page = argv[0]?.startsWith("--") ? null : argv[0];
const opt = (k) => argv.flatMap((a, i) => (a === `--${k}` ? [argv[i + 1]] : []));
const PUB = opt("pub")[0] ? resolve(opt("pub")[0]) : null; // --pub DIR serves /pub/ (the Final Materials or the publication)
if (!page) throw new Error("usage: clip.mjs <page> [--from s] [--to s] [--fps n] [--out file] [--gfx lite] [--query k=v] [--bitrate 6M]");
const fps = Number(opt("fps")[0] || 30);
const from = Number(opt("from")[0] || 0);
const lite = opt("gfx")[0] === "lite";
const bitrate = opt("bitrate")[0] || "6M";
const small = opt("small")[0] || "700k";
const out = resolve(opt("out")[0] || join(STAGE, "out", `${basename(page, extname(page))}${lite ? "-lite" : ""}.mp4`));

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".png": "image/png",
  ".jpg": "image/jpeg", ".json": "application/json", ".woff2": "font/woff2", ".svg": "image/svg+xml", ".md": "text/plain; charset=utf-8", ".glb": "model/gltf-binary", ".mp4": "video/mp4" };
const server = createServer(async (req, res) => {
  if (req.url === "/favicon.ico") return res.writeHead(204).end();
  try {
    const url = decodeURIComponent(new URL(req.url, "http://x").pathname);
    const [root, rest] = url.startsWith("/vendor/three/") ? [join(SITE_3D, "three"), url.slice(14)]
      : url.startsWith("/vendor/mine/") ? [SITE_3D, url.slice(13)]
      : PUB && url.startsWith("/pub/") ? [PUB, url.slice(5)] : [STAGE, url.slice(1)];
    const path = resolve(root, rest);
    if (!path.startsWith(root + sep)) throw new Error("outside root");
    const body = await readFile(path), headers = { "content-type": TYPES[extname(path)] || "application/octet-stream", "accept-ranges": "bytes" };
    // stage-tv: the byte range a request asks for (a Stand video seeks to each frame with ranges)
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
    if (!m || !(m[1] || m[2])) return res.writeHead(200, headers).end(body);
    const a = m[1] ? Number(m[1]) : Math.max(0, body.length - Number(m[2])), b = m[1] && m[2] ? Math.min(Number(m[2]), body.length - 1) : body.length - 1;
    res.writeHead(206, { ...headers, "content-range": `bytes ${a}-${b}/${body.length}` }).end(body.subarray(a, b + 1));
  } catch {
    res.writeHead(404).end();
  }
}).listen(0);

const { chromium } = playwright();
const browser = await chromium.launch({
  channel: process.env.CHROME ? undefined : "chrome",
  executablePath: process.env.CHROME,
  args: ["--headless=new", "--ignore-gpu-blocklist", "--enable-gpu", "--use-angle=metal"],
});
const tab = await (await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 })).newPage();
let failed = false;
tab.on("console", (m) => m.type() === "error" && (console.error("[console]", m.text()), (failed = true)));
tab.on("pageerror", (e) => (console.error("[pageerror]", e.message), (failed = true)));
const query = [lite && "gfx=lite", ...opt("query"), `t=${from}`].filter(Boolean).join("&");
await tab.goto(`http://localhost:${server.address().port}/${page}?${query}`);
await tab.waitForFunction(() => window.__stage?.ready === true, null, { timeout: 90000 });
const info = await tab.evaluate(() => ({ ...window.__stage.info, duration: window.__frame?.duration ?? null }));
if (/swiftshader|llvmpipe|software/i.test(info.gpu)) throw new Error(`software GPU (${info.gpu}): the clip would not be the real look`);
const to = Number(opt("to")[0] || info.duration || 10);
const frames = Math.round((to - from) * fps);
console.log(`GPU: ${info.gpu}  gfx: ${info.gfx}  ${from}–${to} s, ${frames} frames at ${fps} fps → ${out}`);

await mkdir(dirname(out), { recursive: true });
const ff = spawn(FFMPEG, ["-y", "-loglevel", "error", "-f", "image2pipe", "-framerate", String(fps), "-i", "-",
  "-c:v", "libx264", "-preset", "slow", "-b:v", bitrate, "-maxrate", bitrate, "-bufsize", "12M", "-pix_fmt", "yuv420p",
  "-r", String(fps), "-movflags", "+faststart", out], { stdio: ["pipe", "inherit", "inherit"] });
const done = new Promise((r) => ff.on("close", r));
const t0 = Date.now();
for (let i = 0; i < frames; i++) {
  await tab.evaluate((t) => window.__stage.seek(t), from + i / fps);
  const jpg = await tab.screenshot({ type: "jpeg", quality: 95 });
  if (!ff.stdin.write(jpg)) await new Promise((r) => ff.stdin.once("drain", r));
  if (i % (fps * 5) === 0) console.log(`  ${(from + i / fps).toFixed(1)} s  (${((Date.now() - t0) / 1000).toFixed(0)} s elapsed)`);
}
ff.stdin.end();
const code = await done;
await browser.close();
server.close();
if (code !== 0) (console.error(`ffmpeg exited ${code}`), (failed = true));
else {
  console.log(`wrote ${out} (${frames} frames in ${((Date.now() - t0) / 1000).toFixed(0)} s)`);
  // the phone check: what a viewer on a weak connection gets (YouTube's 360p ≈ 700 kbit/s)
  if (small !== "0") {
    const lo = out.replace(/\.mp4$/, "") + "-360p.mp4";
    try {
      execFileSync(FFMPEG, ["-y", "-loglevel", "error", "-i", out, "-vf", "scale=640:360:flags=area", "-c:v", "libx264", "-preset", "slow",
        "-b:v", small, "-maxrate", small, "-bufsize", "1400k", "-pix_fmt", "yuv420p", "-movflags", "+faststart", lo]);
      console.log(`wrote ${lo} (640×360, ${small}bit/s)`);
    } catch (e) {
      console.error(`360p encode failed: ${e.message}`);
      failed = true;
    }
  }
}
process.exit(failed ? 1 : 0);
