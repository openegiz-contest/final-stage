// Closest approach between any two Judges in every vote wave of the synthetic replays: the walks to the
// ballot box must keep the bodies apart (bound MIN_OK, centre to centre). Samples every 0.05 s from the
// wave's first voteCast to 25 s after its last, through live.html with the replay held on the director's clock.
//   node vote-gap.mjs [stage dir] [replay names...]   (default: every test/replays/synthetic-*.jsonl)
// Needs a global playwright-core and Chrome. Progress goes to stderr, the result (JSON per replay) to
// stdout; exit 1 when some wave is closer than MIN_OK or the page logged an error.
import { createServer } from "node:http";
import { readFile, readdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { extname, join, dirname, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const MIN_OK = 0.39;
const STAGE = resolve(process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), ".."));
const NAMES = process.argv.length > 3
  ? process.argv.slice(3)
  : (await readdir(join(STAGE, "test/replays"))).filter((f) => /^synthetic-.*\.jsonl$/.test(f)).map((f) => f.slice(0, -6)).sort();
const SITE_3D = join(dirname(STAGE), "site", "assets", "3d");
const require = createRequire(import.meta.url);
const g = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
let pw;
for (const t of [join(g, "playwright-core"), join(g, "@playwright/mcp/node_modules/playwright-core")]) { try { pw = require(t); break; } catch {} }
const server = createServer(async (req, res) => {
  try {
    const url = decodeURIComponent(new URL(req.url, "http://x").pathname);
    const [root, rest] = url.startsWith("/vendor/three/") ? [join(SITE_3D, "three"), url.slice(14)] : url.startsWith("/vendor/mine/") ? [SITE_3D, url.slice(13)] : [STAGE, url.slice(1)];
    const path = resolve(root, rest);
    const T = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".woff2": "font/woff2", ".glb": "model/gltf-binary" };
    const body = await readFile(path);
    res.writeHead(200, { "content-type": T[extname(path)] || "application/octet-stream" }).end(body);
  } catch (e) { if (!res.headersSent) res.writeHead(404).end(); }
}).listen(0);
const browser = await pw.chromium.launch({ channel: "chrome", args: ["--headless=new", "--enable-gpu", "--use-angle=metal"] });
const results = {};
for (const name of NAMES) {
  const tab = await (await browser.newContext({ viewport: { width: 1920, height: 1080 } })).newPage();
  const errs = [];
  tab.on("console", (m) => m.type() === "error" && !/^Failed to load resource/.test(m.text()) && errs.push(m.text())); // a missing fixture image is not a collision
  tab.on("pageerror", (e) => errs.push(String(e)));
  await tab.goto(`http://localhost:${server.address().port}/live.html?replay=test/replays/${name}.jsonl&voice=estimate&t=0&check=1`);
  await tab.waitForFunction(() => window.__stage?.ready === true, null, { timeout: 600000 });
  const out = await tab.evaluate(() => {
    const L = window.__live, stage = window.__frame.stage;
    const ids = ["opus-5.5", "sonnet-5.5", "fable-5.1", "gpt-6.1-sol", "gpt-6-astra"];
    const waves = [];
    for (const b of L.played.beats) {
      if (b.type === "vote.cast") { const w = waves.at(-1); if (!w || w.begin != null) waves.push({ from: b.at, to: b.at, begin: null, result: null }); else w.to = b.at; }
      else if (b.type === "vote.begin") waves.at(-1).begin = b.at;
      else if (b.type === "vote.result") waves.at(-1).result = b.at;
    }
    return waves.map((w) => {
      let min = 9, at = null, pair = null;
      for (let t = w.from; t < w.to + 25; t += 0.05) {
        for (const id of ids) stage.robots[id].update(t);
        for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
          const a = stage.robots[ids[i]].object3d.position, b = stage.robots[ids[j]].object3d.position;
          const d = Math.hypot(a.x - b.x, a.z - b.z);
          if (d < min) (min = d), (at = t), (pair = [ids[i], ids[j]]);
        }
      }
      const r1 = (x) => (x == null ? null : +x.toFixed(1));
      return { from: r1(w.from), lastCast: r1(w.to), tallyBegin: r1(w.begin), result: r1(w.result), toResult: r1(w.result - w.from), min: +min.toFixed(2), at: +at.toFixed(2), pair };
    });
  });
  results[name] = { waves: out, consoleErrors: errs };
  console.error(`${name}: ${out.map((w) => `${w.min.toFixed(2)} (${w.toResult}s)`).join("  ")}`);
  await tab.context().close();
}
console.log(JSON.stringify(results, null, 1));
await browser.close();
server.close();
process.exit(Object.values(results).some((o) => o.consoleErrors.length || o.waves.some((w) => w.min < MIN_OK)) ? 1 : 0);
