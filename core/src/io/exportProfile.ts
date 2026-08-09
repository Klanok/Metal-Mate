/**
 * Export profile: per-laser layer and style mapping.
 *
 * The friend's CAM decides what a good DXF looks like, and that is not
 * knowledge that belongs in code. An export profile is data, so a different
 * shop (or a changed post-processor) is a settings change, not a patch.
 *
 * Before this writer is trusted, get one DXF that the laser already accepts
 * cleanly and treat it as the reference spec — layer names, arc handling,
 * units flag (Appendix C of the architecture doc).
 */

export type LayerKey = 'outer' | 'inner' | 'bendUp' | 'bendDown' | 'etch' | 'info';

export interface LayerSpec {
  readonly name: string;
  /** AutoCAD colour index. 1 red, 2 yellow, 3 green, 4 cyan, 7 white, 8 grey. */
  readonly colour: number;
  readonly linetype: 'CONTINUOUS' | 'DASHED';
}

export interface ExportProfile {
  readonly id: string;
  readonly name: string;
  readonly layers: Readonly<Record<LayerKey, LayerSpec>>;
  /** Draw bend lines at all. Some CAM setups would rather not see them. */
  readonly includeBendLines: boolean;
  /** Part id and grain arrow on the ETCH layer. */
  readonly includeEtch: boolean;
  /** Bend angles, radii and notes as non-cutting text on the INFO layer. */
  readonly includeInfoText: boolean;
  /** Decimal places for coordinates. */
  readonly decimals: number;
  /** Text height in mm for etch and info text. */
  readonly textHeightMm: number;
}

export const DEFAULT_EXPORT_PROFILE: ExportProfile = {
  id: 'default',
  name: 'Default (mm, R12, arcs as bulges)',
  layers: {
    outer: { name: 'CUT_OUTER', colour: 7, linetype: 'CONTINUOUS' },
    inner: { name: 'CUT_INNER', colour: 2, linetype: 'CONTINUOUS' },
    bendUp: { name: 'BEND_UP', colour: 3, linetype: 'DASHED' },
    bendDown: { name: 'BEND_DOWN', colour: 1, linetype: 'DASHED' },
    etch: { name: 'ETCH', colour: 4, linetype: 'CONTINUOUS' },
    info: { name: 'INFO', colour: 8, linetype: 'CONTINUOUS' },
  },
  includeBendLines: true,
  includeEtch: true,
  includeInfoText: true,
  decimals: 4,
  textHeightMm: 5,
};

/** Profile for a CAM that wants nothing but cut geometry. */
export const CUT_ONLY_EXPORT_PROFILE: ExportProfile = {
  ...DEFAULT_EXPORT_PROFILE,
  id: 'cut-only',
  name: 'Cut geometry only',
  includeBendLines: false,
  includeEtch: false,
  includeInfoText: false,
};

export function layersOf(p: ExportProfile): LayerSpec[] {
  return Object.values(p.layers);
}
