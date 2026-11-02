// test/voice.html in a real browser against a real TTS service, on throwaway ports (not part of `node --test`):
//   node contest/stage/test/voice/browser.mjs [--speaker opus-5.5] [--out dir]
// Starts tts/serve.py and server.py, opens the page in headless Chrome with audio allowed, waits for the line to end
// and prints window.__stage.result: the engine, when the last character was typed against when the audio ended
// (must be within ±0.3 s), the level, and the worst gap between a word appearing and the audio clock. Then opens the
// page frozen at ?t= to check that the virtual-clock typing and level are repeatable (same values twice, no audio).
// Exit 1 on a miss. Needs playwright-core (see tools/clip.mjs) and the macOS voice or keys for the service.
import { createServer } from "node:net";
import { spawn, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir } from "node:fs/promises";

const STAGE = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const argv = process.argv.slice(2);
const opt = (k, d) => argv.flatMap((a, i) => (a === `--${k}` ? [argv[i + 1]] : []))[0] ?? d;
const speaker = opt("speaker", "opus-5.5");
const outDir = resolve(opt("out", "/tmp/stage-voice"));

function playwright() {
  const require = createRequire(import.meta.url);
  const tries = [process.env.PLAYWRIGHT_CORE, "playwright-core"];
  try {
    const g = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
    tries.push(join(g, "playwright-core"), join(g, "@playwright/mcp/node_modules/playwright-core"));
  } catch {}
  for (const t of tries.filter(Boolean)) {
    try { return require(t); } catch {}
  }
  throw new Error("playwright-core not found: npm i -g playwright-core, or set PLAYWRIGHT_CORE to its folder");
}
const freePort = () => new Promise((res) => { const s = createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); });
async function waitFor(url) {
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(url)).ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`${url} did not come up`);
}

const stagePort = await freePort();
const ttsPort = await freePort();
const kids = [
  spawn("python3", [join(STAGE, "server.py"), "--port", String(stagePort)], { stdio: "inherit" }),
  spawn("python3", [join(STAGE, "tts", "serve.py"), "--port", String(ttsPort), "--cors", `http://127.0.0.1:${stagePort}`], { stdio: "inherit" }),
];
let failed = false;
const fail = (m) => (console.error("FAIL:", m), (failed = true));
try {
  await waitFor(`http://127.0.0.1:${ttsPort}/health`);
  await waitFor(`http://127.0.0.1:${stagePort}/test/voice.html`);
  const { chromium } = playwright();
  const browser = await chromium.launch({ channel: process.env.CHROME ? undefined : "chrome", executablePath: process.env.CHROME,
    args: ["--headless=new", "--autoplay-policy=no-user-gesture-required"] });
  const open = async (query) => {
    const tab = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
    tab.on("console", (m) => m.type() === "error" && fail(`console: ${m.text()}`));
    tab.on("pageerror", (e) => fail(`pageerror: ${e.message}`));
    await tab.goto(`http://127.0.0.1:${stagePort}/test/voice.html?speaker=${speaker}&base=http://127.0.0.1:${ttsPort}${query}`);
    await tab.waitForFunction(() => window.__stage?.ready === true, null, { timeout: 120000 });
    return tab;
  };

  // live
  const tab = await open("");
  await tab.waitForFunction(() => window.__stage.result.done, null, { timeout: 120000 });
  const r = await tab.evaluate(() => ({ ...window.__stage.result, report: window.__stage.voice.report }));
  await mkdir(outDir, { recursive: true });
  await tab.screenshot({ path: join(outDir, "voice-live-end.png") });
  console.log(JSON.stringify(r, null, 1));
  if (r.engine === "estimate") fail(`the service did not answer: ${r.reason}`);
  if (!(Math.abs(r.skewS) <= 0.3)) fail(`last character vs audio end: ${r.skewS} s`);
  if (!(r.maxLevel > 0.8 && r.meanLevelInSpeech > 0.2)) fail(`level looks dead: max ${r.maxLevel}, mean ${r.meanLevelInSpeech}`);
  if (!(r.maxWordSyncErrorS <= 0.3)) fail(`a word appeared ${r.maxWordSyncErrorS} s off the audio clock`);

  // virtual: two loads, same values, and nothing played
  const sample = async (t) => {
    const p = await open(`&t=${t}`);
    const v = await p.evaluate(() => ({ typed: document.getElementById("typed").textContent, lv: document.getElementById("lv").textContent, plays: window.__stage.voice.plays.length, virtual: window.__stage.voice.virtual }));
    await p.screenshot({ path: join(outDir, `voice-t${t}.png`) });
    return v;
  };
  for (const t of [0.5, 9, 20]) {
    const a = await sample(t);
    const b = await sample(t);
    console.log(`t=${t}:`, JSON.stringify(a));
    if (JSON.stringify(a) !== JSON.stringify(b)) fail(`t=${t} differs between loads: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
    if (!a.virtual) fail("not in virtual mode");
  }
  await browser.close();
} finally {
  kids.forEach((k) => k.kill());
}
console.log(failed ? "FAILED" : "ok");
process.exit(failed ? 1 : 0);
