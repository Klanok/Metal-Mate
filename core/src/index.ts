/**
 * @metal-mate/core — the sheet metal domain library.
 *
 * Pure functions over immutable data. No DOM, no Tauri, no filesystem: this
 * package runs unchanged in Node for the test suite and in the UI process.
 *
 * Call `initBooleans()` once before unfolding or exporting; everything after
 * that is synchronous.
 */

export * from './units.js';
export * from './ids.js';

export * from './geometry/vec2.js';
export * from './geometry/vec3.js';
export * from './geometry/loop.js';
export * from './geometry/profile.js';
export * from './geometry/transform.js';
export * from './geometry/boolean.js';

export * from './model/graph.js';
export * from './model/corner.js';
export * from './model/assembly.js';

export * from './features/types.js';
export * from './features/regen.js';

export * from './materials/material.js';
export * from './materials/allowance.js';

export * from './machine/machineProfile.js';

export * from './unfold/unfold.js';
export * from './unfold/fold.js';

export * from './validate/report.js';
export * from './validate/validate.js';

export * from './templates/benchtop.js';

export * from './io/exportProfile.js';
export * from './io/dxfR12Writer.js';
export * from './io/dxfReader.js';
export * from './io/projectFile.js';

export * from './pipeline.js';
