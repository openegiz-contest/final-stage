// The presentation queue: beats play strictly in order, none skipped, each as long as its voice.
//
// Time is the director's clock (seconds). A beat starts at the latest of: the end of the beat before it
// (plus a short gap after a spoken one), the time its event was seen, and the time its voice was ready. A
// beat's sink calls are stamped with that start time, so the same input gives the same sequence whether the
// clock is ticked every frame or jumped in one step.
//
// A call marked `awaits` (the walk to the urn) tells how long the beat lasts: the sink returns {end} (the
// director's clock; or {durationS}) or a promise of that. A promise holds the beat until it settles
// (end = the {end} it resolves to, else the time the queue saw it settle), but at most holdMaxS.
//
// Voices: the head beat's voice and the next one are prepared ahead (one while a beat plays), so the next
// line is ready when the current one ends. A voice that rejects falls back to the estimate.

import { estimateTiming } from "./voice.js";

const zero = () => new Promise((r) => setTimeout(r, 0));

export class PresentationQueue {
  constructor({ voice, sink, gapS = 0.3, holdMaxS = 60, onEnd = () => {}, onWarn = () => {} }) {
    this.voice = voice;
    this.sink = sink;
    this.gapS = gapS;
    this.holdMaxS = holdMaxS;
    this.onEnd = onEnd;
    this.onWarn = onWarn;
    this.pending = [];
    this.current = null;
    this.lastEnd = -Infinity;
  }

  get depth() {
    return this.pending.length + (this.current ? 1 : 0);
  }

  push(beat, availableAt) {
    const spoken = beat.voice && String(beat.voice.text ?? "").trim() !== "";
    this.pending.push({ beat, availableAt, spoken, state: spoken ? "idle" : "ready", voice: null, vp: null, stalled: false, readyAt: 0 });
  }

  // the time something next changes in the queue (for drivers that jump the clock), or Infinity
  nextAt() {
    if (this.current) return this.current.end;
    const head = this.pending[0];
    return head ? Math.max(this.lastEnd, head.availableAt) : Infinity;
  }

  _prepare(entry) {
    if (!entry.spoken || entry.vp) return;
    entry.state = "pending";
    const { speaker, text } = entry.beat.voice;
    entry.vp = Promise.resolve()
      .then(() => this.voice.prepare(speaker, text))
      .then(normalize)
      .catch((err) => {
        this.onWarn(`voice for ${speaker} failed, estimating: ${err?.message ?? err}`);
        return estimateTiming(text);
      })
      .then((v) => {
        entry.voice = v;
        entry.state = "ready";
        return v;
      });
  }

  _prefetch() {
    let budget = this.current ? 1 : 2;
    for (const e of this.pending) {
      if (!e.spoken) continue;
      if (budget-- <= 0) break;
      this._prepare(e);
    }
  }

  async advance(now) {
    for (;;) {
      this._prefetch();
      if (this.current?.hold && !this.current.settled) {
        await Promise.race([this.current.hold, zero()]);
        const cur = this.current;
        if (cur.settled) cur.end = Math.max(cur.baseEnd, cur.result ?? now);
        else if (now >= cur.start + this.holdMaxS) {
          this.onWarn(`sink.${cur.holdMethod} did not finish in ${this.holdMaxS} s, moving on`);
          cur.settled = true;
          cur.end = cur.start + this.holdMaxS;
        }
      }
      if (this.current && this.current.end <= now) {
        const cur = this.current;
        this.current = null;
        this.lastEnd = cur.end;
        this.onEnd(cur.beat, cur.end);
        continue;
      }
      if (this.current) return;
      const head = this.pending[0];
      if (!head) return;
      const start = Math.max(this.lastEnd, head.availableAt);
      if (start > now) return;
      if (head.spoken && head.state !== "ready") {
        await Promise.race([head.vp, zero()]);
        if (head.state !== "ready") {
          head.stalled = true;
          return;
        }
      }
      // a voice that was late starts its beat when it is ready, whether it resolved during this tick or
      // between ticks (otherwise the beat is scheduled in the past and its audio is over before it starts)
      if (head.stalled) {
        head.readyAt = Math.max(head.readyAt, now);
        head.stalled = false;
      }
      const startAt = Math.max(start, head.readyAt);
      if (startAt > now) return;
      this.pending.shift();
      this._begin(head, startAt);
    }
  }

  _begin(entry, at) {
    const { beat, voice } = entry;
    const durationS = Math.max(beat.minS ?? 0, voice?.durationS ?? 0);
    let end = at + durationS + (entry.spoken ? this.gapS : 0);
    this.current = { beat, start: at, end };
    const meta = { n: beat.n, type: beat.type, at, durationS, place: beat.place, round: beat.round };
    for (const call of beat.calls) {
      const args = [...call.args];
      if (call.voiced) args.push(voice);
      else if (call.silent) args.push(null);
      args.push(meta);
      try {
        const r = this.sink[call.method]?.(...args);
        if (call.awaits) end = this._await(call, r, at, end);
      } catch (err) {
        this.onWarn(`sink.${call.method} threw: ${err?.message ?? err}`);
      }
    }
    this.current.baseEnd = end;
    if (!this.current.hold) this.current.end = end;
  }

  // what an `awaits` call returned -> the beat's end; a promise holds the beat (current.hold)
  _await(call, r, at, end) {
    const cur = this.current;
    if (r && typeof r.then === "function") {
      cur.holdMethod = call.method;
      cur.settled = false;
      cur.result = null;
      cur.hold = Promise.resolve(r).then((v) => { cur.result = endOf(v, at); }, (err) => {
        this.onWarn(`sink.${call.method} rejected: ${err?.message ?? err}`);
      }).then(() => { cur.settled = true; });
      cur.end = Infinity;
      return end;
    }
    const e = endOf(r, at);
    return e === null ? end : Math.max(end, e);
  }
}

// {end} on the director's clock, or {durationS} from the start; null for anything else
function endOf(v, at) {
  if (typeof v?.end === "number" && Number.isFinite(v.end)) return v.end;
  if (typeof v?.durationS === "number" && Number.isFinite(v.durationS)) return at + v.durationS;
  return null;
}

function normalize(v) {
  if (!v || typeof v.durationS !== "number" || !Array.isArray(v.words)) throw new Error("voice.prepare returned no { durationS, words }");
  return v;
}
