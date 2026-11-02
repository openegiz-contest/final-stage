// createRobot(id): the public entry for robots (README.md in this folder). The models load once, when
// this module is first imported (top-level await), so createRobot stays synchronous.
import { ROSTER, JUDGE_IDS, ROBOT_IDS, caption } from "./roster.js";
import { makeRobot } from "./rig.js";
import { loadModels, buildBody } from "./assets.js";
import { faceMaterial } from "./materials.js";
import { opus, sonnet, fable } from "./anthropic.js";
import { sol, astra } from "./openai.js";
import { host } from "./host.js";

export { ROSTER, JUDGE_IDS, ROBOT_IDS, caption };

const CHARACTERS = { "opus-5.5": opus, "sonnet-5.5": sonnet, "fable-5.1": fable, "gpt-6.1-sol": sol, "gpt-6-astra": astra, host };
const MODELS = await loadModels();

export function createRobot(id) {
  const ch = CHARACTERS[id];
  if (!ch) throw new Error(`no robot ${id}; ids: ${Object.keys(CHARACTERS).join(", ")}`);
  const seed = [...id].reduce((a, c) => a + c.charCodeAt(0), 0) * 0.37; // each face blinks or scans on its own beat
  const face = faceMaterial({ ...ch.face, seed });
  const body = buildBody(MODELS[id], face);
  return makeRobot(id, ROSTER[id], body.sk, {
    ...ch, dims: body.dims, face, height: body.info.height, anchors: { face: body.faceMesh ?? body.sk.head, chest: body.sk.spine },
  });
}
