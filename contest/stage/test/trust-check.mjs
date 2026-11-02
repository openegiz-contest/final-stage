// Headless check of the red team's trust fixes (2026-10-21) on live.html, on the real GPU, one browser:
//   node contest/stage/test/trust-check.mjs [--replays full,unavailable,...] [--stills <dir>] [--bench]
// For each synthetic replay (?voice=estimate, virtual time): every beat plays once, in order, verbatim,
// with 0 console errors; the tokens open in the walk order; the result comes after the last token and
// the camera has no "line" shot mid-reveal; every Judge named on a verdict card gets a close-up there
// (the table per Judge); the notes (a changed vote, a Judge without a vote) are on screen.
// --stills: a verdict card, a changed-vote reveal, the unavailable beat and the ceiling line, full and
// lite. --bench: ms per frame at the busiest verdict (full ≤ 20, lite ≤ 10). Exit 1 on a failure.
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
const replays = opt("replays", "full,unavailable,no-majority,last-word,vote-order").split(",");
const stillsDir = opt("stills", null);
const bench = argv.includes("--bench");

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
  ".json": "application/json", ".jsonl": "application/x-ndjson", ".woff2": "font/woff2", ".svg": "image/svg+xml", ".md": "text/plain; charset=utf-8", ".glb": "model/gltf-binary" };
const server = createServer(async (req, res) => {
  if (req.url === "/favicon.ico") return res.writeHead(204).end();
  try {
    const url = decodeURIComponent(new URL(req.url, "http://x").pathname);
    const [root, rest] = url.startsWith("/vendor/three/") ? [join(SITE_3D, "three"), url.slice(14)]
      : url.startsWith("/vendor/mine/") ? [SITE_3D, url.slice(13)] : [STAGE, url.slice(1)];
    const path = resolve(root, rest);
    if (!path.startsWith(root + sep)) throw new Error("outside root");
    const body = await readFile(path); // before the headers: a missing file is a 404, not a second writeHead
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
tab.on("console", (m) => m.type() === "error" && errors.push(m.text()));
tab.on("pageerror", (e) => errors.push(e.message));
let failed = false;
const expect = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failed = true;
};
const url = (name, extra = []) => `${base}/live.html?${[`replay=test/replays/synthetic-${name}.jsonl`, "voice=estimate", ...extra].join("&")}`;
async function open(name, extra) {
  await tab.goto(url(name, extra));
  await tab.waitForFunction(() => window.__stage?.ready === true, null, { timeout: 240000 });
}

const JUDGES = ["opus-5.5", "sonnet-5.5", "fable-5.1", "gpt-6.1-sol", "gpt-6-astra"];
for (const name of replays) {
  errors = [];
  await open(name, ["t=0", "check=1"]);
  const r = await tab.evaluate(() => {
    const L = window.__live, p = L.played;
    const rep = L.report();
    const trace = L.planner.trace;
    const cuts = rep.cuts;
    // verdict-card close-ups: the cards' "card" shots during each verdict beat
    const verdicts = p.beats.filter((b) => b.type === "verdict");
    const nextAt = (b) => p.beats.find((x) => x.n === b.n + 1)?.at ?? Infinity;
    const perVerdict = verdicts.map((b) => {
      const to = nextAt(b);
      const list = cuts.map((c, i) => ({ ...c, dur: (cuts[i + 1]?.t ?? to) - c.t })).filter((c) => c.t >= b.at - 0.01 && c.t < to && c.tag === "cards:verdict" && c.kind === "card");
      return { at: b.at, n: b.n, shots: list.map((c) => ({ id: c.id, t: c.t, dur: Math.round(Math.min(c.dur, to - c.t) * 10) / 10 })) };
    });
    // the reveal waves: walk order vs reveal order, the result's beat after the last token
    const byBeat = new Map(p.beats.map((b) => [b.n, b]));
    const voteBeats = p.beats.filter((b) => b.type === "vote");
    const resultBeats = p.beats.filter((b) => b.type === "vote.result");
    const lineSegs = trace.filter((s) => /^line:/.test(s.tag)).length;
    const notes = [...document.querySelectorAll(".cd-note")].map((e) => e.textContent);
    return { check: L.check(), duration: window.__frame.duration, perVerdict, lineSegs, notes, casts: p.casts, reveals: p.reveals,
      voteBeats, resultBeats, hosts: p.hosts.map((h) => ({ type: h.type, t0: h.t0, end: h.end, text: h.text })), beatsN: byBeat.size };
  });
  const c = r.check;
  console.log(`\n== ${name}: ${c.beatsPlayed}/${c.beatsPlanned} beats, ${r.duration} s`);
  expect(c.finished && c.inOrder && c.once && c.allPlayed && c.verbatim && c.typedWhole, `${name}: every beat once, in order, verbatim, to the final screen`);
  expect(errors.length === 0, `${name}: console errors ${errors.length}${errors.length ? ": " + errors.slice(0, 3).join(" | ") : ""}`);
  // reveal order == walk order, per wave that opens its tokens (with sealed envelopes, owner 2026-10-28:
  // only each place's deciding round, after the debate)
  let orderOk = true;
  const waveKey = (x) => `${x.place}|${x.round}`;
  for (const key of [...new Set(r.reveals.filter((x) => x.team).map(waveKey))]) {
    const tokens = r.casts.filter((x) => waveKey(x) === key && !x.unavailable).map((x) => x.judge);
    const shown = r.reveals.filter((x) => waveKey(x) === key && x.team).map((x) => x.judge);
    if (JSON.stringify(shown) !== JSON.stringify(tokens)) (orderOk = false), console.log("   walks", tokens.join(" "), "\n   reveals", shown.join(" "));
  }
  expect(r.reveals.some((x) => x.team), `${name}: tokens were opened`);
  expect(orderOk, `${name}: tokens open in the order the Judges reached the urn`);
  expect(r.lineSegs === 0, `${name}: no mid-reveal "line" shot (the majority waits for the result)`);
  const lateOk = r.resultBeats.every((res) => r.voteBeats.filter((v) => v.n < res.n && v.n > res.n - 8).every((v) => v.at <= res.at));
  expect(lateOk, `${name}: each result beat starts after its last reveal`);
  // verdict close-ups per Judge
  if (r.perVerdict.length) {
    const table = JUDGES.map((id) => [id, ...r.perVerdict.map((v) => v.shots.filter((s) => s.id === id).reduce((s, x) => s + x.dur, 0))]);
    console.log(`   verdict close-ups (s) per Judge, places ${r.perVerdict.map((_, k) => k + 1).join(", ")}:`);
    for (const row of table) console.log(`     ${row[0].padEnd(12)} ${row.slice(1).map((x) => x.toFixed(1).padStart(5)).join(" ")}   shots ${r.perVerdict.map((v) => v.shots.filter((s) => s.id === row[0]).length).join("/")}`);
  }
  // every Judge named on a verdict card (a reason or the «Против» line) has a close-up there
  const named = await tab.evaluate(() => [...document.querySelectorAll(".cd-verdict")]
    .map((e) => [...[...e.querySelectorAll(".cd-reason")].map((x) => x.dataset.judge), ...(e.querySelector(".cd-v-against")?.dataset.judges.split(",") ?? [])])
    .filter((list) => list.length));
  const withShots = r.perVerdict.filter((v) => v.shots.length);
  const missing = named.flatMap((list, k) => list.filter((j) => !(withShots[k]?.shots ?? []).some((s) => s.id === j)).map((j) => `place card ${k + 1}: ${j}`));
  expect(named.length === withShots.length && !missing.length, `${name}: every Judge named on a verdict card is on camera there${missing.length ? " (missing " + missing.join(", ") + ")" : ""}`);
}

// stills and the checks of what is on screen at those moments (synthetic-full and synthetic-unavailable)
async function frameAt(name, t, extra = []) {
  await open(name, [`t=${t}`, ...extra]);
  return tab.evaluate(() => ({
    notes: [...document.querySelectorAll(".cd-note")].filter((e) => e.style.display !== "none" && Number(e.style.opacity) > 0.5).map((e) => e.textContent),
    bug: [...document.querySelectorAll(".cd-bug")].filter((e) => e.style.display !== "none").map((e) => e.textContent).join(" "),
    verdict: [...document.querySelectorAll(".cd-verdict")].filter((e) => e.style.display !== "none" && Number(e.style.opacity) > 0.5).map((e) => ({
      cls: e.className, h: e.getBoundingClientRect().height, bottom: e.getBoundingClientRect().bottom,
      reasons: [...e.querySelectorAll(".cd-reason")].filter((x) => x.style.display !== "none").map((x) => x.dataset.judge),
      against: e.querySelector(".cd-v-against")?.style.display !== "none" ? e.querySelector(".cd-v-against")?.textContent ?? null : null,
      absent: e.querySelector(".cd-v-absent")?.textContent ?? null })),
    subs: document.querySelector(".subs")?.textContent ?? "",
    lowers: [...document.querySelectorAll(".cap-lower")].filter((e) => Number(getComputedStyle(e).opacity) > 0.05 && getComputedStyle(e).display !== "none").map((e) => e.textContent),
  }));
}
if (stillsDir || bench) {
  // the times, from a virtual run of synthetic-full
  await open("full", ["t=0"]);
  const T = await tab.evaluate(() => {
    const p = window.__live.played, cuts = window.__live.report().cuts;
    // the place-1 verdict: the first card, or the last with sealed envelopes (opened 3 → 2 → 1)
    const v1 = p.envelopes?.length ? p.beats.filter((b) => b.type === "verdict").at(-1) : p.beats.find((b) => b.type === "verdict");
    const lastCard = cuts.filter((c) => c.tag === "cards:verdict" && c.kind === "card" && c.t >= v1.at && c.t < v1.at + 40).at(-1);
    const changed = p.reveals.find((x) => x.judge === "fable-5.1" && x.team === "team-003");
    const abstain = p.reveals.find((x) => !x.team);
    const ceiling = p.hosts.find((h) => h.type === "ceiling");
    return { verdict: lastCard.t + 1.0, changed: changed.at + 2.0, abstain: abstain.at + 1.2, ceiling: ceiling.t0 + 1.5, awayHost: p.hosts.find((h) => h.type === "unavailable")?.t0 + 3.0 };
  });
  console.log("\nmoments (synthetic-full):", JSON.stringify(T));
  if (stillsDir) {
    await mkdir(stillsDir, { recursive: true });
    for (const g of ["full", "lite"]) {
      for (const [k, t] of Object.entries(T)) {
        const f = await frameAt("full", Math.round(t * 10) / 10, g === "lite" ? ["gfx=lite"] : []);
        const file = join(stillsDir, `${k}-${g}.png`);
        await tab.screenshot({ path: file });
        console.log(`wrote ${file}  ${JSON.stringify(f)}`);
        if (g === "full") {
          if (k === "verdict") {
            const v = f.verdict[0];
            expect(v && v.reasons.length === 4 && v.against && v.bottom <= 1080, `verdict card: all 4 majority reasons, «Против», inside the frame (bottom ${v?.bottom})`);
          }
          if (k === "changed") expect(f.notes.some((n) => /Fable 5\.1: «Штрек» → «Горный поток»/.test(n)), "changed vote note on Fable's reveal");
          if (k === "abstain") expect(f.notes.some((n) => /Fable 5\.1 — не голосует \(п\. 10\.5\)/.test(n) && /3 из 4: один Судья недоступен/.test(n)), "abstain note with the reduced line");
          if (k === "abstain" || k === "awayHost") {
            expect(/Fable 5\.1 — недоступен/.test(f.bug), `${k}: the corner header says Fable is out`);
            expect(!f.lowers.some((x) => /Fable/.test(x)), `${k}: no lower third on Fable`);
          }
          if (k === "ceiling") expect(/9\.3/.test(f.subs) || /потолок/.test(f.subs) || /Рудник/.test(f.subs), "ceiling line in the subtitles");
        }
      }
    }
  }
  if (bench) {
    for (const g of ["full", "lite"]) {
      await open("full", [`t=${Math.round(T.verdict * 10) / 10}`, ...(g === "lite" ? ["gfx=lite"] : [])]);
      const r = await tab.evaluate(() => window.__stage.bench(120));
      const limit = g === "full" ? 20 : 10;
      expect(r.msPerFrame <= limit, `bench ${g} at the place-1 verdict: ${r.msPerFrame.toFixed(2)} ms/frame (≤ ${limit})`);
    }
  }
}
console.log(errors.length ? `console errors (${errors.length})` : "");
await browser.close();
server.close();
process.exit(failed ? 1 : 0);
