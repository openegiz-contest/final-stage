// Headless checks of a Stage page on the real GPU (Metal), one browser for every job.
//   node contest/stage/tools/render.mjs <page> [--t 12.5 ...] [--out dir] [--bench 120] [--gfx lite] [--query k=v] [--size 1600x1000]
// <page> is a path under contest/stage/ (frame.html). The page must use lib/clock.js (window.__stage).
// Writes <out>/<page>-t<t>[-lite].png at 1920×1080 (or --size: a window of another shape, the page
// letterboxes its 1920×1080 frame) for each --t, prints the GPU, console errors and,
// with --bench, ms per frame (GPU-synced, back to back). Exit 1 on a page error or a software GPU.
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { basename, extname, join, dirname, sep, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const STAGE = dirname(dirname(fileURLToPath(import.meta.url)));
const SITE_3D = join(dirname(STAGE), "site", "assets", "3d");
const SIZE = (process.argv.find((a, i) => process.argv[i - 1] === "--size") ?? "1920x1080").split("x").map(Number);
const [W, H] = SIZE;

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
if (!page) throw new Error("usage: render.mjs <page> [--t s ...] [--out dir] [--bench n] [--gfx lite] [--query k=v]");
const times = opt("t").map(Number);
const out = resolve(opt("out")[0] || "/tmp/stage-render");
const bench = Number(opt("bench")[0] || 0);
const lite = opt("gfx")[0] === "lite";
const extra = opt("query");

// The same routes as server.py, minus /run and /pub (a page that needs them takes ?run= / ?pub= URLs).
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css",
  ".png": "image/png", ".jpg": "image/jpeg", ".json": "application/json", ".woff2": "font/woff2", ".svg": "image/svg+xml", ".glb": "model/gltf-binary", ".jsonl": "application/x-ndjson", ".mp4": "video/mp4", ".mp3": "audio/mpeg" };
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
    const [root, rest] = url.startsWith("/vendor/three/") ? [join(SITE_3D, "three"), url.slice(14)]
      : url.startsWith("/vendor/mine/") ? [SITE_3D, url.slice(13)]
      : PUB && url.startsWith("/pub/") ? [PUB, url.slice(5)] : [STAGE, url.slice(1)];
    const path = resolve(root, rest);
    if (!path.startsWith(root + sep)) throw new Error("outside root");
    sendFile(req, res, await readFile(path), { "content-type": TYPES[extname(path)] || "application/octet-stream" });
  } catch {
    res.writeHead(404).end();
  }
}).listen(0);
const base = `http://localhost:${server.address().port}`;

const { chromium } = playwright();
const browser = await chromium.launch({
  channel: process.env.CHROME ? undefined : "chrome",
  executablePath: process.env.CHROME,
  args: ["--headless=new", "--ignore-gpu-blocklist", "--enable-gpu", "--use-angle=metal"],
});
await mkdir(out, { recursive: true });
let failed = false;
const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const tab = await ctx.newPage();
tab.on("console", (m) => m.type() === "error" && (console.error("[console]", m.text()), (failed = true)));
tab.on("pageerror", (e) => (console.error("[pageerror]", e.message), (failed = true)));

const q = [lite && "gfx=lite", ...extra].filter(Boolean);
const shots = times.length ? times : [null];
for (const t of shots) {
  const query = [...q, t !== null && `t=${t}`].filter(Boolean).join("&");
  await tab.goto(`${base}/${page}${query ? "?" + query : ""}`);
  await tab.waitForFunction(() => window.__stage?.ready === true, null, { timeout: 90000 });
  const info = await tab.evaluate(() => window.__stage.info);
  if (t === shots[0]) {
    console.log(`GPU: ${info.gpu}  gfx: ${info.gfx}`);
    if (/swiftshader|llvmpipe|software/i.test(info.gpu)) (console.error("software GPU: the check is not valid"), (failed = true));
  }
  const file = join(out, `${basename(page, extname(page))}-t${t ?? "live"}${lite ? "-lite" : ""}${W !== 1920 || H !== 1080 ? `-${W}x${H}` : ""}.png`);
  await tab.screenshot({ path: file });
  console.log(`wrote ${file}`);
}
if (bench) {
  const r = await tab.evaluate((n) => window.__stage.bench(n), bench);
  console.log(`bench: ${r.msPerFrame.toFixed(2)} ms/frame over ${r.frames} frames at ${W}×${H}${lite ? " (lite)" : ""}`);
}
await browser.close();
server.close();
process.exit(failed ? 1 : 0);
