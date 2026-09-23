/**
 * Unit tests for the renderer-facing path sandbox (FILE_READ_TEXT /
 * FILE_READ_BYTES / FILE_WRITE_TEXT gate in app-handlers.ts).
 *
 * Uses real temp directories rather than an fs mock: the symlink cases are
 * the whole point, and a fake filesystem would only prove the fake resolves
 * links the way the test author expected.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const electronPaths = vi.hoisted(() => ({
  userData: '',
  temp: '',
  home: '',
}));

vi.mock('electron', () => ({
  app: {
    getPath: (name: 'userData' | 'temp' | 'home') => electronPaths[name],
  },
}));

type PathValidatorModule = typeof import('./path-validator');

async function loadValidator(): Promise<PathValidatorModule> {
  // ALLOWED_ROOTS is module state; a fresh module per test keeps roots isolated.
  vi.resetModules();
  return import('./path-validator');
}

describe('path-validator', () => {
  let sandbox: string;
  let allowedRoot: string;
  let outsideDir: string;

  beforeEach(() => {
    // realpath the sandbox so macOS's /var -> /private/var link does not leak
    // into assertions about `resolved`.
    sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aio-path-validator-')));
    allowedRoot = path.join(sandbox, 'allowed');
    outsideDir = path.join(sandbox, 'outside');
    fs.mkdirSync(allowedRoot, { recursive: true });
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.writeFileSync(path.join(allowedRoot, 'inside.txt'), 'inside');
    fs.writeFileSync(path.join(outsideDir, 'secret.txt'), 'secret');
  });

  afterEach(() => {
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  describe('with no roots configured', () => {
    it('allows any path (validator not yet initialized)', async () => {
      const { validatePath } = await loadValidator();
      const result = validatePath(path.join(outsideDir, 'secret.txt'));
      expect(result.valid).toBe(true);
    });

    it('still rejects null bytes', async () => {
      const { validatePath } = await loadValidator();
      const result = validatePath(`${allowedRoot}/evil\0.txt`);
      expect(result).toMatchObject({ valid: false, error: 'Path contains null byte' });
    });
  });

  describe('with an allowed root', () => {
    it('accepts an existing file inside the root', async () => {
      const { addAllowedRoot, validatePath } = await loadValidator();
      addAllowedRoot(allowedRoot);
      const result = validatePath(path.join(allowedRoot, 'inside.txt'));
      expect(result).toEqual({ valid: true, resolved: path.join(allowedRoot, 'inside.txt') });
    });

    it('accepts the root itself', async () => {
      const { addAllowedRoot, validatePath } = await loadValidator();
      addAllowedRoot(allowedRoot);
      expect(validatePath(allowedRoot).valid).toBe(true);
    });

    it('accepts a not-yet-existing file in not-yet-existing subdirectories (write with createDirs)', async () => {
      const { addAllowedRoot, validatePath } = await loadValidator();
      addAllowedRoot(allowedRoot);
      const target = path.join(allowedRoot, 'new', 'deeper', 'file.txt');
      const result = validatePath(target);
      expect(result).toEqual({ valid: true, resolved: target });
    });

    it('rejects a path outside every root', async () => {
      const { addAllowedRoot, validatePath } = await loadValidator();
      addAllowedRoot(allowedRoot);
      const result = validatePath(path.join(outsideDir, 'secret.txt'));
      expect(result.valid).toBe(false);
      expect(result.error).toContain('Path outside allowed directories');
    });

    it('rejects ../ traversal out of the root', async () => {
      const { addAllowedRoot, validatePath } = await loadValidator();
      addAllowedRoot(allowedRoot);
      const result = validatePath(path.join(allowedRoot, '..', 'outside', 'secret.txt'));
      expect(result.valid).toBe(false);
    });

    it('rejects a sibling that only shares the root as a string prefix', async () => {
      const { addAllowedRoot, validatePath } = await loadValidator();
      addAllowedRoot(allowedRoot);
      fs.mkdirSync(`${allowedRoot}-evil`);
      const result = validatePath(path.join(`${allowedRoot}-evil`, 'x.txt'));
      expect(result.valid).toBe(false);
    });

    it('ignores an empty root and de-duplicates repeated roots', async () => {
      const { addAllowedRoot, validatePath } = await loadValidator();
      addAllowedRoot('');
      addAllowedRoot(allowedRoot);
      addAllowedRoot(`${allowedRoot}${path.sep}`);
      expect(validatePath(path.join(allowedRoot, 'inside.txt')).valid).toBe(true);
      expect(validatePath(path.join(outsideDir, 'secret.txt')).valid).toBe(false);
    });
  });

  describe('symlinks', () => {
    it('rejects a file symlink inside the root that points outside it', async () => {
      const { addAllowedRoot, validatePath } = await loadValidator();
      addAllowedRoot(allowedRoot);
      const link = path.join(allowedRoot, 'link-to-secret.txt');
      fs.symlinkSync(path.join(outsideDir, 'secret.txt'), link);

      const result = validatePath(link);

      expect(result.valid).toBe(false);
      expect(result.error).toContain('Path outside allowed directories');
    });

    it('rejects a path through a directory symlink that escapes the root', async () => {
      const { addAllowedRoot, validatePath } = await loadValidator();
      addAllowedRoot(allowedRoot);
      const dirLink = path.join(allowedRoot, 'escape');
      fs.symlinkSync(outsideDir, dirLink, 'dir');

      expect(validatePath(path.join(dirLink, 'secret.txt')).valid).toBe(false);
      // Not-yet-existing file under the escaping directory (a write target).
      expect(validatePath(path.join(dirLink, 'new-file.txt')).valid).toBe(false);
    });

    it('rejects a dangling symlink whose target would be created outside the root', async () => {
      const { addAllowedRoot, validatePath } = await loadValidator();
      addAllowedRoot(allowedRoot);
      const link = path.join(allowedRoot, 'dangling.txt');
      fs.symlinkSync(path.join(outsideDir, 'created-by-write.txt'), link);

      expect(validatePath(link).valid).toBe(false);
    });

    it('accepts a symlink that stays inside the root and resolves to its target', async () => {
      const { addAllowedRoot, validatePath } = await loadValidator();
      addAllowedRoot(allowedRoot);
      const link = path.join(allowedRoot, 'alias.txt');
      fs.symlinkSync(path.join(allowedRoot, 'inside.txt'), link);

      expect(validatePath(link)).toEqual({
        valid: true,
        resolved: path.join(allowedRoot, 'inside.txt'),
      });
    });

    it('accepts paths under a root that is itself reached through a symlink', async () => {
      const { addAllowedRoot, validatePath } = await loadValidator();
      const rootLink = path.join(sandbox, 'root-link');
      fs.symlinkSync(allowedRoot, rootLink, 'dir');
      addAllowedRoot(rootLink);

      expect(validatePath(path.join(rootLink, 'inside.txt')).valid).toBe(true);
      expect(validatePath(path.join(rootLink, 'not-yet.txt')).valid).toBe(true);
    });

    it('rejects a symlink loop instead of throwing', async () => {
      const { addAllowedRoot, validatePath } = await loadValidator();
      addAllowedRoot(allowedRoot);
      const a = path.join(allowedRoot, 'loop-a');
      const b = path.join(allowedRoot, 'loop-b');
      fs.symlinkSync(b, a);
      fs.symlinkSync(a, b);

      const result = validatePath(a);
      expect(result.valid).toBe(false);
    });
  });

  describe('initializePathValidator', () => {
    it('allows the electron userData/temp/home roots and process.cwd()', async () => {
      electronPaths.userData = path.join(sandbox, 'userData');
      electronPaths.temp = path.join(sandbox, 'temp');
      electronPaths.home = allowedRoot;
      const { initializePathValidator, validatePath } = await loadValidator();
      initializePathValidator();

      expect(validatePath(path.join(sandbox, 'userData', 'a.json')).valid).toBe(true);
      expect(validatePath(path.join(sandbox, 'temp', 'b.txt')).valid).toBe(true);
      expect(validatePath(path.join(allowedRoot, 'inside.txt')).valid).toBe(true);
      expect(validatePath(path.join(process.cwd(), 'package.json')).valid).toBe(true);
      expect(validatePath(path.join(outsideDir, 'secret.txt')).valid).toBe(false);
    });
  });
});
