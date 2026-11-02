#!/usr/bin/env node
// Checks the running OBS (collection «OpenEgiz Final») through obs-websocket v5.
// Node 22+ (global WebSocket), no npm packages. Password: ~/.config/openegiz/obs-ws.txt or $OBS_WS_PASSWORD.
//
//   node check.mjs [--url ws://127.0.0.1:4455] [--seconds 60] [--skip-record]
//
// For each of the 6 scenes: switch, wait 4 s, screenshot of the program to /tmp/obs-check/<n>.png, GetStats.
// Then records --seconds on scene 3, stops, and runs ffprobe on the file(s).
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const URL = opt('--url', 'ws://127.0.0.1:4455');
const REC_SECONDS = Number(opt('--seconds', '60'));
const SKIP_RECORD = args.includes('--skip-record');
const OUT = '/tmp/obs-check';
const SCENES = ['1 Скоро начнём', '2 Ведущий', '3 Эфир', '4 Стенд', '5 Технический перерыв', '6 Финиш'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256b64 = (s) => createHash('sha256').update(s).digest('base64');

const password = process.env.OBS_WS_PASSWORD
  ?? readFileSync(join(homedir(), '.config/openegiz/obs-ws.txt'), 'utf8').trim();

const ws = new WebSocket(URL);
const pending = new Map();
let nextId = 1;
let identified;
const ready = new Promise((res, rej) => { identified = { res, rej }; });

ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.op === 0) { // Hello
    const d = { rpcVersion: 1, eventSubscriptions: 0 };
    if (msg.d.authentication) {
      const { challenge, salt } = msg.d.authentication;
      d.authentication = sha256b64(sha256b64(password + salt) + challenge);
    }
    ws.send(JSON.stringify({ op: 1, d }));
  } else if (msg.op === 2) { // Identified
    identified.res();
  } else if (msg.op === 7) { // RequestResponse
    const p = pending.get(msg.d.requestId);
    if (!p) return;
    pending.delete(msg.d.requestId);
    if (msg.d.requestStatus.result) p.res(msg.d.responseData ?? {});
    else p.rej(new Error(`${msg.d.requestType}: ${msg.d.requestStatus.comment ?? msg.d.requestStatus.code}`));
  }
});
ws.addEventListener('close', (ev) => identified.rej(new Error(`websocket closed (${ev.code} ${ev.reason})`)));
ws.addEventListener('error', () => identified.rej(new Error(`cannot connect to ${URL}: is OBS running with the websocket server on?`)));

function request(requestType, requestData = {}) {
  const requestId = String(nextId++);
  return new Promise((res, rej) => {
    pending.set(requestId, { res, rej });
    ws.send(JSON.stringify({ op: 6, d: { requestType, requestId, requestData } }));
  });
}

async function stats() {
  const s = await request('GetStats');
  return {
    cpu: Number(s.cpuUsage.toFixed(1)),
    fps: Number(s.activeFps.toFixed(2)),
    renderSkipped: s.renderSkippedFrames,
    renderTotal: s.renderTotalFrames,
    outputSkipped: s.outputSkippedFrames,
    outputTotal: s.outputTotalFrames,
  };
}

function probe(file) {
  const out = JSON.parse(execFileSync('ffprobe', [
    '-v', 'error', '-show_streams', '-show_format', '-of', 'json', file,
  ], { encoding: 'utf8' }));
  const v = out.streams.find((s) => s.codec_type === 'video');
  const a = out.streams.filter((s) => s.codec_type === 'audio');
  const [n, d] = (v?.avg_frame_rate ?? '0/1').split('/').map(Number);
  const fps = d ? n / d : 0;
  const line = `${file}: video ${v?.codec_name} ${v?.width}x${v?.height} ${fps.toFixed(2)} fps; `
    + `audio ${a.map((s) => `${s.codec_name} ${s.sample_rate} Hz ${s.channels}ch`).join(', ') || 'NONE'}; `
    + `duration ${Number(out.format.duration).toFixed(1)} s`;
  const ok = v?.width === 1920 && v?.height === 1080 && Math.abs(fps - 30) < 0.5 && a.length >= 1;
  return { line, ok };
}

let failed = false;
try {
  await ready;
  mkdirSync(OUT, { recursive: true });
  const version = await request('GetVersion');
  console.log(`OBS ${version.obsVersion}, obs-websocket ${version.obsWebSocketVersion}`);
  const video = await request('GetVideoSettings');
  console.log(`canvas ${video.baseWidth}x${video.baseHeight}, output ${video.outputWidth}x${video.outputHeight}, `
    + `${video.fpsNumerator}/${video.fpsDenominator} fps`);
  const present = (await request('GetSceneList')).scenes.map((s) => s.sceneName);
  for (const name of SCENES) if (!present.includes(name)) throw new Error(`scene missing: ${name}`);
  const tr = await request('GetCurrentSceneTransition');
  console.log(`transition: ${tr.transitionName}, ${tr.transitionDuration} ms`);

  for (const [i, name] of SCENES.entries()) {
    await request('SetCurrentProgramScene', { sceneName: name });
    await sleep(4000);
    const shot = await request('GetSourceScreenshot', {
      sourceName: name, imageFormat: 'png', imageWidth: 1920, imageHeight: 1080,
    });
    const file = join(OUT, `${i + 1}.png`);
    writeFileSync(file, Buffer.from(shot.imageData.split(',')[1], 'base64'));
    console.log(`scene ${i + 1} «${name}»: ${file}  stats ${JSON.stringify(await stats())}`);
  }

  if (!SKIP_RECORD) {
    await request('SetCurrentProgramScene', { sceneName: SCENES[2] });
    const before = await stats();
    await request('StartRecord');
    console.log(`recording ${REC_SECONDS} s on «${SCENES[2]}»`);
    await sleep(REC_SECONDS * 1000);
    const during = await stats();
    const { outputPath } = await request('StopRecord');
    console.log(`GetStats before: ${JSON.stringify(before)}`);
    console.log(`GetStats after ${REC_SECONDS} s: ${JSON.stringify(during)}`);
    console.log(`recorded: ${outputPath}`);
    await sleep(6000); // auto-remux to mp4 runs after the stop
    const files = [outputPath];
    const mp4 = outputPath.replace(/\.[^.]+$/, '.mp4');
    if (mp4 !== outputPath && existsSync(mp4)) files.push(mp4);
    for (const f of files) {
      if (!existsSync(f)) { console.log(`${f}: gone (remuxed or moved)`); continue; }
      const { line, ok } = probe(f);
      console.log(`ffprobe ${ok ? 'OK ' : 'FAIL'} ${line}`);
      if (!ok) failed = true;
    }
    if (files.length === 1) console.log('note: no .mp4 next to the recording (auto-remux did not produce one)');
  }
  await request('SetCurrentProgramScene', { sceneName: SCENES[0] });
} catch (e) {
  console.error(`check failed: ${e.message}`);
  failed = true;
} finally {
  ws.close();
}
process.exit(failed ? 1 : 0);
