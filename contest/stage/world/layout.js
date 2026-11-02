// Where everything stands (metres; y up). The room is a D: a panoramic glass arc toward -Z with the
// pit behind it, a straight back wall at +Z. The five consoles stand on an arc facing the glass, so
// the Judges work with their backs to the room (reference 04: operators seen from behind, their
// screens lit beyond them). The ballot box stands on a slim column a short walk in front of the
// consoles; the Finalists' tubes stand in one row further toward the room, off every walk, and
// below the line from the wide camera to the Judges' feet; the Host stands beside the row.
import * as THREE from "three";
import { JUDGE_IDS } from "/robots/roster.js";

const DEG = Math.PI / 180;
export const GLASS_R = 9.6;            // the glass arc around the room's centre
export const GLASS_SPAN = 82 * DEG;    // its half-angle from -Z
export const SILL = 0.82, HEADER = 4.2, CEILING = 4.6;
export const BACK_Z = 8.6;             // the back wall
export const SIDE_X = GLASS_R * Math.sin(GLASS_SPAN); // the side walls

export const DESK_R = 5.9;             // desk centres on this arc
export const POST_BACK = 0.8;          // the robot stands this far from its desk centre, toward the room
const ANGLES = [-44, -22, 0, 22, 44].map((a) => a * DEG);

export const BALLOT = new THREE.Vector3(0.8, 0, -2.9); // the ballot box (a drum on a column), in the wide shot in the gap between Opus and astra
export const SLOT_Y = 1.24;                            // the box's slot (token height)
export const URN_ROW = 2.3, URN_GAP = 0.5;             // the Finalists' tubes: a row this far toward the room, this far apart
export const ROOM_FOCUS = new THREE.Vector3(0, 0, 2.4); // where a Judge looks when it turns to the room
export const HOST_POST = { pos: new THREE.Vector3(-3.65, 0, 0.35), yaw: 0 }; // beside the tube row, off every walk
HOST_POST.yaw = Math.atan2(0.4 - HOST_POST.pos.x, 4.5 - HOST_POST.pos.z);

const yawTo = (from, to) => Math.atan2(to.x - from.x, to.z - from.z);

/** id -> { angle, pos (desk centre), yaw (the desk's front faces the room), post, deskYaw, roomYaw } */
export const DESKS = Object.fromEntries(
  JUDGE_IDS.map((id, i) => {
    const a = ANGLES[i];
    const pos = new THREE.Vector3(DESK_R * Math.sin(a), 0, -DESK_R * Math.cos(a));
    const inward = new THREE.Vector3(-Math.sin(a), 0, Math.cos(a));
    const post = pos.clone().addScaledVector(inward, POST_BACK);
    return [id, { angle: a, pos, yaw: Math.atan2(inward.x, inward.z), post, deskYaw: yawTo(post, pos), roomYaw: yawTo(post, ROOM_FOCUS) }];
  }),
);

/** Where a Judge stands to drop its token: on the desk side of the box, on the line to its post. */
export function dropSpot(id, reach = 0.62) {
  const p = DESKS[id].post, d = new THREE.Vector3(p.x - BALLOT.x, 0, p.z - BALLOT.z).normalize();
  return BALLOT.clone().addScaledVector(d, reach);
}

/** The urns' positions: one straight row on the room side of the box, left to right as seen from the
 *  room, so the count reads as a bar chart and the majority line runs straight across it. */
export function urnSpots(n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(new THREE.Vector3((i - (n - 1) / 2) * URN_GAP, 0, BALLOT.z + URN_ROW)); // centred in the room
  return out;
}
