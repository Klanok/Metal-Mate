/**
 * Serves the built app the way the Tauri webview does.
 *
 * The point of this harness is the CSP header. `vite dev` and `vite preview`
 * send no Content-Security-Policy at all, so a UI test against them cannot see
 * a whole class of failure that only exists in the packaged app — and one such
 * failure shipped: the geometry kernel could not start because the policy
 * allowed 'wasm-unsafe-eval' but not 'unsafe-eval'.
 *
 * Reading the policy out of tauri.conf.json rather than hard-coding it means
 * these tests exercise whatever the desktop build will actually enforce.
 */

import { createServer, type Server } from 'node:http';
import { readFile, readFileSync } from 'node:fs';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const DIST = join(here, '..', 'dist');

export const CSP: string = (
  JSON.parse(readFileSync(join(here, '..', 'src-tauri', 'tauri.conf.json'), 'utf8')) as {
    app: { security: { csp: string } };
  }
).app.security.csp;

const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.map': 'application/json',
};

export function serveDist(port: number): Promise<Server> {
  const server = createServer((req, res) => {
    const path = join(DIST, normalize((req.url ?? '/').split('?')[0] ?? '/'));
    const file = path.endsWith('/') || extname(path) === '' ? join(DIST, 'index.html') : path;
    readFile(file, (err, body) => {
      if (err !== null) {
        res.statusCode = 404;
        res.end('not found');
        return;
      }
      res.setHeader('Content-Type', MIME[extname(file)] ?? 'application/octet-stream');
      res.setHeader('Content-Security-Policy', CSP);
      res.end(body);
    });
  });
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}
