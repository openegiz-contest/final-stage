// Headless check of the sealed envelopes (owner 2026-10-28, spec §7.7 «Конверты») on live.html, on the
// real GPU (Metal), one browser:
//   node contest/stage/test/envelope-check.mjs [--replays a,b] [--stills <dir>] [--pub <run>/materials]
// For each recording (?voice=estimate, virtual time): every beat once, in order, verbatim, to the final
// screen, 0 console errors; then, sampled every second of the debate (before the Host opens the first
// envelope), what is on screen: no token in a tube, no verdict, Last Word card, podium or final screen,
// no team named on a card (the corner header's ceiling note excepted: п. 9.3 is known before the Final),
// no camera shot of one team's tube (the ceiling line's excepted); after it, the envelopes open 3 → 2 → 1
// and each verdict's tubes hold its deciding round. A reload in the middle of the 1st place's reveal
// resumes it with the opened tokens back in their tubes. --stills: the sealed beat, a round without a
// majority, the 1st place's envelope opening, its verdict, the podium, the final screen. Exit 1 on a failure.
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { extname, join, dirname, sep, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const STAGE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SITE_3D = join(dirname(STAGE), "site", "assets", "3d");
const argv = process.argv.slice(2);
const opt = (k, d) => argv.flatMap((a, i) => (a === `--${k}` ? [argv[i + 1]] : []))[0] ?? d;
const replays = opt("replays", "real-live-probe-20261021,real-live-probe-20261021b,synthetic-fake-engine,synthetic-full,synthetic-no-majority,synthetic-last-word").split(",");
const stillsDir = opt("stills", null);
// --pub DIR serves /pub/ (the run's Final Materials: the screenshots the Judges viewed); without it those
// images are missing and the page logs their 404s
const PUB = opt("pub", null) ? resolve(opt("pub")) : null;

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
  ".json": "application/json", ".jsonl": "application/x-ndjson", ".woff2": "font/woff2", ".svg": "image/svg+xml", ".glb": "model/gltf-binary" };
const server = createServer(async (req, res) => {
  if (req.url === "/favicon.ico") return res.writeHead(204).end();
  try {
    const url = decodeURIComponent(new URL(req.url, "http://x").pathname);
    const [root, rest] = url.startsWith("/vendor/three/") ? [join(SITE_3D, "three"), url.slice(14)]
      : url.startsWith("/vendor/mine/") ? [SITE_3D, url.slice(13)]
      : PUB && url.startsWith("/pub/") ? [PUB, url.slice(5)] : [STAGE, url.slice(1)];
    const path = resolve(root, rest);
    if (!path.startsWith(root + sep)) throw new Error("outside root");
    const body = await readFile(path);
    res.writeHead(200, { "content-type": TYPES[extname(path)] || "application/octet-stream", "cache-control": "no-store" }).end(body);
  } catch {
    res.writeHead(404).end();
  }
}).listen(0);
const base = `http://localhost:${server.address().port}`;
const { chromium } = playwright();
const browser = await chromium.launch({ channel: "chrome", args: ["--headless=new", "--ignore-gpu-blocklist", "--enable-gpu", "--use-angle=metal"] });
const tab = await (await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 })).newPage();
let errors = [];
tab.on("console", (m) => m.type() === "error" && errors.push(`${m.text()} ${m.location()?.url ?? ""}`));
tab.on("pageerror", (e) => errors.push(e.message));
let failed = false;
const expect = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failed = true;
};
async function open(name, extra = []) {
  await tab.goto(`${base}/live.html?${[`replay=test/replays/${name}.jsonl`, "voice=estimate", ...extra].join("&")}`);
  await tab.waitForFunction(() => window.__stage?.ready === true, null, { timeout: 300000 });
  const gpu = await tab.evaluate(() => window.__stage.info.gpu);
  if (/swiftshader|llvmpipe|software/i.test(gpu)) expect(false, `software GPU (${gpu}): the check is not valid`);
}

// what the screen shows at t: the cards layer's visible text by kind, and the tokens in the tubes
const screenAt = (t) => tab.evaluate(async (t) => {
  await window.__stage.seek(t);
  const vis = (sel) => [...document.querySelectorAll(sel)].filter((e) => e.style.display !== "none" && Number(e.style.opacity || 1) > 0.02 && e.offsetParent !== null);
  const ballot = window.__frame.stage.ballot;
  const state = window.__live.director.source.stateAt(Infinity);
  return {
    t,
    cards: { verdict: vis(".cd-verdict").length, lastWord: vis(".cd-lw").length, podium: vis(".cd-podium").length, final: vis(".cd-final").length },
    banner: vis(".cd-banner").map((e) => e.textContent),
    note: vis(".cd-note").map((e) => e.textContent),
    env: vis(".cd-env").map((e) => e.textContent),
    bug: vis(".cd-bug").map((e) => [...e.children].filter((c) => !c.classList.contains("cd-bug-note") || !/может занять/i.test(c.textContent)).map((c) => c.textContent).join(" | ")),
    tokens: state.finalists.reduce((n, f) => n + ballot.count(f.team, t), 0),
  };
}, t);

const moments = {};
for (const name of replays) {
  errors = [];
  await open(name, ["t=0", "check=1"]);
  const r = await tab.evaluate(() => {
    const L = window.__live, p = L.played;
    const state = L.director.source.stateAt(Infinity);
    return { check: L.check(), duration: window.__frame.duration, beats: p.beats, envelopes: p.envelopes, cuts: L.report().cuts, hosts: p.hosts,
      finalists: state.finalists, placements: state.placements, transcript: state.transcript };
  });
  const c = r.check;
  console.log(`\n== ${name}: ${c.beatsPlayed}/${c.beatsPlanned} beats, ${r.duration} s`);
  expect(c.finished && c.inOrder && c.once && c.allPlayed && c.verbatim && c.typedWhole, `${name}: every beat once, in order, verbatim (${c.says}/${c.messagesWithText} messages typed whole), to the final screen`);
  expect(errors.length === 0, `${name}: console errors ${errors.length}${errors.length ? ": " + errors.slice(0, 3).join(" | ") : ""}`);
  const intro = r.beats.find((b) => b.type === "reveal.intro");
  expect(!!intro, `${name}: the Host opens the envelopes`);
  if (!intro) continue;
  // the debate, every second: nothing of a result on screen
  const capped = r.finalists.filter((f) => f.ceiling).map((f) => f.team);
  const names = r.finalists.map((f) => f.name);
  const leaks = [];
  for (let t = 0; t < intro.at; t += 1) {
    const s = await screenAt(t);
    const shown = Object.entries(s.cards).filter(([, n]) => n).map(([k]) => k);
    const text = [...s.banner, ...s.note, ...s.env, ...s.bug].join(" ");
    const named = names.filter((n) => text.includes(`«${n}»`));
    if (shown.length || s.tokens || named.length) leaks.push(`t=${t}: ${[...shown, s.tokens ? `${s.tokens} tokens in tubes` : "", ...named].filter(Boolean).join(", ")}`);
  }
  expect(!leaks.length, `${name}: nothing of a result on screen in ${Math.ceil(intro.at)} s of debate${leaks.length ? " (" + leaks.slice(0, 4).join("; ") + ")" : ""}`);
  const tubeShots = r.cuts.filter((x) => x.t < intro.at && (x.kind === "token" || (x.kind === "tube" && !capped.includes(x.team))));
  expect(!tubeShots.length, `${name}: no shot of one team's tube or token before the reveal${tubeShots.length ? " " + JSON.stringify(tubeShots.slice(0, 3)) : ""}`);
  // the reveal: 3 → 2 → 1, each verdict over its deciding round's tubes
  const opens = r.envelopes.filter((e) => e.stage === "open");
  const sealedPlaces = r.placements.filter((p) => p.decided_by !== "vacant").map((p) => p.place).sort((a, b) => b - a);
  expect(JSON.stringify(opens.map((e) => e.place)) === JSON.stringify(sealedPlaces), `${name}: envelopes open ${opens.map((e) => e.place).join(" → ")}`);
  const verdicts = r.beats.filter((b) => b.type === "verdict" && b.at > intro.at);
  for (const [k, v] of verdicts.entries()) {
    const place = opens[k]?.place;
    const deciding = r.transcript.filter((e) => e.kind === "tally" && e.place === place).at(-1);
    const s = await screenAt(v.at + 3);
    expect(s.cards.verdict === 1 && s.tokens === deciding.voted, `${name}: place ${place} verdict on screen over ${s.tokens}/${deciding.voted} tokens in the tubes`);
  }
  const fin = r.beats.find((b) => b.type === "final");
  const sf = await screenAt(fin.at + 3);
  expect(sf.cards.final === 1, `${name}: the final screen`);
  moments[name] = { intro: intro.at, beats: r.beats, envelopes: r.envelopes, cuts: r.cuts };
}

// a reload in the middle of the 1st place's reveal (real recording): the rest plays, the opened tokens
// are back in their tubes, the podium holds places 3 and 2
{
  const name = "real-live-probe-20261021";
  errors = [];
  await open(name, ["t=0", "check=1"]);
  const plan = await tab.evaluate(() => {
    const p = window.__live.played;
    const open1 = p.envelopes.find((e) => e.stage === "open" && e.place === 1);
    const reveals = p.reveals.filter((x) => x.n > open1.n && x.team);
    return { from: reveals[2].n, shown: reveals.slice(0, 2).map((x) => x.team) };
  });
  errors = [];
  await open(name, ["t=0", "check=1", `from=${plan.from}`]);
  const r = await tab.evaluate(() => {
    const L = window.__live, p = L.played;
    return { check: L.check(), first: p.beats[0], restored: p.restored };
  });
  const s = await screenAt(r.first.at + 0.05);
  expect(r.restored === plan.from && r.check.finished && r.check.allPlayed && r.check.inOrder && r.check.verbatim, `resume from beat ${plan.from} (1st place, 3rd token): the rest of the show plays, once, in order`);
  expect(errors.length === 0, `resume: console errors ${errors.length}${errors.length ? ": " + errors.slice(0, 3).join(" | ") : ""}`);
  expect(s.tokens === plan.shown.length, `resume: the ${plan.shown.length} tokens opened before the reload are in their tubes (${s.tokens})`);
  expect(s.bug.some((b) => /1-е место · вскрываем конверт/.test(b) && b.includes("«Горный поток»") && b.includes("«Карьер-Ай»")), `resume: the corner header names the places opened, 2 and 3: ${JSON.stringify(s.bug)}`);
}

if (stillsDir) {
  await mkdir(stillsDir, { recursive: true });
  const shots = [];
  const A = "real-live-probe-20261021", F = "synthetic-full";
  const beat = (name, pred) => moments[name]?.beats.find(pred);
  const sealed1 = beat(A, (b) => b.type === "sealed" && b.n === moments[A].envelopes.find((e) => e.stage === "sealed" && e.place === 1).n);
  const noMaj = beat(F, (b) => b.type === "vote.result" && b.at < moments[F].intro);
  const open1 = moments[A].envelopes.find((e) => e.stage === "open" && e.place === 1);
  const verdict1 = moments[A].beats.filter((b) => b.type === "verdict").at(-1);
  const podium1 = moments[A].beats.filter((b) => b.type === "podium").at(-1);
  const fin = beat(A, (b) => b.type === "final");
  const sealed3 = moments[A].envelopes.find((e) => e.stage === "sealed" && e.place === 3);
  shots.push([A, "sealed-place1", sealed1.at + 2.2], [A, "sealed-place3", sealed3.at + 2.2], [F, "no-majority-synthetic", noMaj.at + 1.6],
    [A, "open-place1", open1.at + 1.75], [A, "open-place1-opened", open1.at + 3.2], [A, "verdict-place1", verdict1.at + 14], [A, "podium", podium1.at + 2.6], [A, "final", fin.at + 4]);
  // the debate with two envelopes sealed (corner header)
  const p3 = moments[A].beats.find((b) => b.type === "round" && b.at > sealed3.at - 300 && b.at > moments[A].envelopes.find((e) => e.stage === "sealed" && e.place === 2).at);
  if (p3) shots.push([A, "debate-place3-header", p3.at + 20]);
  let loaded = null;
  for (const [name, label, t] of shots) {
    if (loaded !== name) (await open(name, ["t=0"]), (loaded = name));
    const s = await screenAt(Math.round(t * 100) / 100);
    const file = join(stillsDir, `${label}.png`);
    await tab.screenshot({ path: file });
    console.log(`wrote ${file}  t=${s.t.toFixed(2)}  env=${JSON.stringify(s.env)} banner=${JSON.stringify(s.banner)} bug=${JSON.stringify(s.bug)} tokens=${s.tokens}`);
  }
}
await browser.close();
server.close();
process.exit(failed ? 1 : 0);
