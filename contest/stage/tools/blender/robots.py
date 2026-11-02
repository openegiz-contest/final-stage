"""The six robots of the Final Stage, modelled by script (characters v4).

    blender -b --factory-startup -P contest/stage/tools/blender/robots.py -- [--only opus-5.5,...] [--review DIR]

Writes contest/stage/assets/robots/<id>.glb: one node per rigid part, placed at its joint in the rest
pose (standing, arms straight down), the geometry in the joint's own frame. robots/assets.js reads the
node translations as the skeleton (robots/rig.js) and hangs each part on its joint, so the joint
positions live here and nowhere else. Materials are slots by name (ceramic, glaze, terracotta, ...);
robots/materials.js replaces them. Faces (visors, Fable's lens) carry a front-projected UV for the
face-light map.

Coordinates: everything below is written in the Stage's frame (three.js: y up, the robot faces +z, its
left at +x) and converted to Blender's (z up, facing -y) when a mesh is made.
--review DIR renders each robot front, three-quarter and side (EEVEE) for a look before wiring.
"""
import bpy
import bmesh
import json
import math
import os
import sys
from mathutils import Matrix, Vector

HERE = os.path.dirname(os.path.abspath(__file__))
STAGE = os.path.dirname(os.path.dirname(HERE))
OUT = os.path.join(STAGE, "assets", "robots")
ARGS = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []


def arg(name, default=None):
    return ARGS[ARGS.index(name) + 1] if name in ARGS else default


PI = math.pi


def B(x, y, z):
    """Stage frame -> Blender frame."""
    return Vector((x, -z, y))


# ---- materials (preview values; the Stage replaces them by name) ---------------------------------

PREVIEW = {
    "ceramic": ((0.62, 0.55, 0.44), 0.65, 0.0),
    "glaze": ((0.74, 0.68, 0.56), 0.16, 0.0),
    "glaze_fade": ((0.74, 0.68, 0.56), 0.2, 0.0),
    "terracotta": ((0.42, 0.15, 0.07), 0.85, 0.0),
    "terracotta_dark": ((0.22, 0.08, 0.045), 0.85, 0.0),
    "core": ((0.05, 0.04, 0.035), 0.7, 0.0),
    "face": ((0.015, 0.013, 0.012), 0.12, 0.0),
    "lens": ((0.02, 0.015, 0.01), 0.1, 0.0),
    "brass": ((0.45, 0.30, 0.15), 0.35, 1.0),
    "glass": ((0.004, 0.004, 0.005), 0.05, 0.0),
    "glass_cut": ((0.004, 0.004, 0.005), 0.05, 0.0),
    "satin": ((0.03, 0.03, 0.034), 0.35, 0.8),
    "visor": ((0.008, 0.008, 0.01), 0.08, 0.0),
    "host_body": ((0.05, 0.05, 0.055), 0.55, 0.2),
    "host_amber": ((0.70, 0.36, 0.06), 0.5, 0.0),
    "host_reflect": ((0.55, 0.56, 0.56), 0.35, 0.6),
    "host_rubber": ((0.02, 0.02, 0.02), 0.9, 0.0),
    "host_metal": ((0.55, 0.56, 0.58), 0.3, 1.0),
    "status": ((0.9, 0.8, 0.6), 0.3, 0.0),
}


def material(name):
    m = bpy.data.materials.get(name)
    if m:
        return m
    m = bpy.data.materials.new(name)
    col, rough, metal = PREVIEW[name]
    m.use_nodes = True
    p = m.node_tree.nodes.get("Principled BSDF")
    p.inputs["Base Color"].default_value = (*col, 1)
    p.inputs["Roughness"].default_value = rough
    p.inputs["Metallic"].default_value = metal
    return m


# ---- mesh building ------------------------------------------------------------------------------

def cr(p0, p1, p2, p3, t):
    return 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t + (-p0 + 3 * p1 - 3 * p2 + p3) * t ** 3)


def norm_rows(rows, n):
    out = []
    for r in rows:
        r = list(r)
        if len(r) == 3:
            r += [0.0, n]
        elif len(r) == 4:
            r += [n]
        out.append(r)
    return out


def smooth_rows(rows, steps):
    """Catmull-Rom through the rows (bottom to top); steps samples including both ends."""
    N = len(rows)
    if not steps or steps <= N:
        return [list(r) for r in rows]
    out = []
    for i in range(steps):
        s = i / (steps - 1) * (N - 1)
        k = min(N - 2, int(s))
        t = s - k
        r = []
        for c in range(len(rows[0])):
            def v(j):
                return rows[max(0, min(N - 1, j))][c]
            r.append(cr(v(k - 1), v(k), v(k + 1), v(k + 2), t))
        r[1] = max(0.0, r[1])
        r[2] = max(0.0, r[2])
        out.append(r)
    out[0] = list(rows[0])
    out[-1] = list(rows[-1])
    return out


def sec(w, d, z0, n, th):
    s, c = math.sin(th), math.cos(th)
    e = 2.0 / n
    return w * math.copysign(abs(s) ** e, s), z0 + d * math.copysign(abs(c) ** e, c)


def loft(rows, segs=32, n=2.6, steps=None, a0=None, a1=None, cap0=True, cap1=True, grow=0.0, angles=None, offset=0.0):
    """A surface swept along y through superellipse sections.

    rows: [y, w, d, z0=0, n] bottom to top (w, d half sizes; z0 shifts the section forward; a row with
    w = d = 0 is a pole). Smoothed by Catmull-Rom to `steps` rows. a0/a1 limit the arc (0 = front +z,
    +pi/2 = the robot's left); `angles` gives the arc's columns explicitly. cap0/cap1 close open ends
    with a fan. grow offsets the section outward. Returns (verts, faces) in the Stage frame.
    """
    R = smooth_rows(norm_rows(rows, n), steps)
    full = a0 is None and angles is None
    if angles is None:
        if full:
            angles = [-PI + offset + 2 * PI * j / segs for j in range(segs)]
        else:
            angles = [a0 + (a1 - a0) * j / segs for j in range(segs + 1)]
    verts, faces, rings = [], [], []
    for (y, w, d, z0, nn) in R:
        if w < 1e-6 and d < 1e-6:
            rings.append(("pole", len(verts)))
            verts.append((0.0, y, z0))
            continue
        start = len(verts)
        for th in angles:
            x, z = sec(w + grow, d + grow, z0, nn, th)
            verts.append((x, y, z))
        rings.append(("ring", start))
    M = len(angles)
    for i in range(len(rings) - 1):
        (ka, a), (kb, b) = rings[i], rings[i + 1]
        cols = range(M) if full else range(M - 1)
        for j in cols:
            j2 = (j + 1) % M
            if ka == "ring" and kb == "ring":
                faces.append((a + j, a + j2, b + j2, b + j))
            elif ka == "pole" and kb == "ring":
                faces.append((a, b + j2, b + j))
            elif ka == "ring" and kb == "pole":
                faces.append((a + j, a + j2, b))
    if full:
        for cap, (k, s), yy in ((cap0, rings[0], R[0]), (cap1, rings[-1], R[-1])):
            if cap and k == "ring":
                c = len(verts)
                verts.append((0.0, yy[0], yy[3]))
                for j in range(M):
                    faces.append((s + j, s + (j + 1) % M, c))
    return verts, faces


def swap_yz(vf, dy=0.0, dz=0.0):
    """A loft built along y turned to run along z (feet, sockets): (x, y, z) -> (x, z + dy, y + dz)."""
    v, f = vf
    return [(x, z + dy, y + dz) for (x, y, z) in v], f


def rot_x(vf, a, about=(0.0, 0.0)):
    """Rotate about the x axis (a > 0 tips +y toward +z) around the point (y, z) = about."""
    v, f = vf
    c, s = math.cos(a), math.sin(a)
    y0, z0 = about
    return [(x, y0 + (y - y0) * c - (z - z0) * s, z0 + (y - y0) * s + (z - z0) * c) for (x, y, z) in v], f


def rot_z(vf, a):
    v, f = vf
    c, s = math.cos(a), math.sin(a)
    return [(x * c - y * s, x * s + y * c, z) for (x, y, z) in v], f


def rot_y(vf, a):
    v, f = vf
    c, s = math.cos(a), math.sin(a)
    return [(x * c + z * s, y, -x * s + z * c) for (x, y, z) in v], f


def move(vf, dx=0.0, dy=0.0, dz=0.0):
    v, f = vf
    return [(x + dx, y + dy, z + dz) for (x, y, z) in v], f


def scale(vf, sx=1.0, sy=1.0, sz=1.0):
    v, f = vf
    return [(x * sx, y * sy, z * sz) for (x, y, z) in v], f


def box(w, h, d, x=0.0, y=0.0, z=0.0):
    """An axis box (half sizes w, h, d) centred at (x, y, z)."""
    v = [(x + sx * w, y + sy * h, z + sz * d) for sx in (-1, 1) for sy in (-1, 1) for sz in (-1, 1)]
    f = [(0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)]
    return v, f


def cyl(r, h, segs=32, x=0.0, y=0.0, z=0.0, axis="y", r2=None):
    """A capped cylinder (or cone with r2) of height h centred at (x, y, z) along an axis."""
    rows = [(-h / 2, r, r), (h / 2, r2 if r2 is not None else r, r2 if r2 is not None else r)]
    vf = loft(rows, segs=segs, n=2.0)
    if axis == "z":
        vf = swap_yz(vf)
    elif axis == "x":
        v, f = vf
        vf = ([(y_, -x_, z_) for (x_, y_, z_) in v], f)
    return move(vf, x, y, z)


def make(name, vf, mat, smooth=True, sharp=None, uv=None):
    """A mesh object from (verts, faces) in the Stage frame. sharp: auto-smooth angle (deg).
    uv: (x0, x1, y0, y1) front projection bounds in the Stage frame."""
    verts, faces = vf
    me = bpy.data.meshes.new(name)
    me.from_pydata([tuple(B(*p)) for p in verts], [], faces)
    me.validate(clean_customdata=False)
    bm = bmesh.new()
    bm.from_mesh(me)
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context="VERTS")
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-6)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    if uv:
        x0, x1, y0, y1 = uv
        layer = bm.loops.layers.uv.new("UVMap")
        for f in bm.faces:
            for l in f.loops:
                co = l.vert.co  # Blender frame: x, -z, y
                l[layer].uv = ((co.x - x0) / (x1 - x0), (co.z - y0) / (y1 - y0))
    bm.to_mesh(me)
    bm.free()
    o = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(o)
    o.data.materials.append(material(mat))
    if smooth:
        me.shade_smooth()
        if sharp:
            me.set_sharp_from_angle(angle=math.radians(sharp))
    return o


def bake(o):
    """Apply the modifier stack."""
    dg = bpy.context.evaluated_depsgraph_get()
    me = bpy.data.meshes.new_from_object(o.evaluated_get(dg))
    old = o.data
    o.modifiers.clear()
    o.data = me
    bpy.data.meshes.remove(old)
    return o


def solidify(o, t, offset=-1.0):
    m = o.modifiers.new("solid", "SOLIDIFY")
    m.thickness = t
    m.offset = offset
    m.use_even_offset = True
    m.use_rim = True
    return o


def subsurf(o, lv=1):
    m = o.modifiers.new("sub", "SUBSURF")
    m.levels = lv
    m.render_levels = lv
    return o


def bevel(o, w, segs=1, angle=30, profile=0.5, harden=False):
    m = o.modifiers.new("bev", "BEVEL")
    m.width = w
    m.segments = segs
    m.limit_method = "ANGLE"
    m.angle_limit = math.radians(angle)
    m.profile = profile
    m.harden_normals = harden
    m.miter_outer = "MITER_ARC"
    return o


def boolean(o, cutter, op="DIFFERENCE"):
    m = o.modifiers.new("bool", "BOOLEAN")
    m.operation = op
    m.object = cutter
    m.solver = "EXACT"
    bake(o)
    return o


def remove(o):
    me = o.data
    bpy.data.objects.remove(o)
    if me and me.users == 0:
        bpy.data.meshes.remove(me)


def join(objs, name):
    objs = [o for o in objs if o]
    for o in objs:
        if o.modifiers:
            bake(o)
    bpy.ops.object.select_all(action="DESELECT")
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    if len(objs) > 1:
        bpy.ops.object.join()
    o = bpy.context.view_layer.objects.active
    o.name = name
    o.data.name = name
    return o


def mirror(o, name):
    """A copy mirrored across x (the robot's left part -> its right)."""
    me = o.data.copy()
    me.transform(Matrix.Scale(-1, 4, (1, 0, 0)))
    bm = bmesh.new()
    bm.from_mesh(me)
    bmesh.ops.reverse_faces(bm, faces=bm.faces)
    bm.to_mesh(me)
    bm.free()
    me.name = name
    c = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(c)
    c.location = (-o.location.x, o.location.y, o.location.z)
    return c


def place(o, x, y, z):
    o.location = B(x, y, z)
    return o


# ---- shared parts ---------------------------------------------------------------------------------

def ceramic(name, vf, mat="ceramic", sub=0, sharp=None, uv=None):
    o = make(name, vf, mat, sharp=sharp, uv=uv)
    if sub:
        subsurf(o, sub)
    return o


def shell(name, rows, mat="ceramic", t=0.007, segs=28, n=2.6, steps=None, cap0=False, cap1=False, sub=0, **kw):
    """A thin open shell: loft, solidify inward; the cut lip stays crisp (a made shell, not a balloon)."""
    o = make(name, loft(rows, segs=segs, n=n, steps=steps, cap0=cap0, cap1=cap1, **kw), mat)
    solidify(o, t)
    if sub:
        subsurf(o, sub)
    bake(o)
    o.data.set_sharp_from_angle(angle=math.radians(50))
    return o


def surface_at(rows, n, y):
    """The (w, d, z0, n) of a loft's smoothed surface at height y."""
    dense = smooth_rows(norm_rows(rows, n), 240)
    best = min(dense, key=lambda r: abs(r[0] - y))
    return best[1], best[2], best[3], best[4]


def panel(name, rows, center, half, y0, y1, mat, grow=0.003, t=0.004, n=2.6, segs=20, ny=12, sub=1, uv=None, bottom=None):
    """A panel on a loft's surface around the angle `center`: half(y) -> half-angle (a shield, a hatch),
    from y0 to y1 (bottom(u) -> y0 per column u in 0..1 gives a shaped lower edge), raised by grow."""
    verts, faces = [], []
    cols = segs + 1
    for i in range(ny + 1):
        for j in range(cols):
            u = j / segs
            yb = bottom(u) if bottom else y0
            y = yb + (y1 - yb) * i / ny
            w, d, z0, nn = surface_at(rows, n, y)
            h = half(y) if callable(half) else half
            th = center - h + 2 * h * u
            x, z = sec(w + grow, d + grow, z0, nn, th)
            verts.append((x, y, z))
    for i in range(ny):
        for j in range(segs):
            a = i * cols + j
            faces.append((a, a + 1, a + cols + 1, a + cols))
    o = make(name, (verts, faces), mat, uv=uv)
    solidify(o, t)
    if sub:
        subsurf(o, sub)
    return o


def hand(name, P, side=1):
    """Palm with thumb (on the hand joint) and the finger block (on the knuckle joint), left hand.
    P: palm (half thickness x, length y, half width z), count, finger radius, len (two segments), curl,
    style ('soft' | 'chamfer' | 'facet'), mat. The palm faces the body (-x for the left hand)."""
    pw, ph, pd = P["palm"]
    mat = P.get("mat", "terracotta")
    style = P.get("style", "soft")
    soft = style == "soft"
    sharp = None if soft else 35
    parts = []
    if soft:
        rows = [(0.03, pw * 0.7, pd * 0.7), (0.0, pw * 0.95, pd * 0.92), (-ph * 0.35, pw, pd), (-ph * 0.8, pw * 0.98, pd * 1.02),
                (-ph - 0.006, pw * 0.82, pd * 0.95), (-ph - 0.012, 0, 0)]
        parts.append(make(name + "_p", loft(rows, segs=20, n=2.8, steps=10, cap0=True), mat))
    else:
        rows = [(0.03, pw * 0.75, pd * 0.75), (0.0, pw, pd * 0.95), (-ph * 0.9, pw, pd * 1.02), (-ph - 0.008, pw * 0.8, pd * 0.92)]
        o = make(name + "_p", loft(rows, segs=8 if style == "facet" else 16, n=2.0 if style == "facet" else 4.0), mat, sharp=35)
        parts.append(o)
    tr = P["finger"] * 1.12
    tl = P["len"][0] * 1.05
    seg_n = 12 if soft else (6 if style == "facet" else 8)
    nn = 2.2 if soft else (2.0 if style == "facet" else 3.0)
    th = loft([(0, tr * 0.95, tr), (-tl * 0.5, tr, tr * 1.02), (-tl, tr * 0.85, tr * 0.85), (-tl - tr * 0.8, 0, 0)],
              segs=seg_n, n=nn, steps=7 if soft else None, cap0=True)
    th = rot_x(th, -0.55)
    th = rot_z(th, -0.35 * side)
    th = move(th, -pw * 0.25, -ph * 0.25, pd * 0.78)
    parts.append(make(name + "_t", th, mat, sharp=sharp))
    palm = join(parts, name)
    fparts = []
    cnt = P.get("count", 4)
    spread = pd * 0.76
    c = P.get("curl", 0.35)
    for i in range(cnt):
        zf = -spread + 2 * spread * i / (cnt - 1) if cnt > 1 else 0
        k = 1.0 - 0.12 * abs(i - (cnt - 1) / 2) / max(1, (cnt - 1) / 2)
        r = P["finger"] * (0.92 if i == 0 else 1.0)
        L1, L2 = P["len"][0] * k, P["len"][1] * k
        a = loft([(0.004, r * 0.95, r), (-L1 * 0.5, r, r), (-L1, r * 0.92, r * 0.92), (-L1 - r * 0.3, r * 0.9, r * 0.9)], segs=seg_n, n=nn, cap0=True, cap1=True)
        b = loft([(0.0, r * 0.88, r * 0.88), (-L2 * 0.6, r * 0.84, r * 0.84), (-L2, r * 0.7, r * 0.7), (-L2 - r * 0.6, 0, 0)], segs=seg_n, n=nn,
                 steps=5 if soft else None, cap0=True)
        b = rot_z(b, -c * 0.9)
        b = move(b, 0, -L1, 0)
        a = rot_z(a, -c * 0.3)
        b = rot_z(b, -c * 0.3)
        fparts.append(make(f"{name}_f{i}a", move(a, 0, 0, zf), mat, sharp=sharp))
        fparts.append(make(f"{name}_f{i}b", move(b, 0, 0, zf), mat, sharp=sharp))
    fingers = join(fparts, name.replace("hand", "fingers"))
    return palm, fingers


def c_hand(name, P):
    """A mechanical ceramic hand in the body's own colour (the Anthropic family), left hand: a ball
    wrist under the forearm's closed end, a rounded-square palm block, and
    jointed fingers (two squared segments each, a narrow knuckle between them, a rounded tip), so it
    reads as a machine's hand, not a glove. One material, so it costs no extra draw call.
    P: palm (half thickness x, length y, half width z), finger radius, len (two segments), count,
    curl, mat. The palm faces the body (-x for the left hand), the thumb forward (+z)."""
    pw, ph, pd = P["palm"]
    mat = P.get("mat", "ceramic")
    r = P["finger"]
    rw = min(pd, pw * 1.6) * 0.62
    yw = -0.006  # the ball sits a little below the joint, half inside the forearm's closed end
    wrist = make(name + "_w", loft([(yw - rw * 1.05, 0.0, 0.0), (yw - rw * 0.75, rw * 0.68, rw * 0.68), (yw - rw * 0.2, rw, rw), (yw + rw * 0.3, rw * 0.97, rw * 0.97),
                                    (yw + rw * 0.85, rw * 0.55, rw * 0.55), (yw + rw, 0.0, 0.0)], segs=20, n=2.0, steps=9), mat)
    rows = [(-0.014, pw * 0.74, pd * 0.78), (-0.024, pw * 0.97, pd * 0.97), (-ph * 0.5, pw, pd), (-ph * 0.9, pw * 0.97, pd * 1.0),
            (-ph + 0.002, pw * 0.86, pd * 0.94)]
    palm = make(name + "_p", loft(rows, segs=24, n=3.0, steps=10), mat, sharp=40)
    # the thumb: two squared segments on the front edge of the palm, angled forward and down
    tr, tl = r * 1.1, P["len"][0] * 0.95
    def seg(L, rr, tip=False, y0=0.0):
        R = [(y0, rr * 0.8, rr * 0.86), (y0 - 0.003, rr * 0.86, rr * 0.92), (-L + 0.003, rr * 0.86, rr * 0.92), (-L, rr * 0.78, rr * 0.84)]
        R = R[:3] + [(-L - rr * 0.25, rr * 0.7, rr * 0.75), (-L - rr * 0.5, rr * 0.38, rr * 0.42), (-L - rr * 0.58, 0.0, 0.0)] if tip else R
        return loft(R, segs=16, n=3.6, steps=None, cap0=True, cap1=True)
    def knuckle(rr):
        return cyl(rr * 0.55, rr * 1.5, segs=14, axis="z")
    t1 = seg(tl * 0.55, tr)
    t2 = move(rot_z(seg(tl * 0.5, tr * 0.92, tip=True), -0.25), 0, -tl * 0.55 - tr * 0.28, 0)
    tk = move(knuckle(tr), 0, -tl * 0.55 - tr * 0.14, 0)
    thumb = []
    for vf in (t1, t2, tk):
        vf = rot_x(vf, -0.55)
        vf = rot_z(vf, -0.3)
        thumb.append(make(name + "_t", move(vf, -pw * 0.2, -ph * 0.3, pd * 0.82), mat, sharp=40))
    palm = join([wrist, palm] + thumb, name)
    fparts = []
    cnt = P.get("count", 4)
    spread = pd * 0.7
    c = P.get("curl", 0.35)
    for i in range(cnt):
        zf = -spread + 2 * spread * i / (cnt - 1) if cnt > 1 else 0
        k = 1.0 - 0.12 * abs(i - (cnt - 1) / 2) / max(1, (cnt - 1) / 2)
        rr = r * (0.92 if i == 0 else 1.0)
        L1, L2 = P["len"][0] * k, P["len"][1] * k
        g = rr * 0.46
        base = cyl(rr * 0.62, rr * 1.4, segs=14, y=0.0, axis="z")
        a = seg(L1, rr, y0=-0.004)
        kn = move(knuckle(rr), 0, -L1 - g * 0.5, 0)
        b = move(rot_z(seg(L2, rr * 0.92, tip=True), -c * 0.9), 0, -L1 - g, 0)
        for vf in (base, a, kn, b):
            vf = rot_z(vf, -c * 0.3)
            fparts.append(make(f"{name}_f{i}", move(vf, 0, 0, zf), mat, sharp=40))
    fingers = join(fparts, name.replace("hand", "fingers"))
    return palm, fingers


def drum(r, w, y=0.0, z=0.0, mat="terracotta", segs=24):
    """A hinge drum across the joint (axis x): what a robot's elbow or knee is, not a ball."""
    rows = [(-w / 2, r * 0.86, r * 0.86), (-w / 2 + 0.006, r, r), (w / 2 - 0.006, r, r), (w / 2, r * 0.86, r * 0.86)]
    v, f = loft(rows, segs=segs, n=2.0)
    v = [(yy, -xx + y, zz + z) for (xx, yy, zz) in v]  # axis y -> x, centred at (0, y, z)
    return make("drum", (v, f), mat, sharp=40)


def c_arm(rig, k, cap=1.0, bulk=1.0, shellmat="ceramic", coremat="terracotta", hand_p=None, capmat=None):
    """A ceramic arm: shoulder cap over the upper arm, a hinge drum at the elbow behind a guard, a
    one-piece forearm shell that tapers and closes over the wrist (no open cuff: a sleeve with a hand
    coming out of it reads as a costume), a mechanical hand in the body's colour (c_hand). capmat: the
    shoulder cap's own material (Fable's are glazed cream)."""
    d = rig.d
    up, fo = d["upper"], d["fore"]
    cw, cd = 0.108 * k * cap, 0.1 * k * cap
    CAP = [(0.09 * k * cap, 0, 0), (0.084 * k * cap, cw * 0.6, cd * 0.6), (0.055 * k * cap, cw * 0.9, cd * 0.9), (0.005, cw, cd),
           (-0.05 * k * cap, cw * 0.96, cd * 0.95), (-0.088 * k * cap, cw * 0.86, cd * 0.85)]
    capo = shell("cap", CAP, mat=capmat or shellmat, t=0.007, n=2.5, steps=12, segs=28)
    r1, r2 = 0.064 * k, 0.056 * k
    arm = shell("arm", [(-up + 0.042 * k, r2 * 1.04, r2 * 1.02), (-up + 0.07 * k, r2, r2 * 0.98), (-up * 0.5, (r1 + r2) / 2, (r1 + r2) / 2 * 0.97),
                        (-0.06, r1, r1 * 0.97), (-0.02, r1 * 0.98, r1 * 0.95)], mat=shellmat, t=0.006, n=2.6, steps=10, segs=24)
    inner = ceramic("capcore", loft([(-0.09 * k, 0.078 * k, 0.076 * k), (0.03 * k, 0.088 * k, 0.086 * k), (0.07 * k, 0.05 * k, 0.05 * k)], segs=20, n=2.3), mat=coremat)
    elbow = drum(0.05 * k, 0.098 * k, y=-up, mat=coremat)
    rig.add("upper_L", join([capo, arm, inner, elbow], "upper_L"))
    b = bulk
    F = [(0.055 * k, 0.0, 0.0, -0.05 * k), (0.05 * k, 0.04 * k, 0.03 * k, -0.05 * k), (0.02 * k, 0.07 * k * b, 0.05 * k * b, -0.035 * k),
         (-0.04 * k, 0.082 * k * b, 0.074 * k * b, -0.01 * k), (-0.11 * k, 0.086 * k * b, 0.082 * k * b, 0.004 * k), (-fo * 0.62, 0.076 * k * b, 0.074 * k * b, 0.0),
         (-fo + 0.05 * k, 0.067 * k, 0.065 * k), (-fo + 0.022 * k, 0.06 * k, 0.058 * k), (-fo + 0.006 * k, 0.046 * k, 0.045 * k), (-fo - 0.002 * k, 0.0, 0.0)]
    rig.add("fore_L", shell("fore_L", F, mat=shellmat, t=0.007, n=2.7, steps=18, segs=28))
    palm, fingers = c_hand("hand_L", dict(hand_p, mat=hand_p.get("mat", shellmat)))
    rig.add("hand_L", palm)
    rig.add("fingers_L", fingers)


def c_leg(rig, k, shellmat="ceramic", coremat="terracotta", solemat="terracotta_dark", foot_l=1.0, calf=1.0, bands=False, stripe=False):
    """A ceramic leg: a tapered thigh with a knee drum, a shin shell with a kneecap guard in front, a
    clog on a sole. bands: terracotta livery in the shell's own lines, a band round the knee (the thigh's
    lower edge) and one round the ankle (the clog's collar), on a terracotta sole, the shins and clogs
    cream (terracotta shins read as rubber boots); stripe: a terracotta stripe up the outer thigh
    (Sonnet's stripes). The bands ride on parts that already carry terracotta (the knee and ankle
    drums), so they add no draw call."""
    d = rig.d
    th, sh = d["thigh"], d["shin"]
    TH = [(0.075 * k, 0.0, 0.0), (0.07 * k, 0.06 * k, 0.062 * k), (0.035 * k, 0.098 * k, 0.104 * k), (-0.03, 0.108 * k, 0.114 * k, 0.004),
          (-th * 0.45, 0.098 * k, 0.104 * k, 0.006), (-th + 0.07 * k, 0.078 * k, 0.082 * k, 0.002), (-th + 0.045 * k, 0.07 * k, 0.074 * k)]
    thigh = shell("thigh", TH, mat=shellmat, t=0.007, n=2.75, steps=16, segs=28)
    knee = drum(0.056 * k, 0.11 * k, y=-th, mat=coremat)
    parts = [thigh, knee]
    if bands:
        parts.append(panel("kneeband", TH, 0.0, PI, -th + 0.047 * k, -th + 0.083 * k, coremat, grow=0.0032, t=0.004, n=2.75, segs=40, ny=3, sub=0))
    if stripe:
        parts.append(panel("thighstripe", TH, PI / 2, 0.2, -th + 0.1 * k, 0.02 * k, coremat, grow=0.003, t=0.004, n=2.75, segs=6, ny=12, sub=1))
    rig.add("thigh_L", join(parts, "thigh_L"))
    if bands:  # the shin tapers clean into the ankle collar (no spat flare under the band)
        S = [(0.07 * k, 0.0, 0.0, 0.045 * k), (0.064 * k, 0.045 * k, 0.03 * k, 0.05 * k), (0.035 * k, 0.08 * k, 0.06 * k, 0.034 * k),
             (-0.02, 0.098 * k, 0.09 * k, 0.012 * k), (-sh * 0.3, 0.102 * k, 0.104 * k * calf, -0.008 * k * calf), (-sh * 0.62, 0.088 * k, 0.09 * k, -0.004 * k),
             (-sh + 0.06 * k, 0.08 * k, 0.082 * k), (-sh + 0.025 * k, 0.077 * k, 0.079 * k, 0.002), (-sh + 0.004, 0.072 * k, 0.074 * k, 0.003)]
    else:
        S = [(0.07 * k, 0.0, 0.0, 0.045 * k), (0.064 * k, 0.045 * k, 0.03 * k, 0.05 * k), (0.035 * k, 0.08 * k, 0.06 * k, 0.034 * k),
             (-0.02, 0.098 * k, 0.09 * k, 0.012 * k), (-sh * 0.3, 0.102 * k, 0.104 * k * calf, -0.008 * k * calf), (-sh * 0.62, 0.088 * k, 0.09 * k, -0.004 * k),
             (-sh + 0.06 * k, 0.08 * k, 0.082 * k), (-sh + 0.02 * k, 0.09 * k, 0.092 * k, 0.004), (-sh + 0.004, 0.084 * k, 0.086 * k, 0.004)]
    shin = shell("shin", S, mat=shellmat, t=0.007, n=2.8, steps=18, segs=28, cap0=True)
    rig.add("shin_L", shin)
    ah = d["hipY"] - th - sh
    L = foot_l
    FT = [(-0.105 * L, 0.0, 0.0), (-0.1 * L, 0.06 * k, 0.04), (-0.075 * L, 0.078 * k, 0.055), (0.02 * L, 0.086 * k, 0.058, 0.002),
          (0.12 * L, 0.082 * k, 0.046, 0.008), (0.19 * L, 0.066 * k, 0.032, 0.012), (0.212 * L, 0.0, 0.0, 0.014)]
    foot = ceramic("foot", swap_yz(loft(FT, segs=24, n=3.0, steps=14), dy=-ah + 0.06), mat=shellmat)
    sole = ceramic("sole", swap_yz(loft([(-0.104 * L, 0.066 * k, 0.011), (0.0, 0.088 * k, 0.011), (0.19 * L, 0.07 * k, 0.011), (0.214 * L, 0.035 * k, 0.011)],
                                        segs=20, n=4.0, steps=8), dy=-ah + 0.011), mat=coremat if bands else solemat)
    ankle = drum(0.045 * k, 0.09 * k, y=0.0, mat=coremat)
    parts = [foot, sole, ankle]
    if bands:  # the ankle collar: a ring round the shin's foot, standing on the clog
        top = -ah + 0.06 + 0.056
        collar = make("collar", loft([(top - 0.012, 0.086 * k, 0.088 * k, 0.006), (top + 0.004, 0.09 * k, 0.092 * k, 0.005), (top + 0.026 * k, 0.088 * k, 0.09 * k, 0.004),
                                      (top + 0.03 * k, 0.08 * k, 0.082 * k, 0.004)], segs=32, n=2.8, cap0=False, cap1=False), coremat, sharp=40)
        solidify(collar, 0.006)
        parts.append(collar)
    rig.add("foot_L", join(parts, "foot_L"))


# ---- the rig the parts hang on ----------------------------------------------------------------------

class Rig:
    """Joint positions in the rest pose (Stage frame, metres). Parts are made in their joint's frame
    and placed at the joint; a left part is mirrored to the right."""

    def __init__(self, **d):
        self.d = d
        self.parts = []

    def joints(self):
        d = self.d
        hipY, hipW, thigh, shin = d.get("hipY", 0), d.get("hipW", 0), d.get("thigh", 0), d.get("shin", 0)
        sw, sy, sz = d["shoulderW"], d["shoulderY"], d.get("shoulderZ", 0.0)
        up, fo, palm = d["upper"], d["fore"], d["palm"]
        return {
            "pelvis": (0, hipY, 0), "torso": (0, hipY, 0), "base": (0, 0, 0),
            "neck": (0, hipY + d["neckY"], 0), "head": (0, hipY + d["neckY"], 0), "face": (0, hipY + d["neckY"], 0),
            "thigh_L": (hipW, hipY, 0), "shin_L": (hipW, hipY - thigh, 0), "foot_L": (hipW, hipY - thigh - shin, 0),
            "upper_L": (sw, hipY + sy, sz), "fore_L": (sw, hipY + sy - up, sz), "hand_L": (sw, hipY + sy - up - fo, sz),
            "fingers_L": (sw, hipY + sy - up - fo - palm, sz),
        }

    def add(self, name, o):
        if o.modifiers:
            bake(o)
        o.name = name
        o.data.name = name
        place(o, *self.joints()[name])
        self.parts.append(o)
        if name.endswith("_L"):
            self.parts.append(mirror(o, name[:-2] + "_R"))
        return o


def finish(rid, rig, info):
    """Mark the rig on an empty (glTF extras) and export the robot."""
    e = bpy.data.objects.new("rig", None)
    bpy.context.scene.collection.objects.link(e)
    top = 0.0
    for o in rig.parts:
        for v in o.data.vertices:
            top = max(top, (o.matrix_world @ v.co).z)
    info = dict(info, id=rid, height=round(top, 3))
    e["robot"] = json.dumps(info)
    os.makedirs(OUT, exist_ok=True)
    path = os.path.join(OUT, f"{rid}.glb")
    bpy.ops.object.select_all(action="DESELECT")
    for o in rig.parts + [e]:
        o.select_set(True)
    bpy.ops.export_scene.gltf(filepath=path, export_format="GLB", use_selection=True, export_apply=True, export_extras=True,
                              export_yup=True, export_normals=True, export_texcoords=True, export_materials="EXPORT",
                              export_animations=False, export_skins=False, export_morph=False, export_lights=False, export_cameras=False)
    tris = sum(sum(len(p.vertices) - 2 for p in o.data.polygons) for o in rig.parts)
    verts = sum(len(o.data.vertices) for o in rig.parts)
    print(f"[robots] {rid}: {os.path.getsize(path) / 1e6:.2f} MB, {verts} verts, {tris} tris, height {top:.3f} m")
    return path


# ---- Opus 5.5: large and calm ---------------------------------------------------------------------
# A heavy, soft figure: a deep barrel chest between broad shoulder caps, a squared hip block, thick legs
# on big clogs, a wide pebble head low between the shoulders under a heavy brow, the visor a slot.
# Matte cream shells head to foot; terracotta as livery (a band above each knee, a collar round each
# ankle, the soles) and at the joints, the waist and the neck; jointed cream hands out of closed
# forearms (c_hand); one glazed breastplate, a terracotta yoke across the upper back.

def build_opus():
    d = dict(hipY=0.90, hipW=0.13, thigh=0.395, shin=0.40, shoulderW=0.30, shoulderY=0.605, shoulderZ=-0.005,
             upper=0.31, fore=0.30, palm=0.105, neckY=0.735)
    rig = Rig(**d)
    P = [(-0.112, 0.15, 0.1), (-0.104, 0.2, 0.14), (-0.07, 0.222, 0.158, 0.003), (0.0, 0.228, 0.165, 0.005), (0.06, 0.218, 0.16, 0.004),
         (0.1, 0.196, 0.146, 0.0)]
    rig.add("pelvis", shell("pelvis", P, t=0.008, n=3.3, steps=12, segs=32, cap0=True))
    T = [(0.135, 0.185, 0.142, 0.0), (0.18, 0.212, 0.163, 0.008), (0.28, 0.236, 0.186, 0.016), (0.40, 0.247, 0.199, 0.02),
         (0.52, 0.25, 0.2, 0.016), (0.6, 0.244, 0.19, 0.008), (0.655, 0.222, 0.172, -0.004), (0.695, 0.17, 0.134, -0.014),
         (0.718, 0.1, 0.084, -0.016)]
    chest = shell("chest", T, t=0.008, n=2.75, steps=18, segs=36)
    core = ceramic("core", loft([(-0.04, 0.17, 0.126), (0.08, 0.174, 0.13), (0.2, 0.178, 0.134)], segs=28, n=2.6), mat="terracotta")
    # a glazed sternum plate, a terracotta yoke across the upper back (the back is what the wide shot sees)
    shield = lambda y: 0.5 + 0.12 * (y - 0.46) / 0.17
    gap = panel("gap", T, 0.0, lambda y: shield(y) + 0.045, 0.452, 0.638, "terracotta_dark", grow=0.0012, t=0.003, sub=1)
    plate = panel("plate", T, 0.0, shield, 0.46, 0.63, "glaze", grow=0.004, t=0.005, sub=1)
    ygap = panel("yokegap", T, PI, lambda y: 1.2 - 0.25 * (0.68 - y) / 0.2, 0.47, 0.69, "core", grow=0.0012, t=0.003, sub=1, segs=28)
    yoke = panel("yoke", T, PI, lambda y: 1.15 - 0.25 * (0.68 - y) / 0.2, 0.48, 0.69, "terracotta", grow=0.0045, t=0.005, sub=1, segs=28)
    collar = ceramic("collar", loft([(0.69, 0.13, 0.11, -0.012), (0.705, 0.138, 0.116, -0.014), (0.728, 0.122, 0.102, -0.016), (0.736, 0.1, 0.085, -0.016)],
                                    segs=32, n=2.4, cap0=False, cap1=False), mat="terracotta")
    solidify(collar, 0.006)
    rig.add("torso", join([chest, core, gap, plate, ygap, yoke, collar], "torso"))
    rig.add("neck", ceramic("neck", loft([(-0.08, 0.08, 0.076), (0.02, 0.078, 0.074), (0.06, 0.07, 0.066)], segs=24, n=2.2), mat="terracotta"))
    # the head: wider than tall, a heavy brow over a slot visor
    H = [(-0.012, 0.0, 0.0), (-0.006, 0.11, 0.1), (0.022, 0.168, 0.156, 0.004), (0.08, 0.192, 0.175, 0.008), (0.15, 0.194, 0.176, 0.006),
         (0.205, 0.186, 0.172, 0.016), (0.25, 0.162, 0.15, 0.01), (0.28, 0.12, 0.11, 0.0), (0.298, 0.0, 0.0, -0.005)]
    H = [(r[0] * 1.06,) + tuple(r[1:]) for r in H]
    head = ceramic("headshell", loft(H, segs=40, n=2.5, steps=22), sub=0)
    frame = panel("visorframe", H, 0.0, 0.92, 0.112, 0.21, "core", grow=0.0008, t=0.003, sub=1)
    pods = [ceramic(f"pod{s}", cyl(0.04, 0.012, segs=24, x=s * 0.19, y=0.16, z=-0.006, axis="x"), mat="terracotta") for s in (-1, 1)]
    rig.add("head", join([head, frame] + pods, "head"))
    rig.add("face", panel("face", H, 0.0, 0.86, 0.118, 0.204, "face", grow=0.0028, t=0.003, sub=2, segs=24, ny=8, uv=(-0.165, 0.165, 0.118, 0.204)))
    c_arm(rig, 1.0, cap=1.04, bulk=1.06, hand_p=dict(palm=(0.03, d["palm"], 0.055), finger=0.018, len=(0.05, 0.042), count=3, curl=0.45))
    c_leg(rig, 1.05, foot_l=1.08, bands=True)
    return rig, dict(model="Opus 5.5", vendor="anthropic")


# ---- Sonnet 5.5: light ----------------------------------------------------------------------------
# Slim and upright: a narrow tapering torso with a visible waist, long legs, thin arms with small
# hands, an upright egg head with a tall narrow visor. A glazed drop down the chest (wide under the
# collar, tapering to the waist) echoes the visor; a terracotta spine strip reads from behind; the
# livery of Opus (knee and ankle bands) plus a terracotta stripe down each outer thigh; jointed cream hands.

def build_sonnet():
    d = dict(hipY=0.78, hipW=0.083, thigh=0.35, shin=0.35, shoulderW=0.2, shoulderY=0.455, shoulderZ=0.0,
             upper=0.25, fore=0.235, palm=0.075, neckY=0.545)
    rig = Rig(**d)
    P = [(-0.085, 0.1, 0.07), (-0.078, 0.13, 0.092), (-0.045, 0.145, 0.104, 0.003), (0.01, 0.146, 0.106, 0.004), (0.065, 0.128, 0.095)]
    rig.add("pelvis", shell("pelvis", P, t=0.006, n=3.0, steps=10, segs=28, cap0=True))
    T = [(0.1, 0.098, 0.078), (0.14, 0.11, 0.086, 0.004), (0.22, 0.13, 0.1, 0.01), (0.32, 0.148, 0.112, 0.014), (0.40, 0.152, 0.114, 0.012),
         (0.46, 0.146, 0.108, 0.004), (0.505, 0.122, 0.092, -0.004), (0.53, 0.08, 0.064, -0.008)]
    chest = shell("chest", T, t=0.006, n=2.6, steps=16, segs=32)
    core = ceramic("core", loft([(-0.03, 0.088, 0.07), (0.06, 0.084, 0.066), (0.15, 0.09, 0.07)], segs=24, n=2.4), mat="terracotta")
    drop = lambda y: 0.05 + 0.24 * max(0.0, min(1.0, (y - 0.24) / 0.23)) ** 0.75
    sgap = panel("gap", T, 0.0, lambda y: drop(y) + 0.045, 0.228, 0.482, "terracotta_dark", grow=0.001, t=0.003, sub=1, segs=14, ny=14)
    stripe = panel("stripe", T, 0.0, drop, 0.24, 0.472, "glaze", grow=0.0035, t=0.004, sub=1, segs=14, ny=14)
    spine = panel("spine", T, PI, 0.2, 0.15, 0.49, "terracotta", grow=0.003, t=0.004, sub=1, segs=10)
    rig.add("torso", join([chest, core, sgap, stripe, spine], "torso"))
    rig.add("neck", ceramic("neck", loft([(-0.06, 0.045, 0.045), (0.02, 0.042, 0.042), (0.05, 0.038, 0.038)], segs=20, n=2.0), mat="terracotta"))
    H = [(-0.0, 0.0, 0.0), (0.004, 0.06, 0.065), (0.03, 0.088, 0.098, 0.004), (0.09, 0.098, 0.11, 0.008), (0.15, 0.097, 0.109, 0.008),
         (0.2, 0.086, 0.098, 0.004), (0.232, 0.06, 0.07), (0.245, 0.0, 0.0)]
    head = ceramic("headshell", loft(H, segs=36, n=2.25, steps=22))
    frame = panel("visorframe", H, 0.0, 0.44, 0.072, 0.205, "core", grow=0.0008, t=0.003, sub=1, segs=14)
    ring = ceramic("collar", loft([(-0.012, 0.064, 0.07), (0.0, 0.068, 0.074), (0.012, 0.06, 0.066)], segs=24, n=2.2), mat="terracotta")
    stripe_h = panel("headstripe", H, PI, 0.17, 0.03, 0.215, "terracotta", grow=0.0028, t=0.003, sub=1, segs=8)
    rig.add("head", join([head, frame, ring, stripe_h], "head"))
    rig.add("face", panel("face", H, 0.0, 0.4, 0.078, 0.199, "face", grow=0.0028, t=0.003, sub=2, segs=14, ny=12, uv=(-0.05, 0.05, 0.078, 0.199)))
    c_arm(rig, 0.66, cap=0.95, bulk=0.95, hand_p=dict(palm=(0.021, d["palm"], 0.038), finger=0.0115, len=(0.038, 0.032), count=4, curl=0.4))
    c_leg(rig, 0.7, foot_l=0.82, calf=1.1, bands=True, stripe=True)
    return rig, dict(model="Sonnet 5.5", vendor="anthropic")


# ---- Fable 5.1: the storyteller --------------------------------------------------------------------
# A terracotta robot, not a costume: matte terracotta shells over a dark clay body, a rounded acorn head
# on a visible neck (no lid, no slots: a lid read as a bucket) with one warm projector lens in a thin
# glazed bezel and glazed ear discs, glazed cream shoulder caps, a framed chest panel and a back tile
# whose cream glaze thins smoothly into the clay toward the foot (glaze_fade; pointed drips read as
# icicles), long arms with jointed, long-fingered terracotta hands.

def build_fable():
    d = dict(hipY=0.84, hipW=0.105, thigh=0.375, shin=0.375, shoulderW=0.238, shoulderY=0.50, shoulderZ=0.0,
             upper=0.29, fore=0.275, palm=0.09, neckY=0.62)
    rig = Rig(**d)
    TC, CORE = "terracotta", "terracotta_dark"
    P = [(-0.1, 0.12, 0.085), (-0.092, 0.16, 0.115), (-0.055, 0.18, 0.13, 0.003), (0.0, 0.184, 0.134, 0.004), (0.07, 0.165, 0.122)]
    rig.add("pelvis", shell("pelvis", P, mat=TC, t=0.007, n=3.0, steps=10, segs=30, cap0=True))
    T = [(0.115, 0.135, 0.105), (0.16, 0.152, 0.118, 0.006), (0.26, 0.178, 0.138, 0.012), (0.36, 0.192, 0.15, 0.016), (0.45, 0.196, 0.15, 0.014),
         (0.52, 0.186, 0.142, 0.006), (0.56, 0.158, 0.122, -0.004), (0.585, 0.11, 0.09, -0.01), (0.598, 0.07, 0.065, -0.01)]
    chest = shell("chest", T, mat=TC, t=0.007, n=2.6, steps=18, segs=34)
    core = ceramic("core", loft([(-0.04, 0.13, 0.1), (0.07, 0.122, 0.094), (0.17, 0.13, 0.1)], segs=26, n=2.5), mat=CORE)
    # the framed panel: a recessed dark frame round a glazed tile whose cream glaze thins smoothly into
    # the red clay toward its foot (an ombre, as a dipped pot's glaze thins; no drips: pointed runs read
    # as icicles). The fade is a texture on the tile's front-projected UV (slot glaze_fade, materials.js).
    fr = panel("frame", T, 0.0, 0.6, 0.255, 0.495, CORE, grow=0.0012, t=0.003, sub=1, segs=18)
    gy0, gy1 = 0.265, 0.485
    glaze = panel("glaze", T, 0.0, 0.54, gy0, gy1, "glaze_fade", grow=0.0042, t=0.004, sub=1, segs=24, ny=12, uv=(-0.2, 0.2, gy0, gy1))
    # a smaller framed tile of the same glaze between the shoulder blades, so the storyteller's mark reads
    # from behind (at its console the wide shot sees its back); framed like the chest's, not a band
    # across the shoulders (a cream band on a red back would read as a coat's fur collar)
    by0, by1 = 0.308, 0.492
    bfr = panel("backframe", T, PI, 0.46, 0.3, 0.5, CORE, grow=0.0012, t=0.003, sub=1, segs=16)
    bglaze = panel("backglaze", T, PI, 0.41, by0, by1, "glaze_fade", grow=0.0042, t=0.004, sub=1, segs=20, ny=10, uv=(-0.2, 0.2, by0, by1))
    rig.add("torso", join([chest, core, fr, glaze, bfr, bglaze], "torso"))
    rig.add("neck", ceramic("neck", loft([(-0.06, 0.052, 0.05), (0.03, 0.048, 0.046), (0.07, 0.044, 0.042)], segs=20, n=2.2), mat=CORE))
    # the head: a smooth rounded acorn on a short visible neck, widest at the cheeks and tapering to a
    # round crown, one projector lens in a thin glazed bezel (an eye's size, not a goggle's), a small
    # glazed sensor disc each side; no lid, lip or slots (a box with a lid and vents read as a bin).
    # Its crown stays at the old knob's height, so info.height is unchanged.
    H = [(0.04, 0.0, 0.0), (0.046, 0.06, 0.064), (0.065, 0.094, 0.098, 0.004), (0.11, 0.106, 0.11, 0.006), (0.17, 0.104, 0.108, 0.005),
         (0.225, 0.094, 0.098, 0.003), (0.268, 0.076, 0.08, 0.001), (0.294, 0.05, 0.053), (0.306, 0.026, 0.028), (0.31, 0.0, 0.0)]
    HN = 2.35
    head = ceramic("headshell", loft(H, segs=40, n=HN, steps=26), mat=TC)
    ly, LR = 0.158, 0.029  # the lens centre (a little below the middle of the face) and its radius
    w_, d_, z0_, _ = surface_at(H, HN, ly)
    front = z0_ + d_
    bez = make("bezel", move(swap_yz(loft([(0.0, LR + 0.006, LR + 0.006), (0.016, LR + 0.009, LR + 0.009), (0.022, LR + 0.006, LR + 0.006), (0.025, LR + 0.001, LR + 0.001)],
                                          segs=40, n=2.0, cap0=False, cap1=False), dy=ly), dz=front - 0.014), "glaze")
    solidify(bez, 0.003)
    bake(bez)
    ears = [make(f"ear{s}", cyl(0.024, 0.012, segs=28, x=s * (w_ + 0.003), y=ly, z=0.006, axis="x"), "glaze", sharp=40) for s in (-1, 1)]
    for o in ears:
        bevel(o, 0.003, segs=2, angle=30)
    rig.add("head", join([head, bez] + ears, "head"))
    lens = swap_yz(loft([(0.0, 0.0, 0.0), (0.0, LR, LR), (0.004, LR - 0.001, LR - 0.001), (0.008, 0.0, 0.0)], segs=32, n=2.0), dy=ly)
    lens = move(lens, 0, 0, front + 0.002)
    rig.add("face", make("face", lens, "lens", uv=(-LR, LR, ly - LR, ly + LR)))
    c_arm(rig, 0.8, cap=0.9, bulk=0.92, shellmat=TC, coremat=CORE, capmat="glaze",
          hand_p=dict(palm=(0.024, d["palm"], 0.045), finger=0.0135, len=(0.05, 0.044), count=4, curl=0.22))
    c_leg(rig, 0.82, shellmat=TC, coremat=CORE, solemat=CORE, foot_l=0.92)
    return rig, dict(model="Fable 5.1", vendor="anthropic")


BUILDERS = {
    "opus-5.5": build_opus,
    "sonnet-5.5": build_sonnet,
    "fable-5.1": build_fable,
}


# ---- the OpenAI family: black glass, strict geometry ------------------------------------------------
# Polygon sections swept along the limb, then bevelled: sol's chamfers are wide and rounded (3
# segments), astra's are hairlines on hard planar facets. Satin-black hinge drums at the joints, the
# same construction as the ceramic family (caps, guards, cuffs), so neither family reads cheaper.

def g_loft(rows, sides=8, rot=None, n=2.0):
    """A polygon loft: `sides` flat faces around; rot=None puts a flat face at the front."""
    off = PI / sides if rot is None else rot
    return loft(rows, segs=sides, n=n, offset=off)


CUT = 0.013  # astra's chamfer: a flat 1.3 cm facet on every hard edge (a cut stone's, not a hairline)


def cut_bevel(o, w=CUT, angle=35, skip=None):
    """Chamfer the hard edges with flat facets and flag them in the UV (u = 1 on a chamfer, 0 on a
    face): the cut-glass material (slot glass_cut) gives the chamfers a polished edge highlight, so
    the hard planar body reads finished in the dark room. skip(edge) keeps an edge sharp."""
    me = o.data
    bm = bmesh.new()
    bm.from_mesh(me)
    edges = [e for e in bm.edges if e.is_manifold and e.calc_face_angle(0) > math.radians(angle) and not (skip and skip(e))]
    res = bmesh.ops.bevel(bm, geom=edges, offset=w, offset_type="OFFSET", segments=1, profile=0.5, affect="EDGES", clamp_overlap=True)
    new = set(res["faces"])
    layer = bm.loops.layers.uv.new("UVMap")
    for f in bm.faces:
        u = 1.0 if f in new else 0.0
        for l in f.loops:
            l[layer].uv = (u, 0.0)
    bm.to_mesh(me)
    bm.free()
    me.shade_smooth()
    me.set_sharp_from_angle(angle=math.radians(10))
    return o


def glass(name, vf, style, mat="glass", skip=None):
    if style == "sol":
        o = make(name, vf, mat, sharp=1)
        bevel(o, 0.016, segs=3, angle=20)
        bake(o)
        o.data.shade_smooth()
        o.data.set_sharp_from_angle(angle=math.radians(28))
        return o
    return cut_bevel(make(name, vf, "glass_cut", sharp=1), skip=skip)


def g_drum(r, w, y=0.0, style="sol"):
    o = drum(r, w, y=y, mat="satin", segs=24 if style == "sol" else 8)
    return o


def g_arm(rig, style, k=1.0):
    d = rig.d
    up, fo = d["upper"], d["fore"]
    S = 8 if style == "sol" else 6
    rot = None if style == "sol" else 0.0
    if style == "sol":
        CAP = [(-0.09 * k, 0.098 * k, 0.092 * k), (-0.02, 0.112 * k, 0.104 * k), (0.05 * k, 0.104 * k, 0.098 * k), (0.085 * k, 0.07 * k, 0.07 * k), (0.096 * k, 0.0, 0.0)]
    else:  # a pointed pauldron: the outer facet rises to a ridge
        CAP = [(-0.1 * k, 0.094 * k, 0.088 * k), (-0.03, 0.118 * k, 0.1 * k), (0.045 * k, 0.11 * k, 0.094 * k), (0.092 * k, 0.05 * k, 0.06 * k), (0.104 * k, 0.0, 0.0)]
    cap = glass("cap", move(g_loft(CAP, S, rot), 0.006 * k, 0, 0), style)
    arm = glass("arm", g_loft([(-up + 0.03 * k, 0.056 * k, 0.054 * k), (-up * 0.5, 0.062 * k, 0.058 * k), (-0.06, 0.064 * k, 0.06 * k)], S, rot), style)
    elbow = g_drum(0.05 * k, 0.096 * k, y=-up, style=style)
    rig.add("upper_L", join([cap, arm, elbow], "upper_L"))
    F = [(-fo - 0.004, 0.064 * k, 0.06 * k), (-fo + 0.03 * k, 0.07 * k, 0.066 * k), (-fo * 0.55, 0.082 * k, 0.078 * k, 0.002),
         (-0.06 * k, 0.088 * k, 0.084 * k, -0.006 * k), (0.0, 0.08 * k, 0.07 * k, -0.03 * k), (0.045 * k, 0.05 * k, 0.04 * k, -0.05 * k)]
    rig.add("fore_L", glass("fore_L", g_loft(F, S, rot), style))
    palm, fingers = hand("hand_L", dict(palm=(0.028 * k, d["palm"], 0.05 * k), finger=0.0158 * k, len=(0.048, 0.04), count=4, curl=0.35,
                                         style="chamfer" if style == "sol" else "facet", mat="satin"))
    rig.add("hand_L", palm)
    rig.add("fingers_L", fingers)


def g_leg(rig, style, k=1.0):
    d = rig.d
    th, sh = d["thigh"], d["shin"]
    S = 8 if style == "sol" else 6
    rot = None if style == "sol" else 0.0
    TH = [(-th + 0.045 * k, 0.07 * k, 0.074 * k), (-th * 0.5, 0.096 * k, 0.102 * k, 0.004), (-0.03, 0.11 * k, 0.114 * k), (0.06 * k, 0.07 * k, 0.07 * k)]
    thigh = glass("thigh", g_loft(TH, S, rot), style)
    knee = g_drum(0.056 * k, 0.11 * k, y=-th, style=style)
    rig.add("thigh_L", join([thigh, knee], "thigh_L"))
    SH = [(-sh + 0.004, 0.082 * k, 0.086 * k, 0.004), (-sh + 0.05 * k, 0.078 * k, 0.08 * k), (-sh * 0.62, 0.088 * k, 0.092 * k, -0.004 * k),
          (-sh * 0.28, 0.1 * k, 0.106 * k, -0.006 * k), (-0.02, 0.096 * k, 0.09 * k, 0.012 * k), (0.04 * k, 0.07 * k, 0.05 * k, 0.04 * k),
          (0.07 * k, 0.04 * k, 0.026 * k, 0.05 * k)]
    rig.add("shin_L", glass("shin_L", g_loft(SH, S, rot), style))
    ah = d["hipY"] - th - sh
    FT = [(-0.1, 0.062 * k, 0.036), (-0.08, 0.08 * k, 0.05), (0.06, 0.084 * k, 0.05, 0.002), (0.16, 0.072 * k, 0.034, 0.01), (0.205, 0.05 * k, 0.02, 0.014)]
    foot = glass("foot", swap_yz(g_loft(FT, S, rot), dy=-ah + 0.052), style)
    sole = make("sole", swap_yz(loft([(-0.1, 0.064 * k, 0.009), (0.0, 0.086 * k, 0.009), (0.18, 0.07 * k, 0.009), (0.205, 0.05 * k, 0.009)], segs=S, n=2.0,
                                     offset=PI / S if rot is None else 0.0), dy=-ah + 0.009), "satin", sharp=30)
    ankle = g_drum(0.045 * k, 0.09 * k, y=0.0, style=style)
    rig.add("foot_L", join([foot, sole, ankle], "foot_L"))


def poly_head(rows, sides, off, y0, y1, arc, depth, eps=0.0045):
    """A polygon head with a visor recessed into its front: rows are inserted at the visor's edges and the
    vertices within `arc` of the front pushed in by `depth` between them. Returns (head_vf, visor_vf)
    sharing one vertex list (the visor = the recessed front faces)."""
    def interp(y):
        for a, b in zip(rows, rows[1:]):
            if a[0] <= y <= b[0]:
                t = (y - a[0]) / (b[0] - a[0])
                a4, b4 = list(a) + [0.0] * (4 - len(a)), list(b) + [0.0] * (4 - len(b))
                return [y] + [a4[k] + (b4[k] - a4[k]) * t for k in (1, 2, 3)]
        raise ValueError(y)
    R = [(list(r) + [0.0] * (4 - len(r)), False) for r in rows if not (y0 - eps <= r[0] <= y1 + eps)]
    R += [(interp(y0 - eps), False), (interp(y0), True), (interp(y1), True), (interp(y1 + eps), False)]
    R.sort(key=lambda e: e[0][0])
    verts, faces, visor = [], [], []
    angs = [-PI + off + 2 * PI * j / sides for j in range(sides)]
    def wrapa(a):
        return (a + PI) % (2 * PI) - PI
    inarc = [abs(wrapa(a)) <= arc for a in angs]
    for (y, w, d, z0), rec in R:
        for j, th in enumerate(angs):
            x, z = sec(w, d, z0, 2.0, th)
            if rec and inarc[j]:
                L = math.hypot(x, z - z0)
                k = (L - depth) / L
                x, z = x * k, z0 + (z - z0) * k
            verts.append((x, y, z))
    M = sides
    for i in range(len(R) - 1):
        for j in range(M):
            j2 = (j + 1) % M
            q = (i * M + j, i * M + j2, (i + 1) * M + j2, (i + 1) * M + j)
            if R[i][1] and R[i + 1][1] and inarc[j] and inarc[j2]:
                visor.append(q)
            else:
                faces.append(q)
    for row, ring in ((R[0][0], 0), (R[-1][0], len(R) - 1)):
        c = len(verts)
        verts.append((0.0, row[0], row[3]))
        for j in range(M):
            faces.append((ring * M + j, ring * M + (j + 1) % M, c))
    return (verts, faces), (verts, visor)


def build_gpt(style):
    sol = style == "sol"
    if sol:
        d = dict(hipY=0.88, hipW=0.112, thigh=0.39, shin=0.395, shoulderW=0.262, shoulderY=0.535, shoulderZ=0.0,
                 upper=0.29, fore=0.28, palm=0.09, neckY=0.62)
    else:
        d = dict(hipY=0.915, hipW=0.11, thigh=0.41, shin=0.415, shoulderW=0.262, shoulderY=0.56, shoulderZ=0.0,
                 upper=0.305, fore=0.29, palm=0.09, neckY=0.645)
    rig = Rig(**d)
    S = 8 if sol else 6
    rot = None if sol else 0.0
    P = [(-0.105, 0.13, 0.095), (-0.09, 0.18, 0.13), (-0.02, 0.198, 0.142), (0.06, 0.19, 0.138), (0.09, 0.16, 0.118)]
    rig.add("pelvis", glass("pelvis", g_loft(P, S, rot), style))
    if sol:
        T = [(0.11, 0.13, 0.1), (0.17, 0.155, 0.115, 0.004), (0.3, 0.2, 0.138, 0.012), (0.44, 0.236, 0.152, 0.016), (0.53, 0.238, 0.148, 0.01),
             (0.585, 0.2, 0.128, 0.0), (0.605, 0.12, 0.09, -0.006)]
    else:  # a cut stone: a keel down the chest, the facets break at the ribs and the collar
        T = [(0.11, 0.12, 0.1), (0.18, 0.15, 0.125, 0.006), (0.3, 0.188, 0.15, 0.014), (0.42, 0.232, 0.17, 0.02), (0.5, 0.244, 0.165, 0.016),
             (0.565, 0.226, 0.15, 0.006), (0.615, 0.17, 0.11, -0.004), (0.632, 0.1, 0.075, -0.008)]
    chest = glass("chest", g_loft(T, S, rot), style)
    core = make("core", loft([(-0.04, 0.12, 0.09), (0.07, 0.112, 0.086), (0.16, 0.12, 0.09)], segs=24 if sol else 8, n=2.0), "satin", sharp=30)
    # the back: a recessed satin spine plate between two glass blades (reads from behind)
    # the back: a satin spine plate on the back face (sol) or the back ridge (astra), a status light on it in
    # the visor's colour (it reads from behind, where the wide shot sees the Judges)
    def back_z(y):
        for a, b in zip(T, T[1:]):
            if a[0] <= y <= b[0]:
                u = (y - a[0]) / (b[0] - a[0])
                dd = a[2] + (b[2] - a[2]) * u
                zz = (a[3] if len(a) > 3 else 0) + ((b[3] if len(b) > 3 else 0) - (a[3] if len(a) > 3 else 0)) * u
                return zz - dd * (math.cos(PI / 8) if sol else 1.0)
    zb = back_z(0.4)
    spine = make("spine", box(0.032, 0.16, 0.008, y=0.4, z=zb + 0.002), "satin", sharp=30)
    bevel(spine, 0.004, segs=2, angle=30)
    status = make("status", box(0.0075, 0.075, 0.003, y=0.43, z=zb - 0.0065), "status", sharp=30)
    rig.add("torso", join([chest, core, spine, status], "torso"))
    rig.add("neck", make("neck", loft([(-0.07, 0.05, 0.05), (0.03, 0.046, 0.046), (0.08, 0.042, 0.042)], segs=24 if sol else 6, n=2.0), "satin", sharp=30))
    if sol:
        H = [(0.02, 0.085, 0.09), (0.05, 0.112, 0.122), (0.22, 0.118, 0.128, 0.004), (0.29, 0.104, 0.112), (0.315, 0.07, 0.08)]
        hv, vv = poly_head(H, 8, PI / 8, 0.138, 0.188, 3 * PI / 8 + 0.01, 0.011)
        uvb = (-0.11, 0.11, 0.138, 0.188)
    else:  # a gem: a ridge down the face, a keel over the crown; the visor a thin V across both front faces
        H = [(0.02, 0.07, 0.08, 0.004), (0.06, 0.104, 0.122, 0.01), (0.2, 0.108, 0.128, 0.012), (0.26, 0.098, 0.112, 0.006), (0.3, 0.06, 0.07), (0.325, 0.016, 0.03)]
        hv, vv = poly_head(H, 6, 0.0, 0.154, 0.19, PI / 3 + 0.01, 0.01)
        uvb = (-0.095, 0.095, 0.154, 0.19)
    vis_y = (0.154, 0.19) if not sol else (0.138, 0.188)
    near_visor = lambda e: all(vis_y[0] - 0.012 < v.co.z < vis_y[1] + 0.012 for v in e.verts)  # Blender z = the Stage's y
    rig.add("head", glass("headshell", hv, style, skip=near_visor))
    vis = make("face", vv, "visor", uv=uvb, sharp=1)
    rig.add("face", vis)
    g_arm(rig, style, 1.0)
    g_leg(rig, style, 1.0)
    return rig, dict(model="GPT 6.1 sol" if sol else "GPT 6 astra", vendor="openai")


# ---- the Host: the mine's own machine ---------------------------------------------------------------
# A dispatcher on two wheels: graphite powder-coat with a safety-amber hard hat and hi-vis bands on the
# body (the mine's uniform, neither vendor's material), a cap lamp on the hat that is its face light,
# a speaker grille for a chest, two small dark camera eyes under the brim. It rolls, it does not walk.

def build_host():
    d = dict(hipY=0.56, shoulderW=0.215, shoulderY=0.47, shoulderZ=0.0, upper=0.22, fore=0.2, palm=0.07, neckY=0.575)
    rig = Rig(**d)
    BODY, AMB, REF, RUB, MET = "host_body", "host_amber", "host_reflect", "host_rubber", "host_metal"
    parts = []
    for s in (-1, 1):
        tyre = make("tyre", cyl(0.16, 0.07, segs=40, x=s * 0.215, y=0.16, axis="x"), RUB, sharp=40)
        bevel(tyre, 0.02, segs=3, angle=30)
        hub = make("hub", cyl(0.09, 0.076, segs=32, x=s * 0.215, y=0.16, axis="x"), MET, sharp=40)
        parts += [tyre, hub]
    pod = make("pod", loft([(0.06, 0.08, 0.1), (0.1, 0.15, 0.13), (0.26, 0.15, 0.13), (0.4, 0.12, 0.1), (0.47, 0.09, 0.08)], segs=32, n=3.2, steps=10), BODY)
    axle = make("axle", cyl(0.035, 0.36, segs=20, y=0.16, axis="x"), MET, sharp=40)
    parts += [pod, axle]
    rig.add("base", join(parts, "base"))
    T = [(-0.1, 0.12, 0.1), (-0.06, 0.15, 0.115), (0.1, 0.168, 0.124, 0.004), (0.3, 0.205, 0.14, 0.008), (0.42, 0.205, 0.138, 0.004), (0.5, 0.15, 0.104), (0.53, 0.07, 0.06)]
    body = make("body", loft(T, segs=36, n=3.2, steps=16), BODY)
    bands = []
    for y in (0.3,):
        bands.append(panel("band", T, 0.0, PI, y - 0.065, y + 0.065, AMB, grow=0.003, t=0.004, segs=48, ny=5, sub=0))
        bands.append(panel("strip", T, 0.0, PI, y - 0.012, y + 0.012, REF, grow=0.0055, t=0.003, segs=48, ny=2, sub=0))
    grille = panel("grille", T, 0.0, 0.5, 0.07, 0.19, "core", grow=0.0045, t=0.004, segs=16, ny=6, sub=1)
    ribs = [panel(f"rib{i}", T, 0.0, 0.46, 0.08 + i * 0.018, 0.087 + i * 0.018, BODY, grow=0.0062, t=0.003, segs=16, ny=1, sub=0) for i in range(6)]
    rig.add("torso", join([body, grille] + bands + ribs, "torso"))
    rig.add("neck", make("neck", loft([(-0.06, 0.045, 0.045), (0.04, 0.04, 0.04)], segs=20, n=2.0), MET, sharp=40))
    # the head: a face box under a hard hat with a brim and a cap lamp
    face = make("facebox", loft([(0.02, 0.1, 0.09), (0.05, 0.13, 0.115, 0.004), (0.15, 0.135, 0.12, 0.008), (0.19, 0.13, 0.115, 0.008)], segs=32, n=3.0, steps=8), BODY)
    hat = make("hat", loft([(0.165, 0.0, 0.0), (0.165, 0.175, 0.17, 0.02), (0.18, 0.18, 0.175, 0.022), (0.19, 0.15, 0.15, 0.012), (0.24, 0.145, 0.142, 0.006),
                            (0.28, 0.12, 0.118), (0.3, 0.07, 0.07), (0.308, 0.0, 0.0)], segs=40, n=2.3, steps=16), AMB)
    ridge = make("ridge", loft([(0.19, 0.022, 0.15), (0.3, 0.022, 0.08), (0.31, 0.0, 0.0)], segs=12, n=4.0), AMB)
    eyes = []
    for s in (-1, 1):
        rim = make("eyerim", swap_yz(loft([(0.0, 0.03, 0.03), (0.02, 0.03, 0.03), (0.024, 0.024, 0.024)], segs=24, n=2.0, cap0=False, cap1=False), dy=0.105), MET)
        lens = make("eye", swap_yz(loft([(0.0, 0.024, 0.024), (0.008, 0.024, 0.024), (0.014, 0.0, 0.0)], segs=24, n=2.0), dy=0.105), "visor")
        for o in (rim, lens):
            for v in o.data.vertices:
                v.co.x += s * 0.055
                v.co.y -= 0.118
        solidify(rim, 0.003)
        eyes += [rim, lens]
    housing = make("lamphouse", swap_yz(loft([(0.0, 0.045, 0.04), (0.035, 0.048, 0.042), (0.045, 0.044, 0.038)], segs=28, n=2.4), dy=0.215), BODY)
    for v in housing.data.vertices:
        v.co.y -= 0.15
    rig.add("head", join([face, hat, ridge, housing] + eyes, "head"))
    lamp = make("face", move(swap_yz(loft([(0.0, 0.0, 0.0), (0.0, 0.04, 0.034), (0.004, 0.04, 0.034), (0.006, 0.0, 0.0)], segs=28, n=2.4), dy=0.215), dz=0.15 + 0.045),
                "lens", uv=(-0.04, 0.04, 0.215 - 0.034, 0.215 + 0.034))
    rig.add("face", lamp)
    k = 0.72
    CAP = [(-0.07, 0.07, 0.068), (0.0, 0.082, 0.08), (0.05, 0.07, 0.07), (0.072, 0.0, 0.0)]
    cap = make("cap", loft(CAP, segs=28, n=2.6, steps=8, cap0=True), AMB)
    arm = make("arm", loft([(-d["upper"] + 0.02, 0.04, 0.04), (-0.05, 0.046, 0.046)], segs=20, n=2.6), BODY)
    elbow = drum(0.042, 0.075, y=-d["upper"], mat=MET)
    rig.add("upper_L", join([cap, arm, elbow], "upper_L"))
    rig.add("fore_L", make("fore_L", loft([(-d["fore"], 0.044, 0.042), (-d["fore"] * 0.5, 0.052, 0.05), (0.0, 0.046, 0.04, -0.012), (0.03, 0.02, 0.02, -0.03)],
                                        segs=24, n=2.8, steps=8, cap0=True), BODY))
    # the same jointed mechanical hand as the Anthropic Judges (c_hand), in the Host's graphite: a smooth
    # three-finger hand at the end of a sleeve-like forearm read as a work glove up close
    palm, fingers = c_hand("hand_L", dict(palm=(0.024, d["palm"], 0.042), finger=0.014, len=(0.04, 0.034), count=3, curl=0.4, mat=BODY))
    rig.add("hand_L", palm)
    rig.add("fingers_L", fingers)
    return rig, dict(model="Ведущий", vendor="house")


BUILDERS.update({
    "gpt-6.1-sol": lambda: build_gpt("sol"),
    "gpt-6-astra": lambda: build_gpt("astra"),
    "host": build_host,
})


# ---- review renders ------------------------------------------------------------------------------

def review(rid, outdir):
    sc = bpy.context.scene
    sc.render.engine = "BLENDER_EEVEE"
    sc.render.resolution_x, sc.render.resolution_y = 600, 900
    sc.render.film_transparent = False
    world = bpy.data.worlds.new("w") if not sc.world else sc.world
    sc.world = world
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs[0].default_value = (0.18, 0.18, 0.19, 1)
    world.node_tree.nodes["Background"].inputs[1].default_value = 0.6
    for name, loc, energy, size in (("key", (2.5, -3.0, 3.2), 900, 2.0), ("rim", (-2.0, 3.0, 2.6), 600, 1.5), ("fill", (-3, -2, 1.0), 200, 3)):
        L = bpy.data.lights.new(name, "AREA")
        L.energy, L.size = energy, size
        lo = bpy.data.objects.new(name, L)
        sc.collection.objects.link(lo)
        lo.location = loc
        lo.rotation_euler = (Vector((0, 0, 1.0)) - Vector(loc)).to_track_quat("-Z", "Y").to_euler()
    cam = bpy.data.cameras.new("cam")
    cam.type = "ORTHO"
    cam.ortho_scale = 2.2
    co = bpy.data.objects.new("cam", cam)
    sc.collection.objects.link(co)
    sc.camera = co
    for tag, ang in (("front", 0), ("34", 40), ("side", 90), ("back", 180)):
        a = math.radians(ang)
        pos = Vector((math.sin(a) * 6, -math.cos(a) * 6, 1.0))
        co.location = pos
        co.rotation_euler = (Vector((0, 0, 1.0)) - pos).to_track_quat("-Z", "Y").to_euler()
        sc.render.filepath = os.path.join(outdir, f"{rid}-{tag}.png")
        bpy.ops.render.render(write_still=True)


def main():
    only = arg("--only")
    ids = only.split(",") if only else list(BUILDERS)
    rev = arg("--review")
    for rid in ids:
        bpy.ops.wm.read_factory_settings(use_empty=True)
        rig, info = BUILDERS[rid]()
        finish(rid, rig, info)
        if rev:
            os.makedirs(rev, exist_ok=True)
            review(rid, rev)


main()
