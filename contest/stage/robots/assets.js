// The robots' models (assets/robots/<id>.glb, made by tools/blender/robots.py): one node per rigid
// part, placed at its joint in the rest pose. The node translations are the skeleton; the parts hang
// on the joints of rig.js and take the Stage's materials by slot name (materials.js).
import * as THREE from "three";
import { GLTFLoader } from "/vendor/three-addons/loaders/GLTFLoader.js";
import { skeleton } from "./rig.js";
import { slotMaterial } from "./materials.js";

const IDS = ["opus-5.5", "sonnet-5.5", "fable-5.1", "gpt-6.1-sol", "gpt-6-astra", "host"];

/** Load every model once: { [id]: { scene, info } }. */
export async function loadModels() {
  const loader = new GLTFLoader();
  const out = {};
  await Promise.all(IDS.map(async (id) => {
    const g = await loader.loadAsync(`/assets/robots/${id}.glb`);
    const rig = g.scene.getObjectByName("rig");
    out[id] = { scene: g.scene, info: rig?.userData.robot ? JSON.parse(rig.userData.robot) : {} };
  }));
  return out;
}

/** The skeleton dimensions from the parts' rest positions (metres, the Stage's frame). */
function dimsOf(scene) {
  const p = (n) => scene.getObjectByName(n)?.position;
  const pel = p("torso"), up = p("upper_L"), fo = p("fore_L"), ha = p("hand_L"), fi = p("fingers_L"), nk = p("neck");
  const th = p("thigh_L"), sh = p("shin_L"), ft = p("foot_L");
  const d = {
    hipY: pel.y, shoulderW: up.x, shoulderY: up.y - pel.y, shoulderZ: up.z, upper: up.y - fo.y, fore: fo.y - ha.y, palm: ha.y - fi.y,
    neckY: nk.y - pel.y,
  };
  if (th) Object.assign(d, { hipW: th.x, thigh: th.y - sh.y, shin: sh.y - ft.y });
  else d.legs = false;
  return d;
}

// part -> joint
const JOINT = {
  base: (s) => s.base, pelvis: (s) => s.pelvis, torso: (s) => s.spine, neck: (s) => s.neck, head: (s) => s.head, face: (s) => s.head,
  upper_L: (s) => s.arms.L.shoulder, fore_L: (s) => s.arms.L.elbow, hand_L: (s) => s.arms.L.hand, fingers_L: (s) => s.arms.L.fingers,
  upper_R: (s) => s.arms.R.shoulder, fore_R: (s) => s.arms.R.elbow, hand_R: (s) => s.arms.R.hand, fingers_R: (s) => s.arms.R.fingers,
  thigh_L: (s) => s.legs.L?.hip, shin_L: (s) => s.legs.L?.knee, foot_L: (s) => s.legs.L?.ankle,
  thigh_R: (s) => s.legs.R?.hip, shin_R: (s) => s.legs.R?.knee, foot_R: (s) => s.legs.R?.ankle,
};

/**
 * Build a robot's body from its model: the skeleton, the parts on their joints, the materials.
 * faceMat replaces the face node's material. Returns { sk, dims, info, faceMesh }.
 */
export function buildBody(model, faceMat) {
  const dims = dimsOf(model.scene);
  const sk = skeleton(dims);
  let faceMesh = null;
  for (const [name, joint] of Object.entries(JOINT)) {
    const node = model.scene.getObjectByName(name);
    const j = joint(sk);
    if (!node || !j) continue;
    const part = node.clone(true);
    part.position.set(0, 0, 0);
    part.quaternion.identity();
    part.scale.set(1, 1, 1);
    part.traverse((o) => {
      if (!o.isMesh) return;
      const slot = o.material?.name;
      o.material = name === "face" ? faceMat : slot === "status" ? faceMat.userData.status ?? slotMaterial("satin") : slotMaterial(slot) ?? o.material;
      o.castShadow = name !== "face";
      o.receiveShadow = true;
      o.frustumCulled = true;
    });
    if (name === "face") {
      part.traverse((o) => o.isMesh && (faceMesh = o));
    }
    j.add(part);
  }
  return { sk, dims, info: model.info, faceMesh };
}

export { IDS };
