import type { RmOptions } from 'node:fs';
import { unpatchedFs } from './unpatched-fs';

/**
 * Delete a file or folder tree, like `rm -rf`.
 *
 * Use this instead of `fs.promises.rm` for any tree Harness did not write
 * itself: checkouts, `node_modules` copies, agent output. Inside Electron, `fs`
 * treats every `.asar` file as a folder, and a recursive `fs.promises.rm` over
 * a tree holding one (every `node_modules/electron` does) fails half-done or,
 * with retries, never settles. On
 * 2026-10-26 one such delete held the shared Git write queue, and every Plan
 * Queue item behind it stopped. See `unpatched-fs.ts`.
 */
export async function removeTree(target: string, options: Omit<RmOptions, 'recursive'> = {}): Promise<void> {
  await unpatchedFs().promises.rm(target, { force: true, ...options, recursive: true });
}
