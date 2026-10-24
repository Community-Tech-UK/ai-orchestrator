import { spawn } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkWorktreeProcesses, listFolderProcessPids } from './leftover-worktree-processes';

describe.skipIf(process.platform === 'win32')('worktree process lookup', () => {
  it('finds a process working inside the folder, and nothing in an empty one', async (ctx) => {
    const folder = realpathSync(mkdtempSync(join(tmpdir(), 'leftover-folder-')));
    const empty = realpathSync(mkdtempSync(join(tmpdir(), 'leftover-empty-')));
    const child = spawn('sleep', ['30'], { cwd: folder, stdio: 'ignore' });
    try {
      await new Promise(resolve => child.once('spawn', resolve));
      const pids = await listFolderProcessPids(folder);
      // lsof can be missing or refused (fail-closed null): report a skip, never a silent pass.
      if (pids === null) {
        ctx.skip();
        return;
      }
      expect(pids.has(child.pid!)).toBe(true);
      expect(await listFolderProcessPids(empty)).toEqual(new Set());
      expect(await checkWorktreeProcesses(folder)).toEqual({ checked: true, live: true });
    } finally {
      child.kill('SIGKILL');
      rmSync(folder, { recursive: true, force: true });
      rmSync(empty, { recursive: true, force: true });
    }
  }, 40_000);
});
