import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TurnFileBaselineService } from './turn-file-baseline';

const run = promisify(execFile);

describe('turn file counts when a whole directory is deleted', () => {
  let repo: string;
  let service: TurnFileBaselineService;

  beforeEach(async () => {
    repo = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'turn-directory-')));
    await run('git', ['init', '-q'], { cwd: repo });
    await fs.mkdir(join(repo, 'parent', 'removed', 'nested'), { recursive: true });
    await fs.writeFile(join(repo, 'parent', 'removed', 'tracked.txt'), 'tracked\n');
    await run('git', ['-c', 'core.hooksPath=/dev/null', 'add', '.'], { cwd: repo });
    await fs.writeFile(join(repo, 'parent', 'removed', 'nested', 'untracked.txt'), 'draft\n');
    await fs.writeFile(join(repo, 'kept.txt'), 'before\n');
    service = new TurnFileBaselineService();
    service.attach(new EventEmitter(), () => ({ workingDirectory: repo }));
    service.beginTurn('session', 'turn');
    await service.getResult('session', 'turn');
  });

  afterEach(async () => {
    await service.forget('session');
    await fs.rm(repo, { recursive: true, force: true });
  });

  it('counts tracked and baseline-only deletions alongside the rest of the turn', async () => {
    await fs.rm(join(repo, 'parent', 'removed'), { recursive: true });
    await fs.writeFile(join(repo, 'kept.txt'), 'after\n');
    service.settleTurn('session');
    expect(await service.getResult('session', 'turn')).toMatchObject({
      state: 'ready', total: 3, truncated: false,
      files: [
        { path: 'kept.txt', status: 'modified', added: 1, deleted: 1 },
        { path: 'parent/removed/nested/untracked.txt', status: 'deleted', added: 0, deleted: 1 },
        { path: 'parent/removed/tracked.txt', status: 'deleted', added: 0, deleted: 1 },
      ],
    });
  });

  it('counts a directory replaced by a file without losing its deleted descendants', async () => {
    await fs.rm(join(repo, 'parent', 'removed'), { recursive: true });
    await fs.writeFile(join(repo, 'parent', 'removed'), 'replacement\n');
    await fs.writeFile(join(repo, 'kept.txt'), 'after\n');
    service.settleTurn('session');
    expect(await service.getResult('session', 'turn')).toMatchObject({
      state: 'ready', total: 4, truncated: false,
      files: [
        { path: 'kept.txt', status: 'modified', added: 1, deleted: 1 },
        { path: 'parent/removed', status: 'added', added: 1, deleted: 0 },
        { path: 'parent/removed/nested/untracked.txt', status: 'deleted', added: 0, deleted: 1 },
        { path: 'parent/removed/tracked.txt', status: 'deleted', added: 0, deleted: 1 },
      ],
    });
  });

  it('still rejects deletions after settlement by checking the surviving parent', async () => {
    // Make the boundary deterministic without racing the capture's git child process.
    const boundary = performance.timeOrigin + performance.now();
    await fs.rm(join(repo, 'parent', 'removed'), { recursive: true });
    const { snapshotWorkingTree } = await import('./turn-snapshot-git');
    const objects = await fs.mkdtemp(join(tmpdir(), 'turn-directory-objects-'));
    try {
      const future = new Date(boundary + 10_000);
      await fs.utimes(join(repo, 'parent'), future, future);
      await expect(snapshotWorkingTree(repo, objects, undefined, boundary, [
        'parent/removed/nested/untracked.txt',
      ])).rejects.toThrow('folder changed after settlement');
    } finally {
      await fs.rm(objects, { recursive: true, force: true });
    }
  });
});
