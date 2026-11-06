import { beforeEach, expect, it, vi } from 'vitest';
import type { Instance } from '../../../shared/types/instance.types';

const mocks = vi.hoisted(() => ({
  continuity: { updateState: vi.fn(), writeThroughIdentityLocked: vi.fn() },
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../logging/logger', () => ({ getLogger: () => mocks.logger }));
vi.mock('../../session/session-continuity', () => ({ getSessionContinuityManagerIfInitialized: () => mocks.continuity }));
vi.mock('../../providers/account-pool/provider-account-store', () => ({
  getProviderAccountStore: () => ({
    getProfile: () => ({ id: 'example-mimo-b', provider: 'opencode', label: 'Example B', region: 'ams', isLegacy: false }),
    getPoolPolicy: () => ({ continuation: 'shared-store' }),
  }),
}));
vi.mock('../../providers/account-pool/provider-account-routing-service', () => ({
  getProviderAccountRoutingService: () => ({ admit: async () => ({ ok: true }) }),
}));
import { snapshotAccount, tryAccountSwitchInPlace } from './runtime-reconciler-account-handoff';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.continuity.updateState.mockResolvedValue(undefined);
  mocks.continuity.writeThroughIdentityLocked.mockResolvedValue(undefined);
});

it.each(['updateState', 'writeThroughIdentityLocked'] as const)(
  'publishes the actual in-place account and warns when %s fails', async failure => {
    mocks.continuity[failure].mockRejectedValueOnce(new Error('Example session storage failure'));
    const instance = {
      id: 'example-instance', provider: 'opencode', status: 'idle',
      currentModel: 'xiaomi-token-plan-ams/mimo-v2.6-pro', reasoningEffort: 'low',
      accountProfileId: 'legacy', accountSwitches: 0, sessionId: 'example-native-session',
      outputBuffer: [], contextUsage: { used: 0, total: 200000 },
    } as unknown as Instance;
    const adapter = { applyLiveSessionConfig: vi.fn(async () => undefined),
      sendInput: vi.fn(async () => undefined), queueNextPromptContext: vi.fn() };
    const emitSystemNotice = vi.fn();
    const queueUpdate = vi.fn();
    const emitRuntimeChanged = vi.fn();
    await expect(tryAccountSwitchInPlace({
      instance, adapter, oldAccount: snapshotAccount(instance),
      desired: { provider: 'opencode', accountProfileId: 'example-mimo-b', accountHandoffKind: 'failover' },
      assertCurrent: () => undefined, emitSystemNotice, queueUpdate, emitRuntimeChanged,
    })).resolves.toBe(true);
    expect(adapter.applyLiveSessionConfig).toHaveBeenCalledWith({ model: 'aio-mimo-example-mimo-b/mimo-v2.6-pro', effort: 'low' });
    expect(instance.accountProfileId).toBe('example-mimo-b');
    expect(emitSystemNotice).toHaveBeenCalledWith(instance, expect.stringContaining('could not save'));
    expect(mocks.logger.warn).toHaveBeenCalled();
    expect(queueUpdate).toHaveBeenCalledOnce();
    expect(emitRuntimeChanged).toHaveBeenCalledOnce();
    expect(adapter.sendInput).not.toHaveBeenCalled();
  },
);
