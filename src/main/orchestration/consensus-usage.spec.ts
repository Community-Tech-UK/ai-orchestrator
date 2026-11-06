import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ detectAll: vi.fn(), createAdapter: vi.fn(), recordModelCall: vi.fn() }));
vi.mock('../logging/logger', () => ({ getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));
vi.mock('../cli/cli-detection', () => ({ CliDetectionService: { getInstance: () => ({ detectAll: mocks.detectAll }) } }));
vi.mock('../providers/provider-runtime-service', () => ({ getProviderRuntimeService: () => ({ createAdapter: mocks.createAdapter }) }));
vi.mock('../instance/lifecycle/provider-route-preflight', () => ({ attachProviderRoutes: async (_type: unknown, options: unknown) => options }));
vi.mock('../core/system/model-call-recorder', () => ({ recordModelCall: mocks.recordModelCall }));
vi.mock('./utils/coordinator-error-handler', () => ({ handleCoordinatorError: (error: unknown) => ({ classified: { category: 'unknown', message: String(error) } }) }));

import { ConsensusCoordinator } from './consensus-coordinator';
import { markProviderDispatchNotStarted } from '../cli/adapters/provider-dispatch-status';

class BilledAdapter extends EventEmitter {
  spawn = vi.fn(async () => 123);
  sendInput = vi.fn(async () => {
    this.emit('output', { id: 'answer', timestamp: Date.now(), type: 'assistant', content: 'Use option A.' });
    this.emit('status', 'idle');
  });
  terminate = vi.fn(async () => {
    this.emit('usage', { inputTokens: 100, outputTokens: 20, cost: 0.25 });
  });
}

afterEach(() => {
  ConsensusCoordinator._resetForTesting();
  vi.clearAllMocks();
});

describe('consensus billing drain', () => {
  it('records the final native usage emitted during adapter termination once', async () => {
    const adapter = new BilledAdapter();
    mocks.detectAll.mockResolvedValue({ available: [{ name: 'claude' }] });
    mocks.createAdapter.mockReturnValue(adapter);

    const result = await ConsensusCoordinator.getInstance().query('Which option?', undefined, {
      providers: [{ provider: 'claude' }], workingDirectory: '/tmp/project', timeout: 1,
    });

    expect(result.successCount).toBe(1);
    expect(adapter.terminate).toHaveBeenCalledOnce();
    expect(mocks.recordModelCall).toHaveBeenCalledOnce();
    expect(mocks.recordModelCall).toHaveBeenCalledWith(expect.objectContaining({
      purpose: 'consensus', provider: 'claude', outcome: 'success',
      usage: expect.objectContaining({ inputTokens: 100, outputTokens: 20, cost: 0.25 }),
    }));
    for (const event of ['usage', 'complete', 'error', 'output', 'status', 'exit']) {
      expect(adapter.listenerCount(event)).toBe(0);
    }
  });

  it('keeps a failed voter bill when usage arrives during termination', async () => {
    const adapter = new BilledAdapter();
    adapter.sendInput.mockImplementation(async () => {
      adapter.emit('error', new Error('provider refused the vote'));
    });
    mocks.detectAll.mockResolvedValue({ available: [{ name: 'claude' }] });
    mocks.createAdapter.mockReturnValue(adapter);

    const result = await ConsensusCoordinator.getInstance().query('Which option?', undefined, {
      providers: [{ provider: 'claude' }], workingDirectory: '/tmp/project', timeout: 1,
    });

    expect(result.failureCount).toBe(1);
    expect(mocks.recordModelCall).toHaveBeenCalledOnce();
    expect(mocks.recordModelCall).toHaveBeenCalledWith(expect.objectContaining({
      purpose: 'consensus', outcome: 'error', usage: expect.objectContaining({ cost: 0.25 }),
    }));
  });

  it.each([
    ['zero', { inputTokens: 0, outputTokens: 0, cost: 0 }],
    ['unknown', undefined],
  ] as const)('records a dispatched %s cost without fabricating a paid amount', async (_label, usage) => {
    const adapter = new BilledAdapter();
    adapter.terminate.mockImplementation(async () => { if (usage) adapter.emit('usage', usage); });
    mocks.detectAll.mockResolvedValue({ available: [{ name: 'claude' }] });
    mocks.createAdapter.mockReturnValue(adapter);

    const result = await ConsensusCoordinator.getInstance().query('Which option?', undefined, {
      providers: [{ provider: 'claude' }], workingDirectory: '/tmp/project', timeout: 1,
    });

    expect(result.successCount).toBe(1);
    expect(mocks.recordModelCall).toHaveBeenCalledOnce();
    const row = mocks.recordModelCall.mock.calls[0]?.[0] as { usage?: { cost?: number } };
    expect(row.usage?.cost).toBe(usage?.cost);
  });

  it('does not bill a voter that failed before provider dispatch', async () => {
    const adapter = new BilledAdapter();
    adapter.sendInput.mockRejectedValue(markProviderDispatchNotStarted(new Error('local preflight refused')));
    adapter.terminate.mockResolvedValue(undefined);
    mocks.detectAll.mockResolvedValue({ available: [{ name: 'claude' }] });
    mocks.createAdapter.mockReturnValue(adapter);

    const result = await ConsensusCoordinator.getInstance().query('Which option?', undefined, {
      providers: [{ provider: 'claude' }], workingDirectory: '/tmp/project', timeout: 1,
    });

    expect(result.failureCount).toBe(1);
    expect(adapter.terminate).toHaveBeenCalledOnce();
    expect(mocks.recordModelCall).not.toHaveBeenCalled();
  });
});
