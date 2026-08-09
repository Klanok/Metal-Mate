import { TOL } from '../units.js';

/** A point or vector in a 2D plane, in mm. */
export interface Vec2 {
  readonly x: number;
  readonly y: number;
}

export function v2(x: number, y: number): Vec2 {
  return { x, y };
}

export function add(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x + b.x, y: a.y + b.y };
}

export function sub(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x - b.x, y: a.y - b.y };
}

export function scale(a: Vec2, k: number): Vec2 {
  return { x: a.x * k, y: a.y * k };
}

export function dot(a: Vec2, b: Vec2): number {
  return a.x * b.x + a.y * b.y;
}

/** 2D cross product (z of the 3D cross). Positive when b is left of a. */
export function cross(a: Vec2, b: Vec2): number {
  return a.x * b.y - a.y * b.x;
}

export function length(a: Vec2): number {
  return Math.hypot(a.x, a.y);
}

export function distance(a: Vec2, b: Vec2): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

export function normalize(a: Vec2): Vec2 {
  const l = length(a);
  if (l < TOL) throw new Error('cannot normalize a zero-length vector');
  return { x: a.x / l, y: a.y / l };
}

/** Left-hand normal: rotate 90° counter-clockwise. */
export function leftNormal(a: Vec2): Vec2 {
  return { x: -a.y, y: a.x };
}

/** Right-hand normal: rotate 90° clockwise. */
export function rightNormal(a: Vec2): Vec2 {
  return { x: a.y, y: -a.x };
}

export function lerp(a: Vec2, b: Vec2, t: number): Vec2 {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

export function equals(a: Vec2, b: Vec2, tol: number = TOL): boolean {
  return Math.abs(a.x - b.x) <= tol && Math.abs(a.y - b.y) <= tol;
}

export function rotate(a: Vec2, radians: number): Vec2 {
  const c = Math.cos(radians);
  const s = Math.sin(radians);
  return { x: a.x * c - a.y * s, y: a.x * s + a.y * c };
}

/** Axis-aligned bounding box, in mm. */
export interface Box2 {
  readonly min: Vec2;
  readonly max: Vec2;
}

export function boxOf(points: readonly Vec2[]): Box2 {
  if (points.length === 0) throw new Error('boxOf: no points');
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { min: { x: minX, y: minY }, max: { x: maxX, y: maxY } };
}

export function boxUnion(a: Box2, b: Box2): Box2 {
  return {
    min: { x: Math.min(a.min.x, b.min.x), y: Math.min(a.min.y, b.min.y) },
    max: { x: Math.max(a.max.x, b.max.x), y: Math.max(a.max.y, b.max.y) },
  };
}

export function boxWidth(b: Box2): number {
  return b.max.x - b.min.x;
}

export function boxHeight(b: Box2): number {
  return b.max.y - b.min.y;
}
