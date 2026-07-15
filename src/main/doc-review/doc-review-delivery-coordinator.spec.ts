import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DocReviewDeliveryCoordinator } from './doc-review-delivery-coordinator';
import type { DocReviewSession } from '@contracts/schemas/doc-review';

function review(overrides: Partial<DocReviewSession> = {}): DocReviewSession {
  return {
    id: 'dr_1', instanceId: 'instance-1', workspacePath: '/repo', title: 'Plan',
    artifactPath: '/repo/.aio-review/plan.html', status: 'approved', decisions: [],
    createdAt: 1, decidedAt: 2, deliveryAttempts: [],
    origin: { kind: 'instance', requestedInstanceId: 'instance-1', historyThreadId: 'thread-1', sessionId: 'session-1' },
    ...overrides,
  };
}

describe('DocReviewDeliveryCoordinator', () => {
  const instances = new Map<string, { id: string; status: string }>();
  const manager = new EventEmitter() as EventEmitter & {
    getInstance: ReturnType<typeof vi.fn>; sendInput: ReturnType<typeof vi.fn>;
    getAllInstances: ReturnType<typeof vi.fn>; wakeInstance: ReturnType<typeof vi.fn>;
    reviveFromContinuity: ReturnType<typeof vi.fn>;
  };
  const loop = { getLoop: vi.fn(), acceptCompletion: vi.fn(), intervene: vi.fn(), resumeLoop: vi.fn() };
  const recordRecoveredAttempt = vi.fn();
  let coordinator: DocReviewDeliveryCoordinator;

  beforeEach(() => {
    instances.clear();
    manager.removeAllListeners();
    manager.getInstance = vi.fn((id: string) => instances.get(id));
    manager.getAllInstances = vi.fn(() => [...instances.values()]);
    manager.sendInput = vi.fn().mockResolvedValue(undefined);
    manager.wakeInstance = vi.fn().mockResolvedValue(undefined);
    manager.reviveFromContinuity = vi.fn().mockResolvedValue({ instanceId: 'revived-1', restoreMode: 'native' });
    loop.getLoop.mockReset(); loop.acceptCompletion.mockReset(); loop.intervene.mockReset(); loop.resumeLoop.mockReset();
    recordRecoveredAttempt.mockReset();
    coordinator = new DocReviewDeliveryCoordinator({
      instanceManager: manager,
      pauseCoordinator: { isPaused: () => false, on: vi.fn(), off: vi.fn() },
      loopCoordinator: loop,
      resumeOnSubmit: () => true,
      recordRecoveredAttempt,
    });
  });

  it('sends directly to an idle instance', async () => {
    instances.set('instance-1', { id: 'instance-1', status: 'idle' });
    await expect(coordinator.deliver(review(), 'feedback')).resolves.toMatchObject({
      state: 'delivered', mechanism: 'direct-send', targetInstanceId: 'instance-1',
    });
    expect(manager.sendInput).toHaveBeenCalledWith('instance-1', 'feedback');
  });

  it('queues a busy review and drains it once the instance reaches idle', async () => {
    instances.set('instance-1', { id: 'instance-1', status: 'busy' });
    await expect(coordinator.deliver(review(), 'feedback')).resolves.toMatchObject({ state: 'queued', mechanism: 'deferred-idle' });
    instances.set('instance-1', { id: 'instance-1', status: 'idle' });
    manager.emit('instance:state-changed', { instanceId: 'instance-1', status: 'idle' });
    await vi.waitFor(() => expect(manager.sendInput).toHaveBeenCalledWith('instance-1', 'feedback'));
    await vi.waitFor(() => expect(recordRecoveredAttempt).toHaveBeenCalledWith(
      'dr_1',
      expect.objectContaining({ state: 'delivered' }),
    ));
  });

  it('continues draining reviews queued for the same conversation while an earlier send is in flight', async () => {
    instances.set('instance-1', { id: 'instance-1', status: 'busy' });
    const releaseSends: Array<() => void> = [];
    manager.sendInput.mockImplementation(() => new Promise<void>((resolve) => releaseSends.push(resolve)));

    await coordinator.deliver(review(), 'first feedback');
    instances.set('instance-1', { id: 'instance-1', status: 'idle' });
    manager.emit('instance:state-changed', { instanceId: 'instance-1', status: 'idle' });
    await vi.waitFor(() => expect(manager.sendInput).toHaveBeenCalledTimes(1));

    instances.set('instance-1', { id: 'instance-1', status: 'busy' });
    await coordinator.deliver(review({ id: 'dr_2' }), 'second feedback');
    // The first drain owns the conversation. Make the instance safe again without a
    // second state event: completion of that drain must notice and start the next one.
    instances.set('instance-1', { id: 'instance-1', status: 'idle' });
    releaseSends.shift()?.();

    await vi.waitFor(() => expect(manager.sendInput).toHaveBeenCalledTimes(2));
    releaseSends.shift()?.();
  });

  it('keeps global-pause delivery queued until the pause coordinator resumes', async () => {
    let paused = true;
    const pause = new EventEmitter() as EventEmitter & { isPaused(): boolean };
    pause.isPaused = () => paused;
    instances.set('instance-1', { id: 'instance-1', status: 'idle' });
    coordinator = new DocReviewDeliveryCoordinator({
      instanceManager: manager,
      pauseCoordinator: pause,
      loopCoordinator: loop,
      resumeOnSubmit: () => true,
      recordRecoveredAttempt,
    });

    await expect(coordinator.deliver(review(), 'feedback')).resolves.toMatchObject({
      state: 'queued', mechanism: 'await-idle',
    });
    expect(manager.sendInput).not.toHaveBeenCalled();

    paused = false;
    pause.emit('resume');
    await vi.waitFor(() => expect(manager.sendInput).toHaveBeenCalledWith('instance-1', 'feedback'));
  });

  it('wakes a hibernated instance before delivery', async () => {
    instances.set('instance-1', { id: 'instance-1', status: 'hibernated' });
    await expect(coordinator.deliver(review(), 'feedback')).resolves.toMatchObject({ state: 'delivered', mechanism: 'wake' });
    expect(manager.wakeInstance).toHaveBeenCalledWith('instance-1');
    expect(manager.sendInput).toHaveBeenCalledWith('instance-1', 'feedback');
  });

  it('wakes a hibernated instance even when terminal-session revival is disabled', async () => {
    instances.set('instance-1', { id: 'instance-1', status: 'hibernated' });
    coordinator = new DocReviewDeliveryCoordinator({
      instanceManager: manager, pauseCoordinator: { isPaused: () => false, on: vi.fn(), off: vi.fn() },
      loopCoordinator: loop, resumeOnSubmit: () => false, recordRecoveredAttempt,
    });

    await expect(coordinator.deliver(review(), 'feedback')).resolves.toMatchObject({
      state: 'delivered', mechanism: 'wake', targetInstanceId: 'instance-1',
    });
    expect(manager.wakeInstance).toHaveBeenCalledWith('instance-1');
  });

  it('revives a terminal conversation when the operator setting permits it', async () => {
    instances.set('instance-1', { id: 'instance-1', status: 'terminated' });
    await expect(coordinator.deliver(review(), 'feedback')).resolves.toMatchObject({
      state: 'delivered', mechanism: 'continuity-revive', targetInstanceId: 'revived-1',
    });
    expect(manager.reviveFromContinuity).toHaveBeenCalledWith({
      sourceInstanceId: 'instance-1', initialPrompt: 'feedback', reason: 'doc-review-submission',
    });
  });

  it('keeps a terminal conversation recoverable when revival is disabled', async () => {
    instances.set('instance-1', { id: 'instance-1', status: 'terminated' });
    coordinator = new DocReviewDeliveryCoordinator({
      instanceManager: manager, pauseCoordinator: { isPaused: () => false, on: vi.fn(), off: vi.fn() },
      loopCoordinator: loop, resumeOnSubmit: () => false, recordRecoveredAttempt,
    });
    await expect(coordinator.deliver(review(), 'feedback')).resolves.toMatchObject({ state: 'failed', error: expect.stringMatching(/disabled/) });
  });

  it('returns a retryable failed attempt when continuity revival fails', async () => {
    instances.set('instance-1', { id: 'instance-1', status: 'terminated' });
    manager.reviveFromContinuity.mockRejectedValueOnce(new Error('continuity archive unavailable'));

    await expect(coordinator.deliver(review(), 'feedback')).resolves.toMatchObject({
      state: 'failed',
      mechanism: 'continuity-revive',
      error: 'continuity archive unavailable',
    });
    expect(manager.sendInput).not.toHaveBeenCalled();
  });

  it('delivers to a live successor with the same durable history thread instead of reviving the old id', async () => {
    instances.set('instance-1', { id: 'instance-1', status: 'terminated' });
    instances.set('instance-2', {
      id: 'instance-2', status: 'idle', historyThreadId: 'thread-1', providerSessionId: 'session-1',
    } as { id: string; status: string });

    await expect(coordinator.deliver(review(), 'feedback')).resolves.toMatchObject({
      state: 'delivered', mechanism: 'direct-send', targetInstanceId: 'instance-2',
    });
    expect(manager.sendInput).toHaveBeenCalledWith('instance-2', 'feedback');
    expect(manager.reviveFromContinuity).not.toHaveBeenCalled();
  });

  it('does not send the same concurrently requested review twice', async () => {
    instances.set('instance-1', { id: 'instance-1', status: 'idle' });
    let releaseSend: (() => void) | undefined;
    manager.sendInput.mockImplementation(() => new Promise<void>((resolve) => { releaseSend = resolve; }));

    const first = coordinator.deliver(review(), 'feedback');
    const second = coordinator.deliver(review(), 'feedback');
    await vi.waitFor(() => expect(manager.sendInput).toHaveBeenCalledTimes(1));
    releaseSend?.();

    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ state: 'delivered', mechanism: 'direct-send' }),
      expect.objectContaining({ state: 'delivered', mechanism: 'direct-send' }),
    ]);
  });

  it('uses loop acceptance only for a paused, eligible loop', async () => {
    loop.getLoop.mockReturnValue({ status: 'paused', lastCompletionOutcome: 'unverifiable' });
    loop.acceptCompletion.mockResolvedValue(true);
    await expect(coordinator.deliver(review({ origin: { kind: 'loop', loopRunId: 'loop-1', chatId: 'instance-1' } }), 'feedback')).resolves.toMatchObject({
      state: 'delivered', mechanism: 'loop-accept',
    });
  });

  it('uses loop acceptance for a paused complete terminal intent', async () => {
    loop.getLoop.mockReturnValue({
      status: 'paused',
      terminalIntentPending: { kind: 'complete' },
    });
    loop.acceptCompletion.mockResolvedValue(true);

    await expect(coordinator.deliver(review({ origin: { kind: 'loop', loopRunId: 'loop-1', chatId: 'instance-1' } }), 'feedback')).resolves.toMatchObject({
      state: 'delivered', mechanism: 'loop-accept',
    });
    expect(loop.intervene).not.toHaveBeenCalled();
    expect(loop.resumeLoop).not.toHaveBeenCalled();
  });

  it('does not resume an approved loop review that is paused for an unrelated reason', async () => {
    loop.getLoop.mockReturnValue({ status: 'paused' });

    await expect(coordinator.deliver(review({ origin: { kind: 'loop', loopRunId: 'loop-1', chatId: 'instance-1' } }), 'feedback')).resolves.toMatchObject({
      state: 'failed', mechanism: 'loop-accept',
    });
    expect(loop.acceptCompletion).not.toHaveBeenCalled();
    expect(loop.intervene).not.toHaveBeenCalled();
    expect(loop.resumeLoop).not.toHaveBeenCalled();
  });

  it('routes requested changes into a paused loop then resumes it', async () => {
    loop.getLoop.mockReturnValue({ status: 'paused' });
    loop.intervene.mockReturnValue(true); loop.resumeLoop.mockReturnValue(true);
    await expect(coordinator.deliver(review({ status: 'changes_requested', origin: { kind: 'loop', loopRunId: 'loop-1', chatId: 'instance-1' } }), 'feedback')).resolves.toMatchObject({
      state: 'delivered', mechanism: 'loop-intervene',
    });
    expect(loop.intervene).toHaveBeenCalledWith('loop-1', 'feedback');
    expect(loop.resumeLoop).toHaveBeenCalledWith('loop-1');
  });
});
