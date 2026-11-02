// LiveSource: the running engine, through the Stage's server (/run/ → the engine's live page).
//
//   state.json                       polled every stateEveryS (1 s); an unchanged file is not reported
//   turns/<tid>/claude.jsonl|codex   tailed every logsEveryS (0.5 s) for each active turn: refetched and
//                                    cut by line count, only the new complete lines are reported
//   turns/<tid>/prompt.txt           probed (HEAD) for the active turns; its first appearance is reported
//
// The active turns come from the state: a Judge with status «пишет»/«голосует» in state.current runs
// turn p<place>-r<round>-<message|vote>-<judge>; after a failed ask the retry is `…-a2` (a3, …). Each poll
// probes the next attempt's prompt.txt and follows the highest one that exists. When a Judge's turn
// ends, its log is read one more time so the last lines are not lost.
//
// read(now) never waits for the network: it starts the polls that are due and returns what the finished
// ones brought. poll(now) only runs the due polls and resolves when they are done (tests, scripts); the
// items wait in the buffer for the next read().

import { activeTurns, makeTid } from "../events.js";

export class LiveSource {
  constructor(baseUrl = "", {
    fetch: fetchImpl = globalThis.fetch?.bind(globalThis), clock = () => Date.now() / 1000,
    runPath = "/run", stateEveryS = 1, logsEveryS = 0.5, onError = () => {}, maxAttempts = null,
  } = {}) {
    this.base = baseUrl.replace(/\/$/, "") + runPath;
    this.fetch = fetchImpl;
    this.clock = clock;
    this.stateEveryS = stateEveryS;
    this.logsEveryS = logsEveryS;
    this.onError = onError;
    this.maxAttempts = maxAttempts; // default: settings.retries + 1 from the state, else 4
    this.buffer = [];
    this.lastRaw = null;
    this.state = null;
    this.lastStateAt = -Infinity;
    this.lastLogsAt = -Infinity;
    this.following = new Map(); // judge -> { tid, agent }: the turn being tailed
    this.finishing = new Map(); // tid -> agent: read once more, then dropped
    this.lines = new Map();     // tid -> lines already reported
    this.prompts = new Set();   // tids whose prompt.txt was reported
    this.running = null;
  }

  async runKey() {
    // final.json is written once by the first run and kept by every rerun: the run's identity across --resume
    try {
      const r = await this.fetch(`${this.base}/final.json`, { cache: "no-store" });
      if (r.ok) return (await r.json()).created_at ?? null;
    } catch {}
    return null;
  }

  clockOf(iso) {
    return Date.parse(iso) / 1000;
  }

  read(now = this.clock()) {
    this._kick(now);
    return this.buffer.splice(0);
  }

  // starts the due polls and waits for them; the items stay in the buffer for read()
  async poll(now = this.clock()) {
    await this.running;
    this._kick(now);
    await this.running;
  }

  _kick(now) {
    if (this.running) return;
    const stateDue = now - this.lastStateAt >= this.stateEveryS;
    const logsDue = now - this.lastLogsAt >= this.logsEveryS;
    if (!stateDue && !logsDue) return;
    if (stateDue) this.lastStateAt = now;
    if (logsDue) this.lastLogsAt = now;
    this.running = (async () => {
      try {
        if (stateDue) await this._pollState(now);
        if (logsDue || stateDue) await this._pollLogs(now);
      } catch (err) {
        this.onError(err);
      } finally {
        this.running = null;
      }
    })();
  }

  async _get(path, init) {
    const r = await this.fetch(`${this.base}/${path}`, { cache: "no-store", ...init });
    return r;
  }

  async _pollState(now) {
    const r = await this._get("state.json");
    if (!r.ok) throw new Error(`state.json: ${r.status}`);
    const raw = await r.text();
    if (raw === this.lastRaw) return;
    let state;
    try {
      state = JSON.parse(raw);
    } catch {
      return; // caught mid-write; the next poll has it
    }
    this.lastRaw = raw;
    this.state = state;
    this.buffer.push({ t: now, state });
  }

  async _exists(path) {
    try {
      return (await this._get(path, { method: "HEAD" })).ok;
    } catch {
      return false;
    }
  }

  async _tail(tid, agent, now) {
    const r = await this._get(`turns/${tid}/${agent}.jsonl`);
    if (!r.ok) return;
    const text = await r.text();
    const complete = text.endsWith("\n") ? text : text.slice(0, text.lastIndexOf("\n") + 1);
    const lines = complete.split("\n").filter((l) => l !== "");
    const seen = this.lines.get(tid) ?? 0;
    for (const line of lines.slice(seen)) this.buffer.push({ t: now, tid, line });
    this.lines.set(tid, Math.max(seen, lines.length));
  }

  async _pollLogs(now) {
    const state = this.state;
    if (!state) return;
    const attempts = this.maxAttempts ?? (state.settings?.retries ?? 3) + 1;
    const active = activeTurns(state);
    const activeJudges = new Set(active.map((a) => a.judge));
    // a Judge whose turn ended: its log is read once more
    for (const [judge, rec] of this.following) {
      if (!activeJudges.has(judge)) {
        this.finishing.set(rec.tid, rec.agent);
        this.following.delete(judge);
      }
    }
    await Promise.all(active.map(async (a) => {
      let rec = this.following.get(a.judge);
      if (!rec || !rec.tid.startsWith(a.tid)) {
        if (rec) this.finishing.set(rec.tid, rec.agent);
        rec = { tid: a.tid, agent: a.agent };
        this.following.set(a.judge, rec);
      }
      // follow the highest attempt whose prompt.txt exists
      for (let n = attemptOf(rec.tid) + 1; n <= attempts; n++) {
        const tid = makeTid({ ...a, attempt: n });
        if (!(await this._exists(`turns/${tid}/prompt.txt`))) break;
        this.finishing.set(rec.tid, rec.agent);
        rec.tid = tid;
      }
      if (!this.prompts.has(rec.tid) && (await this._exists(`turns/${rec.tid}/prompt.txt`))) {
        this.prompts.add(rec.tid);
        this.buffer.push({ t: now, tid: rec.tid, prompt: true });
      }
      await this._tail(rec.tid, rec.agent, now);
    }));
    for (const [tid, agent] of this.finishing) {
      this.finishing.delete(tid);
      await this._tail(tid, agent, now);
    }
  }
}

function attemptOf(tid) {
  const m = /-a(\d+)$/.exec(tid);
  return m ? +m[1] : 1;
}
