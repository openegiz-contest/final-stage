// The Walk (ui/walk.js) on show.html, headless on the real GPU (Metal), one browser:
//   node contest/stage/test/walk-check.mjs [--only 1,2,…] [--gfx lite]
// 1. P toggles: on (the Walk holds the camera), off (the Host rolls back to its post, the director has the
//    camera again, the page renders as without the Walk), on again; a "toggle" event each time
// 2. W walks the Host and the camera follows it: live, per frame, the camera's speed and the Host's place
//    on screen have no spikes; virtual (?t=, fixed 1/30 s frames), the camera's step per frame is even
// 3. W into a console: the Host stops at the desk, never inside it
// 4. a double-click on the floor beyond the ballot box: the Host goes there by itself, round the box
// 5. in a Finalist's minute, a click on every Judge, every console, the dispatch wall and the ballot box emits
//    its { kind, id } (each after walk-interact's answer to the last, if attached); E at a Judge it faces;
//    nothing while walk.busy(true); walk.focus, walk.share, walk.stage
// 6. the real replay (virtual, the whole show, the Walk on, the Host sent into the Judges' ways to the box
//    every 4 s): every beat once, in order; the camera is the director's through every Judge's line; the
//    Host never overlaps a Judge (walking or not)
// 7. live, the real replay from the debate's start, the Walk on, the Host sent into the Judges' ways, 250 s
//    (five lines and the first vote: --live <s>): beats in order, once, on the virtual plan's times (never
//    delayed); the camera is the director's through every line and every vote beat; no overlap
// 8. ms per frame with the Walk on (?walk=1&walkdemo=1), full ≤ 20, lite ≤ 10, at check.mjs bench's times; each
//    time A/B against the page without the Walk, so a GPU shared with other runs shows as both slower
// 9. the Walk's own JS per frame, live, walking the demo (paths, the camera): the part a GPU does not hide
// Options: --program <url> (default test/program/fixture/program.json), --only, --gfx lite (8 runs both).
import { createServer } from "node:http";
import { readFile, access } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { extname, join, dirname, sep, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const STAGE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SITE_3D = join(dirname(STAGE), "site", "assets", "3d");
const argv = process.argv.slice(2);
const opt = (k, d) => argv.flatMap((a, i) => (a === `--${k}` ? [argv[i + 1]] : []))[0] ?? d;
const programUrl = opt("program", "test/program/fixture/program.json");
const REAL = "test/replays/real-live-probe-20261021b.jsonl";
const SYNTH = "test/replays/synthetic-full.jsonl";
const only = opt("only", null);
const part = (n) => !only || only.split(",").includes(String(n));
const interactExists = await access(join(STAGE, "ui", "walk-interact.js")).then(() => true, () => false);

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
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".png": "image/png", ".jpg": "image/jpeg",
  ".json": "application/json", ".jsonl": "application/x-ndjson", ".woff2": "font/woff2", ".svg": "image/svg+xml", ".md": "text/plain; charset=utf-8", ".glb": "model/gltf-binary", ".mp4": "video/mp4" };
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
    if (url.startsWith("/run/")) return res.writeHead(502).end();
    const [root, rest] = url.startsWith("/vendor/three/") ? [join(SITE_3D, "three"), url.slice(14)]
      : url.startsWith("/vendor/mine/") ? [SITE_3D, url.slice(13)] : [STAGE, url.slice(1)];
    const path = resolve(root, rest);
    if (!path.startsWith(root + sep)) throw new Error("outside root");
    sendFile(req, res, await readFile(path), { "content-type": TYPES[extname(path)] || "application/octet-stream", "cache-control": "no-store" });
  } catch {
    res.writeHead(404).end();
  }
}).listen(0);
const base = `http://localhost:${server.address().port}`;
const { chromium } = playwright();
const browser = await chromium.launch({ channel: "chrome", args: ["--headless=new", "--ignore-gpu-blocklist", "--enable-gpu", "--use-angle=metal", "--autoplay-policy=no-user-gesture-required"] });
const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
const tab = await ctx.newPage();
const errors = [];
let interact404 = 0, pub404 = 0;
tab.on("console", (m) => {
  if (m.type() !== "error") return;
  // ui/walk-interact.js is another session's module: absent on this branch, its import fails (silently in the page)
  if (!interactExists && /404/.test(m.text()) && /walk-interact\.js$/.test(m.location()?.url ?? "")) return void interact404++;
  // walk-interact asks /pub/ for the publication's layout once a click wants a Finalist's scores; this check
  // serves no publication (test/walk-interact-check.mjs does), so that probe's 404s are its documented one
  if (/404/.test(m.text()) && /\/pub\/(publication\/)?results\.json$/.test(m.location()?.url ?? "")) return void pub404++;
  errors.push(`${m.text()}${m.location()?.url ? ` (${m.location().url})` : ""}`);
});
tab.on("pageerror", (e) => errors.push(e.message));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const r2 = (x) => Math.round(x * 100) / 100;
let failed = false;
const expect = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failed = true;
};
const q = (extra) => [`program=${programUrl}`, "voice=estimate", ...extra].filter(Boolean).join("&");
async function open(extra, ready = () => window.__stage?.ready === true && !!window.__walk) {
  await tab.goto(`${base}/show.html?${q(extra)}`);
  await tab.waitForFunction(ready, null, { timeout: 180000, polling: 200 });
}
const state = () => tab.evaluate(() => window.__walk.debug.state);
const waitState = (fn, arg, timeout = 30000) => tab.waitForFunction(fn, arg, { timeout, polling: 100 });

// ---- 1. P toggles
if (part(1)) {
  await open([`replay=${SYNTH}`, "segment=title", "hold=0"]);
  await tab.evaluate(() => {
    window.__toggles = [];
    window.__walk.on("toggle", (e) => window.__toggles.push(e.enabled));
  });
  const s0 = await state();
  expect(!s0.enabled && s0.owner === "director", "the Walk is off by default: the director has the camera");
  await tab.keyboard.press("p");
  await sleep(1800);
  const s1 = await state();
  expect(s1.enabled && s1.owner === "walk" && s1.walkShare === 1, `P: the Walk is on and holds the camera (share ${r2(s1.walkShare)})`);
  await tab.keyboard.down("w");
  await sleep(1500);
  await tab.keyboard.up("w");
  const s2 = await state();
  const away = Math.hypot(s2.x + 3.65, s2.z - 0.35);
  expect(away > 1, `W moved the Host ${r2(away)} m from its post`);
  await tab.keyboard.press("p");
  await sleep(300);
  const s3 = await state();
  expect(!s3.enabled && s3.homing && s3.owner === "director", "P again: off, the Host rolls home, the director takes the camera");
  await waitState(() => !window.__walk.debug.state.homing, null, 20000).catch(() => {});
  await sleep(1200);
  const s4 = await tab.evaluate(() => {
    const st = window.__walk.debug.state, h = window.__frame.stage.robots.host.object3d;
    return { ...st, hx: h.position.x, hz: h.position.z, hyaw: h.rotation.y };
  });
  expect(!s4.homing && Math.hypot(s4.hx + 3.65, s4.hz - 0.35) < 0.01 && s4.walkShare === 0, `home: the Host at its post (${r2(s4.hx)}, ${r2(s4.hz)}), the picture the director's alone`);
  await tab.keyboard.press("p");
  await sleep(500);
  const s5 = await state();
  const toggles = await tab.evaluate(() => window.__toggles);
  expect(s5.enabled && JSON.stringify(toggles) === "[true,false,true]", `P a third time: on again; toggle events ${JSON.stringify(toggles)}`);
}

// ---- 2. W walks, the camera follows without spikes
if (part(2)) {
  await open([`replay=${SYNTH}`, "segment=title", "hold=0", "walk=1"]);
  await tab.evaluate(() => {
    const W = window.__walk, L = window.__frame.stage.lens, st = window.__frame.stage, host = st.robots.host.object3d;
    W.debug.place(-2.6, 2.2, Math.atan2(2.6, -4.2)); // the Host in the room, toward the consoles
    window.__rec = [];
    const v = new L.position.constructor();
    const f = () => {
      v.copy(host.position).setY(1.2);
      const p = st.project(v);
      window.__rec.push({ t: W.debug.viewT, x: L.position.x, y: L.position.y, z: L.position.z, sx: p.x, sy: p.y, hx: host.position.x, hz: host.position.z });
      requestAnimationFrame(f);
    };
    requestAnimationFrame(f);
  });
  await sleep(600);
  await tab.keyboard.down("w");
  const t0 = await tab.evaluate(() => window.__stage.time);
  await sleep(3200);
  await tab.keyboard.up("w");
  await sleep(300);
  const rec = await tab.evaluate(() => window.__rec);
  const run = rec.filter((r) => r.t > t0 + 1.0 && r.t < t0 + 3.1); // steady walking
  const sp = [], hs = [], jit = [];
  for (let i = 1; i < run.length; i++) {
    const a = run[i - 1], b = run[i], dt = b.t - a.t;
    if (!(dt > 1e-4)) continue;
    sp.push(Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z) / dt);
    hs.push(Math.hypot(b.hx - a.hx, b.hz - a.hz) / dt);
  }
  for (let i = 2; i < run.length; i++) jit.push(Math.hypot(run[i].sx - 2 * run[i - 1].sx + run[i - 2].sx, run[i].sy - 2 * run[i - 1].sy + run[i - 2].sy));
  const med = (a) => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)] ?? 0;
  const mSp = med(sp), maxDev = Math.max(...sp.map((v) => Math.abs(v - mSp))) / (mSp || 1);
  const dts = run.slice(1).map((r, i) => r.t - run[i].t);
  console.log(`  live: ${run.length} frames, frame ${r2(med(dts) * 1000)} ms (max ${r2(Math.max(...dts) * 1000)}), Host ${r2(med(hs))} m/s, camera ${r2(mSp)} m/s (max off the median ${r2(maxDev * 100)} %), Host on screen: max 2nd difference ${r2(Math.max(...jit))} px`);
  expect(med(hs) > 1.0, `the Host walks (${r2(med(hs))} m/s)`);
  expect(mSp > 0.8 && maxDev < 0.25, `the camera follows at an even speed (every frame within 25 % of the median)`);
  expect(Math.max(...jit) < 4, `the Host holds its place on screen (no jump over 4 px between frames)`);
  // virtual: fixed frames, the scripted walk (?walkdemo=1: W from 1.2 s, the camera turning 2–4 s)
  await open([`replay=${SYNTH}`, "t=0", "walk=1", "walkdemo=1"], () => window.__stage?.ready === true);
  const vr = await tab.evaluate(async () => {
    const out = [], L = window.__frame.stage.lens;
    for (let i = 0; i <= 180; i++) {
      const t = i / 30;
      await window.__stage.seek(t);
      out.push({ t, x: L.position.x, y: L.position.y, z: L.position.z });
    }
    return out;
  });
  const steps = [];
  for (let i = 1; i < vr.length; i++) if (vr[i].t > 2.0 && vr[i].t < 4.4) steps.push(Math.hypot(vr[i].x - vr[i - 1].x, vr[i].y - vr[i - 1].y, vr[i].z - vr[i - 1].z));
  const accel = steps.slice(1).map((s, i) => Math.abs(s - steps[i]));
  console.log(`  virtual: camera step per frame ${r2(Math.min(...steps) * 1000)}–${r2(Math.max(...steps) * 1000)} mm, largest change between frames ${r2(Math.max(...accel) * 1000)} mm`);
  expect(Math.max(...accel) < 0.15 * med(steps) + 0.002, "virtual: no frame jumps (the step changes by < 15 % of itself between frames)");
}

// ---- 3. W into a console: the Host stops at the desk
if (part(3)) {
  await open([`replay=${SYNTH}`, "segment=title", "hold=0", "walk=1"]);
  const setup = await tab.evaluate(() => {
    // Sonnet's console (the right end of the arc): its end beside the Judge, from the room side
    const a = (44 * Math.PI) / 180, R = 5.9;
    const c = { x: R * Math.sin(a), z: -R * Math.cos(a) }, inw = { x: -Math.sin(a), z: Math.cos(a) }, side = { x: Math.cos(a), z: Math.sin(a) };
    const end = { x: c.x - side.x * 0.72, z: c.z - side.z * 0.72 };
    const start = { x: end.x + inw.x * 2.2, z: end.z + inw.z * 2.2 };
    window.__walk.debug.place(start.x, start.z, Math.atan2(-inw.x, -inw.z));
    window.__minClr = Infinity;
    const W = window.__walk;
    const f = () => {
      const s = W.debug.state;
      window.__minClr = Math.min(window.__minClr, W.debug.plan.clearance(s.x, s.z));
      requestAnimationFrame(f);
    };
    requestAnimationFrame(f);
    return { start, end };
  });
  await sleep(500);
  await tab.keyboard.down("w");
  await sleep(3500);
  const s = await state();
  const clr = await tab.evaluate(([x, z]) => window.__walk.debug.plan.clearance(x, z), [s.x, s.z]);
  const minClr = await tab.evaluate(() => window.__minClr);
  await tab.keyboard.up("w");
  const moved = Math.hypot(s.x - setup.start.x, s.z - setup.start.z);
  console.log(`  from (${r2(setup.start.x)}, ${r2(setup.start.z)}) ${r2(moved)} m, stopped at (${r2(s.x)}, ${r2(s.z)}), ${r2(clr)} m from the desk (the Host's radius 0.33), speed ${r2(s.speed)}, closest ${r2(minClr)} m`);
  expect(moved > 1 && s.speed < 0.05 && clr < 0.45, "W into the console: the Host walked up to it and stopped there, W still held");
  expect(minClr >= 0.32, `never inside: the closest it came is its own radius (${r2(minClr)} ≥ 0.32 m)`);
}

// ---- 4. a double-click: the Host goes there by itself, round the box
if (part(4)) {
  await open([`replay=${SYNTH}`, "segment=title", "hold=0", "walk=1"]);
  const goal = { x: 1.35, z: -4.3 };
  const p = await tab.evaluate((g) => {
    const W = window.__walk, st = window.__frame.stage;
    W.debug.place(0.35, -0.6, Math.atan2(g.x - 0.35, g.z + 0.6));
    return new Promise((res) => setTimeout(() => {
      const v = new st.lens.position.constructor(g.x, 0, g.z), p = st.project(v);
      res({ ...p, pick: W.debug.pick(p.x, p.y, { floor: true }) });
    }, 1500));
  }, goal);
  console.log(`  the goal on screen at (${r2(p.x)}, ${r2(p.y)}), visible ${p.visible}, under the cursor: ${p.pick?.target ? p.pick.target.kind : "floor"} at (${r2(p.pick?.point.x ?? NaN)}, ${r2(p.pick?.point.z ?? NaN)})`);
  await tab.evaluate(() => {
    window.__track = [];
    const W = window.__walk;
    const f = () => {
      const s = W.debug.state;
      window.__track.push({ x: s.x, z: s.z, c: W.debug.plan.clearance(s.x, s.z), auto: !!s.auto });
      requestAnimationFrame(f);
    };
    requestAnimationFrame(f);
  });
  await tab.mouse.dblclick(p.x, p.y);
  await sleep(500);
  const s0 = await state();
  await waitState(() => !window.__walk.debug.state.auto && window.__walk.debug.state.speed < 0.01, null, 20000).catch(() => {});
  const s1 = await state();
  const track = await tab.evaluate(() => window.__track);
  // the straight line from the start passes the ballot box (0.8, -2.9); the walk goes round it
  const boxD = Math.min(...track.map((t) => Math.hypot(t.x - 0.8, t.z + 2.9)));
  const off = Math.hypot(s1.x - goal.x, s1.z - goal.z);
  console.log(`  autopilot: ${s0.auto ? `${s0.auto.n} waypoints` : "none"}; ended at (${r2(s1.x)}, ${r2(s1.z)}), ${r2(off)} m from the goal; closest to the box centre ${r2(boxD)} m; closest to anything ${r2(Math.min(...track.map((t) => t.c)))} m`);
  expect(!!s0.auto && s0.auto.why === "floor", "the double-click started a walk to the point");
  expect(off < 0.15, `the Host got there (${r2(off)} m off)`);
  expect(boxD > 0.45, "round the ballot box, not through it");
}

// ---- 5. clicks and E on the targets
if (part(5)) {
  // a Finalist's minute: minutes on end with no director's beat (the intro's hash check is the director's,
  // and walk-interact's answers to a dozen clicks take a minute)
  await open([`replay=${SYNTH}`, "segment=finalist-10", "hold=0", "walk=1"]);
  await tab.evaluate(() => {
    window.__events = [];
    window.__walk.on("interact", (e) => window.__events.push({ kind: e.kind, id: e.id, point: [e.point.x, e.point.y, e.point.z] }));
  });
  const JUDGES = ["fable-5.1", "gpt-6.1-sol", "opus-5.5", "gpt-6-astra", "sonnet-5.5"];
  // a screen point that picks the wanted target, from candidate world points on it
  const findPoint = (want) => tab.evaluate((want) => {
    const W = window.__walk, st = window.__frame.stage, V = st.lens.position.constructor;
    const cands = [];
    if (want.kind === "judge") {
      const r = st.robots[want.id];
      for (const k of ["head", "chest", "face"]) cands.push(r.anchors[k].getWorldPosition(new V()));
      cands.push(r.object3d.position.clone().setY(1.0));
    } else if (want.kind === "console") {
      const m = st.desks[want.id].monitor(), right = new V().crossVectors(new V(0, 1, 0), m.normal).normalize();
      for (const u of [0.42, -0.42, 0.3, -0.3, 0]) for (const v of [0.3, 0.15, 0]) cands.push(m.center.clone().addScaledVector(right, u * m.width).add(new V(0, v * m.height, 0)));
      const d = st.desks[want.id].object3d;
      for (const x of [0.8, -0.8]) cands.push(d.localToWorld(new V(x, 0.7, 0.2)));
    } else if (want.kind === "wall") {
      for (const dz of [0, 0.8, -0.8]) for (const dy of [0, 0.3]) cands.push(new V(-9.43, 1.78 + dy, 0.6 + dz));
    } else if (want.kind === "urn") {
      for (const dy of [1.0, 0.6, 1.2]) cands.push(new V(0.8, dy, -2.9));
    }
    for (const c of cands) {
      const p = st.project(c);
      if (!p.visible || p.x < 5 || p.y < 5 || p.x > 1915 || p.y > 1075) continue;
      const h = W.debug.pick(p.x, p.y);
      if (h?.target?.kind === want.kind && h.target.id === want.id) return { x: p.x, y: p.y };
    }
    return null;
  }, want);
  const views = [
    { at: [0.2, 1.6], look: [0.2, -5], wants: [...JUDGES.map((id) => ({ kind: "judge", id })), ...JUDGES.map((id) => ({ kind: "console", id })), { kind: "urn", id: "urn" }] },
    { at: [-5.6, 0.6], look: [-9.4, 0.6], wants: [{ kind: "wall", id: "wall" }] },
  ];
  // walk-interact, when attached, answers a click with a focus and maybe a line (walk.busy meanwhile, and a
  // click then goes nowhere, by design): each click, E and the checks below wait until it is over, and
  // until the picture is the Walk's alone
  const idle = async () => {
    await tab.waitForFunction(() => !window.__walk.debug.state.focus && !window.__walk.isBusy && window.__walk.share() === 1, null, { timeout: 120000, polling: 100 });
    await sleep(300);
  };
  const got = [];
  for (const v of views) {
    await idle();
    await tab.evaluate(({ at, look }) => window.__walk.debug.place(at[0], at[1], Math.atan2(look[0] - at[0], look[1] - at[1])), v);
    await sleep(1400);
    for (const want of v.wants) {
      await idle();
      let p = await findPoint(want);
      if (!p && want.kind === "console") {
        // a console behind its Judge from the room: from beside it
        const s = await tab.evaluate((id) => {
          const st = window.__frame.stage, d = st.desks[id].object3d, V = st.lens.position.constructor;
          const at = d.localToWorld(new V(1.6, 0, 1.3)), c = d.localToWorld(new V(0, 0, 0));
          window.__walk.debug.place(at.x, at.z, Math.atan2(c.x - at.x, c.z - at.z));
          return true;
        }, want.id);
        await sleep(1400);
        await idle();
        p = await findPoint(want);
        void s;
      }
      if (!p) {
        got.push({ want, got: null, why: "not on screen" });
        continue;
      }
      const n0 = await tab.evaluate(() => window.__events.length);
      await tab.mouse.click(p.x, p.y);
      await sleep(150);
      const ev = await tab.evaluate((n0) => window.__events.slice(n0), n0);
      got.push({ want, got: ev[0] ?? null, n: ev.length });
    }
    if (v.wants.some((w) => w.kind === "console")) await tab.evaluate(({ at, look }) => window.__walk.debug.place(at[0], at[1], Math.atan2(look[0] - at[0], look[1] - at[1])), views[0]);
  }
  for (const g of got) console.log(`  click ${g.want.kind}:${g.want.id} → ${g.got ? `${g.got.kind}:${g.got.id}` : g.why ?? "nothing"}${g.n > 1 ? ` (${g.n} events)` : ""}`);
  expect(got.every((g) => g.got && g.got.kind === g.want.kind && g.got.id === g.want.id && g.n === 1), `a click on each of the ${got.length} targets emits its own { kind, id }, once`);
  // E: in front of Opus, facing it
  await idle();
  await tab.evaluate(() => window.__walk.debug.place(0, -4.15, Math.PI));
  await sleep(600);
  const near = (await state()).near;
  const n1 = await tab.evaluate(() => window.__events.length);
  await tab.keyboard.press("e");
  await sleep(150);
  const evE = await tab.evaluate((n) => window.__events.slice(n), n1);
  expect(evE.length === 1 && evE[0].kind === "judge" && evE[0].id === "opus-5.5", `E in front of Opus: ${JSON.stringify(evE.map((e) => `${e.kind}:${e.id}`))} (near: ${near ? `${near.kind}:${near.id}` : "none"})`);
  // busy: no events
  await idle();
  await tab.evaluate(() => window.__walk.busy(true));
  const n2 = await tab.evaluate(() => window.__events.length);
  await tab.keyboard.press("e");
  const p = await findPoint({ kind: "judge", id: "opus-5.5" });
  if (p) await tab.mouse.click(p.x, p.y);
  await sleep(150);
  const n3 = await tab.evaluate(() => window.__events.length);
  await tab.evaluate(() => window.__walk.busy(false));
  expect(n3 === n2, "walk.busy(true): no interact events (E and a click)");
  // focus: a Judge, then an empty marker at the wall's centre (as walk-interact puts there); held on it, then back
  await idle();
  await tab.evaluate(({ at, look }) => window.__walk.debug.place(at[0], at[1], Math.atan2(look[0] - at[0], look[1] - at[1])), views[0]);
  await sleep(1400);
  const fx = await tab.evaluate(async () => {
    const THREE = await import("three");
    const W = window.__walk, st = window.__frame.stage, wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const aim = (c) => {
      const p = st.lens.getWorldPosition(new THREE.Vector3()), f = st.lens.getWorldDirection(new THREE.Vector3());
      return (f.angleTo(c.clone().sub(p)) * 180) / Math.PI;
    };
    const marker = new THREE.Object3D();
    marker.position.set(-9.43, 1.78, 0.6);
    st.scene.add(marker);
    marker.updateMatrixWorld(true);
    const out = { stage: W.stage === st, runs: [] };
    for (const [name, obj] of [["opus-5.5", st.robots["opus-5.5"].object3d], ["wall marker", marker]]) {
      const c = new THREE.Box3().setFromObject(obj);
      const centre = c.isEmpty() ? obj.getWorldPosition(new THREE.Vector3()) : c.getCenter(new THREE.Vector3());
      const before = aim(centre), t0 = performance.now();
      const done = W.focus(obj, { seconds: 1.5 });
      await wait(1900);
      const held = aim(centre), share = W.share();
      await done;
      out.runs.push({ name, before, held, share, s: (performance.now() - t0) / 1000, focusAfter: W.debug.state.focus });
    }
    st.scene.remove(marker);
    return out;
  });
  for (const r of fx.runs) console.log(`  focus ${r.name}: ${r2(r.before)}° off before, ${r2(r.held)}° while held, resolved after ${r2(r.s)} s`);
  expect(fx.stage && fx.runs.every((r) => r.share === 1), "walk.stage is the world (world/stage.js); walk.share() is 1 while the Walk's focus is on screen");
  expect(fx.runs.every((r) => r.held < 3 && !r.focusAfter && r.s > 3.4 && r.s < 4.6), "walk.focus frames a Judge and an empty marker (< 3°), then resolves when the camera is back (1.1 + 1.5 + 1.3 s)");
}

// ---- 6. the real replay, virtual, the whole show with the Walk on
let virtualBeats = null;
if (part(6)) {
  await open([`replay=${REAL}`, "t=0", "check=1", "walk=1", "walkdemo=stress"], () => window.__stage?.ready === true && !!window.__walk);
  const info = await tab.evaluate(() => ({ D: window.__program.debateAt, end: window.__frame.duration, check: window.__live.check() }));
  console.log(`  the show: ${info.end} s, the debate from ${r2(info.D)} s`);
  const c = info.check;
  expect(c.finished && c.inOrder && c.once && c.allPlayed && c.verbatim, `every beat once, in order, verbatim (${c.beatsPlayed}/${c.beatsPlanned})`);
  // step the whole show on 1/30 s: the robots where the show has them, the Walk after them
  const R = { lines: 0, lineFrames: 0, lineWalk: 0, worst: [], minGap: Infinity, minGapWalking: Infinity, walkingFrames: 0, corridorFrames: 0, samples: 0, share: { walk: 0, director: 0 } };
  for (let from = 0; from < info.end; from += 60) {
    const part = await tab.evaluate(({ from, to, D }) => {
      const st = window.__frame.stage, W = window.__walk, L = window.__live;
      const ids = ["fable-5.1", "gpt-6.1-sol", "opus-5.5", "gpt-6-astra", "sonnet-5.5"];
      const RJ = { "opus-5.5": 0.41, "gpt-6.1-sol": 0.37, "sonnet-5.5": 0.3, "gpt-6-astra": 0.37, "fable-5.1": 0.33 }, RH = 0.33;
      const says = L.played.says;
      const out = { lineFrames: 0, lineWalk: 0, worst: [], minGap: Infinity, minGapWalking: Infinity, walkingFrames: 0, corridorFrames: 0, samples: 0, share: { walk: 0, director: 0 } };
      for (let i = Math.round(from * 30); i < Math.round(to * 30); i++) {
        const t = i / 30;
        if (t >= D - 10) for (const id of ids) st.robots[id].update(t);
        W.frame(t);
        const s = W.debug.state, share = W.debug.share();
        out.samples++;
        out.share[share > 0.5 ? "walk" : "director"]++;
        const say = says.find((x) => x.t0 <= t && t < x.end);
        if (say) {
          out.lineFrames++;
          if (share > 0) (out.lineWalk++), out.worst.length < 5 && out.worst.push({ t, n: say.n, share });
        }
        if (t < D - 10) continue;
        if (s.corridors.length) out.corridorFrames++;
        for (const id of ids) {
          const p = st.robots[id].object3d.position, gap = Math.hypot(p.x - s.x, p.z - s.z) - RJ[id] - RH;
          out.minGap = Math.min(out.minGap, gap);
          if (st.robots[id].phaseAt(t)) (out.minGapWalking = Math.min(out.minGapWalking, gap)), out.walkingFrames++;
        }
      }
      return out;
    }, { from, to: Math.min(info.end, from + 60), D: info.D });
    for (const k of ["lineFrames", "lineWalk", "walkingFrames", "corridorFrames", "samples"]) R[k] += part[k];
    R.minGap = Math.min(R.minGap, part.minGap);
    R.minGapWalking = Math.min(R.minGapWalking, part.minGapWalking);
    R.worst.push(...part.worst);
    R.share.walk += part.share.walk;
    R.share.director += part.share.director;
  }
  const said = await tab.evaluate(() => window.__live.played.says.length);
  console.log(`  ${said} Judge lines, ${R.lineFrames} frames of them; the Walk's share of the picture > 0 in ${R.lineWalk}${R.worst.length ? ` (first: ${JSON.stringify(R.worst.slice(0, 3).map((w) => ({ t: r2(w.t), n: w.n, share: r2(w.share) })))})` : ""}`);
  console.log(`  the picture: the Walk's ${r2((100 * R.share.walk) / R.samples)} %, the director's ${r2((100 * R.share.director) / R.samples)} % of ${R.samples} frames; a Judge walking in ${R.walkingFrames} Judge-frames, a path closed in ${R.corridorFrames} frames`);
  console.log(`  the Host to the nearest Judge: ${r2(R.minGap)} m between bodies (to a walking Judge: ${r2(R.minGapWalking)} m)`);
  expect(R.lineFrames > 0 && R.lineWalk === 0, "the camera is the director's through every Judge's line");
  expect(R.walkingFrames > 0 && R.minGapWalking >= 0, "the Host never overlaps a Judge walking to the box (it was sent into their ways every 4 s)");
  expect(R.minGap >= 0, "nor any other Judge");
  virtualBeats = await tab.evaluate(() => {
    const D = window.__program.debateAt;
    return window.__live.played.beats.map((b) => ({ n: b.n, at: b.at - D }));
  });
}

// ---- 7. live: the real replay from the debate's start, the Walk on
if (part(7)) {
  await open([`replay=${REAL}`, "segment=debate", "from=0", "walk=1", "walkdemo=stress"], () => window.__stage?.ready === true && !!window.__walk && window.__live?.played?.beats?.length > 0);
  await tab.evaluate(() => {
    window.__shares = [];
    const W = window.__walk, st = window.__frame.stage;
    const RJ = { "opus-5.5": 0.41, "gpt-6.1-sol": 0.37, "sonnet-5.5": 0.3, "gpt-6-astra": 0.37, "fable-5.1": 0.33 }, RH = 0.33;
    const f = () => {
      const t = W.debug.viewT, s = W.debug.state;
      let gap = Infinity;
      for (const id of Object.keys(RJ)) if (st.robots[id].phaseAt(t)) {
        const p = st.robots[id].object3d.position;
        gap = Math.min(gap, Math.hypot(p.x - s.x, p.z - s.z) - RJ[id] - RH);
      }
      window.__shares.push([t, W.debug.share(), gap]);
      requestAnimationFrame(f);
    };
    requestAnimationFrame(f);
  });
  const LIVE_S = Number(opt("live", 250));
  await sleep(LIVE_S * 1000);
  const res = await tab.evaluate(() => {
    const L = window.__live, P = window.__program;
    const ns = L.played.beats.map((b) => b.n);
    const votes = L.planner.trace.filter((x) => /^(decide|walk|slot|wave|card|tube|tally|cards)\b/.test(x.tag)).map((x) => ({ from: x.from, to: x.to, tag: x.tag }));
    return { D: P.debateAt, beats: L.played.beats.map((b) => ({ n: b.n, at: b.at })), says: L.played.says.map((s) => ({ n: s.n, t0: s.t0, end: s.end })), votes, shares: window.__shares, inOrder: ns.every((n, i) => n === ns[0] + i), once: new Set(ns).size === ns.length, first: ns[0] };
  });
  const lastT = res.shares.at(-1)?.[0] ?? 0;
  const done = res.says.filter((s) => s.end <= lastT);
  let bad = 0, frames = 0;
  for (const s of done) for (const [t, sh] of res.shares) if (t >= s.t0 && t < s.end) (frames++), sh > 0 && bad++;
  console.log(`  ${res.beats.length} beats in ${LIVE_S} s, ${done.length} Judge lines over ${frames} frames; the Walk's share > 0 in ${bad} of them`);
  expect(res.first === 0 && res.inOrder && res.once, "every beat once, in order");
  expect(done.length > 0 && bad === 0, "the camera is the director's through every line");
  // the vote: the decisions, the walks, the drops; the director's from their start (a beat the queue could
  // not announce gets the hand-over's 0.9 s)
  const vDone = res.votes.filter((v) => v.to <= lastT);
  let vFrames = 0, vBad = 0, vLate = 0;
  for (const v of vDone) for (const [t, sh] of res.shares) if (t >= v.from && t < v.to) {
    vFrames++;
    if (sh > 0) t < v.from + 0.9 ? vLate++ : vBad++;
  }
  console.log(`  ${vDone.length} vote segments over ${vFrames} frames: the Walk's share > 0 in ${vBad} (and ${vLate} inside a hand-over at a segment's start)`);
  expect(vDone.length > 0 && vBad === 0, "the camera is the director's through the vote");
  const gaps = res.shares.map((x) => x[2]).filter(Number.isFinite);
  console.log(`  a Judge walking in ${gaps.length} frames; the Host's closest: ${gaps.length ? r2(Math.min(...gaps)) : "—"} m between bodies`);
  expect(gaps.length > 0 && Math.min(...gaps) >= 0, "live: the Host never overlaps a Judge walking to the box");
  // never delayed: the same beats start when the virtual plan has them (relative to the debate's start)
  if (virtualBeats) {
    const v = new Map(virtualBeats.map((b) => [b.n, b.at]));
    const offs = res.beats.filter((b) => v.has(b.n)).map((b) => b.at - res.D - v.get(b.n));
    const drift = offs.length ? Math.max(...offs) - Math.min(...offs) : NaN;
    console.log(`  live beat times vs the virtual plan: ${offs.length} beats, offset ${r2(Math.min(...offs))}…${r2(Math.max(...offs))} s`);
    expect(drift < 0.6, `the beats keep the plan's pace with the Walk on (spread ${r2(drift)} s; the director ticks every 0.1 s)`);
  }
}

// ---- 8. ms per frame with the Walk on
if (part(8)) {
  // A/B at each time: the page without the Walk, then with it walking, in the same browser one after the
  // other, each the best of 2 benches: a GPU shared with other runs slows both alike
  const times = opt("t", "4,50,131,631,712,742,1000").split(",").map(Number);
  const deltas = [];
  for (const g of ["full", "lite"]) {
    for (const t of times) {
      const ms = {};
      let st = null, seg = "";
      for (const on of [false, true]) {
        await tab.goto(`${base}/show.html?${q([`replay=${SYNTH}`, `t=${t}`, on && "walk=1", on && "walkdemo=1", g === "lite" && "gfx=lite"])}`);
        await tab.waitForFunction(() => window.__stage?.ready === true, null, { timeout: 180000 });
        const r = await tab.evaluate(async () => [Math.min((await window.__stage.bench(120)).msPerFrame, (await window.__stage.bench(120)).msPerFrame), window.__walk?.debug.state ?? null]);
        ms[on ? "on" : "off"] = r[0];
        if (on) st = r[1];
        seg = await tab.evaluate((x) => window.__program.segmentAt(x), t);
      }
      const limit = g === "full" ? 20 : 10;
      deltas.push(ms.on - ms.off);
      console.log(`${g.padEnd(4)} t=${String(t).padStart(6)}  ${seg.padEnd(16)} off ${ms.off.toFixed(2)}  on ${ms.on.toFixed(2)} ms/frame (${ms.on >= ms.off ? "+" : ""}${(ms.on - ms.off).toFixed(2)})  walk ${st?.owner}${st?.speed > 0.05 ? ", walking" : ""}${ms.on > limit ? `  over ${limit} ms${ms.off > limit ? " (off too)" : ""}` : ""}`);
      if (ms.on > limit) failed = true;
    }
  }
  console.log(`  the Walk's cost: median ${r2(deltas.sort((a, b) => a - b)[deltas.length >> 1])} ms/frame, worst ${r2(deltas[deltas.length - 1])} ms`);
}

// ---- 9. the Walk's own JS per frame, live
if (part(9)) {
  await open([`replay=${SYNTH}`, "segment=title", "hold=0", "walk=1", "walkdemo=1"]);
  const js = await tab.evaluate(async () => {
    const W = window.__walk, f = W.frame, ms = [];
    W.frame = (t) => {
      const a = performance.now();
      f(t);
      ms.push(performance.now() - a);
    };
    await new Promise((r) => setTimeout(r, 14000));
    W.frame = f;
    ms.sort((a, b) => a - b);
    return { n: ms.length, mean: ms.reduce((s, x) => s + x, 0) / ms.length, p99: ms[Math.floor(ms.length * 0.99)], max: ms[ms.length - 1], st: W.debug.state };
  });
  console.log(`  ${js.n} frames over 14 s of the demo (walk, orbit, a path round the box): mean ${js.mean.toFixed(3)}, p99 ${js.p99.toFixed(3)}, max ${js.max.toFixed(3)} ms`);
  expect(js.n > 300 && js.p99 < 1 && js.max < 4, "the Walk's own JS: p99 under 1 ms a frame, no frame over 4 ms");
}

if (pub404) console.log(`(${pub404} requests of walk-interact's /pub/ layout probe answered 404, not counted: no publication here)`);
if (interact404) console.log(`(ui/walk-interact.js is not on this branch: its import failed ${interact404}× silently, as designed)`);
console.log(errors.length ? `console errors (${errors.length}):\n  ${errors.join("\n  ")}` : "console errors: 0");
if (errors.length) failed = true;
await browser.close();
server.close();
process.exit(failed ? 1 : 0);
