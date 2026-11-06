import { describe, expect, it, vi } from 'vitest';
import { applyClaudeLiveRuntime, type LiveRuntimeChange, type LiveRuntimeHost } from '../../cli/adapters/claude-live-runtime';
import { tryLiveClaudeSwitch } from './runtime-live-switch';
import type { Instance } from '../../../shared/types/instance.types';

describe('provider-default effort reset', () => {
  it.each([null, 'low'] as const)('keeps resident and instance state truthful for %s', async effort => {
    let residentEffort = 'high';
    const commit = vi.fn();
    const requestControl = vi.fn<LiveRuntimeHost['requestControl']>(async (subtype, fields) => {
      if (subtype === 'apply_flag_settings') residentEffort = (fields['settings'] as { effortLevel: string }).effortLevel;
      return { ok: true, payload: { applied: { effort: residentEffort } } };
    });
    const instance = {
      id: 'effort-fixture', provider: 'claude', currentModel: 'claude-sonnet-4-6', reasoningEffort: 'high',
      contextUsage: { used: 1000, total: 200000, percentage: 0.5 }, executionLocation: { type: 'local' },
    } as Instance;
    const queueUpdate = vi.fn();
    const ok = await tryLiveClaudeSwitch({
      diff: { hasChanges: true, modelChanged: false, reasoningChanged: true, providerChanged: false,
        runtimeTargetChanged: false, yoloModeChanged: false, copilotAccountChanged: false, accountProfileChanged: false },
      desired: { provider: 'claude', reasoningEffort: effort }, instance,
      adapter: { getAdapterCapabilities: () => ({ residentSession: true }),
        applyLiveRuntime: (change: LiveRuntimeChange) => applyClaudeLiveRuntime({ requestControl, commit }, change) },
      oldModel: instance.currentModel, oldReasoningEffort: 'high', assertCurrent: () => undefined,
      emitSystemNotice: vi.fn(), queueUpdate, emitRuntimeChanged: vi.fn(),
    });
    if (effort === null) {
      expect(ok).toBe(false);
      expect(residentEffort).toBe('high');
      expect(instance.reasoningEffort).toBe('high');
      expect(requestControl).not.toHaveBeenCalled();
      expect(commit).not.toHaveBeenCalled();
      expect(queueUpdate).not.toHaveBeenCalled();
    } else {
      expect(ok).toBe(true);
      expect(residentEffort).toBe('low');
      expect(instance.reasoningEffort).toBe('low');
      expect(commit).toHaveBeenCalledWith(undefined, 'low');
    }
  });
});
