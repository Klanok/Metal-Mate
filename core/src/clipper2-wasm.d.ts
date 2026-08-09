/**
 * The shipped clipper2-wasm types are generated from emscripten bindings and
 * are awkward to consume. `geometry/boolean.ts` declares exactly the surface we
 * depend on and casts through this, so a version bump breaks at that one
 * boundary rather than scattering `any` through the geometry code.
 */
declare module 'clipper2-wasm/dist/es/clipper2z.js' {
  const factory: () => Promise<unknown>;
  export default factory;
}
