// ReplaySource: plays a recorded run on the director's clock.
//
// A replay is JSON lines (a record may be a delta against the previous state: see codec.js). The first line is a header; the rest are records ordered by t (seconds from the
// start of the recording):
//
//   {"format":"stage-replay/1","startedAt":"<ISO time of t=0>","runId":"…","synthetic":true,"note":"…"}
//   {"t":0.0,"state":{…state.json…}}                       a snapshot (written when state.json changed)
//   {"t":1.2,"delta":{"set":…,"append":…}}                 the same, as a delta against the previous one
//   {"t":2.5,"tid":"p1-r1-message-opus-5.5","prompt":true}  prompt.txt of the turn appeared
//   {"t":3.1,"tid":"p1-r1-message-opus-5.5","line":"{…}"}   one raw line of the turn's claude.jsonl|codex.jsonl
//
// read(now) hands out every record with t <= now it has not given yet, in order. Ticking the clock in big
// or small steps gives the same records in the same order, so any moment can be rendered again.
// Records are the same objects LiveSource produces, so the director cannot tell them apart.

import { applyDelta } from "./codec.js";

export class ReplaySource {
  constructor(records, header = {}) {
    this.header = header;
    let cur = null; // deltas are expanded in file order, before the records are sorted by time
    records = records.map((r) => {
      if (r.delta) return { t: r.t, state: (cur = applyDelta(cur ?? {}, r.delta)) };
      if (r.state) cur = r.state;
      return r;
    });
    this.records = records.map((r, i) => [r, i]).sort((a, b) => a[0].t - b[0].t || a[1] - b[1]).map(([r]) => r);
    this.i = 0;
  }

  static parse(text) {
    const lines = text.split("\n").filter((l) => l.trim());
    if (!lines.length) throw new Error("empty replay");
    const first = JSON.parse(lines[0]);
    const hasHeader = first.format !== undefined;
    const records = lines.slice(hasHeader ? 1 : 0).map((l) => JSON.parse(l));
    const header = hasHeader ? first : {};
    if (!header.startedAt) {
      const s = records.find((r) => r.state)?.state;
      if (s?.started_at) header.startedAt = s.started_at;
    }
    return new ReplaySource(records, header);
  }

  static async fromUrl(url, fetchImpl = globalThis.fetch) {
    const r = await fetchImpl(url);
    if (!r.ok) throw new Error(`${url}: ${r.status}`);
    return ReplaySource.parse(await r.text());
  }

  get synthetic() {
    return !!this.header.synthetic;
  }

  get endT() {
    return this.records.at(-1)?.t ?? 0;
  }

  async runKey() {
    return this.header.runId ?? null;
  }

  // ISO time of the engine -> seconds on this replay's clock
  clockOf(iso) {
    const t0 = Date.parse(this.header.startedAt ?? "");
    return Number.isNaN(t0) ? 0 : (Date.parse(iso) - t0) / 1000;
  }

  read(now) {
    const out = [];
    while (this.i < this.records.length && this.records[this.i].t <= now) out.push(this.records[this.i++]);
    return out;
  }

  seek(t = 0) {
    this.i = 0;
    while (this.i < this.records.length && this.records[this.i].t < t) this.i++;
  }

  // the last state at or before t, for a still of any moment
  stateAt(t) {
    let s = null;
    for (const r of this.records) {
      if (r.t > t) break;
      if (r.state) s = r.state;
    }
    return s;
  }
}
