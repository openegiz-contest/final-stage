#!/usr/bin/env node
// Starts the Final's Stage in OBS (spec §7.7, 2026-10-31: the Stands first, then the Stage title to end).
// The Stage's browser source runs even when its scene is not on air, so it waits on about:blank and is
// loaded at the title only when the show starts. Node 22+, no npm packages; password as check.mjs.
//
//   node start_stage.mjs           the Stage at its title (?segment=title), then scene «3 Эфир» on air
//   node start_stage.mjs --blank   the Stage source on about:blank (before the show)
//
// ?segment=title stays in the URL: an OBS refresh opens it with the same ?segment=, so the Stage
// resumes its saved position instead of going back to the title (ui/operator.js resumePlan).
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const STAGE_URL = 'http://127.0.0.1:8780/show.html?cams=1&air=1&hold=0';
const SOURCE = 'Сцена';
const SCENE = '3 Эфир';
const blank = process.argv.includes('--blank');
const sha256b64 = (s) => createHash('sha256').update(s).digest('base64');
const password = process.env.OBS_WS_PASSWORD
  ?? readFileSync(join(homedir(), '.config/openegiz/obs-ws.txt'), 'utf8').trim();

const ws = new WebSocket(process.env.OBS_WS_URL ?? 'ws://127.0.0.1:4455');
const pending = new Map();
let nextId = 1;
let identified;
const ready = new Promise((res, rej) => { identified = { res, rej }; });
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.op === 0) {
    const d = { rpcVersion: 1, eventSubscriptions: 0 };
    if (msg.d.authentication) {
      const { challenge, salt } = msg.d.authentication;
      d.authentication = sha256b64(sha256b64(password + salt) + challenge);
    }
    ws.send(JSON.stringify({ op: 1, d }));
  } else if (msg.op === 2) {
    identified.res();
  } else if (msg.op === 7) {
    const p = pending.get(msg.d.requestId);
    if (!p) return;
    pending.delete(msg.d.requestId);
    if (msg.d.requestStatus.result) p.res(msg.d.responseData ?? {});
    else p.rej(new Error(`${msg.d.requestType}: ${msg.d.requestStatus.comment ?? msg.d.requestStatus.code}`));
  }
});
ws.addEventListener('error', () => identified.rej(new Error('OBS websocket: no connection (is OBS running?)')));
const request = (requestType, requestData = {}) => new Promise((res, rej) => {
  const requestId = String(nextId++);
  pending.set(requestId, { res, rej });
  ws.send(JSON.stringify({ op: 6, d: { requestType, requestId, requestData } }));
});

try {
  await ready;
  const url = blank ? 'about:blank' : `${STAGE_URL}&segment=title`;
  await request('SetInputSettings', { inputName: SOURCE, inputSettings: { url }, overlay: true });
  if (!blank) {
    await new Promise((r) => setTimeout(r, 1500)); // the title's first frame before the cut
    await request('SetCurrentProgramScene', { sceneName: SCENE });
  }
  const now = (await request('GetInputSettings', { inputName: SOURCE })).inputSettings.url;
  console.log(blank ? `Сцена: ${now}` : `Сцена: ${now}; в эфире «${SCENE}»`);
  ws.close();
} catch (e) {
  console.error(String(e.message ?? e));
  process.exit(1);
}
