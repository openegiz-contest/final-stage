// What the Host (the neutral sixth robot) says: templates filled from the data, nothing else. The Host
// evaluates nothing and adds no fact that is not in state.json. Russian only; Judge and model names stay
// in Latin.
//
// Every template below is a PROPOSAL for the owner: the wording is not decided. It goes on air only after
// the owner's «ок» (CLAUDE.md of the project: formulations the owner did not name are proposals).
//
// A Judge is always named by its display name («Fable 5.1»), never by the engine's id («fable-5.1»):
// judgeName() maps one to the other through the Stage's roster.

import { ROSTER } from "../robots/roster.js";

export const plural = (n, one, few, many) => {
  const a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b === 1) return one;
  if (b >= 2 && b <= 4) return few;
  return many;
};

const ORDINAL = { 1: "первое", 2: "второе", 3: "третье" };
export const ordinal = (place) => ORDINAL[place] ?? `${place}-е`;
const ORDINAL_GEN = { 1: "первого", 2: "второго", 3: "третьего" };
export const ordinalGen = (place) => ORDINAL_GEN[place] ?? `${place}-го`; // «конверт третьего места»
// «третье, второе, первое»: the order the envelopes are opened in
const placesDown = (n) => Array.from({ length: n }, (_, i) => ordinal(n - i)).join(", ");
export const votes = (n) => `${n} ${plural(n, "голос", "голоса", "голосов")}`;
export const rounds = (n) => `${n} ${plural(n, "раунд", "раунда", "раундов")}`;
const roundsOf = (n) => `${n} ${plural(n, "раунда", "раундов", "раундов")}`; // «после 3 раундов»
const score = (s) => String(s).replace(".", ",");

// «Горный поток»; the team id when the name is missing
export const teamName = (f, team) => (f?.name ? `«${f.name}»` : team);

// The Judge's display name: the roster's («gpt-6.1-sol» → «GPT 6.1 sol»); an id the roster does not
// know is spelled the same way (words split at "-", "gpt" in capitals, the others capitalised).
export function judgeName(id) {
  const r = ROSTER[id];
  if (r?.model) return r.model;
  const parts = String(id ?? "").split("-").filter(Boolean);
  if (!parts.length) return String(id ?? "");
  const [head, ...rest] = parts;
  return [/^gpt$/i.test(head) ? "GPT" : head.charAt(0).toUpperCase() + head.slice(1), ...rest].join(" ");
}

// «Fable 5.1», «Fable 5.1 и GPT 6 astra», «A, B и C»
export const andList = (xs) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} и ${xs.at(-1)}`);

// «один Судья недоступен», «два Судьи недоступны»
const NUM = { 1: "один", 2: "два", 3: "три", 4: "четыре" };
export const judgesAway = (n) => `${NUM[n] ?? n} ${plural(n, "Судья", "Судьи", "Судей")} ${n === 1 ? "недоступен" : "недоступны"}`;

// The Qualifying ceiling (Положение п. 9.3, spec §7.3): a capped Solution scores at most this and cannot win.
export const CEILING_POINTS = 40;

// «против — 1: «Штрек»», «против — 3: «Забой» — 2, «Штрек» — 1»; null when nobody voted against.
// `against` = [{ team }] (one per dissenting vote).
export function againstPhrase(against, nameOf) {
  if (!against?.length) return null;
  const by = new Map();
  for (const a of against) by.set(a.team, (by.get(a.team) ?? 0) + 1);
  const teams = [...by.entries()].sort((a, b) => b[1] - a[1]);
  const list = teams.length === 1 ? nameOf(teams[0][0]) : teams.map(([t, n]) => `${nameOf(t)} — ${n}`).join(", ");
  return `против — ${against.length}: ${list}`;
}

// «2 голоса за «X», 2 за «Y», 1 за «Z»» from tally.counts (already sorted by the engine)
export function countsPhrase(counts, nameOf) {
  const parts = Object.entries(counts).map(([team, n], i) => (i === 0 ? `${votes(n)} за ${nameOf(team)}` : `${n} за ${nameOf(team)}`));
  return parts.join(", ");
}

export const host = {
  // PROPOSAL: the first line of a place.
  openPlace: ({ place, rounds: max }) => `Определяем ${ordinal(place)} место. Раундов — не больше ${max}.`,

  // PROPOSAL: the first line of every vote wave, before the first Judge walks to the urn. `voted` = the
  // Judges who can vote (the available ones), as in the majority line.
  voteWave: ({ line, voted }) =>
    `Судьи голосуют тайно. Жетоны откроем, когда проголосуют все: нужно ${line} из ${voted}.`,

  // ---- Sealed envelopes (owner 2026-10-28, spec §7.7 «Конверты»): the votes stay in the urn until every
  // place is decided; the Host then opens the envelopes from the last place to the first. These lines
  // name no team and no count before the reveal.

  // PROPOSAL: the first line of a vote wave with sealed envelopes. The show's first wave says what
  // happens to the tokens; every later wave only the line.
  voteWaveSealed: ({ line, voted, first = false, places = 3 }) =>
    first
      ? `Судьи голосуют тайно: нужно ${line} из ${voted}. Жетоны не открываем: решённое место запечатаем в конверт, конверты вскроем в конце — ${placesDown(places)} место.`
      : `Судьи голосуют тайно: нужно ${line} из ${voted}.`,

  // PROPOSAL: a round without a majority, sealed: no counts, the next round.
  noMajoritySealed: ({ round, rounds: max }) => `Нет большинства. Раунд ${round + 1} из ${max}.`,

  // PROPOSAL: a place is decided (a majority or the Last Word Rule: the line does not say which).
  sealed: ({ place }) => `${cap(ordinal(place))} место решено. Конверт запечатан.`,

  // PROPOSAL: every place is decided, before the first envelope.
  revealIntro: ({ places = 3 }) =>
    `Все места решены. Вскрываем конверты: ${placesDown(places)} место. Жетоны решающего раунда откроем в том порядке, в каком Судьи подходили к урне.`,

  // PROPOSAL: one envelope opens: the place and the round whose tokens it holds.
  openEnvelope: ({ place, round, rounds: max }) => `Конверт ${ordinalGen(place)} места. Решающий раунд — ${round} из ${max}.`,

  // PROPOSAL: the bridge after a round without a majority. The owner's example:
  // «2 голоса за X, 2 за Y, 1 за Z — нет большинства, раунд 2».
  noMajority: ({ counts, voted, round, nameOf }) =>
    voted === 0
      ? `Ни один Судья не проголосовал — нет большинства, раунд ${round + 1}.`
      : `${countsPhrase(counts, nameOf)} — нет большинства, раунд ${round + 1}.`,

  // PROPOSAL: after the last round without a majority, before the Last Word card.
  noMajorityLast: ({ counts, voted, nameOf }) =>
    voted === 0
      ? "Ни один Судья не проголосовал — нет большинства. Раундов больше нет."
      : `${countsPhrase(counts, nameOf)} — нет большинства. Раундов больше нет.`,

  // PROPOSAL: the Last Word card (Положение п. 10.4): what fired and whose Qualifying score decided.
  lastWord: ({ rounds: n, name, score: s, rank }) =>
    `Большинство не набралось за ${rounds(n)}. Правило последнего слова, пункт 10.4 Положения: место получает Финалист с наибольшим баллом Отборочного этапа из ещё не получивших место. Это ${name}: балл ${score(s)}, ${rank}-е место Отборочного этапа.`,

  // PROPOSAL: place 1 opens with the Finalists that cannot take it (Положение п. 9.3: a Solution that
  // did not run by its README or is not built on OpenEgiz scores at most 40 and cannot be the Winner).
  // The data says only that the ceiling applied (finalists[].ceiling), not which of the two reasons.
  ceiling: ({ names }) =>
    names.length === 1
      ? `${names[0]} не может занять первое место: к его баллу Отборочного этапа применён потолок ${CEILING_POINTS} баллов. По пункту 9.3 Положения такое Решение не может стать Победителем.`
      : `${andList(names)} не могут занять первое место: к их баллам Отборочного этапа применён потолок ${CEILING_POINTS} баллов. По пункту 9.3 Положения такие Решения не могут стать Победителем.`,

  // PROPOSAL: the headline of the verdict card, with the count against (the teams, not the reasons:
  // the reasons are on the card verbatim, never retold). `against` = [{ team }] per dissenting vote.
  verdict: ({ place, name, n, voted, rounds: r, decidedBy, against = [], nameOf = (t) => t }) => {
    if (decidedBy === "last_word") return `${cap(ordinal(place))} место — ${name}, по Правилу последнего слова после ${roundsOf(r)}.`;
    const vs = againstPhrase(against, nameOf);
    const count = vs ? `За него ${n} из ${voted}, ${vs}.` : n === voted && voted > 1 ? `За него ${n} из ${voted}, единогласно.` : `За него ${n} из ${voted}.`;
    return `${cap(ordinal(place))} место — ${name}. ${count} Раундов: ${r}.`;
  },

  // PROPOSAL: a place nobody can take (every Finalist left is under the ceiling).
  vacant: ({ place }) => `${cap(ordinal(place))} место не присуждено: все оставшиеся Финалисты ниже потолка и не могут его занять.`,

  // PROPOSAL: п. 10.5, a Judge is unavailable for a message.
  unavailableMessage: ({ judge }) =>
    `${judgeName(judge)} недоступен: его сообщения в этом раунде не будет. По пункту 10.5 Положения решение принимает большинство остальных Судей.`,

  // PROPOSAL: п. 10.5, a Judge is unavailable for the vote; the line comes from the voters present.
  unavailableVote: ({ judge, line, voted }) =>
    `${judgeName(judge)} недоступен и не голосует. Большинство считается от проголосовавших: нужно ${line} из ${voted}. При равенстве голосов применяется Правило последнего слова.`,

  // PROPOSAL: the closing line over the final screen.
  final: ({ podium, nameOf }) =>
    "Итог Финала. " +
    podium.map((p) => (p.team ? `${cap(ordinal(p.place))} место — ${nameOf(p.team)}.` : `${cap(ordinal(p.place))} место не присуждено.`)).join(" "),
};

// Short on-screen labels (not spoken); also PROPOSALS.
export const labels = {
  noMajority: (next, max) => `Нет большинства → раунд ${next} из ${max}`,
  noMajorityLast: () => "Нет большинства → Правило последнего слова",
  reached: (n, voted) => `${n} из ${voted}`,
  ceiling: () => "не может занять 1-е место",
  // a Judge without a vote this round (its reveal beat, the verdict card)
  abstains: (judge) => `${judgeName(judge)} — не голосует (п. 10.5)`,
  // the majority line when Judges are away: «3 из 4: один Судья недоступен»
  reducedLine: (line, voted, away) => `${line} из ${voted}: ${judgesAway(away)}`,
  // the corner header while a Judge is out
  away: (judge) => `${judgeName(judge)} — недоступен`,
  // a vote that differs from the Judge's vote in the previous round of the same place
  changed: (judge, from, to) => `${judgeName(judge)}: ${from} → ${to}`,
  changedKicker: (from, to) => `Голос изменён · раунд ${from} → ${to}`,
  against: () => "Против",
  // sealed envelopes (owner 2026-10-28)
  sealed: () => "конверт запечатан",
  decidedTitle: () => "Решено",
  envelopeOf: (place) => `Конверт ${place}-го места`,
  opening: () => "вскрываем конверт",
  decidingRound: (round, max) => `решающий раунд ${round} из ${max}`,
};

function cap(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
