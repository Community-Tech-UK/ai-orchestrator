import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LoopCoordinator, type LoopChildInvocationCallbackResult, type LoopChildResult } from './loop-coordinator';
import { CompletedFileWatcher } from './loop-completion-detector';
import { defaultLoopConfig } from '../../shared/types/loop.types';
import { COPILOT_LIMIT_FIXTURES } from '../cli/copilot-limit-fixtures.test-helpers';
import { CliDetectionService, type DetectionResult } from '../cli/cli-detection';

vi.mock('../core/config/settings-manager', () => ({ getSettingsManager: () => ({ get: () => undefined,
  getAll: () => ({ providerAccountProfiles: [], providerAccountPools: {}, auxiliaryLlmRoutingClassificationEnabled: false }) }) }));

describe('Copilot limits through the real loop coordinator', () => {
  let workspace: string;
  let coordinator: LoopCoordinator;
  beforeEach(() => {
    // Model routing precedes our injected reply. Keep these limit-handling
    // tests independent of CLI installs and version probes on the host.
    const available = [{ name: 'copilot', command: 'copilot', displayName: 'Copilot', installed: true }];
    const detection: DetectionResult = { detected: available, available, unavailable: [], timestamp: new Date() };
    vi.spyOn(CliDetectionService.prototype, 'detectAll').mockResolvedValue(detection);
    workspace = mkdtempSync(join(tmpdir(), 'copilot-limits-'));
    vi.spyOn(CompletedFileWatcher.prototype, 'start').mockImplementation(() => undefined);
    vi.spyOn(CompletedFileWatcher.prototype, 'stop').mockResolvedValue();
    vi.spyOn(CompletedFileWatcher.prototype, 'scanOnce').mockReturnValue(null);
    coordinator = new LoopCoordinator();
    coordinator.setLoopMemoryStore({ surfaceLearnings: async () => [], recordLearning: async () => undefined });
    coordinator.setProviderLimitResumeScheduler(() => vi.fn());
  });
  afterEach(async () => {
    for (const loop of coordinator.getActiveLoops()) await coordinator.cancelLoop(loop.id);
    vi.restoreAllMocks();
    rmSync(workspace, { recursive: true, force: true });
  });
  async function start(provider: 'copilot' | 'claude' = 'copilot') {
    const defaults = defaultLoopConfig(workspace, 'continue task');
    return coordinator.startLoop('chat', { ...defaults, provider, blockSanityProbe: { enabled: false },
      degradedIterationRetry: { enabled: true, maxRetries: 0 },
      completion: { ...defaults.completion, verifyCommand: '', requireCompletedFileRename: false },
      audit: { ...defaults.audit, preflightMode: 'off', finalAuditMode: 'off' } });
  }
  function result(output: string): LoopChildResult {
    return { childInstanceId: null, output, tokens: 0, filesChanged: [], toolCalls: [], errors: [],
      testPassCount: null, testFailCount: null, exitedCleanly: true };
  }
  it.each(['reply', 'error'] as const)('parks a weekly-limit %s once without counting a round', async (delivery) => {
    let calls = 0;
    const notices: unknown[] = [];
    coordinator.on('loop:provider-limit', (notice) => notices.push(notice));
    coordinator.on('loop:invoke-iteration', ({ callback }: { callback: (r: LoopChildInvocationCallbackResult) => void }) => {
      calls++;
      const text = COPILOT_LIMIT_FIXTURES[3][0];
      callback(delivery === 'reply' ? result(`Checked the task.\n${text}`) : { error: text });
    });
    const s = await start();
    await vi.waitFor(() => expect(coordinator.getLoop(s.id)?.status).toBe('provider-limit'));
    expect(coordinator.getLoop(s.id)).toMatchObject({ totalIterations: 0, endedAt: null });
    expect(coordinator.getIterations(s.id)).toEqual([]);
    expect(calls).toBe(1);
    expect(notices).toHaveLength(1);
  });
  it.each(['reply', 'error'] as const)('recycles a session-spend %s once then stops on its second notice', async (delivery) => {
    const resets: boolean[] = [];
    coordinator.on('loop:invoke-iteration', ({ callback, forceContextReset }: { callback: (r: LoopChildInvocationCallbackResult) => void; forceContextReset: boolean }) => {
      resets.push(forceContextReset);
      const text = COPILOT_LIMIT_FIXTURES[4][0];
      callback(delivery === 'reply' ? result(text) : { error: text });
    });
    const s = await start();
    await vi.waitFor(() => expect(coordinator.getLoop(s.id)?.endedAt).not.toBeNull());
    expect(coordinator.getLoop(s.id)).toMatchObject({ status: 'provider-limit', totalIterations: 0, endReason: expect.stringContaining('twice') });
    expect(resets).toEqual([false, true]);
  });
});
