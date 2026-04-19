/**
 * Thin accessor module for Electron's `safeStorage` API.
 *
 * Why this exists as its own file:
 *   Production code calls `require('electron')` lazily to avoid importing
 *   Electron's main-process API during module init (which in some builds can
 *   trigger Keychain prompts or fail outside a running main process). When
 *   that `require('electron')` is invoked from vitest — outside a real
 *   Electron main process — the npm `electron` package's `index.js` returns
 *   a *string* (the path to the Electron binary), not the API. Vitest's
 *   `vi.mock('electron', factory)` reliably intercepts ESM `import`
 *   statements from the bare `electron` specifier, but does NOT intercept
 *   bare `require('electron')` calls that resolve through Node's native CJS
 *   path in some transform configurations.
 *
 *   Splitting the access into this single relative-path module gives tests
 *   a stable, mockable seam: they can do
 *     `vi.mock('./safe-storage-accessor', () => ({ getSafeStorage: () => fake }));`
 *   and be sure the seam is replaced, because vitest fully controls
 *   relative-path imports between project files.
 *
 *   Production behavior is unchanged: the `require('electron')` call is
 *   still deferred until the first time callers actually need safeStorage,
 *   so module import never touches Electron's main-process API.
 */

/**
 * Returns Electron's `safeStorage` API, resolved lazily on first call.
 *
 * Only call this from code paths that exist to encrypt or decrypt
 * on-disk session payloads — never at module-init time.
 */
export function getSafeStorage(): typeof import('electron').safeStorage {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const electron = require('electron') as typeof import('electron');
  return electron.safeStorage;
}
