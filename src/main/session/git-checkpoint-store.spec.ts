import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => path.join(os.tmpdir(), 'orchestrator-git-checkpoint-tests')),
  },
}));

import { GitCheckpointStore } from './git-checkpoint-store';

async function runGit(cwd: string, args: string[]): Promise<void> {
  const { execFile } = await import('node:child_process');
  await new Promise<void>((resolve, reject) => {
    execFile('git', args, { cwd }, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

describe('GitCheckpointStore', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'git-checkpoint-store-'));
  });

  it('creates a real ref for git workspaces without modifying the live index', async () => {
    await runGit(tempDir, ['init']);
    await runGit(tempDir, ['config', 'user.name', 'Test User']);
    await runGit(tempDir, ['config', 'user.email', 'test@example.com']);
    await fs.writeFile(path.join(tempDir, 'file.txt'), 'hello\n', 'utf-8');
    await runGit(tempDir, ['add', 'file.txt']);
    await runGit(tempDir, ['commit', '-m', 'initial']);
    await fs.writeFile(path.join(tempDir, 'file.txt'), 'changed\n', 'utf-8');

    const store = new GitCheckpointStore();
    const summary = await store.createCheckpoint({
      checkpointId: 'cp-1',
      sessionId: 'sess-1',
      workingDirectory: tempDir,
    });

    expect(summary.mode).toBe('git');
    expect(summary.ref).toContain('refs/orchestrator/checkpoints/sess-1/cp-1');
  });

  it('falls back to a shadow repository for non-git workspaces', async () => {
    await fs.writeFile(path.join(tempDir, 'plain.txt'), 'hello\n', 'utf-8');

    const store = new GitCheckpointStore();
    const summary = await store.createCheckpoint({
      checkpointId: 'cp-2',
      sessionId: 'sess-2',
      workingDirectory: tempDir,
    });

    expect(summary.mode).toBe('shadow');
    expect(summary.repoRoot).toContain('shadow-repo');
  });
});
