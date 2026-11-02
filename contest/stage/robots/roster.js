// Who is on the Stage. Captions show model, CLI and version (spec §7.7); the versions here are the
// style frame's samples and the director overwrites them from state.json judges[] before the show.
// Model names stay in Latin script, everything else on screen is Russian.

export const ROSTER = {
  "opus-5.5": { model: "Opus 5.5", cli: "Claude Code", version: "2.1.302", vendor: "anthropic", role: "judge" },
  "gpt-6.1-sol": { model: "GPT 6.1 sol", cli: "Codex CLI", version: "0.160.1", vendor: "openai", role: "judge" },
  "sonnet-5.5": { model: "Sonnet 5.5", cli: "Claude Code", version: "2.1.302", vendor: "anthropic", role: "judge" },
  "gpt-6-astra": { model: "GPT 6 astra", cli: "Codex CLI", version: "0.160.1", vendor: "openai", role: "judge" },
  "fable-5.1": { model: "Fable 5.1", cli: "Claude Code", version: "2.1.302", vendor: "anthropic", role: "judge" },
  host: { model: "Ведущий", cli: "", version: "", vendor: "house", role: "host" },
};

// Consoles from the camera's left to right: Opus in the middle, the two OpenAI Judges beside it, the
// other two Anthropic Judges at the ends, so neither family owns a side or the middle.
export const JUDGE_IDS = ["fable-5.1", "gpt-6.1-sol", "opus-5.5", "gpt-6-astra", "sonnet-5.5"];
export const ROBOT_IDS = [...JUDGE_IDS, "host"];

export const caption = (id) => {
  const r = ROSTER[id];
  return r.cli ? `${r.cli} ${r.version}` : "";
};
