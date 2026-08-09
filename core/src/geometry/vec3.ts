/** Minimal 3D vector maths, used only by the folded (3D) view. */

export interface Vec3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export function v3(x: number, y: number, z: number): Vec3 {
  return { x, y, z };
}

export function add3(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

export function sub3(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

export function scale3(a: Vec3, k: number): Vec3 {
  return { x: a.x * k, y: a.y * k, z: a.z * k };
}

export function dot3(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

export function cross3(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

export function length3(a: Vec3): number {
  return Math.hypot(a.x, a.y, a.z);
}

export function normalize3(a: Vec3): Vec3 {
  const l = length3(a);
  if (l === 0) throw new Error('cannot normalize a zero-length vector');
  return { x: a.x / l, y: a.y / l, z: a.z / l };
}

/** Rotate `v` about unit axis `axis` by `radians` (right-hand rule). */
export function rotateAbout(v: Vec3, axis: Vec3, radians: number): Vec3 {
  const c = Math.cos(radians);
  const s = Math.sin(radians);
  const k = dot3(axis, v) * (1 - c);
  const cr = cross3(axis, v);
  return {
    x: v.x * c + cr.x * s + axis.x * k,
    y: v.y * c + cr.y * s + axis.y * k,
    z: v.z * c + cr.z * s + axis.z * k,
  };
}
