// Finalist codes until the envelopes (spec §7.7 «Коды Финалистов», ADR-0010, owner 2026-10-28).
//
// The Judges' verbatim lines name their favourite («Мой фаворит — «Горный поток»»), which would give
// every sealed place away long before the envelopes. So in the Judges' lines on the Stage (the
// subtitles and the voice: the same text goes to both) every Finalist's name, in any case form, with or
// without «», and every `team-NNN` becomes a code drawn at the launch: «Финалист G». Nothing else in a
// line changes (mines and modules keep their names). From the first envelope on the lines are verbatim:
// each opened envelope's Host line maps the codes of its deciding round to the Teams (the last one maps
// every code still unnamed), and the verdict card shows the reasons in full. The engine's control page
// and the published record keep the unaltered text: this is the Stage only.
//
// The draw is a function of the run's key (its runId, else state.started_at): a reload or a --resume
// of the same run draws the same codes. The letters are Latin (owner 2026-10-28) and none looks like a
// Cyrillic letter on screen (not A B C E H K M O P T X Y: «Финалист B» would read as Russian «В»); the
// voice says the English letter's name inside the Russian line («Финалист Джи»): the TTS dictionary
// (tts/voices.json, elevenlabs "say") spells each «Финалист X» out. W (long to say) and V (heard as
// D) are kept for more than ten Finalists.
//
// What a code never shows: a card, a tube, a marker. The Host's own lines keep their names (the ceiling
// line of place 1 names the Finalists under the ceiling: a rule known before the Final, п. 9.3; the tubes
// show the names too, so no code is ever linked to a name before its envelope).
//
// No imports: node tests load this file as is.

export const LETTERS = ["D", "F", "G", "J", "L", "N", "Q", "R", "S", "Z"];
const MORE = ["V", "W"]; // beyond ten Finalists
// how the voice says each letter (the TTS dictionary): the English letter's name in Cyrillic
export const SPOKEN = { D: "Ди", F: "Эф", G: "Джи", J: "Джей", L: "Эл", N: "Эн", Q: "Кью", R: "Ар", S: "Эс", Z: "Зед", V: "Ви", W: "Дабл-ю" };
export const FINALIST = { nom: "Финалист", gen: "Финалиста", dat: "Финалисту", acc: "Финалиста", ins: "Финалистом", prep: "Финалисте" };

// The Host says what the codes are as the debate opens, and maps them at each envelope (accepted by
// the owner 2026-10-28: contest/stage/out/v8-codes/wording.md)
export const CODE_LINES = {
  intro: () => "До вскрытия конвертов в речи Судей Финалисты звучат под кодами: «Финалист» и буква.",
  map: (pairs) => `${pairs.length > 1 ? "Коды" : "Код"} из реплик Судей: ${pairs.map(([code, name]) => `${code} — ${name}`).join(", ")}.`,
};

// ---- the draw

function hash32(s) {
  let h = 0x811c9dc5;
  for (const ch of String(s)) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** team → letter, a shuffle seeded by the run's key: the same run always draws the same codes. */
export function drawCodes(teams, key) {
  const pool = [...LETTERS, ...MORE];
  const next = rng(hash32(`openegiz-codes:${key ?? ""}`));
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  // the ten clean letters first, in the drawn order; the extras only past ten Finalists
  const order = [...pool.filter((l) => LETTERS.includes(l)), ...pool.filter((l) => !LETTERS.includes(l))];
  return new Map([...teams].sort().map((t, i) => [t, order[i] ?? `${i + 1}`]));
}

// ---- the names' case forms

const CASES = ["nom", "gen", "dat", "acc", "ins", "prep"];
const HUSH = /[жшчщц]$/; // ins -ем after these (unstressed)
const VELAR_HUSH = /[гкхжшчщ]$/; // gen -и, not -ы

// one word's forms: { case: [forms] } (inanimate: acc = nom), or null when it does not decline
function wordForms(w, { adjective = false } = {}) {
  if (!/^[А-ЯЁа-яё]+$/.test(w) || w.length < 2) return null;
  const f = { nom: [w], gen: [], dat: [], acc: [w], ins: [], prep: [] };
  const add = (c, ...xs) => f[c].push(...xs);
  const stem = (n) => w.slice(0, -n);
  if (adjective) {
    if (/(ый|ий|ой)$/.test(w)) {
      const s = stem(2), soft = /ий$/.test(w) && !VELAR_HUSH.test(s);
      add("gen", s + (soft ? "его" : "ого")); add("dat", s + (soft ? "ему" : "ому"));
      add("ins", s + (/ый$/.test(w) && !VELAR_HUSH.test(s) ? "ым" : "им")); add("prep", s + (soft ? "ем" : "ом"));
    } else if (/ая$/.test(w)) {
      const s = stem(2);
      add("gen", s + "ой"); add("dat", s + "ой"); add("ins", s + "ой"); add("prep", s + "ой");
      f.acc = [s + "ую"];
    } else if (/яя$/.test(w)) {
      const s = stem(2);
      for (const c of ["gen", "dat", "ins", "prep"]) add(c, s + "ей");
      f.acc = [s + "юю"];
    } else if (/ое$/.test(w)) {
      const s = stem(2);
      add("gen", s + "ого"); add("dat", s + "ому"); add("ins", s + "ым"); add("prep", s + "ом");
    } else if (/ые$/.test(w)) {
      const s = stem(2);
      add("gen", s + "ых"); add("dat", s + "ым"); add("ins", s + "ыми"); add("prep", s + "ых");
    } else return null;
    return f;
  }
  if (/[бвгджзклмнпрстфхцчшщ]$/i.test(w)) {
    add("gen", w + "а"); add("dat", w + "у"); add("ins", w + (HUSH.test(w) ? "ем" : "ом"), w + "ом"); add("prep", w + "е");
  } else if (/й$/.test(w)) {
    const s = stem(1);
    add("gen", s + "я"); add("dat", s + "ю"); add("ins", s + "ем"); add("prep", s + "е");
  } else if (/ь$/.test(w)) {
    const s = stem(1); // masculine or feminine: both
    add("gen", s + "я", s + "и"); add("dat", s + "ю", s + "и"); add("ins", s + "ем", w + "ю"); add("prep", s + "е", s + "и");
  } else if (/а$/.test(w)) {
    const s = stem(1); // feminine singular, or a plural like «Недра»
    add("gen", s + (VELAR_HUSH.test(s) ? "и" : "ы"), s); add("dat", s + "е", s + "ам"); add("ins", s + "ой", s + "ою", s + "ами");
    add("prep", s + "е", s + "ах");
    f.acc = [s + "у", w];
  } else if (/я$/.test(w)) {
    const s = stem(1);
    add("gen", s + "и"); add("dat", s + "е"); add("ins", s + "ей"); add("prep", s + "е");
    f.acc = [s + "ю"];
  } else if (/о$/.test(w)) {
    const s = stem(1);
    add("gen", s + "а"); add("dat", s + "у"); add("ins", s + "ом"); add("prep", s + "е");
  } else return null;
  for (const c of CASES) f[c] = [...new Set(f[c])];
  return f;
}

/**
 * A name's forms: [{ text, cases: Set }] longest first. A name of several words declines each Cyrillic
 * word (an adjective before the last word as an adjective); Latin, digits, a hyphenated word stay as
 * they are. A form that is the same in every case (an indeclinable name) has cases = null: its case
 * comes from the words before it.
 */
export function nameForms(name) {
  const words = String(name).trim().split(/\s+/);
  const per = words.map((w, i) => wordForms(w, { adjective: i < words.length - 1 && /(ый|ий|ой|ая|яя|ое|ые)$/.test(w) }));
  const out = new Map();
  if (per.every((f) => !f)) return [{ text: words.join(" "), cases: null }];
  for (const c of CASES) {
    // every combination of the words' forms in case c (a word with two forms gives two)
    let acc = [""];
    words.forEach((w, i) => {
      const xs = per[i] ? per[i][c] : [w];
      acc = acc.flatMap((a) => xs.map((x) => (a ? `${a} ${x}` : x)));
    });
    for (const t of acc) (out.get(t) ?? out.set(t, new Set()).get(t)).add(c);
  }
  // also the name without trailing tokens that do not decline («Рудник 4.0» → «Рудника»)
  const lastWord = per.map((f, i) => (f ? i : -1)).filter((i) => i >= 0).at(-1);
  if (lastWord < words.length - 1 && words.slice(lastWord + 1).every((w) => !/[А-ЯЁа-яёA-Za-z]/.test(w))) {
    for (const x of nameForms(words.slice(0, lastWord + 1).join(" "))) if (!out.has(x.text)) out.set(x.text, x.cases);
  }
  return [...out].map(([text, cases]) => ({ text, cases })).sort((a, b) => b.text.length - a.text.length);
}

// ---- the case a code takes, from the word before it

const PREP = {
  у: "gen", от: "gen", до: "gen", из: "gen", без: "gen", для: "gen", против: "gen", около: "gen", после: "gen", кроме: "gen",
  среди: "gen", вместо: "gen", мимо: "gen", возле: "gen", пользу: "gen", ради: "gen", вокруг: "gen", насчёт: "gen", насчет: "gen",
  к: "dat", ко: "dat", по: "dat", благодаря: "dat", согласно: "dat",
  с: "ins", со: "ins", над: "ins", перед: "ins", между: "ins", за: "acc", на: "acc", про: "acc", через: "acc", сквозь: "acc",
  о: "prep", об: "prep", обо: "prep", при: "prep", в: "prep", во: "prep",
};
const LOC = new Set(["о", "об", "обо", "при", "в", "во", "на"]); // a dative-or-prepositional form after these is prepositional
const OPEN = new Set(["и", "а", "но", "или", "что", "чем", "как", "это", "—", "–", "-", "не", "ни", "да", "либо", "тогда", "же", "ли", "вот", "вывод", "лидер", "фаворит", "соперник"]);
const VERB = /(аю|яю|ую|ою|лю|жу|шу|чу|щу|ет|ит|ут|ют|ат|ят|ал|ял|ил|ел|ла|ли|ло|ть|ешь|ишь)$/;
const ADJ_GEN = /(ого|его)$/;
const COMPARATIVE = /(ее|ше|же)$/; // «сильнее», «лучше», «хуже»: what follows is a new subject

function caseOf(cases, before) {
  const m = /([\p{L}\d]+)[^\p{L}\d]*$/u.exec(before);
  // a word straight before it, or a mark (a dash, a colon, an opening): a new phrase
  const gap = m ? before.slice(m.index + m[1].length) : before;
  const prev = m && !/[—–:;.!?(«]/.test(gap) ? m[1].toLowerCase() : null;
  const fits = (c) => !cases || cases.has(c);
  const byPrep = prev ? PREP[prev] : null;
  if (cases && cases.size === 1) return [...cases][0];
  if (cases?.has("dat") && cases.has("prep") && !cases.has("nom")) return prev && LOC.has(prev) ? "prep" : "dat";
  if (byPrep && fits(byPrep)) return byPrep;
  if (byPrep === "prep" && fits("acc")) return "acc"; // «в» with an accusative form
  if (!prev || OPEN.has(prev) || COMPARATIVE.test(prev)) return fits("nom") ? "nom" : [...cases][0];
  if (ADJ_GEN.test(prev) && fits("gen")) return "gen";
  if (VERB.test(prev) && fits("acc")) return "acc";
  if (!cases) return "gen"; // after a noun («модель «Карьер-Ай»»): its genitive
  return fits("nom") ? "nom" : [...cases][0];
}

// ---- the coder

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const yo = (s) => esc(s).replace(/[её]/g, "[её]").replace(/[ЕЁ]/g, "[ЕЁ]");

/**
 * createCoder({ finalists: [{ team, name }], key }) → { codes, code(text) → { text, teams } , label(team) }.
 * code() replaces the names (capitalised as the Team writes it; a lowercase «штрек» is the mine's word,
 * not the Team) and the team ids; `teams` = the teams it coded, in order.
 */
export function createCoder({ finalists = [], key = null } = {}) {
  const letters = drawCodes(finalists.map((f) => f.team), key);
  const label = (team, c = "nom") => `${FINALIST[c]} ${letters.get(team)}`;
  const forms = [];
  for (const f of finalists) if (f.name) for (const x of nameForms(f.name)) forms.push({ ...x, team: f.team });
  forms.sort((a, b) => b.text.length - a.text.length);
  const byForm = new Map(forms.map((x) => [x.text.replace(/ё/g, "е").replace(/Ё/g, "Е"), x]));
  const known = new Set(finalists.map((f) => f.team));
  const NAME = forms.length ? `(${forms.map((x) => yo(x.text)).join("|")})` : "(?!)";
  // «name (team-NNN)», «name» (team-NNN), name: the quotes go with the name, a matching id with it
  const re = new RegExp(`(«)?(?<![\\p{L}\\d-])${NAME}(?![\\p{L}\\d])(»)?(?:(\\s*)\\((team-\\d{3})\\))?(»)?`, "gu");
  const ID = /(?<![\p{L}\d-])team-\d{3}(?![\p{L}\d])/gu;

  function code(text) {
    if (typeof text !== "string" || !text) return { text, teams: [] };
    const teams = [];
    let out = text.replace(re, (all, open, form, close1, sp, id, close2, at, src) => {
      const x = byForm.get(form.replace(/ё/g, "е").replace(/Ё/g, "Е"));
      if (!x) return all;
      const own = id === x.team;
      const closed = !!(open && (close1 || close2));
      // a longer quote that opens with the name is a phrase of its own
      const c = caseOf(x.cases, src.slice(0, at) + (open && !closed ? open : ""));
      teams.push(x.team);
      let s = label(x.team, c);
      // an opening quote without its closing one belongs to a longer quote: it stays
      if (open && !closed) s = open + s;
      if (close1 && !open) s += close1;
      if (id && !own) s += `${sp}(${known.has(id) ? label(id) : id})`;
      if (close2 && !(open && !close1)) s += close2;
      return s;
    });
    out = out.replace(ID, (id, at, src) => {
      if (!known.has(id)) return id;
      teams.push(id);
      return label(id, caseOf(null, src.slice(0, at)));
    });
    // «Финалист G (Финалист G)»: one is enough
    out = out.replace(/(Финалист[а-я]* ([A-ZА-ЯЁ\d]+))\s*\(Финалист[а-я]* \2\)/gu, "$1");
    return { text: out, teams };
  }
  return { codes: letters, code, label, finalists }; // finalists: for ui/veil.js
}

// ---- on the Stage: around the Planner

/**
 * Codes the Judges' lines of every beat before the first envelope (calls and voice: one text), adds the
 * Host's line on the codes to the debate's first beat with a voice, and the mapping to each opened
 * envelope. `director` = a director/director.js Director (its planner and runKey); returns the record
 * { coder, used, mapped, original: Map(beat n → the unaltered text), maps: [{ n, place, pairs }] }.
 * Off (envelopes off: ?reveal=each) it does nothing.
 */
export function installCodes(director, { enabled = true } = {}) {
  const rec = { coder: null, used: new Set(), mapped: new Set(), original: new Map(), maps: [], opened: false, introduced: false };
  if (!enabled) return rec;
  const planner = director.planner;
  const plan = planner.plan.bind(planner);
  const codeCall = (b, call, i) => {
    const r = rec.coder.code(call.args[i]);
    if (r.text === call.args[i]) return;
    rec.original.set(b.n, call.args[i]);
    r.teams.forEach((t) => rec.used.add(t));
    call.args = call.args.map((a, k) => (k === i ? r.text : a));
    if (b.voice) b.voice = { ...b.voice, text: r.text };
  };
  const addLine = (b, line, method) => {
    const call = b.calls.find((c) => c.method === method && c.voiced);
    if (!call || !b.voice) return false;
    const text = `${b.voice.text} ${line}`;
    call.args = call.args.map((a, k) => (k ? a : method === "envelope" ? { ...a, text } : text));
    b.voice = { ...b.voice, text };
    return true;
  };
  planner.plan = (ev) => {
    const beats = plan(ev);
    if (ev.type === "setup") {
      rec.coder = createCoder({ finalists: planner.finalists, key: director.runKey ?? ev.started_at ?? null });
      return beats;
    }
    if (!rec.coder) return beats;
    beats.forEach((b, i) => {
      if (b.type === "reveal.intro" || b.type === "reveal.open") rec.opened = true;
      if (!rec.opened) {
        for (const call of b.calls) if (call.method === "say") codeCall(b, call, 1);
        // the debate's first Host line says what the codes are
        if (!rec.introduced && b.type === "round" && b.voice?.speaker === "host") rec.introduced = addLine(b, CODE_LINES.intro(), "host");
      }
      if (b.type !== "reveal.open") return;
      // this envelope's deciding round: the teams of its tokens in the order they open, and the winner
      const next = beats.findIndex((x, k) => k > i && x.type === "reveal.open");
      const teams = [];
      for (const x of beats.slice(i + 1, next < 0 ? beats.length : next)) {
        for (const c of x.calls) {
          const t = c.method === "voteReveal" ? c.args[0]?.team : c.method === "verdict" || c.method === "lastWord" ? c.args[0]?.team : null;
          if (t && !teams.includes(t)) teams.push(t);
        }
      }
      // the last envelope names every code still unnamed
      if (next < 0 && !planner.sealed.length) for (const t of [...rec.used].sort((a, b) => rec.coder.codes.get(a).localeCompare(rec.coder.codes.get(b), "ru"))) if (!teams.includes(t)) teams.push(t);
      const pairs = teams.filter((t) => rec.used.has(t) && !rec.mapped.has(t))
        .map((t) => [rec.coder.label(t), `«${planner.byTeam.get(t)?.name ?? t}»`]);
      if (!pairs.length) return;
      teams.forEach((t) => rec.used.has(t) && rec.mapped.add(t));
      addLine(b, CODE_LINES.map(pairs), "envelope");
      rec.maps.push({ n: b.n, place: b.place, pairs });
    });
    return beats;
  };
  return rec;
}
