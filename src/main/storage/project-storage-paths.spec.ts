import { describe, expect, it, vi } from 'vitest';
import * as path from 'node:path';

const electronHarness = vi.hoisted(() => {
  // require(+.ts) avoids ESM TDZ: vi.hoisted runs before import bindings initialize
  const { createElectronHarness } =
    require('../testing/electron-mock.ts') as typeof import('../testing/electron-mock');
  return createElectronHarness({ userDataPath: '/tmp/orchestrator-user-data' });
});
vi.mock('electron', () => electronHarness.module);

import { ProjectStoragePaths } from './project-storage-paths';

describe('ProjectStoragePaths', () => {
  it('derives stable project roots from the working directory', () => {
    const paths = new ProjectStoragePaths();

    const first = paths.getProjectRoot('/Users/test/My Project');
    const second = paths.getProjectRoot('/Users/test/My Project');
    const third = paths.getProjectRoot('/Users/test/Other Project');

    expect(first).toBe(second);
    expect(first).not.toBe(third);
    expect(first).toContain(path.join('/tmp/orchestrator-user-data', 'projects') + path.sep);
  });

  it('derives per-project session and checkpoint paths', () => {
    const paths = new ProjectStoragePaths();

    expect(paths.getSessionEventLogPath('/Users/test/repo', 'inst-1')).toContain(
      path.join('session-events', 'inst-1.jsonl'),
    );
    expect(paths.getShadowGitRoot('/Users/test/repo')).toContain(path.join('checkpoints', 'shadow-repo'));
    expect(paths.getAgentTreeRoot('/Users/test/repo')).toContain('agent-trees');
  });
});
