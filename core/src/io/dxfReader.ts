/**
 * DXF reader.
 *
 * Two jobs, deliberately served by one implementation that shares no code with
 * the writer:
 *
 *  1. Verification. The test suite parses everything the writer produces with
 *     this, so a golden file is checked by an independent reading of the
 *     format rather than by the writer agreeing with itself.
 *  2. Import. Starting a benchtop from an architect's or joiner's detail means
 *     reading their DXF, healing it, and adopting a closed loop as a base
 *     flange profile. Import is a conversion: once done there is no live link
 *     back to the source file.
 *
 * Handles the entity types that actually turn up in 2D profile files:
 * POLYLINE/VERTEX, LWPOLYLINE, LINE, ARC, CIRCLE and TEXT.
 */

import { type Loop, type Vertex, bulgeForAngle, dedupe, signedArea } from '../geometry/loop.js';
import { type Vec2, distance } from '../geometry/vec2.js';
import { TOL } from '../units.js';

export interface DxfTag {
  readonly code: number;
  readonly value: string;
}

export interface DxfPolyline {
  readonly type: 'POLYLINE';
  readonly layer: string;
  readonly closed: boolean;
  readonly vertices: readonly Vertex[];
}

export interface DxfLine {
  readonly type: 'LINE';
  readonly layer: string;
  readonly a: Vec2;
  readonly b: Vec2;
}

export interface DxfArc {
  readonly type: 'ARC';
  readonly layer: string;
  readonly centre: Vec2;
  readonly radius: number;
  /** Degrees, counter-clockwise from +x. */
  readonly startAngle: number;
  readonly endAngle: number;
}

export interface DxfCircle {
  readonly type: 'CIRCLE';
  readonly layer: string;
  readonly centre: Vec2;
  readonly radius: number;
}

export interface DxfText {
  readonly type: 'TEXT';
  readonly layer: string;
  readonly at: Vec2;
  readonly height: number;
  readonly text: string;
}

export type DxfEntity = DxfPolyline | DxfLine | DxfArc | DxfCircle | DxfText;

export interface DxfLayer {
  readonly name: string;
  readonly colour: number;
  readonly linetype: string;
}

export interface DxfDocument {
  readonly headerVariables: ReadonlyMap<string, string>;
  readonly layers: readonly DxfLayer[];
  readonly entities: readonly DxfEntity[];
}

export class DxfParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DxfParseError';
  }
}

/** Split the file into (code, value) pairs. */
export function tokenize(text: string): DxfTag[] {
  const lines = text.split(/\r\n|\r|\n/);
  // A trailing newline leaves an empty final element; anything else unpaired
  // is a malformed file.
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  if (lines.length % 2 !== 0) {
    throw new DxfParseError(`odd number of DXF lines (${lines.length}); tags must come in pairs`);
  }
  const tags: DxfTag[] = [];
  for (let i = 0; i < lines.length; i += 2) {
    const raw = lines[i]!.trim();
    const code = Number(raw);
    if (!Number.isInteger(code)) {
      throw new DxfParseError(`line ${i + 1}: expected a group code, got ${JSON.stringify(raw)}`);
    }
    tags.push({ code, value: lines[i + 1]! });
  }
  return tags;
}

export function parseDxf(text: string): DxfDocument {
  const tags = tokenize(text);
  const headerVariables = new Map<string, string>();
  const layers: DxfLayer[] = [];
  const entities: DxfEntity[] = [];

  let section: string | null = null;
  let i = 0;
  while (i < tags.length) {
    const tag = tags[i]!;
    if (tag.code === 0 && tag.value === 'SECTION') {
      const nameTag = tags[i + 1];
      if (nameTag === undefined || nameTag.code !== 2) {
        throw new DxfParseError('SECTION without a name tag');
      }
      section = nameTag.value;
      i += 2;
      continue;
    }
    if (tag.code === 0 && tag.value === 'ENDSEC') {
      section = null;
      i += 1;
      continue;
    }
    if (tag.code === 0 && tag.value === 'EOF') break;

    if (section === 'HEADER' && tag.code === 9) {
      const valueTag = tags[i + 1];
      if (valueTag !== undefined) headerVariables.set(tag.value, valueTag.value);
      i += 2;
      continue;
    }
    if (section === 'TABLES' && tag.code === 0 && tag.value === 'LAYER') {
      const { layer, next } = readLayer(tags, i + 1);
      layers.push(layer);
      i = next;
      continue;
    }
    if (section === 'ENTITIES' && tag.code === 0) {
      const { entity, next } = readEntity(tags, i);
      if (entity !== null) entities.push(entity);
      i = next;
      continue;
    }
    i += 1;
  }
  return { headerVariables, layers, entities };
}

function readLayer(tags: readonly DxfTag[], start: number): { layer: DxfLayer; next: number } {
  let name = '';
  let colour = 7;
  let linetype = 'CONTINUOUS';
  let i = start;
  for (; i < tags.length && tags[i]!.code !== 0; i++) {
    const t = tags[i]!;
    if (t.code === 2) name = t.value;
    else if (t.code === 62) colour = Number(t.value);
    else if (t.code === 6) linetype = t.value;
  }
  return { layer: { name, colour, linetype }, next: i };
}

function readEntity(
  tags: readonly DxfTag[],
  start: number,
): { entity: DxfEntity | null; next: number } {
  const kind = tags[start]!.value;
  const fields = new Map<number, string[]>();
  let i = start + 1;
  for (; i < tags.length && tags[i]!.code !== 0; i++) {
    const t = tags[i]!;
    const list = fields.get(t.code) ?? [];
    list.push(t.value);
    fields.set(t.code, list);
  }
  const num = (code: number, fallback = 0): number => {
    const v = fields.get(code)?.[0];
    return v === undefined ? fallback : Number(v);
  };
  const str = (code: number, fallback = ''): string => fields.get(code)?.[0] ?? fallback;
  const layer = str(8, '0');

  switch (kind) {
    case 'LINE':
      return {
        entity: {
          type: 'LINE',
          layer,
          a: { x: num(10), y: num(20) },
          b: { x: num(11), y: num(21) },
        },
        next: i,
      };
    case 'ARC':
      return {
        entity: {
          type: 'ARC',
          layer,
          centre: { x: num(10), y: num(20) },
          radius: num(40),
          startAngle: num(50),
          endAngle: num(51),
        },
        next: i,
      };
    case 'CIRCLE':
      return {
        entity: {
          type: 'CIRCLE',
          layer,
          centre: { x: num(10), y: num(20) },
          radius: num(40),
        },
        next: i,
      };
    case 'TEXT':
      return {
        entity: {
          type: 'TEXT',
          layer,
          at: { x: num(10), y: num(20) },
          height: num(40),
          text: str(1),
        },
        next: i,
      };
    case 'LWPOLYLINE': {
      const xs = fields.get(10) ?? [];
      const ys = fields.get(20) ?? [];
      const bulges = fields.get(42) ?? [];
      // LWPOLYLINE bulges are positional, so this only lines up when every
      // vertex carries one; that is how every writer we care about emits it.
      const vertices: Vertex[] = xs.map((x, index) => ({
        x: Number(x),
        y: Number(ys[index] ?? '0'),
        bulge: Number(bulges[index] ?? '0'),
      }));
      return {
        entity: { type: 'POLYLINE', layer, closed: (num(70) & 1) === 1, vertices },
        next: i,
      };
    }
    case 'POLYLINE': {
      const closed = (num(70) & 1) === 1;
      const vertices: Vertex[] = [];
      let j = i;
      while (j < tags.length) {
        const t = tags[j]!;
        if (t.code !== 0) {
          j += 1;
          continue;
        }
        if (t.value === 'SEQEND') {
          j += 1;
          break;
        }
        if (t.value !== 'VERTEX') break;
        const vertexFields = new Map<number, string>();
        let k = j + 1;
        for (; k < tags.length && tags[k]!.code !== 0; k++) {
          vertexFields.set(tags[k]!.code, tags[k]!.value);
        }
        vertices.push({
          x: Number(vertexFields.get(10) ?? '0'),
          y: Number(vertexFields.get(20) ?? '0'),
          bulge: Number(vertexFields.get(42) ?? '0'),
        });
        j = k;
      }
      return { entity: { type: 'POLYLINE', layer, closed, vertices }, next: j };
    }
    default:
      return { entity: null, next: i };
  }
}

/** Entities on one layer. */
export function entitiesOnLayer(doc: DxfDocument, layer: string): DxfEntity[] {
  return doc.entities.filter((e) => e.layer === layer);
}

/**
 * Turn entities into closed loops.
 *
 * Closed polylines and circles come across directly. Loose lines and arcs are
 * chained end to end, joining endpoints that are within `tol` of each other —
 * the healing step that makes a hand-drawn detail usable as a base profile.
 * Chains that do not close are dropped and reported.
 */
export function loopsFromEntities(
  entities: readonly DxfEntity[],
  tol = 0.01,
): { loops: Loop[]; openChains: number } {
  const loops: Loop[] = [];
  const pieces: { start: Vec2; end: Vec2; bulge: number }[] = [];

  for (const e of entities) {
    if (e.type === 'POLYLINE') {
      if (e.vertices.length < 2) continue;
      if (e.closed) {
        loops.push(dedupe({ verts: e.vertices }, tol));
      } else {
        for (let i = 0; i < e.vertices.length - 1; i++) {
          const v = e.vertices[i]!;
          const next = e.vertices[i + 1]!;
          pieces.push({ start: { x: v.x, y: v.y }, end: { x: next.x, y: next.y }, bulge: v.bulge });
        }
      }
    } else if (e.type === 'CIRCLE') {
      loops.push({
        verts: [
          { x: e.centre.x - e.radius, y: e.centre.y, bulge: 1 },
          { x: e.centre.x + e.radius, y: e.centre.y, bulge: 1 },
        ],
      });
    } else if (e.type === 'LINE') {
      if (distance(e.a, e.b) > TOL) pieces.push({ start: e.a, end: e.b, bulge: 0 });
    } else if (e.type === 'ARC') {
      pieces.push(arcToPiece(e));
    }
  }

  const { chains, open } = chainPieces(pieces, tol);
  loops.push(...chains);
  return { loops: loops.filter((l) => Math.abs(signedArea(l)) > tol * tol), openChains: open };
}

function arcToPiece(a: DxfArc): { start: Vec2; end: Vec2; bulge: number } {
  const toRad = (d: number): number => (d * Math.PI) / 180;
  let sweep = toRad(a.endAngle - a.startAngle);
  const TWO_PI = Math.PI * 2;
  sweep = ((sweep % TWO_PI) + TWO_PI) % TWO_PI;
  // DXF arcs always run counter-clockwise from start angle to end angle.
  return {
    start: {
      x: a.centre.x + a.radius * Math.cos(toRad(a.startAngle)),
      y: a.centre.y + a.radius * Math.sin(toRad(a.startAngle)),
    },
    end: {
      x: a.centre.x + a.radius * Math.cos(toRad(a.endAngle)),
      y: a.centre.y + a.radius * Math.sin(toRad(a.endAngle)),
    },
    bulge: bulgeForAngle(sweep),
  };
}

function chainPieces(
  pieces: readonly { start: Vec2; end: Vec2; bulge: number }[],
  tol: number,
): { chains: Loop[]; open: number } {
  const remaining = pieces.map((p) => ({ ...p, used: false }));
  const chains: Loop[] = [];
  let open = 0;

  for (let i = 0; i < remaining.length; i++) {
    const seed = remaining[i]!;
    if (seed.used) continue;
    seed.used = true;
    const verts: Vertex[] = [{ x: seed.start.x, y: seed.start.y, bulge: seed.bulge }];
    let head = seed.end;
    let closed = false;

    for (;;) {
      if (distance(head, seed.start) <= tol) {
        closed = true;
        break;
      }
      const nextIndex = remaining.findIndex(
        (p) => !p.used && (distance(p.start, head) <= tol || distance(p.end, head) <= tol),
      );
      if (nextIndex < 0) break;
      const next = remaining[nextIndex]!;
      next.used = true;
      const forward = distance(next.start, head) <= tol;
      verts.push({ x: head.x, y: head.y, bulge: forward ? next.bulge : -next.bulge });
      head = forward ? next.end : next.start;
    }

    if (closed && verts.length >= 2) chains.push(dedupe({ verts }, tol));
    else open += 1;
  }
  return { chains, open };
}
