// Sinks: what the director drives. The real one is the Stage's 3D scene (outside this folder); these two
// are for the terminal and for tests. A sink is any object with these methods (all optional, see README):
//   setup, restore, judge, status, say, host, unavailable, voteCast, voteReveal, tally, envelope, lastWord, verdict, podium, final
// Every call ends with a `meta` argument { at, ... } (the director's clock, seconds).

export const SINK_METHODS = ["setup", "restore", "judge", "status", "say", "host", "unavailable", "voteCast", "voteReveal", "tally",
  "envelope", "lastWord", "verdict", "podium", "final"];

// Collects every call: { method, args (without meta), meta }. For tests and for re-checking a show.
export class RecordingSink {
  constructor() {
    this.calls = [];
    for (const method of SINK_METHODS) {
      this[method] = (...args) => {
        const meta = args.pop();
        this.calls.push({ method, args, meta });
      };
    }
  }

  of(...methods) {
    return this.calls.filter((c) => methods.includes(c.method));
  }
}

const fmt = (s) => {
  if (s < 0) return "-" + fmt(-s);
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, "0")}:${(s - m * 60).toFixed(1).padStart(4, "0")}`;
};

// Logs the show as text, one line per beat; the live layer is marked "~".
export class ConsoleSink {
  constructor({ out = (line) => console.log(line), maxText = 0 } = {}) {
    this.out = out;
    this.maxText = maxText;
    this.printed = new Map(); // judge -> { status, tid, n } last live line printed
    this.origin = null;       // the first time seen: times print from there (a live clock is epoch seconds)
    for (const method of SINK_METHODS) {
      if (this[method] === undefined) this[method] = () => {};
    }
  }

  _t(text) {
    const t = String(text ?? "").replace(/\s+/g, " ");
    return this.maxText && t.length > this.maxText ? t.slice(0, this.maxText - 1) + "…" : t;
  }

  _rel(t) {
    this.origin ??= t;
    return t - this.origin;
  }

  _line(meta, tag, text) {
    this.out(`[${fmt(this._rel(meta.at))}] ${tag}${text ? " " + text : ""}`);
  }

  _beat(meta, tag, text) {
    const d = meta.durationS > 0 ? ` ${meta.durationS.toFixed(1)}s` : "";
    this._line(meta, `#${String(meta.n).padStart(3, "0")} ${tag}${d}`, text);
  }

  setup(info, meta) {
    this._line(meta, "SETUP", `${info.judges.length} Judges (${info.judges.map((j) => j.id).join(", ")}), ${info.finalists.length} Finalists, ${info.rounds} rounds per place`);
  }

  restore(info, meta) {
    this._line(meta, "RESUME", `from beat ${info.cursor}, podium ${JSON.stringify((info.podium ?? []).map((p) => p?.team ?? (p ? "vacant" : null)))}`);
  }

  judge(id, p, meta) {
    const last = this.printed.get(id) ?? { status: null, tid: null, n: 0, got: new Set() };
    const tid = p.turn?.tid ?? null;
    if (p.status !== last.status || tid !== last.tid) {
      const since = p.since != null ? ` since ${fmt(this._rel(p.since))} (${p.sinceSource})` : "";
      this._line(meta, `~ ${id}`, `${p.status}${tid ? " " + tid : ""}${since}`);
      last.n = 0;
    }
    const same = last.tid === tid;
    for (const a of p.activity.slice(same ? last.n : 0)) {
      this._line(meta, `~ ${id}`, `${a.kind.padEnd(6)} ${a.label}${a.path ? "  " + a.path : ""}`);
    }
    // a result that arrived after its call is printed once
    const got = same ? last.got : new Set();
    p.activity.forEach((a) => {
      const key = `${a.at}|${a.label}|${a.path}`;
      if (a.content && !got.has(key)) {
        got.add(key);
        const c = a.content;
        this._line(meta, `~ ${id}`, `${"".padEnd(6)} ↳ ${c.text != null ? `${c.text.length} chars${c.truncated ? " (cut)" : ""}` : "no text"}${c.image ? " " + c.image : ""}`);
      }
    });
    this.printed.set(id, { status: p.status, tid, n: p.activity.length, got });
  }

  status(s, meta) {
    this._line(meta, "STATUS", `place ${s.place}, round ${s.round}/${s.rounds}, ${s.phase}${s.sealed?.length ? `, sealed ${s.sealed.join(",")}` : ""}`);
  }

  say(speaker, text, voice, meta) {
    this._beat(meta, `SAY ${speaker}`, this._t(text), voice);
  }

  host(text, voice, meta) {
    this._beat(meta, "HOST", this._t(text), voice);
  }

  unavailable(judge, info, meta) {
    this._beat(meta, `DARK ${judge}`, `unavailable for the ${info.where}, place ${info.place} round ${info.round}`);
  }

  voteCast(judge, c, meta) {
    this._beat(meta, `CAST ${judge}`, c.unavailable ? "unavailable, no token" : `token ${c.order}/${c.of} (finished ${c.at != null ? fmt(this._rel(c.at)) : "?"})`);
  }

  voteReveal(v, voice, meta) {
    const was = v.changed ? ` [changed: round ${v.previous.round} ${v.previous.team}]` : "";
    const body = v.unavailable ? "unavailable, no vote" : `-> ${v.team} «${v.name}» (${v.teamVotes}/${v.line})${v.reached ? " LINE" : ""}${v.last ? " LAST" : ""}${was}: ${this._t(v.reason)}`;
    this._beat(meta, `VOTE ${v.index + 1}/${v.of} ${v.judge}`, body, voice);
  }

  tally(t, meta) {
    if (t.stage === "begin") {
      this._beat(meta, "TALLY", `place ${t.place} round ${t.round}: ${t.voted} voted of ${t.judges}, line ${t.line}`);
    } else {
      this._beat(meta, "RESULT", `${t.result}${t.winner ? " " + t.winner : ""} ${JSON.stringify(t.counts)} | ${t.banner}`);
    }
  }

  envelope(e, voice, meta) {
    this._beat(meta, e.stage === "open" ? "ENVELOPE OPEN" : "ENVELOPE SEALED", `place ${e.place}${e.round ? ` round ${e.round}/${e.rounds}` : ""} [${e.envelopes.map((x) => `${x.place}:${x.state}`).join(" ")}] | ${this._t(e.text)}`, voice);
  }

  lastWord(c, voice, meta) {
    this._beat(meta, "LAST WORD", `place ${c.place}: ${c.team} «${c.name}» rank ${c.rank} score ${c.score}; contenders ${c.contenders.map((x) => `${x.team}#${x.rank}`).join(" ")}`, voice);
  }

  verdict(c, voice, meta) {
    if (c.vacant) return this._beat(meta, "VERDICT", `place ${c.place} VACANT | ${c.text}`, voice);
    const reasons = c.reasons.map((r) => `\n        ${r.judge}: ${this._t(r.text)}`).join("")
      + (c.against ?? []).map((a) => `\n        against: ${a.judge} -> ${a.team}`).join("")
      + (c.absent ?? []).map((j) => `\n        no vote: ${j}`).join("");
    this._beat(meta, "VERDICT", `place ${c.place}: ${c.team} «${c.name}» ${c.votes}/${c.voted} votes, ${c.rounds} round(s), ${c.decided_by}, card ${c.durationS}s | ${c.text}${reasons}`, voice);
  }

  podium(p, meta) {
    this._beat(meta, "PODIUM", p.places.map((x, i) => `${i + 1}: ${x ? x.team ?? "vacant" : "-"}`).join("  "));
  }

  final(f, voice, meta) {
    this._beat(meta, "FINAL", f.podium.map((x) => `${x.place}: ${x.team ?? "vacant"}`).join("  "), voice);
  }
}
