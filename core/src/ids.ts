/**
 * Topological naming.
 *
 * Features refer to geometry by stable hierarchical names, never by position
 * in an array. `base.profile.seg2` keeps meaning the same edge after the user
 * adds a cutout above it; `edges[3]` does not. This is the classic parametric
 * CAD failure mode and it is designed in from the first commit rather than
 * retrofitted (see CLAUDE.md).
 *
 * An id is a dot-separated path. Segments are lowercase-insensitive tokens
 * matching [A-Za-z0-9_-]+; the dot is reserved as the separator.
 */

const TOKEN = /^[A-Za-z0-9_-]+$/;

declare const brand: unique symbol;
type Branded<T, B> = T & { readonly [brand]: B };

export type TopoId = Branded<string, 'TopoId'>;
export type FeatureId = Branded<string, 'FeatureId'>;
export type FaceId = Branded<string, 'FaceId'>;
export type BendId = Branded<string, 'BendId'>;
export type CornerId = Branded<string, 'CornerId'>;
export type PartId = Branded<string, 'PartId'>;

function assertToken(token: string): void {
  if (!TOKEN.test(token)) {
    throw new Error(
      `invalid id token ${JSON.stringify(token)}: expected [A-Za-z0-9_-]+ with no dots`,
    );
  }
}

/** Build an id from tokens: `topoId('base', 'profile', 'seg2')`. */
export function topoId(...tokens: readonly string[]): TopoId {
  if (tokens.length === 0) throw new Error('topoId needs at least one token');
  for (const t of tokens) assertToken(t);
  return tokens.join('.') as TopoId;
}

/** Extend an id with one more token. */
export function child<T extends string>(parent: T, token: string): T {
  assertToken(token);
  return `${parent}.${token}` as T;
}

export function parts(id: string): string[] {
  return id.split('.');
}

/** The id one level up, or null for a root id. */
export function parent(id: string): string | null {
  const i = id.lastIndexOf('.');
  return i < 0 ? null : id.slice(0, i);
}

export function isDescendantOf(id: string, ancestor: string): boolean {
  return id === ancestor || id.startsWith(`${ancestor}.`);
}

export function featureId(name: string): FeatureId {
  assertToken(name);
  return name as FeatureId;
}

export function faceId(...tokens: readonly string[]): FaceId {
  return topoId(...tokens) as string as FaceId;
}

export function bendId(...tokens: readonly string[]): BendId {
  return topoId(...tokens) as string as BendId;
}

export function cornerId(...tokens: readonly string[]): CornerId {
  return topoId(...tokens) as string as CornerId;
}

/**
 * A document-unique handle for one part.
 *
 * Parts in a multi-part document are addressed by this, never by their position
 * in the array — same rule as the geometry, and for the same reason: inserting
 * a part above another must not silently repoint anything at it.
 *
 * Derived from what the user already typed rather than being a hidden field, so
 * the id in an error message is recognisable as the part on screen.
 */
export function partId(name: string): PartId {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (slug === '') {
    throw new Error(
      `cannot make a part id from ${JSON.stringify(name)}: give the part a name with letters or digits in it`,
    );
  }
  return slug as PartId;
}
