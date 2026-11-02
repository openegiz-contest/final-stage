// The room's reflections: a PMREM of a simple scene with the room's own light layout (ceiling
// slot fixtures, the downlights over the consoles, the luminaire over the ballot station, the dispatch board, five monitors,
// the dark glass with the pit's warm horizon). Black glass and glaze reflect these, so a
// reflection on a robot always comes from a light that is really in the room.
import * as THREE from "three";
import { DESKS, BALLOT, GLASS_R, CEILING, SIDE_X } from "./layout.js";

export function createEnvironment(renderer) {
  const s = new THREE.Scene();
  const C = new THREE.Vector3(0, 1.5, -2.2); // the env is seen from here (the middle of the jury)
  const basic = (r, g, b) => new THREE.MeshBasicMaterial({ color: new THREE.Color(r, g, b), side: THREE.DoubleSide });
  const add = (geo, mat, x, y, z, rx = 0, ry = 0) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x - C.x, y - C.y, z - C.z);
    m.rotation.set(rx, ry, 0);
    s.add(m);
    return m;
  };
  // the room shell: warm near-black, the floor darker
  add(new THREE.BoxGeometry(22, CEILING, 20), basic(0.009, 0.008, 0.007), 0, CEILING / 2, 0);
  add(new THREE.PlaneGeometry(22, 20), basic(0.004, 0.0035, 0.003), 0, 0.01, 0, -Math.PI / 2);
  // the glass: night outside, a thin warm horizon, a band of pit lights
  const glass = add(new THREE.CylinderGeometry(GLASS_R, GLASS_R, 3.4, 64, 1, true, Math.PI - 1.4, 2.8), basic(0.006, 0.008, 0.016), 0, 2.5, 0);
  glass.material.side = THREE.BackSide;
  add(new THREE.CylinderGeometry(GLASS_R - 0.05, GLASS_R - 0.05, 0.08, 64, 1, true, Math.PI - 1.4, 2.8), basic(0.08, 0.05, 0.03), 0, 2.15, 0).material.side = THREE.BackSide;
  // the ceiling's slot fixtures (dimmed, warm), in rows across the room
  const strip = basic(3.8, 3.1, 2.4); // about the old strips' total: the robots' reflections keep their level
  for (const z of [-6.0, -3.6, -1.2, 1.2, 3.6, 6.0])
    for (let x = -7.2; x <= 7.21; x += 2.4) if (!(z < 0 && Math.hypot(x + 0.6, z) > GLASS_R - 1.4)) add(new THREE.BoxGeometry(1.2, 0.02, 0.14), strip, x, CEILING - 0.02, z);
  // downlights over the consoles, the pendant over the box
  const down = basic(9, 7.5, 5.8);
  for (const d of Object.values(DESKS)) add(new THREE.CircleGeometry(0.16, 24), down, d.post.x, CEILING - 0.02, d.post.z, Math.PI / 2);
  add(new THREE.PlaneGeometry(0.56, 0.56), basic(12, 9, 6), BALLOT.x, CEILING - 0.06, BALLOT.z, Math.PI / 2);
  // the dispatch board on the left wall: a dim cool rectangle
  add(new THREE.PlaneGeometry(3.63, 1.36), basic(0.1, 0.13, 0.18), -SIDE_X + 0.08, 1.78, 0.6, 0, Math.PI / 2);
  // five monitors facing the room
  const mon = basic(0.55, 0.62, 0.8);
  for (const d of Object.values(DESKS)) add(new THREE.PlaneGeometry(1.3, 0.72), mon, d.pos.x, 1.5, d.pos.z, 0, d.yaw);
  // a soft fill from the back of the room (the wall the camera stands at)
  add(new THREE.PlaneGeometry(8, 1.2), basic(0.05, 0.045, 0.04), 0, 2.4, 8.4, 0, Math.PI);
  const pmrem = new THREE.PMREMGenerator(renderer);
  const tex = pmrem.fromScene(s, 0.035, 0.1, 50).texture;
  pmrem.dispose();
  return tex;
}
