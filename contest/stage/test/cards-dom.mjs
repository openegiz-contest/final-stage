// The outcome layer read back from the rendered page (test/cards.html, ui/cards.js), on the real GPU:
//   node contest/stage/test/cards-dom.mjs [--gfx lite] [--marks] [--stress]
// Checks, at every moment the page marks and at each verdict's reasons:
//   - verbatim: the reasons on each verdict card equal the payload's reasons[].text exactly, in order,
//     with the Judge's model name, and each is visible (opacity 1) once its turn has come;
//   - legibility: every visible text of the layer (and the subtitles) has a cap height ≥ 20 px at 1080p
//     (Inter 0.727 em, IBM Plex Mono 0.698 em);
//   - nothing of the layer lies under the visible subtitles, and nothing leaves the frame;
//   - no console errors. --marks prints the page's marks (times for stills). Exit 1 on a failure.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { extname, join, dirname, sep, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const STAGE = dirname(dirname(fileURLToPath(import.meta.url)));
const SITE_3D = join(dirname(STAGE), "site", "assets", "3d");
const argv = process.argv.slice(2);
const lite = argv.includes("--gfx") && argv[argv.indexOf("--gfx") + 1] === "lite";

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
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".png": "image/png",
  ".jpg": "image/jpeg", ".json": "application/json", ".woff2": "font/woff2", ".md": "text/plain; charset=utf-8", ".glb": "model/gltf-binary" };
const server = createServer(async (req, res) => {
  if (req.url === "/favicon.ico") return res.writeHead(204).end();
  try {
    const url = decodeURIComponent(new URL(req.url, "http://x").pathname);
    const [root, rest] = url.startsWith("/vendor/three/") ? [join(SITE_3D, "three"), url.slice(14)]
      : url.startsWith("/vendor/mine/") ? [SITE_3D, url.slice(13)] : [STAGE, url.slice(1)];
    const path = resolve(root, rest);
    if (!path.startsWith(root + sep)) throw new Error("outside root");
    res.writeHead(200, { "content-type": TYPES[extname(path)] || "application/octet-stream" }).end(await readFile(path));
  } catch {
    res.writeHead(404).end();
  }
}).listen(0);
const base = `http://localhost:${server.address().port}`;

const { chromium } = playwright();
const browser = await chromium.launch({ channel: "chrome", args: ["--headless=new", "--ignore-gpu-blocklist", "--enable-gpu", "--use-angle=metal"] });
const tab = await (await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 })).newPage();
const fails = [];
tab.on("console", (m) => m.type() === "error" && fails.push(`console: ${m.text()}`));
tab.on("pageerror", (e) => fails.push(`pageerror: ${e.message}`));

// what is visible in the layer at the current frame
const probe = () => {
  const vis = (el) => {
    for (let e = el; e && e !== document.body; e = e.parentElement) {
      const s = getComputedStyle(e);
      if (s.display === "none" || s.visibility === "hidden" || Number(s.opacity) < 0.05) return false;
    }
    return true;
  };
  const texts = [];
  const walk = (root) => {
    for (const el of root.querySelectorAll("*")) {
      const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
      if (!own || !vis(el)) continue;
      const s = getComputedStyle(el), r = el.getBoundingClientRect();
      const k = /Plex Mono/.test(s.fontFamily) ? 0.698 : 0.727;
      texts.push({ cls: el.className, text: el.textContent.trim().slice(0, 60), cap: parseFloat(s.fontSize) * k, box: [r.left, r.top, r.right, r.bottom] });
    }
  };
  walk(document.querySelector(".cd"));
  const sb = document.querySelector(".subs");
  const subs = sb && vis(sb) && sb.textContent.trim() ? (() => { const r = sb.getBoundingClientRect(); return [r.left, r.top, r.right, r.bottom]; })() : null;
  const subCap = sb ? parseFloat(getComputedStyle(sb).fontSize) * 0.727 : 0;
  const reasons = [...document.querySelectorAll(".cd-verdict")].filter(vis).flatMap((v) => [...v.querySelectorAll(".cd-reason")].map((r) => ({
    text: r.querySelector(".cd-reason-text").textContent, who: r.querySelector(".cd-reason-who").textContent, judge: r.dataset.judge,
    opacity: Number(getComputedStyle(r).opacity),
  })));
  return { texts, subs, subCap, reasons };
};

async function open(query) {
  await tab.goto(`${base}/test/cards.html?${[lite && "gfx=lite", query, "t=0"].filter(Boolean).join("&")}`);
  await tab.waitForFunction(() => window.__stage?.ready === true, null, { timeout: 90000 });
}
async function check(label, t) {
  await tab.evaluate((x) => window.__stage.seek(x), t);
  const p = await tab.evaluate(probe);
  for (const x of p.texts) {
    if (x.cap < 20 - 1e-6) fails.push(`${label} t=${t}: «${x.text}» (${x.cls}) cap ${x.cap.toFixed(1)} px < 20`);
    const [l, tp, r, b] = x.box;
    if (l < 0 || tp < 0 || r > 1920 || b > 1080) fails.push(`${label} t=${t}: «${x.text}» leaves the frame`);
    if (p.subs) {
      const [sl, st, sr, sb] = p.subs;
      if (l < sr && r > sl && tp < sb && b > st) fails.push(`${label} t=${t}: «${x.text}» lies under the subtitles`);
    }
  }
  if (p.subs && p.subCap < 20) fails.push(`${label}: subtitles cap ${p.subCap}`);
  return p;
}

await open(argv.includes("--stress") ? "stress=1" : ""); // --stress: five ~20-word majority reasons on the place-1 card
const frame = await tab.evaluate(() => ({ marks: window.__frame.marks, verdicts: window.__frame.verdicts, duration: window.__frame.duration, results: window.__frame.results }));
if (argv.includes("--marks")) console.log(JSON.stringify(frame, null, 1));
let checked = 0;
for (const [k, t] of Object.entries(frame.marks)) (await check(k, t), checked++);
// legibility over the whole page, every 0.5 s
for (let t = 0; t < frame.duration; t += 0.5) (await check("sweep", Math.round(t * 10) / 10), checked++);
// verbatim: each verdict's reasons, at the end of the card (all shown) and as each one joins
let reasonsSeen = 0;
for (const v of frame.verdicts) {
  if (v.vacant) continue;
  const cardShots = v.shots.filter((s) => s.kind === "card");
  for (let i = 0; i < v.reasons.length; i++) {
    const p = await check(`verdict ${v.place} reason ${i + 1}`, cardShots[i].from + 1.0);
    const r = p.reasons[i];
    if (!r) { fails.push(`verdict ${v.place}: reason ${i + 1} missing`); continue; }
    if (r.text !== v.reasons[i].text) fails.push(`verdict ${v.place}: reason ${i + 1} differs:\n  shown  «${r.text}»\n  payload «${v.reasons[i].text}»`);
    if (r.judge !== v.reasons[i].judge) fails.push(`verdict ${v.place}: reason ${i + 1} judge ${r.judge} ≠ ${v.reasons[i].judge}`);
    if (r.opacity < 0.99) fails.push(`verdict ${v.place}: reason ${i + 1} not fully shown in its own shot (opacity ${r.opacity})`);
    reasonsSeen++;
  }
  const last = await tab.evaluate(probe);
  if (last.reasons.length !== v.reasons.length) fails.push(`verdict ${v.place}: ${last.reasons.length} reasons on the card, payload has ${v.reasons.length}`);
}
// a resume: the header and the podium at once
for (const mode of ["mid", "done"]) {
  await open(`restore=${mode}`);
  const p = await check(`restore ${mode}`, 0);
  const has = (cls) => p.texts.some((x) => String(x.cls).includes(cls));
  if (mode === "mid" && !(has("cd-bug-place") && has("cd-bug-name"))) fails.push("restore mid: header or podium missing at t=0");
  if (mode === "done" && !has("cd-step-name")) fails.push("restore done: final screen missing at t=0");
  checked++;
}
await browser.close();
server.close();
console.log(`cards-dom${lite ? " (lite)" : ""}: ${checked} frames checked, ${reasonsSeen} reasons verbatim, ${fails.length} failures`);
for (const f of fails.slice(0, 40)) console.error("  " + f);
process.exit(fails.length ? 1 : 0);
