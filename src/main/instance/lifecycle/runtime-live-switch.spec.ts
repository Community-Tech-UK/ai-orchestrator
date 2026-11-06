/**
 * Live model/effort switch for resident Claude sessions (A8.3, Step 14d).
 *
 * Guards the fall-through contract: anything suspicious returns false and
 * changes nothing on the instance, so the existing replay path takes over.
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('../../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('./create-validation-helpers', () => ({
  getKnownModelsForCli: vi.fn(async () => ['claude-opus-4-8', 'claude-sonnet-4-6']),
}));

import type { Instance } from '../../../shared/types/instance.types';
import type { RuntimeDiff } from './runtime-reconciler.types';
import { canTryLiveSwitch, resolveLiveModel, tryLiveClaudeSwitch } from './runtime-live-switch';
import { getKnownModelsForCli } from './create-validation-helpers';

function makeDiff(overrides: Partial<RuntimeDiff> = {}): RuntimeDiff {
  return {
    providerChanged: false,
    modelChanged: true,
    reasoningChanged: false,
    runtimeTargetChanged: false,
    yoloModeChanged: false,
    copilotAccountChanged: false,
    accountProfileChanged: false,
    hasChanges: true,
    ...overrides,
  };
}

function makeInstance(overrides: Partial<Instance> = {}): Instance {
  return {
    id: 'inst-1',
    provider: 'claude',
    currentModel: 'claude-sonnet-4-6',
    reasoningEffort: 'high',
    contextUsage: {
      used: 50_000,
      total: 200_000,
      percentage: 25,
      occupancyReported: true,
      occupancyIsAggregate: false,
    },
    executionLocation: { type: 'local' },
    ...overrides,
  } as unknown as Instance;
}

function residentAdapter(result: { ok: boolean; reason?: string } = { ok: true }) {
  return {
    applyLiveRuntime: vi.fn(async () => result),
    getAdapterCapabilities: () => ({ residentSession: true }),
  };
}

const noopOwner = {
  assertCurrent: () => undefined,
  emitSystemNotice: vi.fn(),
  queueUpdate: vi.fn(),
  emitRuntimeChanged: vi.fn(),
};

describe('canTryLiveSwitch', () => {
  it('is true for a model-only change on a resident Claude adapter', () => {
    expect(canTryLiveSwitch({
      diff: makeDiff(), desired: { provider: 'claude' as const, model: 'claude-opus-4-8' },
      instance: makeInstance(), adapter: residentAdapter(),
    })).toBe(true);
  });

  it('is true for an effort-only change', () => {
    expect(canTryLiveSwitch({
      diff: makeDiff({ modelChanged: false, reasoningChanged: true }),
      desired: { provider: 'claude' as const, reasoningEffort: 'low' },
      instance: makeInstance(),
      adapter: residentAdapter(),
    })).toBe(true);
  });

  it('is false for provider, account, yolo and remote changes', () => {
    const base = {
      desired: { provider: 'claude' as const, model: 'claude-opus-4-8' },
      instance: makeInstance(),
      adapter: residentAdapter(),
    };
    expect(canTryLiveSwitch({ ...base, diff: makeDiff({ providerChanged: true }) })).toBe(false);
    expect(canTryLiveSwitch({ ...base, diff: makeDiff({ accountProfileChanged: true }) })).toBe(false);
    expect(canTryLiveSwitch({ ...base, diff: makeDiff({ copilotAccountChanged: true }) })).toBe(false);
    expect(canTryLiveSwitch({ ...base, diff: makeDiff({ yoloModeChanged: true }) })).toBe(false);
    expect(canTryLiveSwitch({
      ...base,
      diff: makeDiff({ runtimeTargetChanged: true }),
    })).toBe(false);
    expect(canTryLiveSwitch({
      ...base,
      diff: makeDiff(),
      instance: makeInstance({ executionLocation: { type: 'remote', nodeId: 'n1' } as never }),
    })).toBe(false);
  });

  it('is false for a non-Claude provider, a non-resident adapter and workflow effort', () => {
    const base = {
      diff: makeDiff(),
      desired: { provider: 'claude' as const, model: 'claude-opus-4-8' },
      instance: makeInstance(),
      adapter: residentAdapter(),
    };
    expect(canTryLiveSwitch({ ...base, instance: makeInstance({ provider: 'codex' }) })).toBe(false);
    expect(canTryLiveSwitch({
      ...base,
      adapter: { applyLiveRuntime: vi.fn(), getAdapterCapabilities: () => ({ residentSession: false }) },
    })).toBe(false);
    expect(canTryLiveSwitch({ ...base, adapter: {} })).toBe(false);
    expect(canTryLiveSwitch({
      ...base,
      diff: makeDiff({ modelChanged: false, reasoningChanged: true }),
      desired: { provider: 'claude' as const, reasoningEffort: 'workflow' },
    })).toBe(false);
    expect(canTryLiveSwitch({
      ...base,
      diff: makeDiff({ modelChanged: false, reasoningChanged: false }),
    })).toBe(false);
  });
});

describe('resolveLiveModel', () => {
  it('returns null for an absent model and an unknown id', async () => {
    expect(await resolveLiveModel(undefined)).toBeNull();
    expect(await resolveLiveModel('gpt-not-a-claude-model')).toBeNull();
  });

  it('returns a known Claude id', async () => {
    expect(await resolveLiveModel('claude-opus-4-8')).toBe('claude-opus-4-8');
  });

  it('falls back to replay when the model catalog cannot be read', async () => {
    vi.mocked(getKnownModelsForCli).mockRejectedValueOnce(new Error('catalog unavailable'));
    expect(await resolveLiveModel('claude-opus-4-8')).toBeNull();
  });
});

describe('tryLiveClaudeSwitch', () => {
  it('switches in place and updates the instance on success', async () => {
    const instance = makeInstance();
    const adapter = residentAdapter();
    const emitSystemNotice = vi.fn();
    const queueUpdate = vi.fn();
    const emitRuntimeChanged = vi.fn();
    const ok = await tryLiveClaudeSwitch({
      diff: makeDiff(),
      desired: { provider: 'claude' as const, model: 'claude-opus-4-8' },
      instance,
      adapter,
      oldModel: 'claude-sonnet-4-6',
      oldReasoningEffort: 'high',
      assertCurrent: () => undefined,
      emitSystemNotice,
      queueUpdate,
      emitRuntimeChanged,
    });
    expect(ok).toBe(true);
    expect(adapter.applyLiveRuntime).toHaveBeenCalledWith({ model: 'claude-opus-4-8' });
    expect(instance.currentModel).toBe('claude-opus-4-8');
    expect(emitSystemNotice).toHaveBeenCalledWith(
      instance,
      expect.stringContaining('Switched from claude-sonnet-4-6 to claude-opus-4-8 in place'),
      expect.anything(),
    );
    expect(queueUpdate).toHaveBeenCalled();
    expect(emitRuntimeChanged).toHaveBeenCalledWith(expect.objectContaining({
      instanceId: 'inst-1',
      model: 'claude-opus-4-8',
    }));
  });

  it('returns false and changes nothing when the CLI refuses', async () => {
    const instance = makeInstance();
    const adapter = residentAdapter({ ok: false, reason: 'mismatch' });
    const ok = await tryLiveClaudeSwitch({
      diff: makeDiff(),
      desired: { provider: 'claude' as const, model: 'claude-opus-4-8' },
      instance,
      adapter,
      oldModel: 'claude-sonnet-4-6',
      oldReasoningEffort: 'high',
      ...noopOwner,
    });
    expect(ok).toBe(false);
    expect(instance.currentModel).toBe('claude-sonnet-4-6');
    expect(instance.contextUsage.used).toBe(50_000);
    expect(noopOwner.emitSystemNotice).not.toHaveBeenCalled();
    expect(noopOwner.queueUpdate).not.toHaveBeenCalled();
  });

  it('returns false and changes nothing when applyLiveRuntime throws', async () => {
    const instance = makeInstance();
    const adapter = {
      applyLiveRuntime: vi.fn(async () => { throw new Error('timeout'); }),
      getAdapterCapabilities: () => ({ residentSession: true }),
    };
    const ok = await tryLiveClaudeSwitch({
      diff: makeDiff(),
      desired: { provider: 'claude' as const, model: 'claude-opus-4-8' },
      instance,
      adapter,
      oldModel: 'claude-sonnet-4-6',
      oldReasoningEffort: 'high',
      ...noopOwner,
    });
    expect(ok).toBe(false);
    expect(instance.currentModel).toBe('claude-sonnet-4-6');
    expect(noopOwner.emitSystemNotice).not.toHaveBeenCalled();
  });

  it('falls through when the model cannot be resolved to a live id', async () => {
    const instance = makeInstance();
    const adapter = residentAdapter();
    const ok = await tryLiveClaudeSwitch({
      diff: makeDiff(),
      desired: { provider: 'claude' as const, model: 'not-a-claude-model' },
      instance,
      adapter,
      oldModel: 'claude-sonnet-4-6',
      oldReasoningEffort: 'high',
      ...noopOwner,
    });
    expect(ok).toBe(false);
    expect(adapter.applyLiveRuntime).not.toHaveBeenCalled();
    expect(instance.currentModel).toBe('claude-sonnet-4-6');
  });

  it('passes the effort on an effort-only change', async () => {
    const instance = makeInstance();
    const adapter = residentAdapter();
    const ok = await tryLiveClaudeSwitch({
      diff: makeDiff({ modelChanged: false, reasoningChanged: true }),
      desired: { provider: 'claude' as const, reasoningEffort: 'low' },
      instance,
      adapter,
      oldModel: 'claude-sonnet-4-6',
      oldReasoningEffort: 'high',
      ...noopOwner,
    });
    expect(ok).toBe(true);
    expect(adapter.applyLiveRuntime).toHaveBeenCalledWith({ effort: 'low' });
    expect(instance.reasoningEffort).toBe('low');
  });

  describe('the notice James reads', () => {
    it('says the model switched and names the new price for a model change', async () => {
      const emitSystemNotice = vi.fn();
      const instance = makeInstance();
      await tryLiveClaudeSwitch({
        diff: makeDiff(),
        desired: { provider: 'claude' as const, model: 'claude-opus-4-8' },
        instance,
        adapter: residentAdapter(),
        oldModel: 'claude-sonnet-4-6',
        oldReasoningEffort: 'high',
        ...noopOwner,
        emitSystemNotice,
      });
      expect(emitSystemNotice).toHaveBeenCalledOnce();
      expect(emitSystemNotice.mock.calls[0]?.[1]).toBe(
        'Switched from claude-sonnet-4-6 to claude-opus-4-8 in place. '
        + 'The whole conversation, including tool results, was kept. '
        + "The next reply re-reads it at the new model's price (about 50K tokens).",
      );
      expect(emitSystemNotice.mock.calls[0]?.[2]).toEqual({ source: 'runtime-live-switch', method: 'live-switch' });
    });

    it.each([
      ['placeholder zero', { used: 0, occupancyReported: false }],
      ['unreported value', { used: 70_000 }],
      ['aggregate spend', { used: 87_000, occupancyReported: true, occupancyIsAggregate: true }],
      ['reported zero', { used: 0, occupancyReported: true }],
      ['invalid occupancy', { used: Number.NaN, occupancyReported: true }],
    ])('omits the size for %s while retaining the price warning', async (_label, usage) => {
      const emitSystemNotice = vi.fn();
      const instance = makeInstance({ contextUsage: { total: 200_000, percentage: 0, ...usage } });
      await tryLiveClaudeSwitch({
        diff: makeDiff(),
        desired: { provider: 'claude', model: 'claude-opus-4-8' },
        instance, adapter: residentAdapter(), oldModel: 'claude-sonnet-4-6', oldReasoningEffort: 'high',
        ...noopOwner, emitSystemNotice,
      });
      expect(emitSystemNotice.mock.calls[0]?.[1]).toBe(
        'Switched from claude-sonnet-4-6 to claude-opus-4-8 in place. '
        + 'The whole conversation, including tool results, was kept. '
        + "The next reply re-reads it at the new model's price.",
      );
      expect(instance.contextUsage.used).toBe(usage.used);
    });

    it('says only the thinking level changed for an effort-only change', async () => {
      const emitSystemNotice = vi.fn();
      const instance = makeInstance({ reasoningEffort: 'low' });
      await tryLiveClaudeSwitch({
        diff: makeDiff({ modelChanged: false, reasoningChanged: true }),
        desired: { provider: 'claude' as const, reasoningEffort: 'high' },
        instance,
        adapter: residentAdapter(),
        oldModel: 'claude-sonnet-4-6',
        oldReasoningEffort: 'low',
        ...noopOwner,
        emitSystemNotice,
      });
      expect(emitSystemNotice).toHaveBeenCalledOnce();
      const text = emitSystemNotice.mock.calls[0]?.[1] as string;
      expect(text).toBe('Thinking changed from low to high in place; the conversation was kept.');
      expect(text).not.toMatch(/model|price|tokens|Switched/i);
      expect(emitSystemNotice.mock.calls[0]?.[2]).toEqual({ source: 'runtime-live-switch', method: 'live-switch' });
    });

    it.each([
      [null, 'the default'],
      [undefined, 'the default'],
    ] as const)('names %s old effort as %s', async (oldEffort, spoken) => {
      const emitSystemNotice = vi.fn();
      await tryLiveClaudeSwitch({
        diff: makeDiff({ modelChanged: false, reasoningChanged: true }),
        desired: { provider: 'claude' as const, reasoningEffort: 'medium' },
        instance: makeInstance({ reasoningEffort: undefined }),
        adapter: residentAdapter(),
        oldModel: 'claude-sonnet-4-6',
        oldReasoningEffort: oldEffort,
        ...noopOwner,
        emitSystemNotice,
      });
      expect(emitSystemNotice.mock.calls[0]?.[1]).toBe(
        `Thinking changed from ${spoken} to medium in place; the conversation was kept.`,
      );
    });

    it('keeps the model wording when the model and the thinking level change together', async () => {
      const emitSystemNotice = vi.fn();
      await tryLiveClaudeSwitch({
        diff: makeDiff({ reasoningChanged: true }),
        desired: { provider: 'claude' as const, model: 'claude-opus-4-8', reasoningEffort: 'low' },
        instance: makeInstance(),
        adapter: residentAdapter(),
        oldModel: 'claude-sonnet-4-6',
        oldReasoningEffort: 'high',
        ...noopOwner,
        emitSystemNotice,
      });
      expect(emitSystemNotice.mock.calls[0]?.[1]).toContain('Switched from claude-sonnet-4-6 to claude-opus-4-8 in place.');
      expect(emitSystemNotice.mock.calls[0]?.[1]).toContain("new model's price");
    });
  });

  describe('context meter re-base after a verified switch', () => {
    const usage = (used: number, total: number) => ({
      used, total, percentage: (used / total) * 100,
      occupancyReported: true, occupancyIsAggregate: false,
    });

    it('re-bases a 200K meter to the new 1M window, keeping the used tokens', async () => {
      const instance = makeInstance({ contextUsage: usage(50_000, 200_000) });
      const queueUpdate = vi.fn();
      const emitSystemNotice = vi.fn();
      const ok = await tryLiveClaudeSwitch({
        diff: makeDiff(),
        desired: { provider: 'claude' as const, model: 'claude-opus-4-8' },
        instance,
        adapter: residentAdapter(),
        oldModel: 'claude-sonnet-4-6',
        oldReasoningEffort: 'high',
        assertCurrent: () => undefined,
        emitSystemNotice,
        queueUpdate,
        emitRuntimeChanged: vi.fn(),
      });
      expect(ok).toBe(true);
      expect(instance.contextUsage).toMatchObject({ used: 50_000, total: 1_000_000, percentage: 5 });
      // Carried over untouched by the re-base.
      expect(instance.contextUsage.occupancyReported).toBe(true);
      // The renderer is told the re-based meter, and the notice quotes its `used`.
      expect(queueUpdate.mock.calls[0]?.[2]).toBe(instance.contextUsage);
      expect(emitSystemNotice.mock.calls[0]?.[1]).toContain('about 50K tokens');
    });

    it('re-bases a 1M meter down to the new 200K window and recomputes the percentage', async () => {
      vi.mocked(getKnownModelsForCli).mockResolvedValueOnce(['claude-haiku-4-5']);
      const instance = makeInstance({
        currentModel: 'claude-opus-4-8',
        contextUsage: usage(150_000, 1_000_000),
      });
      const ok = await tryLiveClaudeSwitch({
        diff: makeDiff(),
        desired: { provider: 'claude' as const, model: 'claude-haiku-4-5' },
        instance,
        adapter: residentAdapter(),
        oldModel: 'claude-opus-4-8',
        oldReasoningEffort: 'high',
        ...noopOwner,
      });
      expect(ok).toBe(true);
      expect(instance.contextUsage).toMatchObject({ used: 150_000, total: 200_000, percentage: 75 });
    });

    it('leaves the meter alone on an effort-only change (window unchanged)', async () => {
      const instance = makeInstance({ contextUsage: usage(50_000, 1_000_000) });
      const ok = await tryLiveClaudeSwitch({
        diff: makeDiff({ modelChanged: false, reasoningChanged: true }),
        desired: { provider: 'claude' as const, reasoningEffort: 'low' },
        instance,
        adapter: residentAdapter(),
        oldModel: 'claude-sonnet-4-6',
        oldReasoningEffort: 'high',
        ...noopOwner,
      });
      expect(ok).toBe(true);
      expect(instance.contextUsage).toMatchObject({ used: 50_000, total: 1_000_000, percentage: 5 });
    });
  });
});
