/// <reference types="vite/client" />

// Vite emits the Clipper2 WebAssembly binary as an asset and hands back its
// final URL; `initBooleans({ wasmUrl })` passes that to the kernel.
declare module '*.wasm?url' {
  const url: string;
  export default url;
}
