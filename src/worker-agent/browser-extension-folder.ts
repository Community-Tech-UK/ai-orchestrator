import * as fs from 'fs';
import * as path from 'path';

/**
 * The unpacked Chrome extension folder for this worker, when it runs from a
 * source checkout (`dist/worker-agent/index.js` or `src/worker-agent/*.ts`,
 * both two levels below the checkout). A standalone binary ships no extension
 * folder, so this returns undefined there.
 */
export function workerBrowserExtensionFolder(moduleDir: string = __dirname): string | undefined {
  const folder = path.resolve(moduleDir, '..', '..', 'resources', 'browser-extension');
  return fs.existsSync(path.join(folder, 'manifest.json')) ? folder : undefined;
}
