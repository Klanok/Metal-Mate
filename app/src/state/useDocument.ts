/**
 * The document: several parts, one of them being edited.
 *
 * A canopy is a set of panels rather than one folded part, so the app edits a
 * list. The rules from `useBuild` still hold — the UI holds parameters and
 * never geometry, and every part on screen comes from one `buildDocument` call.
 *
 * Rows carry a `uid` that exists only here and is never saved. Two parts can
 * temporarily share a name while somebody is typing, and the document build
 * reports that as a problem; the UI still has to know which of the two the user
 * is editing, and a name cannot answer that.
 */

import { useCallback, useMemo, useState } from 'react';
import type {
  BenchtopParams,
  DocumentBuild,
  FoldedPart,
  MachineProfile,
  Material,
  Part,
  PartBuild,
} from '@metal-mate/core';
import { DEFAULT_BENCHTOP, benchtopPart, buildDocument, fold } from '@metal-mate/core';

export interface PartRow {
  /** Stable while the app runs; never written to a project file. */
  readonly uid: string;
  readonly params: BenchtopParams;
}

export interface DocumentState {
  readonly rows: readonly PartRow[];
  readonly activeUid: string;
}

let nextUid = 0;
export function makeRow(params: BenchtopParams): PartRow {
  nextUid += 1;
  return { uid: `row-${nextUid}`, params };
}

export function initialDocument(params: BenchtopParams = DEFAULT_BENCHTOP): DocumentState {
  const row = makeRow(params);
  return { rows: [row], activeUid: row.uid };
}

export interface DocumentActions {
  readonly state: DocumentState;
  readonly active: PartRow;
  readonly setActive: (uid: string) => void;
  readonly updateActive: (params: BenchtopParams) => void;
  readonly add: () => void;
  readonly duplicate: (uid: string) => void;
  readonly remove: (uid: string) => void;
  readonly replaceAll: (parts: readonly BenchtopParams[]) => void;
}

export function useDocument(initial: DocumentState = initialDocument()): DocumentActions {
  const [state, setState] = useState<DocumentState>(initial);
  const active = state.rows.find((r) => r.uid === state.activeUid) ?? state.rows[0]!;

  const setActive = useCallback((uid: string) => {
    setState((s) => ({ ...s, activeUid: uid }));
  }, []);

  const updateActive = useCallback((params: BenchtopParams) => {
    setState((s) => ({
      ...s,
      rows: s.rows.map((r) => (r.uid === s.activeUid ? { ...r, params } : r)),
    }));
  }, []);

  const add = useCallback(() => {
    setState((s) => {
      const row = makeRow({ ...DEFAULT_BENCHTOP, name: uniqueName(s.rows, 'Part') });
      return { rows: [...s.rows, row], activeUid: row.uid };
    });
  }, []);

  const duplicate = useCallback((uid: string) => {
    setState((s) => {
      const source = s.rows.find((r) => r.uid === uid);
      if (source === undefined) return s;
      // A copy is a different part, so it must not inherit the part number —
      // two panels sharing one identity is how one gets cut twice and the
      // other not at all.
      const { partId: _dropped, ...withoutNumber } = source.params;
      const row = makeRow({ ...withoutNumber, name: uniqueName(s.rows, source.params.name) });
      const at = s.rows.indexOf(source) + 1;
      return {
        rows: [...s.rows.slice(0, at), row, ...s.rows.slice(at)],
        activeUid: row.uid,
      };
    });
  }, []);

  const remove = useCallback((uid: string) => {
    setState((s) => {
      // A document with no parts at all is a state the user cannot get out of
      // through this panel, so the last row stays.
      if (s.rows.length <= 1) return s;
      const at = s.rows.findIndex((r) => r.uid === uid);
      if (at < 0) return s;
      const rows = s.rows.filter((r) => r.uid !== uid);
      const activeUid =
        s.activeUid === uid ? (rows[Math.min(at, rows.length - 1)] ?? rows[0]!).uid : s.activeUid;
      return { rows, activeUid };
    });
  }, []);

  const replaceAll = useCallback((parts: readonly BenchtopParams[]) => {
    const rows = (parts.length > 0 ? parts : [DEFAULT_BENCHTOP]).map(makeRow);
    setState({ rows, activeUid: rows[0]!.uid });
  }, []);

  return { state, active, setActive, updateActive, add, duplicate, remove, replaceAll };
}

/** "Part", then "Part 2", "Part 3" — whatever is not taken. */
export function uniqueName(rows: readonly PartRow[], base: string): string {
  const taken = new Set(rows.map((r) => r.params.name));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base} ${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

export interface DocumentBuildState {
  readonly document: DocumentBuild | null;
  /** The active part's build, or null while the kernel is still loading. */
  readonly active: PartBuild | null;
  /**
   * Each row's build, by uid. The document returns one result per part it was
   * given, so working the mapping out is this hook's job — anywhere else would
   * be a second copy of it, free to disagree.
   */
  readonly buildByUid: ReadonlyMap<string, PartBuild>;
  /** Folded geometry for the active part only; the rest never need it. */
  readonly folded: FoldedPart | undefined;
  /** Why the active part will not build, if it will not. */
  readonly error: string | null;
  readonly ready: boolean;
}

/**
 * Build every part, and fold only the one on screen.
 *
 * `buildDocument` deliberately skips folding, which is the expensive step, so
 * adding a tenth panel to a canopy does not make the fold slider stutter.
 */
export function useDocumentBuild(
  rows: readonly PartRow[],
  activeUid: string,
  machine: MachineProfile,
  materials: readonly Material[],
  foldFraction: number,
  ready: boolean,
): DocumentBuildState {
  // Parameters that make no physical sense throw out of the template, before
  // `buildDocument` ever sees a part. Those rows are held here with their
  // message so the panel can say which row is wrong and why.
  const rowParts = useMemo(() => rows.map(toRowPart), [rows]);
  const buildable = useMemo(() => rowParts.filter((r) => r.part !== null), [rowParts]);

  const document = useMemo(() => {
    if (!ready) return null;
    return buildDocument(
      buildable.map((r) => r.part!),
      { machine, materials },
    );
  }, [buildable, machine, materials, ready]);

  // `buildDocument` returns one result per part it was given, in order, so a
  // row's result is at its index among the buildable rows — not among all rows.
  const buildByUid = useMemo(() => {
    const map = new Map<string, PartBuild>();
    if (document === null) return map;
    buildable.forEach((row, i) => {
      const build = document.parts[i];
      if (build !== undefined) map.set(row.uid, build);
    });
    return map;
  }, [buildable, document]);
  const active = buildByUid.get(activeUid) ?? null;

  const templateError = rowParts.find((r) => r.uid === activeUid)?.error ?? null;
  const error = templateError ?? (active !== null && !active.ok ? active.error : null);

  const folded = useMemo(() => {
    if (active === null || !active.ok) return undefined;
    return fold(active.result.graph, {
      material: active.result.material,
      fraction: foldFraction,
    });
  }, [active, foldFraction]);

  return { document, active, buildByUid, folded, error, ready };
}

interface RowPart {
  readonly uid: string;
  readonly part: Part | null;
  readonly error: string | null;
}

function toRowPart(row: PartRow): RowPart {
  try {
    return { uid: row.uid, part: benchtopPart(row.params), error: null };
  } catch (e) {
    return { uid: row.uid, part: null, error: e instanceof Error ? e.message : String(e) };
  }
}
