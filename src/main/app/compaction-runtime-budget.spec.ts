import { afterEach, expect, it, vi } from 'vitest';
import type { InstanceManager } from '../instance/instance-manager';
import type { WindowManager } from '../window-manager';
import { CompactionCoordinator } from '../context/compaction-coordinator';
import { setupCompactionCoordinator } from './compaction-runtime';

vi.mock('../core/config/settings-manager', () => ({ getSettingsManager: () => ({
  get: (key: string) => key === 'auxiliaryLlmSlotsJson' ? JSON.stringify({ compression: { maxInputTokens: 10 } }) : 0,
  on: vi.fn(),
}) }));
vi.mock('../conversation-ledger', () => ({ getConversationLedgerService: () => ({ listEvidence: async () => [] }) }));

afterEach(() => CompactionCoordinator._resetForTesting());

it('reports an insufficient configured compression budget and preserves the existing session', async () => {
  CompactionCoordinator._resetForTesting();
  const instance = { id: 'inst-budget', outputBuffer: [
    { id: 'm1', type: 'user' as const, content: 'one '.repeat(10000), timestamp: 1 },
    { id: 'm2', type: 'assistant' as const, content: 'two '.repeat(10000), timestamp: 2 },
    { id: 'm3', type: 'user' as const, content: 'latest', timestamp: 3 },
    { id: 'm4', type: 'assistant' as const, content: 'reply', timestamp: 4 },
  ] };
  const manager = {
    getAdapterRuntimeCapabilities: vi.fn(() => ({ supportsNativeCompaction: false })),
    getAdapter: vi.fn(() => ({})), getInstance: vi.fn(() => instance),
    restartFreshInstance: vi.fn(), sendInput: vi.fn(), emitOutputMessage: vi.fn(),
  } as unknown as InstanceManager;
  setupCompactionCoordinator(manager, { sendToRenderer: vi.fn() } as unknown as WindowManager);
  const result = await CompactionCoordinator.getInstance().compactInstance(instance.id, { keepLatestExchanges: 1 });
  expect(result.success).toBe(false);
  expect(manager.restartFreshInstance).not.toHaveBeenCalled();
  expect(manager.sendInput).not.toHaveBeenCalled();
  expect(manager.emitOutputMessage).toHaveBeenCalledWith(instance.id, expect.objectContaining({
    type: 'system', content: expect.stringMatching(/10-token.*Increase the compression input limit.*session was not restarted/),
  }));
});
