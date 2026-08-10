/**
 * Flat pattern -> SVG.
 *
 * Arcs become SVG `A` commands rather than polylines, for the same reason they
 * become bulges in the DXF: what the user checks on screen should be the same
 * geometry the laser gets. If a sink radius ever looks faceted here, something
 * upstream has linearised it and the preview is the place that shows it.
 *
 * Path data stays in model coordinates (millimetres, y up). The component
 * flips y with a transform, so nothing here has to think about screen space.
 */

import type { FlatPattern, Loop, Vec2 } from '@metal-mate/core';
import { angleForBulge, segments } from '@metal-mate/core';

export interface FlatBendLineView {
  readonly bendId: string;
  readonly direction: 'up' | 'down';
  readonly angleDeg: number;
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
  readonly label: string;
}

export interface FlatPatternView {
  readonly outerPath: string;
  readonly innerPaths: readonly string[];
  readonly bendLines: readonly FlatBendLineView[];
  /** Model-space box, before the y flip. */
  readonly box: { x: number; y: number; width: number; height: number };
  readonly widthMm: number;
  readonly heightMm: number;
}

function num(v: number): string {
  // Six decimals is far finer than any display need and keeps the DOM small.
  return (Math.round(v * 1e6) / 1e6).toString();
}

/**
 * One closed loop as an SVG path.
 *
 * The arc flags are resolved in the path's own user space, which is still
 * y-up here: a positive included angle is counter-clockwise, so sweep-flag 1.
 */
export function loopToPath(loop: Loop): string {
  const parts: string[] = [];
  const last = loop.verts.length - 1;
  let first = true;
  for (const { p0, p1, bulge, index } of segments(loop)) {
    if (first) {
      parts.push(`M ${num(p0.x)} ${num(p0.y)}`);
      first = false;
    }
    if (bulge === 0) {
      // The closing segment of a straight-edged loop is what `Z` draws, so
      // emitting it as well would double the line.
      if (index !== last) parts.push(`L ${num(p1.x)} ${num(p1.y)}`);
      continue;
    }
    const theta = angleForBulge(bulge);
    const chord = Math.hypot(p1.x - p0.x, p1.y - p0.y);
    const radius = Math.abs(chord / (2 * Math.sin(theta / 2)));
    const largeArc = Math.abs(theta) > Math.PI ? 1 : 0;
    const sweep = theta > 0 ? 1 : 0;
    parts.push(`A ${num(radius)} ${num(radius)} 0 ${largeArc} ${sweep} ${num(p1.x)} ${num(p1.y)}`);
  }
  parts.push('Z');
  return parts.join(' ');
}

export function flatPatternView(flat: FlatPattern): FlatPatternView {
  const widthMm = flat.bounds.max.x - flat.bounds.min.x;
  const heightMm = flat.bounds.max.y - flat.bounds.min.y;
  return {
    outerPath: loopToPath(flat.profile.outer),
    innerPaths: flat.profile.inners.map(loopToPath),
    bendLines: flat.bendLines.map((b) => ({
      bendId: String(b.bendId),
      direction: b.direction,
      angleDeg: b.angleDeg,
      x1: b.centreline[0].x,
      y1: b.centreline[0].y,
      x2: b.centreline[1].x,
      y2: b.centreline[1].y,
      label: `${b.angleDeg.toFixed(0)}° ${b.direction} R${b.insideRadius.toFixed(1)}`,
    })),
    box: {
      x: flat.bounds.min.x,
      y: flat.bounds.min.y,
      width: widthMm,
      height: heightMm,
    },
    widthMm,
    heightMm,
  };
}

/** Midpoint of a bend line, for placing its label. */
export function bendLabelAnchor(line: FlatBendLineView): Vec2 {
  return { x: (line.x1 + line.x2) / 2, y: (line.y1 + line.y2) / 2 };
}
