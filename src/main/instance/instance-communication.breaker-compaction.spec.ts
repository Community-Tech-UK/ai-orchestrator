import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Instance, OutputMessage } from '../../shared/types/instance.types';
import type { CliAdapter } from '../cli/adapters/adapter-factory';
import { InstanceCommunicationManager } from './instance-communication';
import { compactForOverflow } from './overflow-compaction-route';
import { captureOverflowRecoveryOwner } from './overflow-recovery-owner';

vi.mock('../core/config/settings-manager', () => ({ getSettingsManager: () => ({
  getAll: () => ({ outputBufferSize: 500, enableDiskStorage: false }),
}) }));
vi.mock('../memory/output-storage', () => ({ getOutputStorageManager: () => ({}) }));
vi.mock('../hooks/hook-manager', () => ({ getHookManager: () => ({}) }));
vi.mock('../memory/token-stats', () => ({ getTokenStatsService: () => ({
  record: vi.fn(), classifyToolType: () => 'assistant',
}) }));
vi.mock('../rlm/token-counter', () => ({ getTokenCounter: () => ({ countTokens: () => 1 }) }));
vi.mock('../session/session-continuity', () => ({ getSessionContinuityManagerIfInitialized: () => undefined }));

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

function setup(mode: 'buffers-only' | 'native' | 'restart-with-summary' | 'restart-refused' | 'no-outcome') {
  const restart = mode === 'restart-with-summary' || mode === 'restart-refused';
  const instance = {
    id: `breaker-${mode}`, sessionId: 'fixture-session', providerSessionId: 'fixture-session',
    provider: restart ? 'gemini' : 'claude', status: 'busy', parentId: null, agentId: 'build',
    restartEpoch: 0, adapterGeneration: 0, requestCount: 1, outputBuffer: [],
    contextUsage: { used: 1000, total: 1_000_000, percentage: 0.1 },
  } as unknown as Instance;
  const native = vi.fn(async () => true);
  const adapter = Object.assign(new EventEmitter(), {
    getName: () => restart ? 'gemini-cli' : 'claude-cli',
    getSessionId: () => instance.sessionId,
    ...(mode === 'native' ? { compactContext: native } : {}),
  }) as unknown as CliAdapter;
  const compactBuffers = vi.fn();
  const compactInstance = vi.fn(async () => ({
    success: mode !== 'restart-refused', method: 'restart-with-summary' as const,
  }));
  const compactContext = vi.fn((id: string) => mode === 'no-outcome' ? Promise.resolve(undefined) : compactForOverflow({
    getInstance: () => instance, getAdapter: () => adapter, compactBuffers, compactInstance,
    emitSystemNotice: (_instance, content) => manager.emitSystemOutput(id, {
      id: 'trim-notice', type: 'system', content, timestamp: Date.now(),
    }),
  }, id, undefined, captureOverflowRecoveryOwner(id, () => instance, () => adapter)));
  const manager = new InstanceCommunicationManager({
    getInstance: () => instance, getAdapter: () => adapter, compactContext,
    setAdapter: vi.fn(), deleteAdapter: () => false, queueUpdate: vi.fn(),
    processOrchestrationOutput: vi.fn(), onInterruptedExit: vi.fn(async () => undefined),
    ingestToRLM: vi.fn(), ingestToUnifiedMemory: vi.fn(),
  });
  manager.setupAdapterEvents(instance.id, adapter);
  cleanups.push(() => { adapter.removeAllListeners(); manager.cleanupCircuitBreaker(instance.id); });
  const messages: OutputMessage[] = [];
  manager.on('output', ({ message }: { message: OutputMessage }) => messages.push(message));
  return { adapter, instance, manager, messages, native, compactContext, compactBuffers, compactInstance };
}

describe('empty-response breaker through actual overflow routing', () => {
  it.each(['buffers-only', 'native', 'restart-with-summary', 'restart-refused', 'no-outcome'] as const)(
    'reports the actual %s recovery without claiming buffers-only compacted the provider', async mode => {
      const f = setup(mode);
      for (let i = 0; i < 3; i++) f.adapter.emit('output', {
        id: `empty-${i}`, type: 'assistant', content: '', timestamp: Date.now(),
      });
      await vi.waitFor(() => {
        expect(f.compactContext).toHaveBeenCalledOnce();
        expect(f.manager.isCircuitTripped(f.instance.id)).toBe(false);
      });
      const trimmed = mode === 'buffers-only' || mode === 'restart-refused';
      const compacted = mode === 'native' || mode === 'restart-with-summary';
      expect(f.messages.filter(message => message.metadata?.['circuitBreakerTripped'])).toHaveLength(1);
      expect(f.messages.filter(message => message.content.includes("own session is unchanged"))).toHaveLength(trimmed ? 1 : 0);
      expect(f.messages.filter(message => message.metadata?.['circuitBreakerRecovered'])).toHaveLength(compacted ? 1 : 0);
      expect(f.messages.filter(message => message.content === 'Context compacted. You can continue the conversation.'))
        .toHaveLength(compacted ? 1 : 0);
      expect(f.native).toHaveBeenCalledTimes(mode === 'native' ? 1 : 0);
      expect(f.compactInstance).toHaveBeenCalledTimes(mode.startsWith('restart') ? 1 : 0);
      // The breaker has no interrupted request to replay or send a second time.
      if (mode.startsWith('restart')) {
        expect(f.compactInstance.mock.calls[0]).toEqual([f.instance.id, {
          trigger: 'overflow', recoveryOwner: expect.any(Object),
        }]);
      }
    },
  );
});
