import { recordCostAttribution } from '../core/system/cost-attribution';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { InstanceManager } from '../instance/instance-manager';
import type { Instance } from '../../shared/types/instance.types';
import { pauseConsults } from '../work-admission/consult-admission';
import { getWorkAdmission, WorkAdmission } from '../work-admission/work-admission';
import {
  getReviewerSessionSpawner,
  ReviewerSessionSpawner,
} from './reviewer-session-spawner';

function mockInstance(id: string, assistantText: string) {
  return {
    id,
    status: 'idle',
    totalTokensUsed: 1000,
    readyPromise: Promise.resolve(),
    outputBuffer: [
      { id: 'm1', timestamp: 1, type: 'user', content: 'review this' },
      { id: 'm2', timestamp: 2, type: 'assistant', content: assistantText },
    ],
  };
}

function makeManager(overrides: Partial<InstanceManager> = {}): InstanceManager {
  const inst = mockInstance('rev-1', '```json\n{"verdict":"APPROVED"}\n```');
  return {
    createInstance: vi.fn().mockResolvedValue(inst),
    waitForInstanceSettled: vi.fn().mockResolvedValue(inst),
    getInstance: vi.fn().mockReturnValue(inst),
    terminateInstance: vi.fn().mockResolvedValue(undefined),
    interruptInstance: vi.fn(),
    sendInput: vi.fn().mockResolvedValue(undefined),
    exportSessionMarkdown: vi.fn().mockReturnValue(''),
    ...overrides,
  } as unknown as InstanceManager;
}

describe('ReviewerSessionSpawner', () => {
  afterEach(() => {
    ReviewerSessionSpawner._resetForTesting();
    WorkAdmission._resetForTesting();
  });

  it('fails cleanly when no InstanceManager is wired', async () => {
    const spawner = getReviewerSessionSpawner();
    const result = await spawner.runReviewSession({
      provider: 'codex',
      workingDirectory: '/tmp',
      prompt: 'review',
      timeoutMs: 1000,
    });
    expect(result.outcome).toBe('failed');
    expect(result.error).toContain('InstanceManager');
  });

  it('spawns root-level, awaits settle, reads output, and always tears down', async () => {
    const manager = makeManager({waitForInstanceSettled: vi.fn(async () => {
      recordCostAttribution({source:'instance-turn',taskType:'review',instanceId:'rev-1',provider:'claude',usage:{inputTokens:600,outputTokens:400,cost:0.25}});
      return mockInstance('rev-1', '{"verdict":"APPROVED"}') as Instance;
    })});
    const spawner = getReviewerSessionSpawner();
    spawner.setInstanceManager(manager);
    const onSpawned = vi.fn();

    const result = await spawner.runReviewSession({
      provider: 'codex',
      workingDirectory: '/repo',
      prompt: 'deep dive',
      timeoutMs: 5000,
      onSpawned,
    });

    expect(result.outcome).toBe('settled');
    expect(result.finalOutput).toContain('APPROVED');
    expect(result.tokensUsed).toBe(1000);
    expect(result.costCents).toBe(25);
    expect(result.exactCostCents).toBe(25);
    expect(onSpawned).toHaveBeenCalledWith('rev-1');
    // Root-level: NO parentId passed to createInstance.
    const createArg = (manager.createInstance as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(createArg.parentId).toBeUndefined();
    expect(createArg.workingDirectory).toBe('/repo');
    // Disposable: terminated even on success.
    expect(manager.terminateInstance).toHaveBeenCalledWith('rev-1', false);
  });

  it('includes a final turn attribution arriving just after idle', async () => {
    const manager=makeManager({waitForInstanceSettled:vi.fn(async()=>{
      setImmediate(()=>recordCostAttribution({source:'instance-turn',taskType:'review',instanceId:'rev-1',provider:'claude',usage:{inputTokens:50,cost:0.3}}));
      return mockInstance('rev-1','done') as Instance;
    })});
    const spawner=getReviewerSessionSpawner();spawner.setInstanceManager(manager);
    const result=await spawner.runReviewSession({provider:'claude',workingDirectory:'/repo',prompt:'review',timeoutMs:1000});
    expect(result.tokensUsed).toBe(50);expect(result.costCents).toBe(30);expect(result.costBasis).toBe('provider-reported');
  });
  it('marks unreported session spend as a legacy estimate',async()=>{
    const spawner=getReviewerSessionSpawner();spawner.setInstanceManager(makeManager());
    const result=await spawner.runReviewSession({provider:'codex',workingDirectory:'/repo',prompt:'review',timeoutMs:1000});
    expect(result.costBasis).toBe('legacy-estimate'); expect(result.exactCostCents).toBe(0);
  });

  it.each(['settled', 'timeout', 'failed', 'cancelled'] as const)('retains unknown reviewer usage on %s', async outcome => {
    let cancelled = false;
    const manager = makeManager({ waitForInstanceSettled: vi.fn(async () => {
      recordCostAttribution({ source: 'instance-turn', taskType: 'review', instanceId: 'rev-1', provider: 'opencode', model: 'unknown-model', usage: { inputTokens: 10 } });
      if (outcome === 'settled') return mockInstance('rev-1', 'done') as Instance;
      cancelled = outcome === 'cancelled';
      throw new Error(outcome === 'timeout' ? 'Timed out waiting for instance rev-1 to settle' : 'review failed');
    }) });
    const spawner = getReviewerSessionSpawner();
    spawner.setInstanceManager(manager);
    const result = await spawner.runReviewSession({ provider: 'codex', workingDirectory: '/repo', prompt: 'review', timeoutMs: 1000, isCancelled: () => cancelled });
    expect(result).toMatchObject({ outcome, tokensUsed: 10, costCents: 0, exactCostCents: 0, spendRecords: 1, costBasis: 'unknown', spendBreakdown: [{ tokens: 10, costCents: 0, basis: 'unknown' }] });
    expect(manager.terminateInstance).toHaveBeenCalledWith('rev-1', false);
  });

  it('retains exact, rounded-zero computed, and unknown usage in a mixed review', async () => {
    const manager = makeManager({ waitForInstanceSettled: vi.fn(async () => {
      recordCostAttribution({ source: 'instance-turn', taskType: 'review', instanceId: 'rev-1', provider: 'claude', usage: { inputTokens: 10, cost: 0.101 } });
      recordCostAttribution({ source: 'instance-turn', taskType: 'review', instanceId: 'rev-1', provider: 'codex', model: 'gpt-5.5', usage: { inputTokens: 1 } });
      recordCostAttribution({ source: 'instance-turn', taskType: 'review', instanceId: 'rev-1', provider: 'opencode', model: 'unknown-model', usage: { inputTokens: 10 } });
      return mockInstance('rev-1', 'done') as Instance;
    }) });
    const spawner = getReviewerSessionSpawner();
    spawner.setInstanceManager(manager);
    const result = await spawner.runReviewSession({ provider: 'codex', workingDirectory: '/repo', prompt: 'review', timeoutMs: 1000 });
    expect(result).toMatchObject({ tokensUsed: 21, costCents: 11, exactCostCents: 11, spendRecords: 3, costBasis: 'unknown', spendBreakdown: [{ tokens: 10, costCents: 11, basis: 'provider-reported' }, { tokens: 1, costCents: 0, basis: 'computed' }, { tokens: 10, costCents: 0, basis: 'unknown' }] });
  });

  it('prefers settled output over a stale live instance snapshot', async () => {
    const stale = mockInstance('rev-1', '```json\n{"verdict":"APPROVED","completeness":{"filesInspected":0}}\n```');
    const settled = mockInstance(
      'rev-1',
      '```json\n{"verdict":"CHANGES_REQUESTED","completeness":{"filesInspected":34}}\n```',
    );
    const manager = makeManager({
      createInstance: vi.fn().mockResolvedValue(stale),
      waitForInstanceSettled: vi.fn().mockResolvedValue(settled),
      getInstance: vi.fn().mockReturnValue(stale),
    });
    const spawner = getReviewerSessionSpawner();
    spawner.setInstanceManager(manager);

    const result = await spawner.runReviewSession({
      provider: 'codex',
      workingDirectory: '/repo',
      prompt: 'deep dive',
      timeoutMs: 5000,
    });

    expect(result.outcome).toBe('settled');
    expect(result.finalOutput).toContain('CHANGES_REQUESTED');
    expect(result.finalOutput).toContain('"filesInspected":34');
    expect(result.finalOutput).not.toContain('"filesInspected":0');
  });

  it('reports timeout (and still tears down) when settle times out', async () => {
    const manager = makeManager({
      waitForInstanceSettled: vi.fn().mockRejectedValue(new Error('Timed out waiting for instance rev-1 to settle')),
    });
    const spawner = getReviewerSessionSpawner();
    spawner.setInstanceManager(manager);

    const result = await spawner.runReviewSession({
      provider: 'gemini',
      workingDirectory: '/repo',
      prompt: 'deep dive',
      timeoutMs: 10,
    });

    expect(result.outcome).toBe('timeout');
    expect(manager.terminateInstance).toHaveBeenCalledWith('rev-1', false);
  });

  it('does not spawn when already cancelled', async () => {
    const manager = makeManager();
    const spawner = getReviewerSessionSpawner();
    spawner.setInstanceManager(manager);
    const result = await spawner.runReviewSession({
      provider: 'codex',
      workingDirectory: '/repo',
      prompt: 'x',
      timeoutMs: 1000,
      isCancelled: () => true,
    });
    expect(result.outcome).toBe('cancelled');
    expect(manager.createInstance).not.toHaveBeenCalled();
  });

  it('waits for a reviewer still being created and tears it down without sending its prompt', async () => {
    let finishSpawn!: (instance: Instance) => void;
    let markStarted!: () => void;
    const started = new Promise<void>(resolve => { markStarted = resolve; });
    const creation = new Promise<Instance>(resolve => { finishSpawn = resolve; });
    let finishTeardown!: () => void;
    const teardown = new Promise<void>(resolve => { finishTeardown = resolve; });
    const manager = makeManager({ createInstance: vi.fn(() => { markStarted(); return creation; }),
      terminateInstance: vi.fn(() => teardown) });
    const spawner = getReviewerSessionSpawner(); spawner.setInstanceManager(manager);
    const review = spawner.runReviewSession({ provider: 'codex', workingDirectory: '/tmp', prompt: 'review', timeoutMs: 1000 });
    await started;
    getWorkAdmission().setGlobalPhase('collecting');
    let stopped = false;
    const pausing = pauseConsults().then(() => { stopped = true; });
    await new Promise<void>(resolve => setImmediate(resolve));
    const stoppedDuringCreation = stopped;
    finishSpawn(mockInstance('rev-1', '') as Instance);
    await vi.waitFor(() => expect(manager.terminateInstance).toHaveBeenCalled());
    const stoppedDuringTeardown = stopped;
    finishTeardown();
    const result = await review; await pausing;
    expect(stoppedDuringCreation).toBe(false);
    expect(stoppedDuringTeardown).toBe(false);
    expect(manager.createInstance).toHaveBeenCalledWith(expect.not.objectContaining({ initialPrompt: expect.any(String) }));
    expect(manager.sendInput).not.toHaveBeenCalled();
    expect(result.outcome).toBe('cancelled');
  });

  it('cancels a prompt waiting for initialization when restart pause starts', async () => {
    let startSend!: () => void;
    const sending = new Promise<void>(resolve => { startSend = resolve; });
    let finishInit!: () => void;
    const initialization = new Promise<void>(resolve => { finishInit = resolve; });
    const delivered = vi.fn();
    const instance = mockInstance('rev-1', '') as Instance;
    const manager = makeManager({
      sendInput: vi.fn(async (_id, _prompt, _attachments, options) => {
        startSend();
        await initialization;
        options?.signal?.throwIfAborted();
        delivered();
      }),
      waitForInstanceSettled: vi.fn(async (_id, options) => {
        await new Promise<void>(resolve => options?.signal?.addEventListener('abort', () => resolve(), { once: true }));
        return instance;
      }),
    });
    const spawner = getReviewerSessionSpawner(); spawner.setInstanceManager(manager);
    const review = spawner.runReviewSession({ provider: 'codex', workingDirectory: '/tmp', prompt: 'review', timeoutMs: 1000 });
    await sending;
    getWorkAdmission().setGlobalPhase('collecting');
    const pausing = pauseConsults();
    finishInit();
    const result = await review; await pausing;
    expect(result.outcome).toBe('cancelled');
    expect(delivered).not.toHaveBeenCalled();
    expect(manager.interruptInstance).toHaveBeenCalledWith('rev-1');
    expect(manager.terminateInstance).toHaveBeenCalledWith('rev-1', false);
  });

  it('retries failed reviewer teardown before allowing restart pause to finish', async () => {
    const terminateInstance = vi.fn().mockRejectedValue(new Error('Reviewer is still running'));
    const manager = makeManager({ terminateInstance });
    const spawner = getReviewerSessionSpawner(); spawner.setInstanceManager(manager);
    await spawner.runReviewSession({ provider: 'codex', workingDirectory: '/tmp', prompt: 'review', timeoutMs: 1000 });
    let stopped = false;
    const pausing = pauseConsults().then(() => { stopped = true; });
    await new Promise<void>(resolve => setImmediate(resolve));
    const stoppedAfterFailure = stopped;
    terminateInstance.mockResolvedValue(undefined);
    await pauseConsults(); await pausing;
    expect(stoppedAfterFailure).toBe(false);
    expect(terminateInstance).toHaveBeenCalledTimes(3);
  });

  // LT-643: for Codex app-server `readyPromise` covers the whole first turn,
  // and live it never resolved although the reviewer went idle with a
  // complete verdict. The spawner used to await it before arming the settle
  // wait, so the round hung forever with its timeout never armed.
  function stuckReviewer(buffer: unknown[]) {
    return {
      id: 'rev-1',
      status: 'idle',
      totalTokensUsed: 500,
      readyPromise: new Promise<void>(() => { /* never settles */ }),
      outputBuffer: buffer,
    };
  }

  it('LT-643: returns the verdict when the reviewer settles while readyPromise never resolves', async () => {
    const inst = stuckReviewer([{ type: 'assistant', content: '{"verdict":"CHANGES_REQUESTED"}' }]);
    const manager = makeManager({
      createInstance: vi.fn().mockResolvedValue(inst),
      getInstance: vi.fn().mockReturnValue(inst),
      waitForInstanceSettled: vi.fn().mockResolvedValue(inst),
    });
    const spawner = getReviewerSessionSpawner();
    spawner.setInstanceManager(manager);

    const result = await spawner.runReviewSession({
      provider: 'codex', workingDirectory: '/repo', prompt: 'deep dive', timeoutMs: 600_000,
    });

    expect(result.outcome).toBe('settled');
    expect(result.finalOutput).toContain('CHANGES_REQUESTED');
    expect(manager.terminateInstance).toHaveBeenCalledWith('rev-1', false);
  });

  it('LT-643: reports a timeout when the reviewer never settles and readyPromise never resolves', async () => {
    const inst = stuckReviewer([]);
    const manager = makeManager({
      createInstance: vi.fn().mockResolvedValue(inst),
      getInstance: vi.fn().mockReturnValue(inst),
      waitForInstanceSettled: vi.fn().mockRejectedValue(new Error('Timed out waiting for instance rev-1 to settle')),
    });
    const spawner = getReviewerSessionSpawner();
    spawner.setInstanceManager(manager);

    const result = await spawner.runReviewSession({
      provider: 'codex', workingDirectory: '/repo', prompt: 'deep dive', timeoutMs: 600_000,
    });

    expect(result.outcome).toBe('timeout');
    expect(manager.terminateInstance).toHaveBeenCalledWith('rev-1', false);
  });

  it('fails fast when background init rejects before the reviewer settles', async () => {
    const inst = { ...stuckReviewer([]), readyPromise: Promise.reject(new Error('spawn failed')) };
    const manager = makeManager({
      createInstance: vi.fn().mockResolvedValue(inst),
      getInstance: vi.fn().mockReturnValue(inst),
      waitForInstanceSettled: vi.fn(() => new Promise<Instance | undefined>(() => { /* never settles */ })),
    });
    const spawner = getReviewerSessionSpawner();
    spawner.setInstanceManager(manager);

    const result = await spawner.runReviewSession({
      provider: 'codex', workingDirectory: '/repo', prompt: 'deep dive', timeoutMs: 600_000,
    });

    expect(result.outcome).toBe('failed');
    expect(result.error).toBe('spawn failed');
  });
});
