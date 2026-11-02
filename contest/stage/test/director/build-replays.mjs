// Writes the synthetic replays to contest/stage/test/replays/ (and one synthetic run folder).
//   node contest/stage/test/director/build-replays.mjs
// Every file is synthetic test data, marked in its header, and is never shown on air.

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FINALISTS, JUDGES, L, Sim } from "./sim.mjs";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "replays");
const J = JUDGES.map((j) => j.name);
const [OPUS, SONNET, FABLE, SOL, ASTRA] = J;

const TEXT = {
  1: "Сильнее всего выглядит модель карьера: связный граф дорог и честная симуляция очередей. Слабое место лидера — сценарии «что если», они есть, но запускаются не сразу.",
  2: "Соглашусь по модели, но визуализация у соперника лучше: видно поток самосвалов, виден простой на экскаваторе. Это важнее для диспетчера, чем число сценариев.",
  3: "Замысел команды читается: она знает, какую проблему рудника решает, и показывает метрику до и после. Типовое Решение такого сравнения не давало.",
  4: "Я бы проверил, что модуль диспетчеризации действительно меняет результат на Стенде. Отчёт сборки это подтверждает, а в оценках разброс небольшой.",
  5: "Мой выбор не изменился. Аргумент против лидера слышу, но он касается оформления, а не модели, и баллы Отборочного этапа это показывают.",
};
const msg = (i) => TEXT[(i % 5) + 1];

function vote(judge, team, reason) {
  return { judge, team, reason };
}

function discussion(sim, place, round, { skip = [], opts = {} } = {}) {
  sim.round(place, round);
  J.forEach((j, i) => {
    if (!skip.includes(j)) sim.message(j, `${msg(i + round)} (место ${place}, раунд ${round})`, { dur: 4, ...(opts[j] ?? {}) });
  });
}

function write(sim) {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, `synthetic-${sim.name}.jsonl`), sim.toJsonl());
  return sim;
}

// 1. no majority in round 1 (2/2/1, line 3), majority in round 2
write(((s) => {
  discussion(s, 1, 1);
  s.votes([vote(OPUS, "team-003", "Модель карьера полная."), vote(SONNET, "team-003", "Лучшие сценарии."), vote(FABLE, "team-011", "Визуализация сильнее."),
    vote(SOL, "team-011", "Лучше поток самосвалов."), vote(ASTRA, "team-007", "Ровный замысел.")]);
  discussion(s, 1, 2);
  s.votes([vote(OPUS, "team-003", "Модель карьера полная и проверена на Стенде."), vote(SONNET, "team-003", "Сценарии запускаются и отменяются."),
    vote(FABLE, "team-003", "Согласен: модель важнее оформления."), vote(SOL, "team-011", "Остаюсь при своём."), vote(ASTRA, "team-003", "Аргументы по модели убедили.")]);
  s.placement("team-003", "majority", 2).finish();
  return s;
})(new Sim({ name: "no-majority", note: "Place 1: round 1 splits 2/2/1, round 2 gives a majority.", settings: { places: 1 } })));

// 2. no majority through the last round: the Last Word Rule (two rounds per place here)
write(((s) => {
  discussion(s, 1, 1);
  s.votes([vote(OPUS, "team-011", "Визуализация."), vote(SONNET, "team-011", "Потоки."), vote(FABLE, "team-007", "Замысел."),
    vote(SOL, "team-007", "Метрика до и после."), vote(ASTRA, "team-003", "Модель.")]);
  discussion(s, 1, 2);
  s.votes([vote(OPUS, "team-011", "Визуализация сильнее."), vote(SONNET, "team-007", "Замысел яснее."), vote(FABLE, "team-007", "Метрика убедительна."),
    vote(SOL, "team-011", "Поток самосвалов виден."), vote(ASTRA, "team-003", "Модель полнее всех.")]);
  s.placement("team-003", "last_word", 2).finish();
  return s;
})(new Sim({ name: "last-word", note: "Place 1: no majority in either of two rounds, Last Word Rule gives it to the top Qualifying rank.", settings: { places: 1, rounds_per_place: 2 } })));

// 3. a vacant place: every Finalist is under the ceiling, place 1 stays empty
write(((s) => {
  s.vacant(1);
  discussion(s, 2, 1);
  s.votes(J.map((j, i) => vote(j, i < 4 ? "team-103" : "team-102", "Лучший из оставшихся.")));
  s.placement("team-103", "majority", 1);
  discussion(s, 3, 1);
  s.votes(J.map((j) => vote(j, "team-102", "Остаётся сильнейшим.")));
  s.placement("team-102", "majority", 1).finish();
  return s;
})(new Sim({
  name: "vacant", note: "Place 1 vacant: every Finalist is under the ceiling; places 2 and 3 are still awarded.",
  finalists: [{ team: "team-103", name: "Первый ниже потолка", rank: 1, score: "39", ceiling: true }, { team: "team-102", name: "Второй ниже потолка", rank: 2, score: "35", ceiling: true },
    { team: "team-101", name: "Третий ниже потолка", rank: 3, score: "30", ceiling: true }, { team: "team-104", name: "Четвёртый ниже потолка", rank: 4, score: "22", ceiling: true }],
})));

// 4. an unavailable Judge: no message, no vote (4 voters, line 3), back in round 2
write(((s) => {
  s.round(1, 1);
  J.forEach((j, i) => s.message(j, j === FABLE ? null : `${msg(i)} (раунд 1)`, { dur: 4 }));
  s.votes([vote(OPUS, "team-003", "Модель."), vote(SONNET, "team-003", "Сценарии."), vote(FABLE, null, null), vote(SOL, "team-011", "Потоки."), vote(ASTRA, "team-011", "Визуализация.")]);
  discussion(s, 1, 2);
  s.votes([vote(OPUS, "team-003", "Модель."), vote(SONNET, "team-003", "Сценарии."), vote(FABLE, "team-003", "Теперь согласен с моделью."), vote(SOL, "team-011", "Потоки."), vote(ASTRA, "team-011", "Визуализация.")]);
  s.placement("team-003", "majority", 2).finish();
  return s;
})(new Sim({ name: "unavailable", note: "Place 1 round 1: fable-5.1 unavailable (message null, vote null, 4 voters, line 3, 2/2 no majority); available again in round 2.", settings: { places: 1 } })));

// 4b. two unavailable Judges: 3 voters, the line is 2 (not 3 of five)
write(((s) => {
  s.round(1, 1);
  J.forEach((j, i) => s.message(j, j === OPUS || j === SONNET ? null : `${msg(i)} (раунд 1)`, { dur: 3 }));
  s.votes([vote(OPUS, null, null), vote(SONNET, null, null), vote(FABLE, "team-003", "Модель."), vote(SOL, "team-003", "Сценарии."), vote(ASTRA, "team-011", "Потоки.")], { dur: 2 });
  s.placement("team-003", "majority", 1).finish();
  return s;
})(new Sim({ name: "two-unavailable", note: "opus-5.5 and sonnet-5.5 unavailable: 3 voters, majority line 2 (two votes win).", settings: { places: 1 } })));

// 5. retries: a message and a vote asked twice (turn ids ...-a2)
write(((s) => {
  s.round(1, 1);
  J.forEach((j, i) => s.message(j, `${msg(i)} (раунд 1)`, { dur: 4, fail: j === SONNET ? 1 : 0,
    lines: j === SONNET ? { 1: [L.claudeInit(), L.claudeTool("a1", "Read", { file_path: "solutions/team-003/build_report.json" })], 2: [L.claudeInit(), L.claudeTool("b1", "Glob", { pattern: "solutions/team-011/*.json" })] } : {} }));
  s.votes(J.map((j) => vote(j, "team-003", "Модель полнее.")), { fail: { [SOL]: 1 }, lines: { [SOL]: { 1: [L.codexStart()], 2: [L.codexStart(), L.codexCmd("c1", "cat solutions/team-003/build_report.json")] } } });
  s.placement("team-003", "majority", 1).finish();
  return s;
})(new Sim({ name: "retry", note: "sonnet-5.5 message and gpt-6.1-sol vote fail once and are asked again (-a2).", settings: { places: 1 } })));

// 6. Finalists under the ceiling: grey for place 1, free to take 2 and 3
write(((s) => {
  discussion(s, 1, 1);
  s.votes(J.map((j, i) => vote(j, i < 3 ? "team-007" : "team-002", "Из доступных сильнее.")));
  s.placement("team-007", "majority", 1);
  discussion(s, 2, 1);
  s.votes(J.map((j) => vote(j, "team-003", "Потолок не мешает второму месту.")));
  s.placement("team-003", "majority", 1);
  discussion(s, 3, 1);
  s.votes(J.map((j, i) => vote(j, i < 4 ? "team-011" : "team-002", "Третье место.")));
  s.placement("team-011", "majority", 1).finish();
  return s;
})(new Sim({ name: "ceiling", note: "team-003 and team-011 are under the ceiling: they cannot take place 1, but take places 2 and 3.",
  finalists: FINALISTS.map((f) => ({ ...f, ceiling: f.team === "team-003" || f.team === "team-011" })) })));

// 7. activity: tool events in the raw logs of both CLIs, while the queue is still voicing earlier messages
write(((s) => {
  const lines = {
    [OPUS]: { 1: [L.claudeInit(["Read", "Glob", "Grep", "LS"]), L.claudeThinking(), L.claudeTool("t1", "Read", { file_path: "solutions/team-003/build_report.json" }), L.claudeResult("t1"),
      L.claudeTool("t2", "Glob", { pattern: "solutions/team-003/screenshots/**/*.png" }), L.claudeTool("t3", "Read", { file_path: "solutions/team-003/screenshots/opus/01.png" }),
      L.claudeTool("t4", "Grep", { pattern: "ceiling", path: "solutions" }), L.claudeText("готово"), L.claudeDone()] },
    [SONNET]: { 1: [L.claudeInit(["mcp__final__read_file"]), L.claudeTool("u1", "mcp__final__read_file", { path: "teams/team-003/source/src/SUBMISSION.md" }),
      L.claudeTool("u2", "mcp__final__list_dir", { path: "solutions" }), L.claudeTool("u3", "mcp__final__fancy_tool", { x: 1 })] },
    [FABLE]: { 1: [L.claudeInit(), L.claudeTool("v1", "LS", { path: "solutions/team-011" }), L.claudeTool("v2", "Read", { file_path: "teams/team-011/source/src/SUBMISSION.md", offset: 10, limit: 40 }),
      L.claudeTool("v3", "WebFetch", { url: "https://example.org" })] },
    [SOL]: { 1: [L.codexStart(), L.codexCmd("i0", "/bin/zsh -lc \"sed -n 1,80p solutions/team-003/scores/opus-5.5.json\"", "item.started"),
      L.codexCmd("i0", "/bin/zsh -lc \"sed -n 1,80p solutions/team-003/scores/opus-5.5.json\""), L.codexMcp("i1", "final", "read_file", { path: "solutions/team-011/build_report.json" }),
      L.codexItem("i2", "reasoning", { text: "hidden" }), L.codexCmd("i3", "rg -n \"сценар\" solutions"), L.codexItem("i4", "agent_message", { text: "готово" }), L.codexDone()] },
    [ASTRA]: { 1: [L.codexStart(), L.codexCmd("j0", "ls -la solutions/team-003"), L.codexCmd("j1", "python3 -c 'print(1)'"), L.codexCmd("j2", "cat solutions/team-003/screenshots/astra/02.png"), L.codexDone()] },
  };
  s.round(1, 1);
  J.forEach((j, i) => s.message(j, `${msg(i)} (раунд 1)`, { dur: 6, lines: lines[j] ?? {} }));
  s.votes(J.map((j) => vote(j, "team-003", "Модель.")));
  s.placement("team-003", "majority", 1).finish();
  return s;
})(new Sim({ name: "activity", note: "Raw Claude and Codex log lines with tool calls, reasoning and plain text.", settings: { places: 1 } })));

// 7b. vote turns finish out of the roster order: the walks to the urn follow the real finish
write(((s) => {
  discussion(s, 1, 1);
  // round 1: opus-5.5 is slowest and sonnet-5.5 fails twice; by state alone the order would be fable, astra, sonnet, sol, opus
  // (sol is seen done in its log, 3.3 s, before the state shows it at 5 s; opus's log says 4.8 s)
  s.votes([vote(OPUS, "team-003", "Модель."), vote(SONNET, null, null), vote(FABLE, "team-011", "Визуализация."),
    vote(SOL, "team-003", "Сценарии."), vote(ASTRA, "team-011", "Потоки.")],
  { durs: { [OPUS]: 6, [SONNET]: 2, [FABLE]: 2, [SOL]: 5, [ASTRA]: 3 },
    lines: { [OPUS]: { 1: [L.claudeInit(), L.claudeThinking(), L.claudeText("{\"team\":\"team-003\"}"), L.claudeDone()] }, [SOL]: { 1: [L.codexStart(), L.codexDone()] } } });
  discussion(s, 1, 2);
  // round 2: everyone's state ends at the same second; the logs tell astra (1.5 s) from fable (2.25 s), the rest keep the roster order
  s.votes(J.map((j) => vote(j, "team-003", "Согласен.")), { dur: 3,
    lines: { [FABLE]: { 1: [L.claudeInit(), L.claudeText("{}"), L.claudeDone()] }, [ASTRA]: { 1: [L.codexDone()] } } });
  s.placement("team-003", "majority", 2).finish();
  return s;
})(new Sim({ name: "vote-order", note: "Vote turns finish out of the roster order (round 1: fable, astra, sol, sonnet unavailable, opus; round 2: astra, fable, then the roster).", settings: { places: 1 } })));

// 8. the whole show, 3 places, as a run folder too: no majority, an unavailable Judge, a retry
const full = ((s) => {
  // the vote turns end at different times, vendors mixed, so the walks and the reveals follow a real
  // finish order (not the roster): round 2 crosses the line on Fable's token, the result waits for Opus's
  discussion(s, 1, 1);
  s.votes([vote(OPUS, "team-003", "Модель полнее."), vote(SONNET, "team-003", "Сценарии."), vote(FABLE, "team-011", "Визуализация."),
    vote(SOL, "team-011", "Потоки."), vote(ASTRA, "team-007", "Замысел.")],
  { durs: { [ASTRA]: 2, [SOL]: 2.5, [OPUS]: 3, [FABLE]: 3.5, [SONNET]: 4 } });
  discussion(s, 1, 2);
  s.votes(J.map((j, i) => vote(j, i === 3 ? "team-011" : "team-003", "Модель убедила.")),
    { durs: { [SONNET]: 2, [ASTRA]: 2.5, [SOL]: 3, [FABLE]: 3.5, [OPUS]: 4 } });
  s.placement("team-003", "majority", 2);
  s.round(2, 1);
  J.forEach((j, i) => s.message(j, j === FABLE ? null : `${msg(i)} (место 2)`, { dur: 4, fail: j === SONNET ? 1 : 0 }));
  s.votes(J.map((j, i) => vote(j, i === 2 ? null : "team-011", i === 2 ? null : "Лучшее из оставшихся.")),
    { durs: { [SOL]: 2, [OPUS]: 2.5, [ASTRA]: 3, [SONNET]: 3.5 } });
  s.placement("team-011", "majority", 1);
  discussion(s, 3, 1);
  s.votes(J.map((j, i) => vote(j, i < 3 ? "team-007" : "team-002", "Третье место.")),
    { durs: { [FABLE]: 2, [ASTRA]: 2.5, [SONNET]: 3, [SOL]: 3.5, [OPUS]: 4 } });
  s.placement("team-007", "majority", 1).finish();
  return s;
})(new Sim({ name: "full", note: "Three places: round 2 at place 1, an unavailable Judge and a retry at place 2." }));
write(full);
const folder = join(OUT, "synthetic-run");
rmSync(folder, { recursive: true, force: true });
full.writeFolder(folder);
console.log("written to", OUT);
