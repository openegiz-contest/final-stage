// The Finalist codes on the Stage (ui/codes.js, ADR-0010), checked in show.html on a recording:
//   node contest/stage/test/codes-check.mjs [--program <url>] [--replay <url>] [--out <dir>]
//     [--monitors <url>] [--pub <Final Materials dir>] [--stills <dir>] [--only monitors]
// A mock TTS service (?tts=) records every /synth request and answers with silence and word timings.
// Checks, over the broadcast's virtual plan (?t=):
//   - the subtitles (the DOM of .subs and .say, every 0.25 s of the debate) and the /synth requests name
//     no Finalist and no team id in a Judge's line before the first envelope opens; the Host's lines
//     before it name none either, but for the ceiling line of place 1 (a rule known before the Final)
//   - every code used is mapped by the Host at an envelope, and every coded Finalist's name is on screen
//     after the first envelope
//   - a reload draws the same codes; a resume (?from=) plays the same coded lines from there
//   - the monitors (ui/veil.js), on --replay and on --monitors (a recording with the Judges' reading on
//     their consoles): from the debate's start until the first envelope, no text drawn into a texture a
//     console shows (main monitor's header and body, side monitor; followed through every canvas drawn
//     into it) names a Finalist or a team id, and every picture reaches a console only through a canvas
//     at most 64 px wide (the blur path, SOFT_W = 48); from the first envelope on the originals show (a name
//     or a team id, a picture at full size); a jump back over the envelope veils again
//   - the page's visible DOM text, every second of the debate before the first envelope: no Finalist,
//     no team id, but for the ceiling of place 1 (the Host's line and the corner note: a rule known
//     before the Final, never beside a code)
// Stills of a coded speech line and of the mapping at an envelope (1920×1080) go to --out; monitor
// close-ups, each as it aired before the veil and veiled, to --stills (out/monitor-codes).
import { createServer } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { extname, join, dirname, sep, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const STAGE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SITE_3D = join(dirname(STAGE), "site", "assets", "3d");
const argv = process.argv.slice(2);
const opt = (k, d) => argv.flatMap((a, i) => (a === `--${k}` ? [argv[i + 1]] : []))[0] ?? d;
const programUrl = opt("program", "test/program/fixture/program.json");
const replayUrl = opt("replay", "test/replays/real-live-probe-20261021b.jsonl");
const out = resolve(opt("out", join(STAGE, "out", "v8-codes")));
// monitor-codes: a recording with console activity, the Final Materials as /pub/ (the pictures)
const monitorsUrl = opt("monitors", "test/replays/real-live-probe-20261021.jsonl");
const FIXTURE_PUB = join(process.env.HOME ?? "", "Projects", "openegiz-judge", "runs", "final-fixture");
const PUB = opt("pub", null) ? resolve(opt("pub")) : existsSync(join(FIXTURE_PUB, "publication")) ? FIXTURE_PUB : null;
const stillsDir = resolve(opt("stills", join(STAGE, "out", "monitor-codes")));
const only = opt("only", null);

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

// ---- the mock TTS service: silence of a plausible length, one timing per word
const synth = []; // { speaker, text }
function silentWav(seconds) {
  const rate = 8000, n = Math.max(1, Math.round(seconds * rate)), b = Buffer.alloc(44 + n, 128);
  b.write("RIFF", 0); b.writeUInt32LE(36 + n, 4); b.write("WAVEfmt ", 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate, 28); b.writeUInt16LE(1, 32); b.writeUInt16LE(8, 34); b.write("data", 36); b.writeUInt32LE(n, 40);
  return b;
}
function synthAnswer(text) {
  const words = [];
  let t = 0.1;
  for (const m of text.matchAll(/\S+/g)) {
    words.push({ start_char: m.index, end_char: m.index + m[0].length, start_s: t, end_s: t + 0.28 });
    t += 0.36;
  }
  const d = Math.round((t + 0.2) * 100) / 100;
  return { audio: `/tts/audio/${d}.wav`, duration_s: d, words, engine: "mock", voice: "mock", format: "wav", cached: false };
}

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".png": "image/png", ".jpg": "image/jpeg",
  ".json": "application/json", ".jsonl": "application/x-ndjson", ".woff2": "font/woff2", ".svg": "image/svg+xml", ".glb": "model/gltf-binary", ".mp4": "video/mp4", ".mp3": "audio/mpeg" };
const server = createServer(async (req, res) => {
  if (req.url === "/favicon.ico") return res.writeHead(204).end();
  try {
    const u = new URL(req.url, "http://x"), url = decodeURIComponent(u.pathname);
    const cors = { "access-control-allow-origin": "*" };
    if (url === "/tts/synth") {
      const speaker = u.searchParams.get("speaker"), text = u.searchParams.get("text");
      synth.push({ speaker, text });
      return res.writeHead(200, { ...cors, "content-type": "application/json" }).end(JSON.stringify(synthAnswer(text)));
    }
    if (url.startsWith("/tts/audio/")) return res.writeHead(200, { ...cors, "content-type": "audio/wav" }).end(silentWav(Number.parseFloat(url.slice(11))));
    if (url.startsWith("/run/")) return res.writeHead(502).end();
    const [root, rest] = url.startsWith("/vendor/three/") ? [join(SITE_3D, "three"), url.slice(14)]
      : url.startsWith("/vendor/mine/") ? [SITE_3D, url.slice(13)]
      : PUB && url.startsWith("/pub/") ? [PUB, url.slice(5)] : [STAGE, url.slice(1)];
    const path = resolve(root, rest);
    if (!path.startsWith(root + sep)) throw new Error("outside root");
    const body = await readFile(path), headers = { "content-type": TYPES[extname(path)] || "application/octet-stream", "accept-ranges": "bytes" };
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
    if (!m || !(m[1] || m[2])) return res.writeHead(200, headers).end(body);
    const a = m[1] ? Number(m[1]) : Math.max(0, body.length - Number(m[2])), b = m[1] && m[2] ? Math.min(Number(m[2]), body.length - 1) : body.length - 1;
    res.writeHead(206, { ...headers, "content-range": `bytes ${a}-${b}/${body.length}` }).end(body.subarray(a, b + 1));
  } catch {
    res.writeHead(404).end();
  }
}).listen(0);
const base = `http://localhost:${server.address().port}`;
const { chromium } = playwright();
const browser = await chromium.launch({ channel: "chrome", args: ["--headless=new", "--ignore-gpu-blocklist", "--enable-gpu", "--use-angle=metal", "--autoplay-policy=no-user-gesture-required"] });
const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
// monitor-codes: every 2D canvas keeps what was drawn into it since its last opaque clear: the texts, and
// each drawImage's source (a canvas: followed; a picture: its URL and this canvas's width)
await ctx.addInitScript(() => {
  const P = CanvasRenderingContext2D.prototype;
  const fresh = (c) => (c.__rec = { texts: [], draws: [] });
  const rec = (c) => c.__rec ?? fresh(c);
  const { fillRect, fillText, drawImage } = P;
  P.fillRect = function (x, y, w, h) {
    const c = this.canvas;
    if (x <= 0 && y <= 0 && w >= c.width && h >= c.height && this.globalCompositeOperation === "source-over" && /^#/.test(String(this.fillStyle)) && this.getTransform().isIdentity) fresh(c);
    return fillRect.apply(this, arguments);
  };
  P.fillText = function (text) {
    rec(this.canvas).texts.push(String(text));
    return fillText.apply(this, arguments);
  };
  P.drawImage = function (src) {
    const r = rec(this.canvas);
    if (src instanceof HTMLCanvasElement) r.draws.push({ canvas: src });
    else r.draws.push({ src: src?.currentSrc || src?.src || String(src?.constructor?.name), intoW: this.canvas.width });
    return drawImage.apply(this, arguments);
  };
});
const tab = await ctx.newPage();
const errors = [];
tab.on("console", (m) => m.type() === "error" && errors.push(m.text()));
tab.on("pageerror", (e) => errors.push(e.message));
await mkdir(out, { recursive: true });
let failed = false;
const expect = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failed = true;
};

async function open(extra = [], replay = replayUrl) {
  synth.length = 0;
  const q = [`program=${programUrl}`, `replay=${replay}`, `tts=${base}/tts`, "t=0", ...extra].join("&");
  await tab.goto(`${base}/show.html?${q}`);
  await tab.waitForFunction(() => window.__stage?.ready === true, null, { timeout: 300000 });
  return tab.evaluate(() => {
    const L = window.__live, c = L.codes;
    return {
      D: window.__program.debateAt, duration: window.__frame.duration,
      finalists: L.director.planner.finalists.map((f) => ({ team: f.team, name: f.name })),
      codes: c.coder ? [...c.coder.codes] : null, used: [...c.used], maps: c.maps, original: [...c.original],
      says: L.played.says.map((s) => ({ n: s.n, speaker: s.speaker, text: s.text, t0: s.t0, end: s.end })),
      hosts: L.played.hosts.map((h) => ({ n: h.n, type: h.type, text: h.text, t0: h.t0 })),
      envelopes: L.played.envelopes, check: L.check(),
    };
  });
}
const seek = (t) => tab.evaluate(async (t) => await window.__stage.seek(t), t);

let full = null, synthFull = [];
if (only !== "monitors") {
// ---- the full broadcast
full = await open();
synthFull = [...synth];
const names = full.finalists.map((f) => f.name);
// a name's first five letters at a word's start, capitalised as the Team writes it (a lowercase «штрек» is the mine's)
const stems = full.finalists.map((f) => f.name.split(" ")[0].slice(0, 5).replace(/[ёе]/g, "[её]"));
const NAMED = new RegExp(`(?<![\\p{L}])(${stems.join("|")})|team-\\d{3}`, "u");
const open1 = full.envelopes.find((e) => e.stage === "open");
const T = open1?.at;
console.log(`debate from ${full.D}, first envelope opens at ${T}, ${full.says.length} Judges' lines, ${full.original.length} coded`);
console.log(`codes: ${full.codes?.map(([t, l]) => `${t}=${l}`).join(" ")}`);
expect(T != null && T > full.D, "an envelope opens after the debate");
expect(full.check.verbatim && full.check.coded === full.original.length && full.check.coded > 0, `check(): every line verbatim but for its codes (${full.check.coded} coded)`);

// 1) what was played: the Judges' lines before T, and the Host's
const saysBefore = full.says.filter((s) => s.t0 < T);
const ceiling = new Set(full.hosts.filter((h) => h.type === "ceiling").map((h) => h.text));
const hostsBefore = full.hosts.filter((h) => h.t0 >= full.D && h.t0 < T);
expect(saysBefore.length === full.says.length, `every Judge's message plays before the first envelope (${saysBefore.length})`);
expect(saysBefore.every((s) => !NAMED.test(s.text)), "no Finalist or team id in a Judge's line before the first envelope");
const hostNamed = hostsBefore.filter((h) => NAMED.test(h.text));
expect(hostNamed.every((h) => ceiling.has(h.text)), `the Host names no Finalist before the first envelope but in the ceiling line (${hostNamed.length} ceiling line(s))`);
for (const h of hostNamed) console.log(`     ceiling: ${h.text}`);

// 2) the /synth requests: the coded lines, never an original; a name only in a line said outside the debate's
// coded part (the preshow, the ceiling line, from the first envelope on)
const reqTexts = new Set(synthFull.map((r) => r.text));
const originals = new Set(full.original.map(([, t]) => t));
expect(saysBefore.every((s) => reqTexts.has(s.text)), `every Judge's line went to the voice coded (${synthFull.length} /synth requests)`);
expect(![...originals].some((t) => reqTexts.has(t)), "no original (uncoded) Judge's line went to the voice");
const judgeIds = new Set(["opus-5.5", "sonnet-5.5", "fable-5.1", "gpt-6.1-sol", "gpt-6-astra"]);
const debateBefore = new Set([...saysBefore.map((s) => s.text), ...hostsBefore.filter((h) => !ceiling.has(h.text)).map((h) => h.text)]);
const leaked = synthFull.filter((r) => debateBefore.has(r.text) && NAMED.test(r.text));
expect(!leaked.length, `no /synth request of a line before the first envelope names a Finalist (${leaked.length})`);
const judgeNamed = synthFull.filter((r) => judgeIds.has(r.speaker) && NAMED.test(r.text));
console.log(`     /synth: ${synthFull.length} requests, ${synthFull.filter((r) => judgeIds.has(r.speaker)).length} Judges'; ${judgeNamed.length} Judges' requests name a Finalist (vote reasons, read at the envelopes)`);

// 3) the subtitles on screen, every 0.25 s of the debate
const NAMED_SRC = NAMED.source;
const sweep = await tab.evaluate(({ from, to, T, src }) => {
  const re = new RegExp(src, "u"), subs = window.__program.subs;
  const text = () => [...document.querySelectorAll(".subs, .say")].map((e) => e.textContent).join(" | ");
  const bad = [], after = new Set();
  let n = 0;
  for (let t = from; t < to; t = Math.round((t + 0.25) * 100) / 100) {
    subs.update(t);
    const s = subs.shown;
    if (!s) continue;
    n++;
    const on = text();
    if (t < T && re.test(on) && s.id !== "host") bad.push({ t, on: on.slice(0, 160) });
    if (t < T && re.test(on) && s.id === "host") after.add(`host<T:${s.text}`);
    if (t >= T) after.add(on);
  }
  return { n, bad, after: [...after] };
}, { from: full.D, to: full.duration, T, src: NAMED_SRC });
expect(!sweep.bad.length, `the subtitles (${sweep.n} moments with a line): no Finalist in a Judge's line before the first envelope`);
for (const b of sweep.bad.slice(0, 5)) console.log(`     t=${b.t}: ${b.on}`);
const shownAfter = sweep.after.filter((x) => !x.startsWith("host<T:")).join("\n");
const usedNames = full.used.map((t) => full.finalists.find((f) => f.team === t).name);
const missing = usedNames.filter((n) => !shownAfter.includes(n));
expect(!missing.length, `every coded Finalist's name is in the subtitles after the first envelope (${usedNames.join(", ")})${missing.length ? `; missing ${missing.join(", ")}` : ""}`);
const mappedCodes = full.maps.flatMap((m) => m.pairs.map(([c]) => c));
expect(mappedCodes.length === full.used.length && new Set(mappedCodes).size === mappedCodes.length, `every code used is mapped once at the envelopes (${full.maps.map((m) => `place ${m.place}: ${m.pairs.map((p) => p.join(" — ")).join(", ")}`).join("; ")})`);

// 4) stills: a coded speech line (the camera on the Judge), the mapping at the first envelope
async function still(name, t) {
  await seek(t);
  await tab.screenshot({ path: join(out, `${name}.png`) });
  console.log(`     still ${name}.png at t=${t}`);
}
const sayAt = await tab.evaluate(({ from, to }) => {
  const subs = window.__program.subs;
  for (let t = from; t < to; t = Math.round((t + 0.5) * 100) / 100) {
    subs.update(t);
    if (subs.shown?.mode === "say" && /Финалист/.test(subs.shown.text)) return t;
  }
  return null;
}, { from: full.D, to: T });
if (sayAt != null) await still("coded-say", sayAt + 0.3);
const barAt = await tab.evaluate(({ from, to }) => {
  const subs = window.__program.subs;
  for (let t = from; t < to; t = Math.round((t + 0.5) * 100) / 100) {
    subs.update(t);
    if (subs.shown?.mode === "bar" && subs.shown.id !== "host" && /Финалист/.test(subs.shown.text)) return t;
  }
  return null;
}, { from: full.D, to: T });
if (barAt != null) await still("coded-bar", barAt + 0.3);
const mapAt = await tab.evaluate(({ from, to }) => {
  const subs = window.__program.subs;
  for (let t = from; t < to; t = Math.round((t + 0.25) * 100) / 100) {
    subs.update(t);
    if (/Коды? из реплик/.test(subs.shown?.text ?? "") || /^Финалист [A-Z] — /.test(subs.shown?.text ?? "")) return t;
  }
  return null;
}, { from: T, to: T + 60 });
expect(mapAt != null, `the Host's mapping is in the subtitles at the first envelope (t=${mapAt})`);
if (mapAt != null) await still("mapping-envelope", mapAt + 0.5);

// 5) a reload draws the same codes; a resume from the middle of the debate plays the same coded lines
const again = await open();
expect(JSON.stringify(again.codes) === JSON.stringify(full.codes), "a reload draws the same codes");
const from = full.says[Math.floor(full.says.length / 2)].n;
const resumed = await open([`from=${from}`]);
expect(JSON.stringify(resumed.codes) === JSON.stringify(full.codes), `?from=${from}: the same codes`);
const tail = (r) => r.says.filter((s) => s.n >= from).map((s) => s.text);
expect(JSON.stringify(tail(resumed)) === JSON.stringify(tail(full)) && tail(full).length > 0, `?from=${from}: the same ${tail(full).length} coded lines from there`);
const tailMaps = JSON.stringify(resumed.maps) === JSON.stringify(full.maps);
expect(tailMaps, "?from=: the same mapping at the envelopes");

}

// ---- 6) the monitors (ui/veil.js) and the page's visible text, on each recording
const SOFT_MAX = 64; // px: a picture drawn into a canvas wider than this is sharp (world/screen.js SOFT_W = 48)
const namedOf = (finalists) => new RegExp(`(?<![\\p{L}])(${finalists.map((f) => f.name.split(" ")[0].slice(0, 5).replace(/[ёе]/g, "[её]")).join("|")})|team-\\d{3}`, "u");
async function monitors(replay, { stills = false } = {}) {
  const r = await open([], replay);
  const T = r.envelopes.find((e) => e.stage === "open")?.at;
  const NAMED = namedOf(r.finalists);
  const tag = replay.split("/").at(-1);
  console.log(`-- monitors on ${tag}: debate from ${r.D}, first envelope at ${T}, show ends ${r.duration}${PUB ? `, /pub/ = ${PUB}` : ", no /pub/ (pictures not served)"}`);
  const sweep = await tab.evaluate(async ({ T, D, end, src, SOFT_MAX }) => {
    const NAMED = new RegExp(src, "u");
    const st = window.__frame.stage, veil = window.__live.veil;
    await st.ready();
    const desks = Object.entries(st.desks);
    // the canvases a console shows now: main header (1600×92), main body (1600×…), side (800×480)
    const bound = (d) => {
      const out = [];
      d.object3d.traverse((o) => o.isMesh && o.material?.map?.image instanceof HTMLCanvasElement && out.push(o.material.map.image));
      return out;
    };
    const kindOf = (c) => (c.width === 800 ? "side" : c.height === 92 ? "head" : "body");
    const prov = (c, seen = new Set()) => {
      const o = { texts: [], pictures: [] };
      if (!c || seen.has(c) || !c.__rec) return o;
      seen.add(c);
      o.texts.push(...c.__rec.texts);
      for (const d of c.__rec.draws) {
        if (d.canvas) {
          const sub = prov(d.canvas, seen);
          o.texts.push(...sub.texts);
          o.pictures.push(...sub.pictures);
        } else o.pictures.push(d);
      }
      return o;
    };
    const sample = (t) => desks.flatMap(([id, d]) => (d.update(t), bound(d).map((c) => ({ id, kind: kindOf(c), ...prov(c) }))));
    const after = { n: 0, named: 0, sharp: 0, examples: [] };
    for (let t = T; t <= end; t = Math.round((t + 2) * 100) / 100) {
      for (const x of sample(t)) {
        after.n++;
        const hit = x.texts.find((s) => NAMED.test(s));
        if (hit) (after.named++, after.examples.length < 3 && after.examples.push(`${x.id} ${x.kind}: ${hit.slice(0, 120)}`));
        if (x.pictures.some((p) => p.intoW > SOFT_MAX)) after.sharp++;
      }
    }
    // then back over the envelope: the debate again, veiled (the cache must not serve the originals)
    const before = { n: 0, named: 0, sharp: 0, soft: 0, coded: 0, texts: 0, bad: [], sharpOnes: [], pictures: new Set(), kinds: {} };
    for (let t = D; t < T; t = Math.round((t + 0.5) * 100) / 100) {
      for (const x of sample(t)) {
        before.n++;
        before.texts += x.texts.length;
        const hit = x.texts.find((s) => NAMED.test(s));
        if (hit) (before.named++, before.bad.length < 8 && before.bad.push(`t=${t} ${x.id} ${x.kind}: ${hit.slice(0, 140)}`));
        if (x.texts.some((s) => /Финалист[а-я]* [A-Z]/.test(s))) (before.coded++, (before.kinds[x.kind] = (before.kinds[x.kind] ?? 0) + 1));
        for (const p of x.pictures) {
          if (p.intoW > SOFT_MAX) (before.sharp++, before.sharpOnes.length < 5 && before.sharpOnes.push(`t=${t} ${x.id}: ${p.src} into ${p.intoW} px`));
          else (before.soft++, before.pictures.add(p.src));
        }
      }
    }
    return { openAt: veil.openAt, from: D, after, before: { ...before, pictures: before.pictures.size } };
  }, { T, D: r.D, end: r.duration, src: NAMED.source, SOFT_MAX });
  const b = sweep.before, a = sweep.after;
  expect(Math.abs(sweep.openAt - T) < 1e-6, `${tag}: the veil opens with the first envelope (${sweep.openAt})`);
  expect(b.named === 0, `${tag}: monitors before the first envelope: no Finalist or team id in any text drawn (${b.n} console textures over the debate, ${b.texts} texts, ${b.coded} with a code: ${JSON.stringify(b.kinds)})`);
  for (const x of b.bad) console.log(`     ${x}`);
  expect(b.sharp === 0, `${tag}: monitors before the first envelope: every picture through the blur path (${b.soft} soft draws of ${b.pictures} pictures, ${b.sharp} sharp)`);
  for (const x of b.sharpOnes) console.log(`     ${x}`);
  expect(a.named > 0 || a.sharp > 0, `${tag}: from the first envelope on the monitors show the originals (${a.named} of ${a.n} textures name a Finalist or a team id, ${a.sharp} pictures at full size)`);
  for (const x of a.examples) console.log(`     after: ${x}`);
  if (stills) {
    expect(b.coded > 0 && (!PUB || b.pictures > 0), `${tag}: the recording's consoles were veiled for real (${b.coded} coded textures, ${b.pictures} pictures blurred)`);
    await closeups(T, r.D, tag);
  }

  // the page's visible text, every second of the debate before the envelope
  const dom = { n: 0, bad: [], exempt: new Set() };
  const ceiling = new Set(r.hosts.filter((h) => h.type === "ceiling").map((h) => h.text));
  for (let t = Math.ceil(r.D); t < T; t += 1) {
    await seek(t);
    const got = await tab.evaluate(({ src, ceiling }) => {
      const NAMED = new RegExp(src, "u"), shown = window.__program?.subs?.shown, sp = (x) => String(x).replace(/\s+/g, " ").trim();
      const out = [];
      const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let n; (n = w.nextNode());) {
        const s = n.textContent.trim(), el = n.parentElement;
        if (!s || !el || !NAMED.test(s) || !el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
        const why = el.closest(".cd-bug-note") ? "corner note on the ceiling" : el.closest(".subs, .say") && shown?.id === "host" && ceiling.some((c) => sp(c).includes(sp(shown.text))) ? "the Host's ceiling line" : null;
        out.push({ s: s.slice(0, 140), why, cls: el.className });
      }
      return out;
    }, { src: NAMED.source, ceiling: [...ceiling] });
    dom.n++;
    for (const x of got) {
      if (x.why) dom.exempt.add(`${x.why}: ${x.s}`);
      else if (dom.bad.length < 8) dom.bad.push(`t=${t} .${x.cls}: ${x.s}`);
    }
  }
  expect(!dom.bad.length, `${tag}: the page's visible text names no Finalist and no team id before the first envelope (${dom.n} moments)`);
  for (const x of dom.bad) console.log(`     ${x}`);
  for (const x of [...dom.exempt].slice(0, 6)) console.log(`     kept (no code beside it): ${x}`);
}

// a monitor close-up of a picture and of a file, each as it aired before the veil and veiled
async function closeups(T, D, tag) {
  await mkdir(stillsDir, { recursive: true });
  const picks = await tab.evaluate(({ T, D }) => {
    const st = window.__frame.stage, cuts = window.__live.planner.report(T).cuts;
    const out = {};
    const rank = (k) => (k === "screen" ? 0 : 1);
    const cands = cuts.map((c, i) => ({ ...c, next: cuts[i + 1]?.t ?? T })).filter((c) => (c.kind === "screen" || c.kind === "ots") && c.id && c.t >= D && c.t < T && c.next - c.t > 1.2)
      .sort((a, b) => rank(a.kind) - rank(b.kind) || a.t - b.t);
    for (const c of cands) {
      const t = Math.round((c.t + Math.min(1.5, (c.next - c.t) / 2)) * 100) / 100;
      const d = st.desks[c.id];
      d.update(t);
      let body = null;
      d.object3d.traverse((o) => o.isMesh && o.material?.map?.image?.width === 1600 && o.material.map.image.height !== 92 && (body = o.material.map.image));
      const pictured = (c) => !!c?.__rec?.draws.some((x) => x.src || pictured(x.canvas));
      const texts = (c) => (c?.__rec ? c.__rec.texts.length + c.__rec.draws.reduce((n, x) => n + texts(x.canvas), 0) : 0);
      const kind = pictured(body) ? "image" : texts(body) > 3 ? "text" : null;
      if (kind === "image" && !out.image) out.image = { t, id: c.id, shot: c.kind };
      if (kind === "text" && !out.text) out.text = { t, id: c.id, shot: c.kind };
    }
    return out;
  }, { T, D });
  for (const [kind, p] of Object.entries(picks)) {
    for (const [name, force] of [["before", false], ["after", null]]) {
      await tab.evaluate((f) => (window.__live.veil.override = f), force);
      await seek(p.t);
      await tab.waitForTimeout(150);
      const file = `${kind}-${name}.png`;
      await tab.screenshot({ path: join(stillsDir, file) });
      console.log(`     still ${file}: ${p.id}'s monitor (${p.shot}) at t=${p.t}${name === "before" ? ", as it aired before the veil" : ", veiled"}`);
    }
  }
  await tab.evaluate(() => (window.__live.veil.override = null));
  expect(!!picks.image || !PUB, `${tag}: a close-up of a monitor with a picture before the first envelope (${picks.image ? `t=${picks.image.t}` : "none"})`);
}

for (const [replay, stills] of [[replayUrl, false], [monitorsUrl, true]]) await monitors(replay, { stills });
expect(!errors.length, `console errors: ${errors.length}`);
for (const e of errors.slice(0, 5)) console.log("     " + e);
if (full) await writeFile(join(out, "codes-check.json"), JSON.stringify({ programUrl, replayUrl, codes: full.codes, maps: full.maps, says: full.says, synth: synthFull }, null, 1));
await browser.close();
server.close();
console.log(failed ? "FAIL" : "all ok");
process.exit(failed ? 1 : 0);
