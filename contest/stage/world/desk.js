// A Judge's console: a dispatcher's standing desk (dark laminate, steel edge, graphite pedestals),
// a large main monitor on a column stand, a small side monitor angled toward the Judge, a keyboard,
// a power LED (white when on, amber standby when the Judge is offline). The main monitor is a light
// source: its spill falls on the robot in front of it in proportion to its brightness.
// Local frame: the Judge stands at +Z (the room side), the monitors face +Z.
import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { createMainScreen, createSideScreen } from "./screen.js";
import { ROOM, LIGHT } from "./palette.js";
import { Track, smooth } from "./timeline.js";

const SCREEN_W = 1.3, SCREEN_H = SCREEN_W * 9 / 16;
export const MONITOR = { y: 1.5, z: -0.2, tilt: 0.1 }; // centre height, set-back, tilt back (rad)
let shared = null;
function materials() {
  if (shared) return shared;
  const std = (o, env = 0.5) => Object.assign(new THREE.MeshStandardMaterial(o), { userData: { env } });
  shared = {
    top: std({ color: ROOM.laminate, roughness: 0.48, metalness: 0.05 }, 0.6),
    steel: std({ color: ROOM.steel, roughness: 0.32, metalness: 0.95 }, 1.0),
    graphite: std({ color: ROOM.graphite, roughness: 0.62, metalness: 0.35 }, 0.4),
    bezel: std({ color: "#0c0c0d", roughness: 0.35, metalness: 0.2 }, 0.8),
    keys: std({ color: "#1d1d1f", roughness: 0.7, metalness: 0.1 }, 0.3),
    back: std({ color: "#18181a", roughness: 0.55, metalness: 0.3 }, 0.5),
  };
  return shared;
}

const rb = (w, h, d, r, mat, seg = 3) => {
  const m = new THREE.Mesh(new RoundedBoxGeometry(w, h, d, seg, Math.min(r, w / 2, h / 2, d / 2)), mat);
  m.castShadow = m.receiveShadow = true;
  return m;
};
const at = (o, x, y, z) => (o.position.set(x, y, z), o);

export function createDesk(id, { lite }) {
  const M = materials();
  const g = new THREE.Group();
  g.name = `desk-${id}`;
  // the desk
  g.add(at(rb(1.78, 0.05, 0.8, 0.02, M.top), 0, 0.955, 0));
  g.add(at(rb(1.8, 0.022, 0.03, 0.008, M.steel, 2), 0, 0.955, 0.4));
  for (const x of [-0.82, 0.82]) g.add(at(rb(0.05, 0.93, 0.72, 0.012, M.graphite), x, 0.465, -0.02));
  g.add(at(rb(1.6, 0.5, 0.03, 0.01, M.graphite), 0, 0.62, -0.36));
  g.add(at(rb(1.5, 0.06, 0.18, 0.01, M.graphite), 0, 0.3, -0.25)); // cable tray
  g.add(at(rb(0.46, 0.02, 0.15, 0.006, M.keys), -0.05, 0.99, 0.16));
  // the main monitor on its column
  const mon = new THREE.Group();
  mon.position.set(0, MONITOR.y, MONITOR.z);
  mon.rotation.x = -MONITOR.tilt;
  mon.add(at(rb(SCREEN_W + 0.04, SCREEN_H + 0.04, 0.04, 0.012, M.bezel), 0, 0, -0.012));
  mon.add(at(rb(0.5, 0.3, 0.05, 0.02, M.back), 0, 0, -0.05));
  const screen = createMainScreen(SCREEN_W, SCREEN_H);
  screen.group.position.z = 0.0095;
  mon.add(screen.group);
  g.add(mon);
  g.add(at(rb(0.08, 0.5, 0.05, 0.015, M.steel), 0, 1.2, MONITOR.z - 0.09));
  g.add(at(rb(0.34, 0.02, 0.24, 0.008, M.steel), 0, 0.99, MONITOR.z - 0.06));
  // the side monitor on the Judge's left (screen right from the room), angled in
  const sideW = 0.56, sideH = 0.336;
  const side = new THREE.Group();
  side.position.set(0.76, 1.2, 0.14); // in front of the main monitor and clear of it (they used to cut into each other)
  side.rotation.set(-0.16, -0.75, 0);
  side.add(at(rb(sideW + 0.03, sideH + 0.03, 0.03, 0.01, M.bezel), 0, 0, -0.01));
  const sideScreen = createSideScreen(sideW, sideH);
  sideScreen.mesh.position.z = 0.0062;
  side.add(sideScreen.mesh);
  g.add(side);
  g.add(at(rb(0.04, 0.24, 0.04, 0.01, M.steel), 0.76, 1.0, 0.1));
  // the power LED on the desk's front edge
  const ledMat = new THREE.MeshBasicMaterial({ color: 0x000000, toneMapped: false });
  const led = at(new THREE.Mesh(new THREE.SphereGeometry(0.007, 12, 8), ledMat), 0.72, 0.955, 0.415);
  g.add(led);

  // where the screen's spill on the robot comes from and goes to; the stage lends this desk one of
  // its pooled spill lights while the screen is among the brightest (stage.js)
  const spillFrom = at(new THREE.Object3D(), 0, MONITOR.y + 0.02, MONITOR.z + 0.08);
  const spillTo = at(new THREE.Object3D(), 0, 1.25, 1.6);
  g.add(spillFrom, spillTo);

  const ledTrack = new Track();
  const world = { center: new THREE.Vector3(), normal: new THREE.Vector3(), width: SCREEN_W, height: SCREEN_H };
  return {
    object3d: g,
    show: (content, t) => screen.show(content, t),
    setLog: (items, t) => sideScreen.setLog(items, t),
    setTimer: (since, t) => sideScreen.setTimer(since, t),
    setPower(level, t) {
      screen.setPower(level, t);
      sideScreen.setPower(level > 0 ? Math.max(0.35, level) : 0, t);
      ledTrack.add(t, { on: level > 0 });
    },
    ready: () => screen.ready(),
    /** monitor-codes: both monitors veiled while veil.on(t) (ui/veil.js) */
    setVeil(v) {
      screen.setVeil(v);
      sideScreen.setVeil(v);
    },
    /** the spill this frame: { from, to } world anchors and its intensity (0 when the screen is dark) */
    spill: { from: spillFrom, to: spillTo, get intensity() { return 3.2 * screen.light; } },
    /** the main monitor in world space (for the camera) */
    monitor() {
      screen.group.getWorldPosition(world.center);
      world.normal.set(0, 0, 1).applyQuaternion(screen.group.getWorldQuaternion(new THREE.Quaternion()));
      return world;
    },
    update(t) {
      screen.update(t);
      sideScreen.update(t);
      const on = ledTrack.current(t)?.on ?? true;
      if (on) ledMat.color.setRGB(0.9, 0.95, 1.0).multiplyScalar(0.8);
      else ledMat.color.set(LIGHT.standby).multiplyScalar(2.2);
    },
  };
}
