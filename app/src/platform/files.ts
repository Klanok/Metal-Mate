/**
 * File access, one interface over two hosts.
 *
 * Under Tauri this is the real native save/open dialog. Loaded in a plain
 * browser — which is how `npm run dev` and the smoke tests run it — it falls
 * back to a download and a file picker, so the whole UI stays exercisable
 * without a desktop build.
 *
 * The Tauri plugins are imported dynamically. A static import would pull
 * desktop-only code into the browser bundle and fail at load.
 */

export interface FileFilter {
  readonly name: string;
  readonly extensions: readonly string[];
}

export interface OpenedFile {
  readonly name: string;
  readonly contents: string;
}

/** True when running inside the Tauri webview rather than a plain browser. */
export function isDesktop(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/**
 * Save text to a user-chosen file.
 * Returns the path written, or null if the user cancelled.
 */
export async function saveTextFile(
  suggestedName: string,
  contents: string,
  filters: readonly FileFilter[],
): Promise<string | null> {
  if (isDesktop()) {
    const [{ save }, { writeTextFile }] = await Promise.all([
      import('@tauri-apps/plugin-dialog'),
      import('@tauri-apps/plugin-fs'),
    ]);
    const path = await save({
      defaultPath: suggestedName,
      filters: filters.map((f) => ({ name: f.name, extensions: [...f.extensions] })),
    });
    if (path === null) return null;
    await writeTextFile(path, contents);
    return path;
  }
  downloadInBrowser(suggestedName, contents);
  return suggestedName;
}

/** Read a user-chosen text file, or null if the user cancelled. */
export async function openTextFile(filters: readonly FileFilter[]): Promise<OpenedFile | null> {
  if (isDesktop()) {
    const [{ open }, { readTextFile }] = await Promise.all([
      import('@tauri-apps/plugin-dialog'),
      import('@tauri-apps/plugin-fs'),
    ]);
    const path = await open({
      multiple: false,
      directory: false,
      filters: filters.map((f) => ({ name: f.name, extensions: [...f.extensions] })),
    });
    if (path === null || Array.isArray(path)) return null;
    return { name: path, contents: await readTextFile(path) };
  }
  return pickInBrowser(filters);
}

function downloadInBrowser(name: string, contents: string): void {
  const blob = new Blob([contents], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function pickInBrowser(filters: readonly FileFilter[]): Promise<OpenedFile | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    const accept = filters.flatMap((f) => f.extensions.map((e) => `.${e}`)).join(',');
    if (accept !== '') input.accept = accept;
    input.onchange = () => {
      const file = input.files?.[0];
      if (file === undefined) {
        resolve(null);
        return;
      }
      void file.text().then((contents) => resolve({ name: file.name, contents }));
    };
    // A cancelled picker fires no event in some browsers, so the promise simply
    // never settles; that is harmless here because nothing awaits it forever.
    input.click();
  });
}
