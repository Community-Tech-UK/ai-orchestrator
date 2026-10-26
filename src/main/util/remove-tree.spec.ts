import { execFile } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { removeTree } from './remove-tree';

const roots: string[] = [];
afterEach(() => { roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })); });

/** A checkout-shaped tree with an `.asar` file inside, as `node_modules/electron` has. */
function treeWithAsar(): { root: string; tree: string } {
  const electronBinary = createRequire(import.meta.url)('electron') as string;
  const asar = [
    join(dirname(electronBinary), '..', 'Resources', 'default_app.asar'),
    join(dirname(electronBinary), 'resources', 'default_app.asar'),
  ].find(existsSync);
  if (!asar) throw new Error(`No default_app.asar beside ${electronBinary}`);
  const root = mkdtempSync(join(tmpdir(), 'aio-remove-tree-'));
  roots.push(root);
  const tree = join(root, 'worktree');
  const resources = join(tree, '_scratch', 'node_modules', 'electron', 'dist', 'Resources');
  mkdirSync(resources, { recursive: true });
  copyFileSync(asar, join(resources, 'default_app.asar'));
  writeFileSync(join(tree, 'README.md'), 'work');
  return { root, tree };
}

describe('removeTree', () => {
  // Electron's fs.promises.rm fails with ENOTEMPTY here, leaving the tree
  // half-removed, and with retries (as worktree cleanup asks) never settles.
  it('removes a tree holding an .asar file inside Electron, with and without retries', async () => {
    const plain = treeWithAsar().tree;
    const retried = treeWithAsar().tree;
    const script = String.raw`
      require('tsx/cjs');
      const path = require('node:path');
      const { removeTree } = require(path.join(process.cwd(), 'src/main/util/remove-tree.ts'));
      const timer = setTimeout(() => { console.log('hung'); process.exit(2); }, 8000);
      Promise.allSettled([removeTree(process.argv[1]), removeTree(process.argv[2], { maxRetries: 3, retryDelay: 100 })])
        .then((results) => {
          clearTimeout(timer);
          console.log(results.map((r) => r.status === 'fulfilled' ? 'removed' : 'failed ' + r.reason.code).join(' '));
        });
    `;
    const { stdout } = await promisify(execFile)(createRequire(import.meta.url)('electron') as string,
      ['-e', script, plain, retried], { cwd: process.cwd(), env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 15_000 });
    expect(stdout.trim()).toBe('removed removed');
    expect(existsSync(plain)).toBe(false);
    expect(existsSync(retried)).toBe(false);
  }, 20_000);

  it('removes the same tree under plain Node and ignores a missing path', async () => {
    const { tree } = treeWithAsar();
    await removeTree(tree);
    expect(existsSync(tree)).toBe(false);
    await expect(removeTree(tree)).resolves.toBeUndefined();
  });
});
