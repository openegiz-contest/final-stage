// Run a robots check page on the real GPU (Metal) and print what it leaves in window[global] as JSON.
//   node contest/stage/robots/check/run.mjs robots/check/luma.html --global __luma [--gfx lite] [--query k=v] [--shot file.png] [--size 1920x1080]
// The same routes and browser flags as tools/render.mjs (one browser, headless, ANGLE on Metal).
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join, dirname, sep, resolve, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const STAGE = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const SITE_3D = join(dirname(STAGE), "site", "assets", "3d");

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

const argv = process.argv.slice(2);
const page = argv[0];
const opt = (k) => argv.flatMap((a, i) => (a === `--${k}` ? [argv[i + 1]] : []));
const global = opt("global")[0] || "__result";
const lite = opt("gfx")[0] === "lite";
const shot = opt("shot")[0];
const [W, H] = (opt("size")[0] || "1920x1080").split("x").map(Number);
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".png": "image/png", ".jpg": "image/jpeg",
  ".json": "application/json", ".woff2": "font/woff2", ".glb": "model/gltf-binary" };
const server = createServer(async (req, res) => {
  if (req.url === "/favicon.ico") return res.writeHead(204).end();
  try {
    const url = decodeURIComponent(new URL(req.url, "http://x").pathname);
    const [root, rest] = url.startsWith("/vendor/three/") ? [join(SITE_3D, "three"), url.slice(14)] : url.startsWith("/vendor/mine/") ? [SITE_3D, url.slice(13)] : [STAGE, url.slice(1)];
    const path = resolve(root, rest);
    if (!path.startsWith(root + sep)) throw new Error("outside root");
    const body = await readFile(path);
    res.writeHead(200, { "content-type": TYPES[extname(path)] || "application/octet-stream" }).end(body);
  } catch {
    res.writeHead(404).end();
  }
}).listen(0);
const base = `http://localhost:${server.address().port}`;
const { chromium } = playwright();
const browser = await chromium.launch({ channel: "chrome", args: ["--headless=new", "--ignore-gpu-blocklist", "--enable-gpu", "--use-angle=metal"] });
const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const tab = await ctx.newPage();
let failed = false;
tab.on("console", (m) => m.type() === "error" && (console.error("[console]", m.text()), (failed = true)));
tab.on("pageerror", (e) => (console.error("[pageerror]", e.message), (failed = true)));
const q = [lite && "gfx=lite", ...opt("query")].filter(Boolean).join("&");
await tab.goto(`${base}/${page}${q ? "?" + q : ""}`);
await tab.waitForFunction((g) => window[g] !== undefined, global, { timeout: 180000 });
const r = await tab.evaluate((g) => window[g], global);
console.log(JSON.stringify(r, null, 1));
if (shot) {
  await mkdir(dirname(resolve(shot)), { recursive: true });
  await tab.screenshot({ path: resolve(shot) });
  console.error(`wrote ${resolve(shot)}`);
}
await browser.close();
server.close();
process.exit(failed ? 1 : 0);
