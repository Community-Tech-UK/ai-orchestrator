import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/tmp/orchestrator-user-data'),
  },
}));

import { ProjectStoragePaths } from './project-storage-paths';

describe('ProjectStoragePaths', () => {
  it('derives stable project roots from the working directory', () => {
    const paths = new ProjectStoragePaths();

    const first = paths.getProjectRoot('/Users/test/My Project');
    const second = paths.getProjectRoot('/Users/test/My Project');
    const third = paths.getProjectRoot('/Users/test/Other Project');

    expect(first).toBe(second);
    expect(first).not.toBe(third);
    expect(first).toContain('/tmp/orchestrator-user-data/projects/');
  });

  it('derives per-project session and checkpoint paths', () => {
    const paths = new ProjectStoragePaths();

    expect(paths.getSessionEventLogPath('/Users/test/repo', 'inst-1')).toMatch(/session-events\/inst-1\.jsonl$/);
    expect(paths.getShadowGitRoot('/Users/test/repo')).toMatch(/checkpoints\/shadow-repo$/);
    expect(paths.getAgentTreeRoot('/Users/test/repo')).toMatch(/agent-trees$/);
  });
});
