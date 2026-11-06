import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../../shared/types/settings.types';
const state = vi.hoisted(() => ({ coordinator: null as unknown as EventEmitter, create: vi.fn() }));
vi.mock('./loop-coordinator', () => ({ getLoopCoordinator: () => state.coordinator }));
vi.mock('../logging/logger', () => ({ getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));
vi.mock('../cli/adapters/adapter-factory', () => ({ resolveCliType: async () => 'claude' }));
vi.mock('../providers/provider-runtime-service', () => ({ getProviderRuntimeService: () => ({ createAdapter: state.create }) }));
vi.mock('../core/config/settings-manager', () => ({ getSettingsManager: () => ({ getAll: () => DEFAULT_SETTINGS, get: (key: keyof typeof DEFAULT_SETTINGS) => DEFAULT_SETTINGS[key] }) }));
vi.mock('../core/circuit-breaker', () => ({ getCircuitBreakerRegistry: () => ({ getBreaker: () => ({ execute: async (fn: () => unknown) => fn() }) }) }));
vi.mock('./loop-output-externalize', () => ({ maybeExternalizeLoopOutput: async (text: string) => text }));
import { registerDefaultLoopInvoker } from './default-invokers';
import { _resetLoopAccountFailoverForTesting } from '../providers/account-pool/loop-account-failover';
import { _resetAdapterLoansForTesting } from '../instance/lifecycle/adapter-loan-registry';
describe('loop context reset wording', () => {
  afterEach(() => { _resetLoopAccountFailoverForTesting(); _resetAdapterLoansForTesting(); });
  it('emits the neutral clean-context message after recycling an existing adapter', async () => {
    const workspaceCwd = mkdtempSync(join(tmpdir(), 'phase5-context-reset-'));
    try {
    state.coordinator = Object.assign(new EventEmitter(), { registerIterationHook: vi.fn(() => () => undefined) });
    state.create.mockImplementation(() => Object.assign(new EventEmitter(), {
      sendMessage: async () => ({ content: 'ok', usage: { totalTokens: 10 } }),
      initializeForRequest: async () => undefined, terminate: async () => undefined, setResume: vi.fn(),
    }));
    registerDefaultLoopInvoker({ getInstance: () => undefined, getAllInstances: () => [] } as never);
    const activities: string[] = [];
    state.coordinator.on('loop:activity', (activity) => activities.push(activity.message));
    const invoke = (seq: number, forceContextReset: boolean) => new Promise((resolve) => state.coordinator.emit('loop:invoke-iteration', {
      correlationId: `reset:${seq}`, loopRunId: 'reset', chatId: 'chat', provider: 'claude', workspaceCwd,
      stage: 'IMPLEMENT', seq, prompt: 'Continue', config: { contextStrategy: 'same-session' },
      idempotencyKey: `reset:${seq}`, forceContextReset, callback: resolve,
    }));
    await invoke(0, false); await invoke(1, true);
    expect(activities).toContain('Started this round with a clean context');
    } finally {
      state.coordinator.emit('loop:state-changed', { loopRunId: 'reset', state: { status: 'completed' } });
      rmSync(workspaceCwd, { recursive: true, force: true });
    }
  });
});
