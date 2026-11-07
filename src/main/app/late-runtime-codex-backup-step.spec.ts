/**
 * Wiring check for the composed Codex backup startup step: the runtime step
 * must call `pruneCodexBackupsAtStartup` with the configured keep-3 setting,
 * so the single-deletion-actor policy (and its accounting) actually runs at
 * startup rather than only existing on disk.
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp/aio-codex-backup-step-test',
    getVersion: () => '0.0.0-test',
    isPackaged: false,
  },
}));

vi.mock('../core/config/settings-manager', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../core/config/settings-manager')>()),
  getSettingsManager: () => ({ get: (key: string) => (key === 'codexBackupKeepThree' ? true : undefined) }),
}));

vi.mock('../cli/adapters/codex/codex-backup-retention-policy', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../cli/adapters/codex/codex-backup-retention-policy')>()),
  pruneCodexBackupsAtStartup: vi.fn(),
}));

import type { InstanceManager } from '../instance/instance-manager';
import type { WindowManager } from '../window-manager';
import { createLateRuntimeInitializationSteps } from './late-runtime-initialization-steps';
import { pruneCodexBackupsAtStartup } from '../cli/adapters/codex/codex-backup-retention-policy';

describe('late runtime Codex backup pruning step', () => {
  it('runs the composed startup policy with the configured keep-3 setting', async () => {
    const steps = createLateRuntimeInitializationSteps({
      instanceManager: {} as InstanceManager,
      windowManager: {} as WindowManager,
      isStatelessExecProvider: () => false,
      getNodeLatencyForInstance: () => undefined,
      syncRemoteNodeMetricsToLoadBalancer: () => undefined,
    });
    const step = steps.find((candidate) => candidate.name === 'Codex backup pruning');
    expect(step).toBeDefined();
    await step!.fn();
    expect(pruneCodexBackupsAtStartup).toHaveBeenCalledExactlyOnceWith(true);
  });
});
