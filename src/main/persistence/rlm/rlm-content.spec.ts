import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { getDirectorySize, getDirectorySizeAsync } from './rlm-content';

describe('getDirectorySizeAsync', () => {
  const roots: string[] = [];

  function makeRoot(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rlm-content-size-'));
    roots.push(root);
    return root;
  }

  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  it('sums files in nested folders, matching the synchronous walk', async () => {
    const root = makeRoot();
    fs.mkdirSync(path.join(root, 'ab', 'deeper'), { recursive: true });
    fs.writeFileSync(path.join(root, 'top.txt'), 'x'.repeat(3));
    fs.writeFileSync(path.join(root, 'ab', 'one.txt'), 'x'.repeat(5));
    // More files than one stat batch, so batching is exercised.
    for (let index = 0; index < 70; index += 1) {
      fs.writeFileSync(path.join(root, 'ab', 'deeper', `${index}.txt`), 'x'.repeat(2));
    }

    await expect(getDirectorySizeAsync(root)).resolves.toBe(3 + 5 + 70 * 2);
    await expect(getDirectorySizeAsync(root)).resolves.toBe(getDirectorySize(root));
  });

  it('counts files deleted while the walk runs as 0 instead of failing', async () => {
    const root = makeRoot();
    const doomed: string[] = [];
    for (let prefix = 0; prefix < 20; prefix += 1) {
      const folder = path.join(root, `p${prefix}`);
      fs.mkdirSync(folder);
      for (let index = 0; index < 50; index += 1) {
        const file = path.join(folder, `${index}.txt`);
        fs.writeFileSync(file, 'x');
        if (index % 10 === 0) doomed.push(file);
      }
    }
    const lastFolder = path.join(root, 'p19');

    const walk = getDirectorySizeAsync(root);
    // Delete while the walk is between steps, as RLM section deletes do.
    setImmediate(() => {
      for (const file of doomed) fs.rmSync(file, { force: true });
      fs.rmSync(lastFolder, { recursive: true, force: true });
    });
    const size = await walk;

    expect(size).toBeGreaterThan(0);
    expect(size).toBeLessThanOrEqual(1_000);
  });

  it('rejects for a missing folder, like the synchronous walk', async () => {
    const missing = path.join(makeRoot(), 'missing');

    await expect(getDirectorySizeAsync(missing)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
