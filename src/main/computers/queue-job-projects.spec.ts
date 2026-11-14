import { describe, expect, it, vi } from 'vitest';
import type { QueueJobComputer, QueueJobProjectCheck } from '../../shared/types/plan-queue-computers.types';
import { QueueProjectSchema } from '../remote-node/queue-job-rpc-schemas';
import { knownQueueProjects, queueProjectKeyFor, remoteProjectChecker } from './queue-job-projects';

const PC: QueueJobComputer = { nodeId: 'pc', label: 'the Windows PC', takesJobs: true, paused: false, jobsAtOnce: 2, projects: {} };
const PASSED: QueueJobProjectCheck = { ok: true, checkedAt: 5, problem: null, summary: 'Checks took 43 s.' };

describe('queueProjectKeyFor', () => {
  it('names a repository by its folder and a fingerprint of its path, in a form a computer accepts', () => {
    const key = queueProjectKeyFor('/Users/me/work/my repo');
    expect(key).toMatch(/^my-repo-[0-9a-f]{8}$/);
    expect(QueueProjectSchema.safeParse(key).success).toBe(true);
  });

  it('tells two repositories with one folder name apart, and is stable', () => {
    expect(queueProjectKeyFor('/a/app')).not.toBe(queueProjectKeyFor('/b/app'));
    expect(queueProjectKeyFor('/a/app')).toBe(queueProjectKeyFor('/a/app'));
  });
});

describe('knownQueueProjects', () => {
  it('lists each repository once, in the order the runs came', () => {
    const projects = knownQueueProjects([{ workspaceCwd: '/work/b' }, { workspaceCwd: '/work/a' }, { workspaceCwd: '/work/b' }]);
    expect(projects).toEqual([
      { key: queueProjectKeyFor('/work/b'), name: 'b', repoRoot: '/work/b' },
      { key: queueProjectKeyFor('/work/a'), name: 'a', repoRoot: '/work/a' },
    ]);
  });
});

describe('remoteProjectChecker', () => {
  it('sends the repository\'s branch to the named computer', async () => {
    const projectCheck = vi.fn().mockResolvedValue(PASSED);
    const check = remoteProjectChecker({ projectCheck }, { list: () => [PC] }, async () => 'main');
    await expect(check('pc', '/work/repo')).resolves.toBe(PASSED);
    expect(projectCheck).toHaveBeenCalledWith({ computer: { nodeId: 'pc', label: 'the Windows PC' }, repoRoot: '/work/repo', baseBranch: 'main' });
  });

  it('refuses an unpaired computer and a repository that is not on a branch, before sending anything', async () => {
    const projectCheck = vi.fn();
    const check = remoteProjectChecker({ projectCheck }, { list: () => [PC] }, async () => '');
    await expect(check('stranger', '/work/repo')).rejects.toThrow(/not paired/);
    await expect(check('pc', '/work/repo')).rejects.toThrow(/not on a branch/);
    expect(projectCheck).not.toHaveBeenCalled();
  });
});
