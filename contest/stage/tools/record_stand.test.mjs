// node contest/stage/tools/record_stand.test.mjs — the sidecar's element boxes on a fake step list
// (no browser, no Stand).
import assert from "node:assert/strict";
import { stepBox, stepSelector, toFrameBox } from "./record_stand.box.mjs";

const boxes = {
  "button.start:visible": { x: 1715.2, y: 498.6, width: 81.4, height: 26 },
  "a.twin-link": { x: 1528, y: 66, width: 70, height: 18 },
  "#gone": null,                       // detached / hidden: Playwright returns null
};
const locatorFor = (sel) => ({
  boundingBox: async () => {
    if (sel === "#never") throw new Error("Timeout 2000ms exceeded");
    return boxes[sel];
  },
});

const steps = [
  { at: 16, click: "button.start:visible" },
  { at: 30, hover: "a.twin-link" },
  { at: 35, fill: ["#gone", "text"] },
  { at: 40, click: "#never" },
  { at: 44, goto: "http://localhost:3000/d/x" },
  { at: 50, sh: "cd ~/solution && make storm" },
];

let n = 0;
const ok = (name, f) => f().then(() => { n++; console.log(`ok  ${name}`); });

await ok("selector of each step kind", async () => {
  assert.deepEqual(steps.map(stepSelector), ["button.start:visible", "a.twin-link", "#gone", "#never", null, null]);
});
await ok("boxes in frame px at scale 1 (1920×1080 viewport = frame)", async () => {
  const out = [];
  for (const s of steps) out.push({ ...s, box: await stepBox(locatorFor, s, { scale: 1 }) });
  assert.deepEqual(out.map((s) => s.box), [
    { x: 1715.2, y: 498.6, w: 81.4, h: 26 },
    { x: 1528, y: 66, w: 70, h: 18 },
    null, null, null, null,
  ]);
  assert.ok(out.every((s) => "box" in s), "every step has the field");
});
await ok("scale and offset (deviceScaleFactor 2, letterbox)", async () => {
  assert.deepEqual(toFrameBox({ x: 10, y: 20, width: 30, height: 40 }, { scale: 2, dx: 0, dy: 60 }), { x: 20, y: 100, w: 60, h: 80 });
});
await ok("a broken box is null", async () => {
  assert.equal(toFrameBox({ x: NaN, y: 0, width: 1, height: 1 }), null);
  assert.equal(toFrameBox(undefined), null);
});
console.log(`${n} passed`);
