/**
 * The document: several designs, each producing one or more parts.
 *
 * A benchtop is one template instance producing one part. A canopy is one
 * template instance producing six. That difference is why the document is a
 * list of **designs** rather than a list of parts: the design is what you edit,
 * and the parts are what it makes, what you look at, and what gets exported.
 *
 * Rows carry a `uid` that exists only here and is never saved. Two designs can
 * temporarily share a name while somebody is typing, and the document build
 * reports that as a problem; the UI still has to know which one the user is
 * editing, and a name cannot answer that.
 */

import { useCallback, useMemo, useState } from 'react';
import type {
  BenchtopParams,
  CanopyParams,
  DocumentBuild,
  FoldedPart,
  MachineProfile,
  Material,
  Part,
  PartBuild,
} from '@metal-mate/core';
import {
  DEFAULT_BENCHTOP,
  DEFAULT_CANOPY,
  benchtopPart,
  buildDocument,
  canopyDocument,
  fold,
} from '@metal-mate/core';

export type TemplateKind = 'benchtop' | 'canopy';

export type DesignRow =
  | { readonly uid: string; readonly kind: 'benchtop'; readonly params: BenchtopParams }
  | { readonly uid: string; readonly kind: 'canopy'; readonly params: CanopyParams };

export interface DocumentState {
  readonly rows: readonly DesignRow[];
  /** The design being edited. */
  readonly activeUid: string;
  /** The part being looked at. Empty until the first build names one. */
  readonly activePartUid: string;
}

let nextUid = 0;
function uid(): string {
  nextUid += 1;
  return `row-${nextUid}`;
}

export function benchtopRow(params: BenchtopParams = DEFAULT_BENCHTOP): DesignRow {
  return { uid: uid(), kind: 'benchtop', params };
}

export function canopyRow(params: CanopyParams = DEFAULT_CANOPY): DesignRow {
  return { uid: uid(), kind: 'canopy', params };
}

export function initialDocument(): DocumentState {
  const row = benchtopRow();
  return { rows: [row], activeUid: row.uid, activePartUid: '' };
}

/** One part, and which design made it. */
export interface ExpandedPart {
  /** Unique across the document; `${rowUid}#${index}`. */
  readonly partUid: string;
  readonly rowUid: string;
  readonly name: string;
  /** null when the design's parameters cannot make this part at all. */
  readonly part: Part | null;
}

export interface ExpandedRow {
  readonly row: DesignRow;
  readonly parts: readonly ExpandedPart[];
  /** Why this design will not build, if it will not. */
  readonly error: string | null;
}

/**
 * Turn one design into its parts.
 *
 * Parameters that make no physical sense throw out of the template, before the
 * pipeline ever sees a part, so the message is caught here and shown against
 * the design that produced it.
 */
export function expandRow(row: DesignRow): ExpandedRow {
  try {
    const parts =
      row.kind === 'benchtop' ? [benchtopPart(row.params)] : [...canopyDocument(row.params).parts];
    return {
      row,
      error: null,
      parts: parts.map((part, i) => ({
        partUid: `${row.uid}#${i}`,
        rowUid: row.uid,
        name: part.parameters.name,
        part,
      })),
    };
  } catch (e) {
    return {
      row,
      error: e instanceof Error ? e.message : String(e),
      parts: [],
    };
  }
}

export interface DocumentActions {
  readonly state: DocumentState;
  readonly active: DesignRow;
  readonly setActiveRow: (uid: string) => void;
  readonly setActivePart: (partUid: string, rowUid: string) => void;
  readonly updateActive: (params: BenchtopParams | CanopyParams) => void;
  readonly add: (kind: TemplateKind) => void;
  readonly duplicate: (uid: string) => void;
  readonly remove: (uid: string) => void;
  readonly replaceAll: (rows: readonly DesignRow[]) => void;
}

export function useDocument(initial: DocumentState = initialDocument()): DocumentActions {
  const [state, setState] = useState<DocumentState>(initial);
  const active = state.rows.find((r) => r.uid === state.activeUid) ?? state.rows[0]!;

  const setActiveRow = useCallback((rowUid: string) => {
    setState((s) => ({ ...s, activeUid: rowUid, activePartUid: '' }));
  }, []);

  const setActivePart = useCallback((partUid: string, rowUid: string) => {
    setState((s) => ({ ...s, activeUid: rowUid, activePartUid: partUid }));
  }, []);

  const updateActive = useCallback((params: BenchtopParams | CanopyParams) => {
    setState((s) => ({
      ...s,
      rows: s.rows.map((r) =>
        r.uid === s.activeUid ? ({ ...r, params } as DesignRow) : r,
      ),
    }));
  }, []);

  const add = useCallback((kind: TemplateKind) => {
    setState((s) => {
      const base = kind === 'benchtop' ? DEFAULT_BENCHTOP : DEFAULT_CANOPY;
      const named = { ...base, name: uniqueName(s.rows, base.name) };
      const row =
        kind === 'benchtop'
          ? benchtopRow(named as BenchtopParams)
          : canopyRow(named as CanopyParams);
      return { rows: [...s.rows, row], activeUid: row.uid, activePartUid: '' };
    });
  }, []);

  const duplicate = useCallback((rowUid: string) => {
    setState((s) => {
      const source = s.rows.find((r) => r.uid === rowUid);
      if (source === undefined) return s;
      // A copy is a different design, so it must not inherit the part number
      // or prefix — two parts sharing one identity is how one gets cut twice
      // and the other not at all.
      const name = uniqueName(s.rows, source.params.name);
      const row =
        source.kind === 'benchtop'
          ? benchtopRow(withoutKey(source.params, 'partId', name))
          : canopyRow(withoutKey(source.params, 'partPrefix', name));
      const at = s.rows.indexOf(source) + 1;
      return {
        rows: [...s.rows.slice(0, at), row, ...s.rows.slice(at)],
        activeUid: row.uid,
        activePartUid: '',
      };
    });
  }, []);

  const remove = useCallback((rowUid: string) => {
    setState((s) => {
      // A document with no designs is a state the panel cannot get out of, so
      // the last row stays.
      if (s.rows.length <= 1) return s;
      const at = s.rows.findIndex((r) => r.uid === rowUid);
      if (at < 0) return s;
      const rows = s.rows.filter((r) => r.uid !== rowUid);
      const activeUid =
        s.activeUid === rowUid ? (rows[Math.min(at, rows.length - 1)] ?? rows[0]!).uid : s.activeUid;
      return { rows, activeUid, activePartUid: '' };
    });
  }, []);

  const replaceAll = useCallback((rows: readonly DesignRow[]) => {
    const next = rows.length > 0 ? [...rows] : [benchtopRow()];
    setState({ rows: next, activeUid: next[0]!.uid, activePartUid: '' });
  }, []);

  return {
    state,
    active,
    setActiveRow,
    setActivePart,
    updateActive,
    add,
    duplicate,
    remove,
    replaceAll,
  };
}

/** A copy of some parameters under a new name, with one identity field gone. */
function withoutKey<P extends { name: string }, K extends keyof P>(
  params: P,
  key: K,
  name: string,
): P {
  const next = { ...params, name };
  delete next[key];
  return next;
}

/** "Benchtop", then "Benchtop 2", "Benchtop 3" — whatever is not taken. */
export function uniqueName(rows: readonly DesignRow[], base: string): string {
  const taken = new Set(rows.map((r) => r.params.name));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base} ${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

export interface DocumentBuildState {
  readonly document: DocumentBuild | null;
  readonly expanded: readonly ExpandedRow[];
  /** The part on screen, or null while the kernel is still loading. */
  readonly active: PartBuild | null;
  /** Each part's build, by its part uid. */
  readonly buildByUid: ReadonlyMap<string, PartBuild>;
  /** Folded geometry for the part on screen only; the rest never need it. */
  readonly folded: FoldedPart | undefined;
  /** Why the active design will not build, if it will not. */
  readonly error: string | null;
  readonly ready: boolean;
}

/**
 * Build every part of every design, and fold only the one on screen.
 *
 * `buildDocument` deliberately skips folding, which is the expensive step, so a
 * six-panel canopy costs no more to have on the list than a benchtop does.
 */
export function useDocumentBuild(
  rows: readonly DesignRow[],
  activeUid: string,
  activePartUid: string,
  machine: MachineProfile,
  materials: readonly Material[],
  foldFraction: number,
  ready: boolean,
): DocumentBuildState {
  const expanded = useMemo(() => rows.map(expandRow), [rows]);
  const buildable = useMemo(
    () => expanded.flatMap((e) => e.parts).filter((p) => p.part !== null),
    [expanded],
  );

  const document = useMemo(() => {
    if (!ready) return null;
    return buildDocument(
      buildable.map((p) => p.part!),
      { machine, materials },
    );
  }, [buildable, machine, materials, ready]);

  // `buildDocument` returns one result per part it was given, in order, so a
  // part's result is at its index among the buildable parts.
  const buildByUid = useMemo(() => {
    const map = new Map<string, PartBuild>();
    if (document === null) return map;
    buildable.forEach((p, i) => {
      const build = document.parts[i];
      if (build !== undefined) map.set(p.partUid, build);
    });
    return map;
  }, [buildable, document]);

  // Fall back to the active design's first part, so selecting a canopy shows a
  // panel rather than nothing.
  const fallback = expanded.find((e) => e.row.uid === activeUid)?.parts[0]?.partUid ?? '';
  const active = buildByUid.get(activePartUid) ?? buildByUid.get(fallback) ?? null;

  const error = expanded.find((e) => e.row.uid === activeUid)?.error ?? null;

  const folded = useMemo(() => {
    if (active === null || !active.ok) return undefined;
    return fold(active.result.graph, {
      material: active.result.material,
      fraction: foldFraction,
    });
  }, [active, foldFraction]);

  return { document, expanded, active, buildByUid, folded, error, ready };
}
