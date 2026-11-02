// Merge a static object (mine.js machines are dozens of small meshes) into one mesh per material,
// so a truck costs ~8 draw calls instead of ~70. Instanced meshes are expanded. Geometry only:
// position, normal (and color when every part has it); uv is dropped (the mine uses none).
import * as THREE from "three";

export function bakeByMaterial(root) {
  root.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const buckets = new Map(); // material -> [geometry in root space]
  const m = new THREE.Matrix4(), mi = new THREE.Matrix4(), tint = new THREE.Color();
  const vc = new Map(); // material -> its vertex-coloured clone
  root.traverse((o) => {
    if (!o.isMesh || !o.visible) return;
    const local = new THREE.Matrix4().multiplyMatrices(inv, o.matrixWorld);
    const push = (mat, tint) => {
      let g = o.geometry.index ? o.geometry.toNonIndexed() : o.geometry.clone();
      for (const k of Object.keys(g.attributes)) if (k !== "position" && k !== "normal" && k !== "color") g.deleteAttribute(k);
      if (!g.attributes.normal) g.computeVertexNormals();
      g.applyMatrix4(mat);
      let key = o.material;
      if (tint) {
        // instance colours become vertex colours on a material clone that reads them
        const c = new Float32Array(g.attributes.position.count * 3);
        for (let i = 0; i < c.length; i += 3) (c[i] = tint.r), (c[i + 1] = tint.g), (c[i + 2] = tint.b);
        g.setAttribute("color", new THREE.BufferAttribute(c, 3));
        if (!vc.has(o.material)) vc.set(o.material, Object.assign(o.material.clone(), { vertexColors: true }));
        key = vc.get(o.material);
      }
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(g);
    };
    if (o.isInstancedMesh) {
      for (let i = 0; i < o.count; i++) {
        o.getMatrixAt(i, mi);
        if (o.instanceColor) o.getColorAt(i, tint);
        push(m.multiplyMatrices(local, mi), o.instanceColor ? tint : null);
      }
    } else push(local);
  });
  const out = new THREE.Group();
  for (const [mat, geos] of buckets) {
    const hasColor = geos.every((g) => g.attributes.color);
    let n = 0;
    for (const g of geos) n += g.attributes.position.count;
    const pos = new Float32Array(n * 3), nrm = new Float32Array(n * 3), col = hasColor ? new Float32Array(n * 3) : null;
    let off = 0;
    for (const g of geos) {
      pos.set(g.attributes.position.array, off * 3);
      nrm.set(g.attributes.normal.array, off * 3);
      if (col) col.set(g.attributes.color.array, off * 3);
      off += g.attributes.position.count;
      g.dispose();
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setAttribute("normal", new THREE.BufferAttribute(nrm, 3));
    if (col) geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
    geo.computeBoundingSphere();
    out.add(new THREE.Mesh(geo, mat));
  }
  out.position.copy(root.position);
  out.quaternion.copy(root.quaternion);
  out.scale.copy(root.scale);
  return out;
}
