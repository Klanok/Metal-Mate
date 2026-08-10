/**
 * The desktop app's Content Security Policy.
 *
 * This exists because of a real failure: the shipped v0.1.0 build started with
 * "could not load the geometry kernel: EvalError" and every panel was dead,
 * because the CSP allowed 'wasm-unsafe-eval' but not 'unsafe-eval'.
 *
 * Clipper2 reaches us as an Emscripten module, and embind generates its C++
 * method invokers with `new Function(...)`. 'wasm-unsafe-eval' only permits
 * compiling WebAssembly; it does not permit that. So the kernel — and with it
 * unfolding, validation and export — cannot start without 'unsafe-eval'.
 *
 * A browser smoke test cannot catch this: `vite dev` and `vite preview` serve
 * no CSP at all, so the policy only ever bites inside the Tauri webview. These
 * assertions are the cheap standing check that the desktop build stays
 * loadable.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(
  readFileSync(join(here, '..', 'src-tauri', 'tauri.conf.json'), 'utf8'),
) as { app: { security: { csp: string } } };

const csp = config.app.security.csp;

function directive(name: string): string {
  const found = csp
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name} `));
  return found ?? '';
}

describe('desktop content security policy', () => {
  it('lets the Emscripten geometry kernel start', () => {
    const scriptSrc = directive('script-src');
    expect(scriptSrc).toContain("'wasm-unsafe-eval'");
    // The one that actually broke the shipped build.
    expect(scriptSrc).toContain("'unsafe-eval'");
  });

  it('still refuses remote script and content by default', () => {
    expect(directive('default-src')).toBe("default-src 'self'");
    expect(directive('script-src')).toContain("'self'");
    for (const bad of ['http://*', 'https://*', '*']) {
      expect(directive('script-src').split(/\s+/)).not.toContain(bad);
    }
  });

  it('keeps the Tauri IPC endpoints reachable', () => {
    const connectSrc = directive('connect-src');
    expect(connectSrc).toContain('ipc:');
    expect(connectSrc).toContain('http://ipc.localhost');
  });
});
