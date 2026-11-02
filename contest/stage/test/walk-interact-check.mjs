// The Walk's interactions (ui/walk-interact.js) on the real GPU, one browser, one page (test/walk-interact.html,
// a mock walk emitting the clicks), against the fixture publication served read-only as /pub/ the way
// `server.py --pub <run>/materials` serves it (/pub/publication/…, /pub/teams/…):
//   node contest/stage/test/walk-interact-check.mjs [--pub <run dir with publication/ and teams/>] [--out <dir>]
// Proves: each kind does its effect (judge: a wordless reaction and its card; in a hold the three
// Qualifying Judges say their reason; console: the cited screenshots and references on the monitor;
// wall: the Finalist's video, screenshots and Concept, else the list; urns: the Host says the rules
// paragraph of the intro, else a card); a quote is the scores JSON's text, string-equal; Sonnet and Fable
// never speak; in phase "debate" nothing speaks; busy blocks re-entry while a line may be said, a
// wordless reaction gives way to the next click; the Walk switched off stops a line; a jump of the show
// clock undoes what is still playing; under ?cams=1 nothing of the layer touches the webcam circles; the card never
// writes a version that is not in state.json. Stills of each interaction go to --out
// (default contest/stage/out/walk-interact/). Exit 1 on a failure or a console error.
// The /synth service and /run/state.json are mocks here (SYNTHETIC: a tone per word, CLI versions
// that no roster carries), so the check needs no TTS service and no engine.
import { createServer } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { extname, join, dirname, sep, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { homedir } from "node:os";

const STAGE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SITE_3D = join(dirname(STAGE), "site", "assets", "3d");
const argv = process.argv.slice(2);
const opt = (k, d) => argv.flatMap((a, i) => (a === `--${k}` ? [argv[i + 1]] : []))[0] ?? d;
const PUB = resolve(opt("pub", join(homedir(), "Projects/openegiz-judge/runs/final-fixture")));
const PROGRAM_DIR = resolve(opt("program-dir", join(STAGE, "test/program/fixture")));
const out = resolve(opt("out", join(STAGE, "out", "walk-interact")));
const HOLD_TEAM = opt("team", "team-007"); // the fixture's Finalist with a Stand video

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
  throw new Error("playwright-core not found (set PLAYWRIGHT_CORE)");
}

// ---- the expected values, from the files themselves
const json = async (p) => JSON.parse(await readFile(p, "utf8"));
const scorePath = (team, judge) => join(PUB, "publication/solutions", team, "scores", `${judge}.json`);
/** the highest-weight criterion's reason (the first on a tie), trimmed: what the Judge must say */
async function expectedReason(team, judge) {
  const s = await json(scorePath(team, judge));
  let best = null;
  for (const c of s.criteria) if (typeof c.reasoning === "string" && c.reasoning.trim() && (!best || c.max > best.max)) best = c;
  return best.reasoning.trim();
}
async function citedShots(team, judge) {
  const s = await json(scorePath(team, judge));
  const shots = [];
  for (const c of s.criteria) for (const r of c.references) if (r.startsWith("screenshot:") && !shots.includes(r.slice(11))) shots.push(r.slice(11));
  return shots.map((n) => `/pub/publication/solutions/${team}/screenshots/${judge}/${n}`);
}
// the Concept as tools/build.py concept_section reads it (the oracle, never a copy of the module's parser)
const pyConcepts = (mds) => JSON.parse(execFileSync("python3", ["-c", [
  "import sys, json; sys.path.insert(0, sys.argv[1]); import build",
  "print(json.dumps([build.concept_section(m) for m in json.load(sys.stdin)]))",
].join("\n"), join(STAGE, "tools")], { input: JSON.stringify(mds), encoding: "utf8" }));
async function expectedConcept(team) {
  return pyConcepts([await readFile(join(PUB, "teams", team, "source/src/SUBMISSION.md"), "utf8")])[0];
}
// SUBMISSION.md shapes where a "first ## section" reading and build.py part ways
const CONCEPT_CASES = [
  "# Команда\n\n## Состав\n\nА, Б\n\n## Замысел\n\nДвойник смены.\n\n## Модули\n\n- М1\n",
  "## 1. Concept\n\nIdea <!-- draft -->here.\n\n```md\n## not a heading\n```\nafter the fence\n# Next\n",
  "## Тұжырымдама\r\n\r\nМәтін.\r\n## Модульдер\r\n",
  "## Замыселы\n\nне раздел\n",
  "## Concept\n\n<!-- empty -->\n## Next\n",
  "no headings at all",
];
// the accepted intro of tools/build.py (its «Правила голосования» paragraph is what the Host must say)
const program = await json(join(PROGRAM_DIR, "program.json"));
const buildIntro = execFileSync("python3", ["-c", [
  "import sys, json; sys.path.insert(0, sys.argv[1]); import build",
  "p = json.load(open(sys.argv[2]))",
  "print(build.intro_text(p['finalists'], 40), end='')",
].join("\n"), join(STAGE, "tools"), join(PROGRAM_DIR, "program.json")], { encoding: "utf8" });
const buildRules = (() => {
  const paras = buildIntro.split(/\n\s*\n/).map((p) => p.trim());
  const i = paras.findIndex((p) => p.startsWith("Правила голосования."));
  return [paras[i], ...(/потол/i.test(paras[i + 1] ?? "") ? [paras[i + 1]] : [])].join("\n\n");
})();

// ---- the synthetic engine state and the /synth mock
const STATE = {
  synthetic: true, status: "running",
  judges: [
    { name: "opus-5.5", agent: "claude", model: "claude-opus-5-5", cli: "Claude Code 2.1.308", status: "ждёт" },
    { name: "sonnet-5.5", agent: "claude", model: "claude-sonnet-5-5", cli: "Claude Code 2.1.308", status: "ждёт" },
    { name: "fable-5.1", agent: "claude", model: "claude-fable-5-1", cli: "Claude Code 2.1.308", status: "ждёт" },
    { name: "gpt-6.1-sol", agent: "codex", model: "gpt-6.1-sol", cli: "codex-cli 0.161.2", status: "ждёт" },
    { name: "gpt-6-astra", agent: "codex", model: "gpt-6-astra", cli: "codex-cli 0.161.2", status: "ждёт" },
  ],
  settings: { rounds_per_place: 3 }, finalists: [], transcript: [], votes: [], placements: [],
};
const synth = []; // { speaker, text }
const wavs = new Map();
function wavOf(text) {
  const sr = 22050, words = [...text.matchAll(/\S+/g)];
  const W = 0.3, dur = 0.2 + words.length * W + 0.1, n = Math.ceil(dur * sr);
  const buf = Buffer.alloc(44 + n * 2);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write("WAVE", 8); buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(sr, 24);
  buf.writeUInt32LE(sr * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write("data", 36); buf.writeUInt32LE(n * 2, 40);
  const timing = words.map((m, i) => ({ start_char: m.index, end_char: m.index + m[0].length, start_s: 0.2 + i * W, end_s: 0.2 + i * W + 0.24 }));
  for (let k = 0; k < n; k++) {
    const t = k / sr, on = timing.some((w) => t >= w.start_s && t < w.end_s);
    buf.writeInt16LE(on ? Math.round(5000 * Math.sin(2 * Math.PI * 190 * t)) : 0, 44 + k * 2);
  }
  return { buf, words: timing, dur };
}

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".png": "image/png", ".jpg": "image/jpeg",
  ".json": "application/json", ".jsonl": "application/x-ndjson", ".woff2": "font/woff2", ".svg": "image/svg+xml", ".glb": "model/gltf-binary",
  ".mp4": "video/mp4", ".mp3": "audio/mpeg", ".wav": "audio/wav", ".md": "text/markdown; charset=utf-8" };
const served = []; // /pub/ paths asked for (the module never lists a folder)
const missing = []; // /pub/ and /nopub/ paths answered 404 (the layout probe's, step 12)
const server = createServer(async (req, res) => {
  if (req.url === "/favicon.ico") return res.writeHead(204).end();
  let url = "";
  try {
    const u = new URL(req.url, "http://x");
    url = decodeURIComponent(u.pathname);
    if (url === "/run/state.json") return res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify(STATE));
    if (url.startsWith("/run/")) return res.writeHead(404).end();
    if (url === "/synth") {
      const speaker = u.searchParams.get("speaker"), text = u.searchParams.get("text");
      synth.push({ speaker, text });
      const k = String(wavs.size);
      const w = wavOf(text);
      wavs.set(k, w.buf);
      return res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*" })
        .end(JSON.stringify({ audio: `/synth-audio/${k}.wav`, words: w.words, duration_s: w.dur, engine: "mock", voice: speaker, cached: false }));
    }
    if (url.startsWith("/synth-audio/")) return res.writeHead(200, { "content-type": "audio/wav" }).end(wavs.get(url.slice(13, -4)));
    let root, rest;
    if (url.startsWith("/vendor/three/")) [root, rest] = [join(SITE_3D, "three"), url.slice(14)];
    else if (url.startsWith("/vendor/mine/")) [root, rest] = [SITE_3D, url.slice(13)];
    else if (url.startsWith("/pub/")) {
      [root, rest] = [PUB, url.slice(5)];
      served.push(url);
    } else if (url.startsWith("/program/")) [root, rest] = [PROGRAM_DIR, url.slice(9)];
    else [root, rest] = [STAGE, url.slice(1)];
    const path = resolve(root, rest);
    if (!path.startsWith(root + sep)) throw new Error("outside root");
    const body = await readFile(path), headers = { "content-type": TYPES[extname(path)] || "application/octet-stream", "accept-ranges": "bytes" };
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
    if (!m || !(m[1] || m[2])) return res.writeHead(200, headers).end(body);
    const a = m[1] ? Number(m[1]) : Math.max(0, body.length - Number(m[2])), b = m[1] && m[2] ? Math.min(Number(m[2]), body.length - 1) : body.length - 1;
    res.writeHead(206, { ...headers, "content-range": `bytes ${a}-${b}/${body.length}` }).end(body.subarray(a, b + 1));
  } catch {
    if (/^\/(no)?pub\//.test(url)) missing.push(url);
    res.writeHead(404).end();
  }
}).listen(0);
const base = `http://localhost:${server.address().port}`;

const { chromium } = playwright();
const browser = await chromium.launch({ channel: "chrome", args: ["--headless=new", "--ignore-gpu-blocklist", "--enable-gpu", "--use-angle=metal", "--autoplay-policy=no-user-gesture-required"] });
const page = await (await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 })).newPage();
const errors = [];
// step 12's layout probes fail by design (one per attach where /pub/ is the publication itself, two with no /pub/):
// counted there, never as errors
const PROBES = new Set(["/pub/publication/publication/results.json", "/nopub/publication/results.json", "/nopub/results.json"]), probed = [];
page.on("console", (m) => {
  const at = m.location()?.url ? new URL(m.location().url, base).pathname : "";
  if (m.type() === "error" && /404/.test(m.text()) && PROBES.has(at)) return void probed.push(at);
  if (m.type() === "error") (errors.push(m.text()), console.log("  [error]", m.text()));
  else if (m.type() === "warning") console.log("  [warn]", m.text());
});
page.on("pageerror", (e) => (errors.push(e.message), console.log("  [pageerror]", e.message)));
page.on("response", (r) => r.status() >= 400 && console.log("  [http]", r.status(), r.url()));
await mkdir(out, { recursive: true });
let failed = false;
const expect = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failed = true;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const W = (fn, arg) => page.evaluate(fn, arg);
const lastLog = () => W(() => { const l = __wi.wi.log; return JSON.parse(JSON.stringify(l[l.length - 1] ?? null)); });
const idle = () => page.waitForFunction(() => !__wi.wi.active, null, { timeout: 60000 });
const still = async (name) => {
  await page.screenshot({ path: join(out, `${name}.png`) });
  stills.push(name);
};
const stills = [];
// under ?cams=1: nothing of the layer may touch a webcam circle (ui/safe.js hitsCams)
async function camsClear(what) {
  const bad = await W(() => __wi.wi.boxes().filter((b) => __wi.m && b.right > b.left && b.bottom > b.top)
    .filter((b) => { const c = [[190, 190], [1730, 190]]; return c.some(([cx, cy]) => { const x = Math.max(b.left, Math.min(cx, b.right)), y = Math.max(b.top, Math.min(cy, b.bottom)); return (x - cx) ** 2 + (y - cy) ** 2 < 150 ** 2; }); })
    .map((b) => `${b.cls} ${Math.round(b.left)},${Math.round(b.top)}–${Math.round(b.right)},${Math.round(b.bottom)}`));
  expect(bad.length === 0, `${what}: nothing under the cam circles${bad.length ? ` (${bad.join("; ")})` : ""}`);
}
const VERSION = /\d+\.\d+\.\d+/;

await page.goto(`${base}/test/walk-interact.html?cams=1&tts=${encodeURIComponent(base)}`);
await page.waitForFunction(() => window.__wi?.ready === true && window.__stage?.ready === true, null, { timeout: Number(process.env.READY_MS ?? 240000) });
console.log(`GPU: ${await W(() => __stage.info.gpu)}`);

// ---- the pure parts on cases the fixture does not have
{
  const r = await W(() => {
    const { clipQuote, reasonOf, sentences, rulesOf } = __wi.m;
    const long = "Модель шахты подробная: шестьдесят двойников связаны по горизонтам, и связи видны на схеме. Поведение правдоподобно, расход воздуха меняется с режимом вентиляторов. Сценарии есть, но только два, и оба про одно событие, т. е. охват узкий. Модули подключены по README, правило оповещения работает на Стенде.";
    const q = clipQuote(long);
    const huge = Array.from({ length: 70 }, (_, i) => `слово${i}`).join(" ") + ". Второе.";
    return {
      q, prefix: long.startsWith(q), words: q.split(/\s+/).length, endsAtSentence: /[.!?…]$/.test(q),
      huge: clipQuote(huge),
      tie: reasonOf({ criteria: [{ id: "a", max: 20, reasoning: "x" }, { id: "b", max: 25, reasoning: "first of 25" }, { id: "c", max: 25, reasoning: "second of 25" }] })?.text,
      overall: reasonOf({ reasoning: "общее", criteria: [{ id: "b", max: 25, reasoning: "крит" }] })?.text,
      abbr: sentences("Сценариев два, т. е. мало. Модули есть.").length,
      noRules: rulesOf("Добрый день. Начинаем."),
    };
  });
  expect(r.prefix && r.words <= 40 && r.endsAtSentence, `clipQuote: a long reason becomes its first whole sentences, ≤ 40 words, verbatim prefix (${r.words} words)`);
  expect(r.huge === null, "clipQuote: a first sentence over 60 words is not said at all");
  expect(r.tie === "first of 25", "reasonOf: the highest-weight criterion, the first in Rubric order on a tie");
  expect(r.overall === "общее", "reasonOf: an overall reason wins when the file has one");
  expect(r.abbr === 2, "sentences: «т. е.» stays inside its sentence");
  expect(r.noRules === null, "rulesOf: an intro without voting sentences gives no text (the card is shown)");
  const js = await W((cases) => cases.map((c) => __wi.m.conceptOf(c)), CONCEPT_CASES), py = pyConcepts(CONCEPT_CASES);
  const diff = CONCEPT_CASES.map((_, i) => i).filter((i) => js[i] !== py[i]);
  expect(!diff.length, `conceptOf = build.py concept_section on ${CONCEPT_CASES.length} SUBMISSION.md shapes${diff.length ? `: differ at ${diff.map((i) => `${i} js ${JSON.stringify(js[i])} py ${JSON.stringify(py[i])}`).join("; ")}` : ""}`);
}

// ---- the reaction is eased (robots/rig.js react): the head's world orientation sampled at 240 Hz far
// ahead of the live clock (the events are removed after), a nod, a gesture, and a gesture started
// while a nod still eases out; a jerk would show as a jump of the angular speed between two samples
{
  const r = await W(() => {
    const out = {};
    for (const id of ["fable-5.1", "opus-5.5", "gpt-6-astra"]) {
      const rb = __wi.stage.robots[id], head = rb.anchors.head, T0 = __wi.now() + 1000, dt = 1 / 240;
      const host = __wi.stage.robots.host.anchors.head.getWorldPosition(rb.object3d.position.clone());
      const sample = (a, b) => {
        const qs = [];
        for (let t = a; t <= b; t += dt) {
          rb.update(t);
          rb.object3d.updateMatrixWorld(true);
          qs.push(head.getWorldQuaternion(head.quaternion.clone()));
        }
        const sp = qs.slice(1).map((q, i) => (2 * Math.acos(Math.min(1, Math.abs(q.dot(qs[i]))))) / dt);
        const jump = Math.max(...sp.slice(1).map((s, i) => Math.abs(s - sp[i])));
        return { max: Math.max(...sp), jump };
      };
      const base = sample(T0 - 1, T0 + 4.5);
      const h1 = rb.react("nod", T0, { toward: host }), h2 = rb.react("gesture", T0 + 1.6, { toward: host });
      const withReact = sample(T0 - 1, T0 + 6);
      h1.cancel(), h2.cancel();
      out[id] = { base, withReact };
    }
    return out;
  });
  for (const [id, x] of Object.entries(r)) {
    expect(x.withReact.jump < 0.6 && x.withReact.max < 4, `${id}: the reaction is eased (head ≤ ${x.withReact.max.toFixed(2)} rad/s, largest step in speed ${x.withReact.jump.toFixed(3)} rad/s; idle ${x.base.max.toFixed(2)} / ${x.base.jump.toFixed(3)})`);
  }
}

// ---- 1. judge, outside a hold: a wordless reaction and the card (the CLI's name, never a sample version)
await W(() => __wi.setCurrent("preshow", null));
const synth0 = synth.length;
await W(() => __wi.emit({ kind: "judge", id: "opus-5.5", point: null }));
await sleep(1300);
let L = await lastLog();
expect(L?.kind === "judge" && L.react === "nod" && L.spoke === null, `judge outside a hold: a wordless reaction (${L?.react})`);
expect(L?.card?.name === "Opus 5.5" && L.card.line === "Claude Code · Anthropic" && !VERSION.test(L.card.line), `card before the launch: «${L?.card?.line}» (no version from the roster)`);
expect(await W(() => __wi.calls.react.some((c) => c.id === "opus-5.5" && c.kind === "nod" && c.toward && c.ok)), "the rig reacts toward the Host");
expect(await W(() => __wi.calls.focus.at(-1)?.shot === "medium" && __wi.calls.focus.at(-1)?.id === "opus-5.5"), "walk.focus on the Judge");
await camsClear("judge card");
await still("01-judge-reaction");
await idle();
expect(synth.length === synth0 || synth.slice(synth0).every((s) => s.speaker !== "opus-5.5"), "no line asked for outside a hold");

// ---- 2. judge in a hold after a Finalist: the three Qualifying Judges say their reason, verbatim
await W((team) => __wi.setCurrent("hold", team), HOLD_TEAM);
await sleep(2500); // the prewarm prepares the three reasons
const teamName = program.finalists.find((f) => f.team === HOLD_TEAM).name;
for (const [i, id] of ["opus-5.5", "gpt-6.1-sol", "gpt-6-astra"].entries()) {
  const want = await expectedReason(HOLD_TEAM, id);
  const plays0 = (await W(() => __wi.plays())).length;
  await W((id) => __wi.emit({ kind: "judge", id }), id);
  await page.waitForFunction(() => __wi.wi.log.at(-1)?.spoke !== undefined, null, { timeout: 10000 });
  L = await lastLog();
  expect(L.spoke?.speaker === id && L.spoke.text === want, `${id} says its reason, string-equal to scores/${id}.json: «${L.spoke?.text}»`);
  expect(synth.some((s) => s.speaker === id && s.text === want), `${id}: the line went to /synth in its own voice (speaker=${id})`);
  const plays = await W(() => __wi.plays());
  expect(plays.length === plays0 + 1 && plays.at(-1).speaker === id && plays.at(-1).text === want, `${id}: one line on the voice's queue`);
  expect(L.label === `из Отборочного этапа · о «${teamName}»`, `label «${L.label}»`);
  if (i === 0) {
    await page.waitForFunction(() => __wi.subsShown() && Number(document.querySelector(".wi-label")?.style.opacity) > 0.5, null, { timeout: 10000 });
    await sleep(500);
    const sh = await W(() => __wi.subsShown());
    expect(sh && want.includes(sh.text.split(" ")[0]), `subtitles show the line (${sh?.mode}: «${sh?.text}»)`);
    await camsClear("quote label and subtitles");
    await still("02-judge-quote");
  }
  await idle();
}

// ---- 3. Sonnet 5.5 and Fable 5.1 in the same hold: a reaction, never a word (Sonnet has a Score in the fixture)
for (const id of ["sonnet-5.5", "fable-5.1"]) {
  const plays0 = (await W(() => __wi.plays())).length;
  await W((id) => __wi.emit({ kind: "judge", id }), id);
  await sleep(600);
  L = await lastLog();
  expect(L.kind === "judge" && L.id === id && L.spoke === null && !!L.react, `${id} in the hold: ${L.react}, no words`);
  if (id === "sonnet-5.5") await still("03-sonnet-gesture-no-words");
  await idle();
  expect((await W(() => __wi.plays())).length === plays0 && !synth.some((s) => s.speaker === id), `${id}: nothing on the voice, nothing asked of /synth`);
}

// ---- 4. busy blocks re-entry
{
  const busy0 = await W(() => __wi.calls.busy.length);
  await W(() => {
    __wi.emit({ kind: "judge", id: "gpt-6.1-sol" });
    __wi.emit({ kind: "judge", id: "gpt-6-astra" });
  });
  await sleep(300);
  const log = await W(() => __wi.wi.log.slice(-2).map((x) => ({ id: x.id, ignored: x.ignored ?? null })));
  expect(log[0].id === "gpt-6.1-sol" && !log[0].ignored && log[1].id === "gpt-6-astra" && log[1].ignored === "busy", "a click while one plays is ignored");
  await idle();
  const busy = await W((n) => __wi.calls.busy.slice(n).map((x) => x.b), busy0);
  expect(JSON.stringify(busy) === "[true,false]", `walk.busy: ${JSON.stringify(busy)}`);
}

// ---- 4b. a wordless one gives way to the next click (never busy); the Walk switched off stops a line
{
  await W(() => __wi.setCurrent("preshow", null));
  const busy0 = await W(() => __wi.calls.busy.length), react0 = await W(() => __wi.calls.react.length);
  await W(() => __wi.emit({ kind: "judge", id: "fable-5.1" }));
  await sleep(500);
  await W(() => __wi.emit({ kind: "judge", id: "gpt-6.1-sol" }));
  await sleep(400);
  const log = await W(() => __wi.wi.log.slice(-2).map((x) => ({ id: x.id, ignored: x.ignored ?? null, superseded: x.superseded ?? null })));
  const rs = await W((n) => __wi.calls.react.slice(n), react0);
  const fable = rs.find((r) => r.id === "fable-5.1");
  expect(log[0].id === "fable-5.1" && log[0].superseded !== null && log[1].id === "gpt-6.1-sol" && !log[1].ignored, "a click during a wordless reaction is taken: the next Judge answers");
  expect(fable && fable.released !== null && !fable.cancelled && rs.some((r) => r.id === "gpt-6.1-sol" && r.ok), "the first reaction eases out (released, not cut)");
  expect((await W((n) => __wi.calls.busy.length - n, busy0)) === 0, "a wordless reaction never sets walk.busy");
  await idle();

  await W((team) => __wi.setCurrent("hold", team), HOLD_TEAM);
  const b1 = await W(() => __wi.calls.busy.length);
  await W(() => __wi.emit({ kind: "judge", id: "opus-5.5" }));
  await page.waitForFunction(() => __wi.wi.log.at(-1)?.spoke, null, { timeout: 10000 });
  await sleep(1500);
  const before = await W(() => __wi.plays().filter((p) => p.speaker === "opus-5.5" && p.end > __wi.now()).length);
  await W(() => __wi.toggle(false));
  await sleep(300);
  const after = await W(() => ({ live: __wi.plays().filter((p) => p.speaker === "opus-5.5" && p.end > __wi.now()).length, active: __wi.wi.active, shown: __wi.wi.shown }));
  const bs = await W((n) => __wi.calls.busy.slice(n).map((x) => x.b), b1);
  expect(before === 1 && after.live === 0 && after.active === null && !after.shown.label && !after.shown.card && JSON.stringify(bs) === "[true,false]", `the Walk switched off mid-line: the line leaves the queue, label and card close, not busy (${JSON.stringify(bs)})`);
  await W(() => __wi.toggle(true));
}

// ---- 5. console in the hold: the cited screenshots and the references on that Judge's monitor
{
  const want = await citedShots(HOLD_TEAM, "opus-5.5");
  const n0 = await W(() => __wi.calls.show.length);
  await W(() => __wi.emit({ kind: "console", id: "opus-5.5" }));
  await page.waitForFunction(() => __wi.wi.log.at(-1)?.console !== undefined && __wi.wi.log.at(-1)?.console !== null, null, { timeout: 10000 });
  L = await lastLog();
  const shown = await W((n) => __wi.calls.show.slice(n), n0);
  const srcs = shown.map((s) => new URL(s.src, base).pathname);
  expect(JSON.stringify(srcs) === JSON.stringify(want) && shown.every((s) => s.id === "opus-5.5"), `monitor shows the Score's screenshots in order: ${srcs.map((s) => s.split("/").pop()).join(", ")}`);
  const s = await json(scorePath(HOLD_TEAM, "opus-5.5")), refs = [...new Set(s.criteria.flatMap((c) => c.references))];
  const logged = await W(() => __wi.calls.log.at(-1));
  expect(logged.id === "opus-5.5" && JSON.stringify(logged.items) === JSON.stringify(refs), `side monitor: the Score's references verbatim (${refs.length})`);
  expect(await W(() => __wi.calls.focus.at(-1)?.shot === "ots"), "walk.focus on the console's monitor");
  await sleep(1800);
  await still("04-console-qualifying");
  await idle();
}

// ---- 6. wall in the hold: the Stand video, the screenshots, the Concept
{
  await W(() => __wi.emit({ kind: "wall" }));
  await page.waitForFunction(() => __wi.wi.log.at(-1)?.concept && __wi.wi.log.at(-1)?.images, null, { timeout: 10000 });
  L = await lastLog();
  const f = program.finalists.find((x) => x.team === HOLD_TEAM);
  expect(L.panel === "finalist" && L.video?.endsWith(f.video), `wall: the panel plays ${f.video}`);
  expect(L.concept === (await expectedConcept(HOLD_TEAM)), `wall: the Concept verbatim from SUBMISSION.md («${L.concept?.slice(0, 60)}…»)`);
  const shots = (await Promise.all(["opus-5.5", "gpt-6.1-sol", "gpt-6-astra"].map((j) => citedShots(HOLD_TEAM, j)))).flat();
  expect(L.images.length > 0 && L.images.every((u) => shots.includes(new URL(u, base).pathname)), `wall: ${L.images.length} screenshots the Qualifying Judges cite`);
  await page.waitForFunction(() => { const v = document.querySelector(".wi-panel video"); return v && v.readyState >= 2 && v.currentTime > 0.3; }, null, { timeout: 15000 });
  await sleep(600);
  await camsClear("wall panel");
  await still("05-wall-finalist");
  // Escape closes the panel
  await page.keyboard.press("Escape");
  await sleep(150);
  expect(await W(() => __wi.wi.shown.panel === null), "Escape closes the panel");
  await idle();
}

// ---- 7. wall with no Finalist on: the list
{
  await W(() => __wi.setCurrent("preshow", null));
  await W(() => __wi.emit({ kind: "wall" }));
  await sleep(900);
  L = await lastLog();
  expect(L.panel === "list" && L.rows === program.finalists.length, `wall without a Finalist: the list of ${L.rows}`);
  await camsClear("Finalists' list");
  await still("06-wall-list");
  await idle();
}

// ---- 8. urns: the Host says the accepted rules paragraph (tools/build.py intro), verbatim
{
  await W((t) => __wi.reattach(t), buildIntro);
  await W((team) => __wi.setCurrent("hold", team), HOLD_TEAM);
  await W(() => __wi.emit({ kind: "urn" }));
  await page.waitForFunction(() => __wi.wi.log.at(-1)?.spoke !== undefined, null, { timeout: 10000 });
  L = await lastLog();
  expect(L.spoke?.speaker === "host" && L.spoke.text === buildRules, `urns: the Host says the «Правила голосования» paragraph verbatim (${buildRules.split(/\s+/).length} words)`);
  expect(synth.some((s) => s.speaker === "host" && s.text === buildRules), "urns: the rules went to /synth as the Host");
  await page.waitForFunction(() => __wi.subsShown(), null, { timeout: 10000 });
  await sleep(700);
  await still("07-urns-host-rules");
  // a jump of the show clock (the operator's ←) undoes the line: off the voice's queue, no reaction, not busy
  const playsBefore = await W(() => __wi.plays().filter((p) => p.speaker === "host").length);
  await W(() => __wi.showClock.jump(__wi.now() - 8));
  await sleep(400);
  const after = await W(() => ({ host: __wi.plays().filter((p) => p.speaker === "host").length, active: __wi.wi.active, cancelled: __wi.calls.react.at(-1) }));
  expect(after.host === playsBefore - 1 && after.active === null && after.cancelled.id === "host" && after.cancelled.cancelled, "a jump of the clock undoes the line: off the queue, its reaction removed, not busy");
  expect(await W(() => !__wi.subsShown()), "… and its subtitles are gone");
}

// ---- 9. the repo fixture's intro (no rules paragraph): the Host's own sentences on voting, verbatim
{
  await W((t) => __wi.reattach(t), program.intro.text);
  await W(() => __wi.emit({ kind: "urn" }));
  await page.waitForFunction(() => __wi.wi.log.at(-1)?.spoke !== undefined, null, { timeout: 10000 });
  L = await lastLog();
  const parts = L.spoke?.text?.split(/(?<=[.!?…])\s+/) ?? [];
  expect(L.spoke?.speaker === "host" && parts.length > 1 && parts.every((p) => program.intro.text.includes(p)), `urns (older intro): ${parts.length} of its sentences on voting, each verbatim`);
  await idle();
}

// ---- 10. the debate: nothing speaks; the card from state.json; the console and the urns stay silent
{
  await W((t) => __wi.reattach(t), buildIntro);
  await W(() => __wi.setCurrent("debate", null));
  const plays0 = (await W(() => __wi.plays())).length, synthN = synth.length, show0 = await W(() => __wi.calls.show.length);
  await W(() => __wi.emit({ kind: "judge", id: "opus-5.5" }));
  await sleep(900);
  L = await lastLog();
  expect(L.spoke === null && L.react, `debate: Opus reacts without words (${L.react})`);
  expect(L.card?.source === "state" && L.card.line === "claude-opus-5-5 · Claude Code 2.1.308 · Anthropic", `debate: the card from state.json: «${L.card?.line}»`);
  await still("08-debate-judge-card");
  await idle();
  await W(() => __wi.setCurrent("debate", "team-007")); // even with a team: the debate's rule wins
  await W(() => __wi.emit({ kind: "judge", id: "gpt-6.1-sol" }));
  await sleep(500);
  L = await lastLog();
  expect(L.spoke === null, "debate with a team set: sol says nothing");
  await idle();
  await W(() => __wi.setCurrent("debate", null));
  await W(() => __wi.emit({ kind: "urn" }));
  await sleep(900);
  L = await lastLog();
  expect(L.spoke === null && L.panel === "rules-text", `debate: the urns show the rules on a card (${L.panel}), silent`);
  await camsClear("rules card");
  await still("09-debate-urns-card");
  // the director takes the screen (a Judge's line): the card leaves the air, and comes back with the Walk
  await W(() => __wi.setShare(0));
  await sleep(300);
  const off = (await W(() => __wi.wi.boxes())).length;
  await W(() => __wi.setShare(1));
  await sleep(300);
  const on = (await W(() => __wi.wi.boxes())).length;
  expect(off === 0 && on > 0, `the director's screen (walk share 0): nothing of the layer on air (${off} boxes; ${on} with the Walk back)`);
  await idle();
  await W(() => __wi.emit({ kind: "console", id: "opus-5.5" }));
  await sleep(700);
  await idle();
  expect(await W((n) => __wi.calls.show.length === n, show0), "debate: a console click leaves the monitor to the live reading");
  expect((await W(() => __wi.plays())).length === plays0, `debate: nothing on the voice's queue (${plays0})`);
  expect(synth.slice(synthN).every((s) => s.speaker === "host" && s.text === buildRules), "debate: no Judge's line asked of /synth");
}

// ---- 11. the rules card from ui/cards.js LABELS when no accepted text exists
{
  await W(() => __wi.reattach("Добрый день. Начинаем."));
  await W(() => __wi.setCurrent("hold", "team-007"));
  await W(() => __wi.emit({ kind: "urn" }));
  await sleep(900);
  L = await lastLog();
  expect(L.spoke === null && L.panel === "rules-labels", `no accepted rules text: the LABELS card (${L.panel}), nothing said`);
  await camsClear("LABELS rules card");
  await still("10-urns-labels-card");
  await idle();
}

// ---- 12. /pub/ as the publication itself (server.py --pub <publication>, before a run: the holds), then no /pub/
{
  const before = missing.length;
  await W(() => __wi.reattach(null, "/pub/publication/"));
  await W((team) => __wi.setCurrent("hold", team), HOLD_TEAM);
  await W(() => __wi.emit({ kind: "judge", id: "opus-5.5" }));
  await page.waitForFunction(() => __wi.wi.log.at(-1)?.spoke !== undefined, null, { timeout: 10000 });
  L = await lastLog();
  expect(L.spoke?.text === (await expectedReason(HOLD_TEAM, "opus-5.5")), `publication itself: Opus says the same reason («${L.spoke?.text?.slice(0, 40)}…»)`);
  await idle();
  await W(() => __wi.emit({ kind: "wall", id: "wall" }));
  await page.waitForFunction(() => __wi.wi.log.at(-1)?.images, null, { timeout: 10000 });
  await sleep(800);
  L = await lastLog();
  expect(L.panel === "finalist" && L.images.length > 0 && L.images.every((x) => new URL(x, base).pathname.startsWith(`/pub/publication/solutions/${HOLD_TEAM}/screenshots/`)) && !L.concept,
    `publication itself: the wall has the cited screenshots (${L.images.length}) and no Concept (the sources are not in a publication)`);
  await W(() => __wi.wi.close());
  await idle();
  const miss1 = missing.slice(before);
  expect(JSON.stringify(miss1) === JSON.stringify(["/pub/publication/publication/results.json"]), `publication itself: one failed request, the layout probe (${JSON.stringify(miss1)})`);

  const before2 = missing.length, synth2 = synth.length;
  await W(() => __wi.reattach(null, "/nopub/"));
  await sleep(2200); // two prewarm ticks with a Finalist in a hold
  expect(missing.length === before2, `a Walk only switched on asks nothing of /pub/ before the first click (${missing.length - before2})`);
  for (const ev of [{ kind: "judge", id: "opus-5.5" }, { kind: "console", id: "gpt-6-astra" }, { kind: "wall", id: "wall" }]) {
    await W((ev) => __wi.emit(ev), ev);
    await sleep(ev.kind === "judge" ? 2200 : 900);
    L = await lastLog();
    const ok = ev.kind === "judge" ? L.spoke === null && !!L.react : ev.kind === "console" ? L.console === null : L.panel === "finalist" && !L.concept;
    expect(L.kind === ev.kind && ok, `no /pub/: ${ev.kind} still answers, wordless (${JSON.stringify({ react: L.react ?? null, spoke: L.spoke ?? null, console: L.console ?? null, panel: L.panel ?? null })})`);
    await W(() => __wi.wi.close());
    await idle();
  }
  const miss2 = missing.slice(before2);
  expect(JSON.stringify(miss2) === JSON.stringify(["/nopub/publication/results.json", "/nopub/results.json"]) && synth.slice(synth2).every((s) => s.speaker === "host"),
    `no /pub/: two failed requests, both the probe, and no Judge's line (${JSON.stringify(miss2)})`);
  expect(probed.length === 3, `the probes' 404s in the console: ${probed.length} (counted here, not as errors)`);
  await W(() => __wi.reattach(null));
}

expect(!served.some((p) => p.endsWith("/")), "no folder listing asked of /pub/");
expect(errors.length === 0, `no console errors${errors.length ? `: ${errors.slice(0, 3).join(" | ")}` : ""}`);
await writeFile(join(out, "report.json"), JSON.stringify({ stills, synth, served: [...new Set(served)], errors }, null, 1));
console.log(`stills: ${out} (${stills.length})`);
await browser.close();
server.close();
process.exit(failed ? 1 : 0);
