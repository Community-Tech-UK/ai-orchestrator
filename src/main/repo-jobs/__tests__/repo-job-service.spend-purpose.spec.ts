import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Instance, InstanceCreateConfig } from '../../../shared/types/instance.types';
import { resolveSpendPurpose } from '../../core/system/spend-purpose';
import { BackgroundTaskManager } from '../../tasks/background-task-manager';
import { RepoJobService, getRepoJobService } from '../repo-job-service';

/**
 * Step 6 (A0-S): a repo job is a Harness-started session, so the config handed
 * to `createInstance` must carry `spendPurpose: 'repo-job'`. Without it the
 * Costs page files the job's turns under "chat" (the agent id alone is not
 * a purpose). Kept apart from `repo-job-service.spec.ts` on purpose.
 */
vi.mock('../../workspace/git/vcs-manager', () => ({
  createVcsManager: (workingDirectory: string) => ({
    isGitRepository: () => true,
    findGitRoot: () => workingDirectory,
    getCurrentBranch: () => 'main',
    getBranches: () => [{ name: 'main', current: true }],
    getDefaultRemote: () => null,
    getStatus: () => ({
      branch: 'main', ahead: 0, behind: 0, staged: [], unstaged: [], untracked: [],
      hasChanges: false, isClean: true,
    }),
    getDiffBetween: () => ({ files: [], totalAdditions: 0, totalDeletions: 0 }),
    getDiffStats: () => ({ filesChanged: 0, insertions: 0, deletions: 0 }),
  }),
  isGitAvailable: () => true,
}));

describe('RepoJobService spend purpose (Step 6, A0-S)', () => {
  const tempDirs: string[] = [];

  beforeEach(() => {
    BackgroundTaskManager._resetForTesting();
    RepoJobService._resetForTesting();
  });

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('tags the job session so its turns file under repo-job', async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-job-spend-'));
    tempDirs.push(workspace);
    fs.writeFileSync(path.join(workspace, 'README.md'), '# test repo\n');
    const settled = {
      id: 'instance-1',
      status: 'idle',
      createdAt: Date.now(),
      outputBuffer: [{ id: 'm1', timestamp: Date.now(), type: 'assistant', content: 'Review complete' }],
    } as unknown as Instance;
    const createInstance = vi.fn(async (_config: InstanceCreateConfig) => settled);
    const service = getRepoJobService();
    service.initialize({
      instanceManager: {
        createInstance,
        getInstance: () => settled,
        waitForInstanceSettled: async () => settled,
        terminateInstance: async () => undefined,
      },
      sleep: async () => undefined,
    });

    const job = service.submitJob({ type: 'pr-review', workingDirectory: workspace, title: 'Review README' });
    await service.waitForJob(job.id, 5000);

    expect(createInstance).toHaveBeenCalledTimes(1);
    const config = createInstance.mock.calls[0]![0];
    expect(config.metadata).toMatchObject({ spendPurpose: 'repo-job', repoJobId: job.id });
    expect(resolveSpendPurpose({ metadata: config.metadata }).purpose).toBe('repo-job');
  });
});
