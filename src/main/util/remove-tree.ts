import type { RmOptions } from 'node:fs';
import * as fs from 'node:fs/promises';

/**
 * Delete a file or folder tree, like `rm -rf`.
 *
 * Use this instead of `fs.promises.rm` for any tree Harness did not write
 * itself: checkouts, `node_modules` copies, agent output. Inside Electron, `fs`
 * treats every `.asar` file as a folder, and a recursive `fs.promises.rm` over
 * a tree holding one (every `node_modules/electron` does) fails half-done or,
 * with retries, never settles. On
 * 2026-10-26 one such delete held the shared Git write queue, and every Plan
 * Queue item behind it stopped. `original-fs` is Electron's unpatched `fs`.
 */
export async function removeTree(target: string, options: Omit<RmOptions, 'recursive'> = {}): Promise<void> {
  await unpatchedRm()(target, { force: true, ...options, recursive: true });
}

function unpatchedRm(): typeof fs.rm {
  if (!process.versions.electron) return fs.rm;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return (require('original-fs') as typeof import('node:fs')).promises.rm;
}
