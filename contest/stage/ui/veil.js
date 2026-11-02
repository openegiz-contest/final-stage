// The Judges' monitors under the Finalist codes (spec §7.7 «Коды Финалистов», ADR-0010, owner 2026-10-28).
//
// The Judges' lines name the Finalists by code until the first envelope opens (ui/codes.js); their
// consoles show what they really read, which named the Team anyway: a header
// `view_image publication/solutions/team-041/…`, the Stand's own screenshot with the mine's name. So
// from the debate's start until the first envelope opens the consoles show the same reading veiled:
//   - every path, tool label, query and log line: each `team-NNN` and each Finalist's name (the matcher
//     of ui/codes.js, every case, with or without «») is the Finalist's code, «Финалист G», the same
//     code as in the lines; a team id of no Finalist is `team-···`. What that matcher leaves (a query
//     typed in lowercase, a part of a name: «горн», «Штрека») goes too: a word of 4+ letters that begins
//     a word of a Finalist's name, or that such a word begins, is «…» (the mine's own words with it)
//   - a picture the Judge opens is drawn only through a tiny canvas (blurred, greyed, low contrast):
//     a picture of a twin, never whose; the text of a file is drawn coded and blurred, the line
//     numbers and the scroll as they are (the reading stays visible)
//   - the ballot sheet of a vote turn lists the codes in the letters' order (no rank, no ceiling mark:
//     next to the tubes' names either would map the codes)
// From the first envelope on (and before the debate) everything shows as it was. A list of every
// Finalist with no code (the tubes, the corner note on the ceiling, the Walk's list) keeps the names: it
// never puts a code beside a name, while a coded list in rank order would map every code.
//
// The veil is a function of the show clock: on(t) for the debate's frames before the first envelope's
// beat (a jump back over the envelope veils again). world/screen.js asks it per frame.

const ID = /(?<![\p{L}\d-])team-\d{3}(?![\p{L}\d])/gu;
export const UNKNOWN_TEAM = "team-···";
const norm = (w) => w.toLowerCase().replace(/ё/g, "е");
const WORD = /[\p{L}\d]{4,}/gu;
/** the words of the Finalists' names a word on a monitor must not begin or be begun by */
const nameWords = (finalists) => [...new Set(finalists.flatMap((f) => norm(String(f.name ?? "")).split(/[^\p{L}\d]+/u)).filter((w) => w.length >= 4))];

/**
 * createVeil({ codes, from }): `codes` = the record of installCodes (ui/codes.js: its coder appears
 * at the run's setup; ui/live.js sets veil.codes once the director exists); `from` = the show time the
 * debate starts (show.html: the launch; live.html: none). Returns
 * { codes, on(t), open(t), openAt, path(s), label(s), text(s), ballot(contenders), override }.
 */
export function createVeil({ codes = null, from = null } = {}) {
  let words = null, wordsOf = null;
  const loose = (s, c) => {
    if (wordsOf !== c) [words, wordsOf] = [nameWords(c.finalists ?? []), c];
    return words.length ? s.replace(WORD, (w) => (words.some((n) => n.startsWith(norm(w)) || norm(w).startsWith(n)) ? "…" : w)) : s;
  };
  const veil = {
    codes,
    openAt: Infinity,
    /** tests and stills: true / false force the veil at every time; null = the rule */
    override: null,
    on(t) {
      if (veil.override != null) return veil.override;
      return !!veil.codes?.coder && t >= (from ?? -Infinity) && t < veil.openAt;
    },
    /** the first envelope opens at t (a later call with an earlier t wins: a replay played twice) */
    open(t) {
      if (Number.isFinite(t) && t < veil.openAt) veil.openAt = t;
    },
    /** a path, a tool label, a command: team ids in the nominative, then the names */
    path(s) {
      const c = veil.codes?.coder;
      if (typeof s !== "string" || !s || !c) return s;
      const ids = s.replace(ID, (id) => (c.codes.has(id) ? c.label(id) : UNKNOWN_TEAM));
      return loose(c.code(ids).text, c);
    },
    /** a tool's label: `search_text «query»` keeps its quotes around the coded query */
    label(s) {
      const m = typeof s === "string" ? /^(\S+) «(.*)»$/su.exec(s) : null;
      return m ? `${m[1]} «${veil.path(m[2])}»` : veil.path(s);
    },
    /** prose (a file's text, a query): the names and ids by ui/codes.js, case and all */
    text(s) {
      const c = veil.codes?.coder;
      if (typeof s !== "string" || !s || !c) return s;
      return veil.path(c.code(s).text);
    },
    /** the ballot sheet's rows: every contender by code, in the letters' order */
    ballot(contenders = []) {
      const c = veil.codes?.coder;
      if (!c) return contenders.map((f) => ({ code: "", label: f.name ?? f.team }));
      return contenders.map((f) => ({ code: c.codes.get(f.team) ?? "", label: c.codes.has(f.team) ? c.label(f.team) : UNKNOWN_TEAM }))
        .sort((a, b) => a.code.localeCompare(b.code, "en"));
    },
  };
  return veil;
}
