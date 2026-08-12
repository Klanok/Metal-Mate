/**
 * The canopy's body, as eight corners and six planes.
 *
 * The skeleton canopy was six rectangles, and every number in it — panel size,
 * mate angle, lip mitre — was a special case of "everything is square". Nothing
 * in that survives a taper, so rather than thread angles through the special
 * cases this module states the body once, geometrically, and lets the template
 * read the answers off it.
 *
 * The body is six planes:
 *
 *  - the floor, flat at z = 0;
 *  - the roof, which may fall from the front of the canopy to the rear;
 *  - four walls, each of which may lean inward at the top by its own angle.
 *
 * A corner is where three of them meet, and there are eight. Every panel is the
 * quadrilateral through the four corners on its own plane, every dihedral is the
 * angle between two planes, and every mitre is half a corner. Square is just the
 * case where all the angles happen to be zero — it falls out rather than being
 * built in, which is what makes it safe to add tapers without breaking it.
 *
 * All planes carry their **inward** normal, so "which side is the metal on" is
 * never a guess. Outside dimensions go in; the planes offset half a thickness
 * inward to the neutral surfaces the panels are actually cut to.
 */

import {
  type Vec3,
  add3,
  cross3,
  dot3,
  normalize3,
  scale3,
  sub3,
  v3,
} from '../geometry/vec3.js';
import { type Vec2, v2 } from '../geometry/vec2.js';
import { toDegrees } from '../units.js';

/** Which panel of the body. */
export type CanopyPanel = 'floor' | 'roof' | 'front' | 'rear' | 'left' | 'right';

/** Every panel, in the order the template builds them. */
export const PANEL_ORDER = ['floor', 'front', 'rear', 'left', 'right', 'roof'] as const;

/** The four walls, in the order the template builds them. */
export const CANOPY_WALLS = ['front', 'rear', 'left', 'right'] as const;
export type CanopyWall = (typeof CANOPY_WALLS)[number];

export type BoxEnd = 'front' | 'rear';
export type BoxSide = 'left' | 'right';
export type BoxLevel = 'bottom' | 'top';

/** One of the eight corners, named by the three planes that make it. */
export type CornerKey = `${BoxEnd}-${BoxSide}-${BoxLevel}`;

export function cornerKey(end: BoxEnd, side: BoxSide, level: BoxLevel): CornerKey {
  return `${end}-${side}-${level}`;
}

/**
 * How much each wall leans **inward** at the top, degrees.
 *
 * Zero is vertical. Positive brings the top of the wall in over the floor, the
 * way a canopy is usually drawn; negative flares it out. Each wall is separate,
 * so a body can lean on one side only.
 */
export interface CanopyTaper {
  readonly frontDeg?: number;
  readonly rearDeg?: number;
  readonly leftDeg?: number;
  readonly rightDeg?: number;
}

export interface CanopyBodyParams {
  /** Outside length of the **footprint**, front to rear. */
  readonly lengthMm: number;
  /** Outside width of the footprint, side to side. */
  readonly widthMm: number;
  /** Outside height at the front. */
  readonly heightMm: number;
  readonly thicknessMm: number;
  /** How much lower the roof sits at the rear than at the front, mm. */
  readonly roofDropMm?: number;
  readonly taperDeg?: CanopyTaper;
}

/** A plane, as the set of points where `dot(n, p) = d`. `n` points inward. */
export interface Plane {
  readonly n: Vec3;
  readonly d: number;
}

export class CanopyBodyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CanopyBodyError';
  }
}

/** The largest lean the body model will take, degrees. */
export const MAX_TAPER_DEG = 45;

/**
 * The body's neutral-surface geometry.
 *
 * `corners` are on the neutral surfaces, which is where the panels are cut to;
 * `outside` are the corners of the metal's outer skin, which is what a tape
 * measure reads. Both come from the same six planes half a thickness apart, so
 * they can never drift out of step.
 */
export interface CanopyBody {
  readonly params: CanopyBodyParams;
  /** Neutral plane of each panel, inward normal. */
  readonly planes: Readonly<Record<CanopyPanel, Plane>>;
  /** Neutral-surface corners. */
  readonly corners: ReadonlyMap<CornerKey, Vec3>;
  /** Outside-skin corners, for reporting the sizes somebody would measure. */
  readonly outside: ReadonlyMap<CornerKey, Vec3>;
}

/** Outward normal of a panel — the direction its metal faces. */
export function outwardNormal(body: CanopyBody, panel: CanopyPanel): Vec3 {
  return scale3(body.planes[panel].n, -1);
}

/** A body's corner, by name. */
export function corner(body: CanopyBody, key: CornerKey): Vec3 {
  const p = body.corners.get(key);
  if (p === undefined) throw new CanopyBodyError(`no corner ${key}`);
  return p;
}

/**
 * Build the body.
 *
 * The floor is the datum: its outside face is z = 0 and the footprint is the
 * length and width asked for, so a canopy that leans in loses width at the roof
 * rather than gaining it at the tray, which is the way it is measured on the
 * job.
 */
export function canopyBody(params: CanopyBodyParams): CanopyBody {
  const { lengthMm: L, widthMm: W, heightMm: H, thicknessMm: t } = params;
  if (!(t > 0)) throw new CanopyBodyError('thickness must be positive');
  if (!(L > 0 && W > 0 && H > 0)) {
    throw new CanopyBodyError('length, width and height must all be positive');
  }
  if (L <= t || W <= t || H <= t) {
    throw new CanopyBodyError(
      `a ${L} x ${W} x ${H} mm canopy has nothing left once ${t} mm of thickness comes off each dimension`,
    );
  }
  const drop = params.roofDropMm ?? 0;
  if (drop < 0) {
    throw new CanopyBodyError('roof drop is how much lower the rear is, so it cannot be negative');
  }
  if (drop >= H) {
    throw new CanopyBodyError(
      `a ${drop} mm roof drop on a ${H} mm canopy leaves nothing standing at the rear`,
    );
  }

  const lean = {
    front: params.taperDeg?.frontDeg ?? 0,
    rear: params.taperDeg?.rearDeg ?? 0,
    left: params.taperDeg?.leftDeg ?? 0,
    right: params.taperDeg?.rightDeg ?? 0,
  };
  for (const [wall, deg] of Object.entries(lean)) {
    if (!Number.isFinite(deg) || Math.abs(deg) > MAX_TAPER_DEG) {
      throw new CanopyBodyError(
        `the ${wall} wall leans ${deg} degrees; past ${MAX_TAPER_DEG} it stops being a wall`,
      );
    }
  }

  // Outside planes, inward normals. A wall leaning in by `a` at the top runs
  // its trace inward as z rises, hence the -tan(a) on the z component.
  const outsidePlanes: Record<CanopyPanel, Plane> = {
    floor: plane(v3(0, 0, 1), 0),
    // The roof falls with y, so its height depends on where along the canopy
    // you stand: z + (drop/L) y = H.
    roof: plane(v3(0, -drop / L, -1), -H),
    left: plane(v3(1, 0, -tan(lean.left)), 0),
    right: plane(v3(-1, 0, -tan(lean.right)), -W),
    front: plane(v3(0, 1, -tan(lean.front)), 0),
    rear: plane(v3(0, -1, -tan(lean.rear)), -L),
  };

  // Neutral planes: the same planes, half a thickness in. Every panel sits on
  // its own neutral surface, so the six of them are the box the panels are cut
  // to — the taper-general form of "one thickness off each dimension".
  const planes = mapPanels(outsidePlanes, (p) => offsetInward(p, t / 2));

  const corners = cornersOf(planes);
  const outside = cornersOf(outsidePlanes);

  // Tapers steep enough to run one wall past another still produce eight
  // corners — they are just no longer the corners of a solid. Every corner has
  // to sit on the inward side of the three planes it is not on, or the body has
  // closed over itself and every angle downstream would be quietly wrong rather
  // than loudly.
  for (const [key, at] of corners) {
    const own = key.split('-');
    for (const panel of PANEL_ORDER) {
      if (own.includes(PANEL_FIXES[panel])) continue;
      if (distanceInto(planes[panel], at) <= 0) {
        throw new CanopyBodyError(
          `the ${key.replace(/-/g, ' ')} corner falls outside the ${panel}: the tapers have closed the body over`,
        );
      }
    }
  }

  return { params, planes, corners, outside };
}

function cornersOf(planes: Readonly<Record<CanopyPanel, Plane>>): Map<CornerKey, Vec3> {
  const out = new Map<CornerKey, Vec3>();
  for (const [end, side] of ends()) {
    for (const level of ['bottom', 'top'] as const) {
      const deck = level === 'bottom' ? planes.floor : planes.roof;
      out.set(cornerKey(end, side, level), meet(deck, planes[end], planes[side]));
    }
  }
  return out;
}

function* ends(): Generator<[BoxEnd, BoxSide]> {
  for (const end of ['front', 'rear'] as const) {
    for (const side of ['left', 'right'] as const) yield [end, side];
  }
}

function plane(n: Vec3, d: number): Plane {
  const len = Math.hypot(n.x, n.y, n.z);
  return { n: scale3(n, 1 / len), d: d / len };
}

/** The same plane moved `by` mm along its own inward normal. */
export function offsetInward(p: Plane, by: number): Plane {
  return { n: p.n, d: p.d + by };
}

/** Signed distance from a point to a plane, positive on the inward side. */
export function distanceInto(p: Plane, point: Vec3): number {
  return dot3(p.n, point) - p.d;
}

/**
 * Where three planes meet.
 *
 * Cramer's rule. The determinant is the triple product of the normals, so it
 * only vanishes when two of the three are parallel — which for this body means
 * a taper has been asked for that folds one wall onto another.
 */
export function meet(a: Plane, b: Plane, c: Plane): Vec3 {
  const det = dot3(a.n, cross3(b.n, c.n));
  if (Math.abs(det) < 1e-9) {
    throw new CanopyBodyError('three faces of the body do not meet in a point');
  }
  return scale3(
    add3(
      scale3(cross3(b.n, c.n), a.d),
      add3(scale3(cross3(c.n, a.n), b.d), scale3(cross3(a.n, b.n), c.d)),
    ),
    1 / det,
  );
}

/**
 * The interior angle between two panels, degrees.
 *
 * 90 for a square box. This is the angle the metal actually turns through at
 * that seam, so it sets the bend angle of any lip folded there and the setback
 * that comes with it.
 */
export function dihedralDeg(body: CanopyBody, a: CanopyPanel, b: CanopyPanel): number {
  // Both normals point into the body, so the angle between them is the
  // supplement of the interior angle between the two faces.
  const c = clamp(dot3(body.planes[a].n, body.planes[b].n));
  return 180 - toDegrees(Math.acos(c));
}

function clamp(x: number): number {
  return x < -1 ? -1 : x > 1 ? 1 : x;
}

function tan(deg: number): number {
  return Math.tan((deg * Math.PI) / 180);
}

function mapPanels(
  planes: Readonly<Record<CanopyPanel, Plane>>,
  f: (p: Plane) => Plane,
): Record<CanopyPanel, Plane> {
  return {
    floor: f(planes.floor),
    roof: f(planes.roof),
    front: f(planes.front),
    rear: f(planes.rear),
    left: f(planes.left),
    right: f(planes.right),
  };
}

// ---------------------------------------------------------------------------
// Panels
// ---------------------------------------------------------------------------

/**
 * Which coordinate a panel holds fixed.
 *
 * A corner is named by three coordinates — which end, which side, which level —
 * and a panel is the set of corners agreeing on one of them. That one fact
 * names every edge of every panel without a lookup table: an edge joins the two
 * corners that agree on a *second* coordinate, and that coordinate's value is
 * the edge's name. So the floor has front/rear/left/right edges and a side wall
 * has front/rear/bottom/top, and nothing has to remember which is which.
 */
const PANEL_FIXES: Record<CanopyPanel, string> = {
  floor: 'bottom',
  roof: 'top',
  front: 'front',
  rear: 'rear',
  left: 'left',
  right: 'right',
};

/** The direction that becomes local +x, so flat patterns come out the right way up. */
const PANEL_ACROSS: Record<CanopyPanel, Vec3> = {
  floor: v3(1, 0, 0),
  roof: v3(1, 0, 0),
  front: v3(1, 0, 0),
  rear: v3(1, 0, 0),
  left: v3(0, 1, 0),
  right: v3(0, 1, 0),
};

/** The four corners on a panel, in no particular order. */
export function panelCorners(panel: CanopyPanel): CornerKey[] {
  const fixed = PANEL_FIXES[panel];
  const keys: CornerKey[] = [];
  for (const [end, side] of ends()) {
    for (const level of ['bottom', 'top'] as const) {
      const key = cornerKey(end, side, level);
      if (key.split('-').includes(fixed)) keys.push(key);
    }
  }
  return keys;
}

/** A panel's own 2D space, sitting in the body's 3D space. */
export interface PanelFrame {
  readonly origin: Vec3;
  readonly xAxis: Vec3;
  readonly yAxis: Vec3;
  /** Outward: the direction the panel's metal faces. */
  readonly normal: Vec3;
}

/**
 * A panel's local frame, right-handed with its outward normal.
 *
 * `xAxis` runs across the panel — the width for a deck or an end wall, the
 * length for a side wall — so a flat pattern lands on the sheet the way you
 * would expect to see it rather than on its side.
 */
export function panelFrame(body: CanopyBody, panel: CanopyPanel): PanelFrame {
  const normal = outwardNormal(body, panel);
  const across = PANEL_ACROSS[panel];
  const projected = sub3(across, scale3(normal, dot3(across, normal)));
  const xAxis = normalize3(projected);
  // x cross y = n, so y = n cross x.
  const yAxis = cross3(normal, xAxis);
  return { origin: corner(body, panelCorners(panel)[0]!), xAxis, yAxis, normal };
}

/** Carry a body point into a panel's own 2D space. */
export function toPanel(frame: PanelFrame, p: Vec3): Vec2 {
  const d = sub3(p, frame.origin);
  return v2(dot3(d, frame.xAxis), dot3(d, frame.yAxis));
}

/** Carry a panel point back out into the body's space. */
export function fromPanel(frame: PanelFrame, p: Vec2): Vec3 {
  return add3(frame.origin, add3(scale3(frame.xAxis, p.x), scale3(frame.yAxis, p.y)));
}

export interface PanelOutline {
  readonly frame: PanelFrame;
  /** The four corners, counter-clockwise seen from outside the body. */
  readonly loop: readonly { readonly key: CornerKey; readonly at: Vec2 }[];
  /** Edge name to the pair of corners it joins, in loop order. */
  readonly edges: ReadonlyMap<string, readonly [CornerKey, CornerKey]>;
}

/**
 * A panel's outline: four corners counter-clockwise, and what each edge is
 * called.
 *
 * The order comes from sorting the corners about their own centroid rather than
 * from a table, because a table would have to be re-derived every time a taper
 * moved a corner. Counter-clockwise is what the profile and the flange machinery
 * both want — material on the left of every directed edge.
 */
export function panelOutline(body: CanopyBody, panel: CanopyPanel): PanelOutline {
  const frame = panelFrame(body, panel);
  const placed = panelCorners(panel).map((key) => ({ key, at: toPanel(frame, corner(body, key)) }));

  const cx = placed.reduce((s, p) => s + p.at.x, 0) / placed.length;
  const cy = placed.reduce((s, p) => s + p.at.y, 0) / placed.length;
  const loop = [...placed].sort(
    (a, b) => Math.atan2(a.at.y - cy, a.at.x - cx) - Math.atan2(b.at.y - cy, b.at.x - cx),
  );

  const edges = new Map<string, readonly [CornerKey, CornerKey]>();
  for (let i = 0; i < loop.length; i += 1) {
    const a = loop[i]!.key;
    const b = loop[(i + 1) % loop.length]!.key;
    const name = sharedName(a, b, PANEL_FIXES[panel]);
    edges.set(name, [a, b]);
  }
  return { frame, loop, edges };
}

/** What two corners of a panel have in common besides the panel itself. */
function sharedName(a: CornerKey, b: CornerKey, exclude: string): string {
  const shared = a.split('-').filter((part) => part !== exclude && b.split('-').includes(part));
  if (shared.length !== 1) {
    throw new CanopyBodyError(`corners ${a} and ${b} do not name one edge of the panel`);
  }
  return shared[0]!;
}
