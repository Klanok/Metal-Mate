/**
 * DXF R12 (AC1009) ASCII writer.
 *
 * R12 is a simple tagged text format and is the most widely accepted flavour
 * on laser CAM, which is why it is written in-house rather than pulled from a
 * library: the whole writer fits in one readable file and is verified by an
 * independent parser in the test suite.
 *
 * INVARIANT: arcs are written as POLYLINE bulge values (group code 42) and are
 * never linearised. A 10 mm sink corner radius must arrive at the laser as an
 * arc, not as forty short chords.
 *
 * Output conventions:
 *  - millimetres, $INSUNITS = 4
 *  - outer loops counter-clockwise, inner loops clockwise
 *  - closed polylines (group code 70 = 1), no duplicate closing vertex
 *  - flat pattern origin at the lower-left of the blank
 */

import { type Loop, segments, isCCW, reverse } from '../geometry/loop.js';
import { type Profile } from '../geometry/profile.js';
import { type Vec2 } from '../geometry/vec2.js';
import { type FlatPattern } from '../unfold/unfold.js';
import { type GrainDirection, type PartParameters } from '../features/types.js';
import { round } from '../units.js';
import {
  DEFAULT_EXPORT_PROFILE,
  type ExportProfile,
  type LayerSpec,
  layersOf,
} from './exportProfile.js';

export interface DxfExportInput {
  readonly flat: FlatPattern;
  readonly part: PartParameters;
  readonly profile?: ExportProfile;
  /** Stamped into the INFO text block. Passed in so output stays deterministic. */
  readonly dateStamp?: string;
}

/** Tag stream builder. R12 is just pairs of (group code, value) lines. */
class TagWriter {
  private readonly lines: string[] = [];

  constructor(private readonly decimals: number) {}

  tag(code: number, value: string | number): this {
    this.lines.push(String(code));
    this.lines.push(typeof value === 'number' ? this.format(code, value) : value);
    return this;
  }

  /**
   * DXF types are decided by the group code, not by the caller. Codes 0-9 are
   * strings, 10-59 are doubles, 60-79 and 90-99 are integers. Writing "4.0000"
   * where an int16 is expected is malformed and some CAM readers reject the
   * whole file for it.
   */
  private format(code: number, value: number): string {
    if (isIntegerCode(code)) return String(Math.round(value));
    return this.num(value);
  }

  num(value: number): string {
    return round(value, this.decimals).toFixed(this.decimals);
  }

  toString(): string {
    // DXF is a line-oriented format and readers are happier with a trailing
    // newline; CRLF is not required and LF keeps golden files diffable.
    return `${this.lines.join('\n')}\n`;
  }
}

function isIntegerCode(code: number): boolean {
  return (code >= 60 && code <= 79) || (code >= 90 && code <= 99) || (code >= 170 && code <= 179);
}

export function writeDxfR12(input: DxfExportInput): string {
  const profile = input.profile ?? DEFAULT_EXPORT_PROFILE;
  const w = new TagWriter(profile.decimals);

  writeHeader(w, input.flat);
  writeTables(w, profile);
  writeEntities(w, input, profile);
  w.tag(0, 'EOF');
  return w.toString();
}

function writeHeader(w: TagWriter, flat: FlatPattern): void {
  w.tag(0, 'SECTION').tag(2, 'HEADER');
  w.tag(9, '$ACADVER').tag(1, 'AC1009');
  // 4 = millimetres. Strictly an R13+ variable, but every CAM package we care
  // about reads it and it removes any doubt about units at the laser.
  w.tag(9, '$INSUNITS').tag(70, 4);
  w.tag(9, '$MEASUREMENT').tag(70, 1);
  w.tag(9, '$EXTMIN').tag(10, flat.bounds.min.x).tag(20, flat.bounds.min.y).tag(30, 0);
  w.tag(9, '$EXTMAX').tag(10, flat.bounds.max.x).tag(20, flat.bounds.max.y).tag(30, 0);
  w.tag(0, 'ENDSEC');
}

function writeTables(w: TagWriter, profile: ExportProfile): void {
  const layers = layersOf(profile);
  const needsDashed = layers.some((l) => l.linetype === 'DASHED');

  w.tag(0, 'SECTION').tag(2, 'TABLES');

  w.tag(0, 'TABLE').tag(2, 'LTYPE').tag(70, needsDashed ? 2 : 1);
  w.tag(0, 'LTYPE').tag(2, 'CONTINUOUS').tag(70, 0).tag(3, 'Solid line').tag(72, 65).tag(73, 0).tag(40, 0);
  if (needsDashed) {
    w.tag(0, 'LTYPE')
      .tag(2, 'DASHED')
      .tag(70, 0)
      .tag(3, '__ __ __ __ __ __ __ __ __ __ __')
      .tag(72, 65)
      .tag(73, 2)
      .tag(40, 12.7)
      .tag(49, 8.4667)
      .tag(49, -4.2333);
  }
  w.tag(0, 'ENDTAB');

  w.tag(0, 'TABLE').tag(2, 'LAYER').tag(70, layers.length);
  for (const layer of layers) {
    w.tag(0, 'LAYER').tag(2, layer.name).tag(70, 0).tag(62, layer.colour).tag(6, layer.linetype);
  }
  w.tag(0, 'ENDTAB');

  w.tag(0, 'ENDSEC');
}

function writeEntities(w: TagWriter, input: DxfExportInput, profile: ExportProfile): void {
  const { flat, part } = input;
  w.tag(0, 'SECTION').tag(2, 'ENTITIES');

  writePolyline(w, flat.profile.outer, profile.layers.outer, true);
  for (const inner of flat.profile.inners) {
    writePolyline(w, inner, profile.layers.inner, false);
  }

  if (profile.includeBendLines) {
    for (const bend of flat.bendLines) {
      const layer = bend.direction === 'up' ? profile.layers.bendUp : profile.layers.bendDown;
      writeLine(w, bend.centreline[0], bend.centreline[1], layer);
    }
  }

  if (profile.includeEtch) {
    writeEtch(w, input, profile);
  }

  if (profile.includeInfoText) {
    writeInfo(w, input, profile);
  }

  w.tag(0, 'ENDSEC');
  void part;
}

/**
 * Write a closed loop. Orientation is forced here rather than trusted from
 * upstream: outer counter-clockwise, inner clockwise, every time.
 */
function writePolyline(w: TagWriter, loop: Loop, layer: LayerSpec, outer: boolean): void {
  const oriented = isCCW(loop) === outer ? loop : reverse(loop);
  w.tag(0, 'POLYLINE')
    .tag(8, layer.name)
    .tag(6, layer.linetype)
    .tag(66, 1) // vertices follow
    .tag(70, 1) // closed
    .tag(10, 0)
    .tag(20, 0)
    .tag(30, 0);
  for (const { p0, bulge } of segments(oriented)) {
    w.tag(0, 'VERTEX').tag(8, layer.name).tag(10, p0.x).tag(20, p0.y).tag(30, 0);
    if (bulge !== 0) w.tag(42, bulge);
  }
  w.tag(0, 'SEQEND').tag(8, layer.name);
}

function writeLine(w: TagWriter, a: Vec2, b: Vec2, layer: LayerSpec): void {
  w.tag(0, 'LINE')
    .tag(8, layer.name)
    .tag(6, layer.linetype)
    .tag(10, a.x)
    .tag(20, a.y)
    .tag(30, 0)
    .tag(11, b.x)
    .tag(21, b.y)
    .tag(31, 0);
}

function writeText(w: TagWriter, at: Vec2, height: number, text: string, layer: LayerSpec): void {
  w.tag(0, 'TEXT')
    .tag(8, layer.name)
    .tag(10, at.x)
    .tag(20, at.y)
    .tag(30, 0)
    .tag(40, height)
    .tag(1, text);
}

/**
 * Part id and grain arrow. Polished stainless has to be nested with the grain
 * running the right way, and the arrow is how the laser operator knows which
 * way that is.
 */
function writeEtch(w: TagWriter, input: DxfExportInput, profile: ExportProfile): void {
  const { flat, part } = input;
  const layer = profile.layers.etch;
  const h = profile.textHeightMm;
  const margin = h;
  const at = { x: flat.bounds.min.x + margin, y: flat.bounds.min.y + margin };
  const label = part.partId ?? part.name;
  writeText(w, at, h, label, layer);

  if (part.grain !== 'none') {
    writeGrainArrow(w, input, profile, part.grain);
  }
}

function writeGrainArrow(
  w: TagWriter,
  input: DxfExportInput,
  profile: ExportProfile,
  grain: GrainDirection,
): void {
  const { flat } = input;
  const layer = profile.layers.etch;
  const h = profile.textHeightMm;
  const length = h * 6;
  const head = h;
  // Sits above the part label, in the bottom-left margin of the blank.
  const start = { x: flat.bounds.min.x + h, y: flat.bounds.min.y + h * 3 };
  const along: Vec2 = grain === 'length' ? { x: 1, y: 0 } : { x: 0, y: 1 };
  const across: Vec2 = { x: -along.y, y: along.x };
  const end = { x: start.x + along.x * length, y: start.y + along.y * length };
  writeLine(w, start, end, layer);
  writeLine(
    w,
    end,
    { x: end.x - along.x * head + across.x * head * 0.4, y: end.y - along.y * head + across.y * head * 0.4 },
    layer,
  );
  writeLine(
    w,
    end,
    { x: end.x - along.x * head - across.x * head * 0.4, y: end.y - along.y * head - across.y * head * 0.4 },
    layer,
  );
  writeText(w, { x: start.x, y: start.y + h * 1.2 }, h * 0.7, 'GRAIN', layer);
}

/** Non-cutting notes: material, thickness, and one line per bend. */
function writeInfo(w: TagWriter, input: DxfExportInput, profile: ExportProfile): void {
  const { flat, part } = input;
  const layer = profile.layers.info;
  const h = profile.textHeightMm * 0.7;
  const lineHeight = h * 1.6;
  let y = flat.bounds.max.y + lineHeight;
  const x = flat.bounds.min.x;

  const lines: string[] = [
    `${part.name}${part.revision === undefined ? '' : ` rev ${part.revision}`}`,
    `MATERIAL ${part.materialId} ${part.thicknessMm} mm`,
    `BLANK ${(flat.bounds.max.x - flat.bounds.min.x).toFixed(1)} x ${(flat.bounds.max.y - flat.bounds.min.y).toFixed(1)} mm`,
    `GRAIN ${part.grain.toUpperCase()}`,
  ];
  if (input.dateStamp !== undefined) lines.push(`DATE ${input.dateStamp}`);
  for (const [i, bend] of flat.bendLines.entries()) {
    lines.push(
      `BEND ${i + 1} ${bend.angleDeg.toFixed(1)} DEG ${bend.direction.toUpperCase()} R${bend.insideRadius.toFixed(2)} LEN ${bend.lengthMm.toFixed(1)}`,
    );
  }
  for (const text of lines) {
    writeText(w, { x, y }, h, text, layer);
    y += lineHeight;
  }
}
