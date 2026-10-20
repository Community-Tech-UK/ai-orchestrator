import { beforeEach, describe, expect, it, vi } from 'vitest';

import { OrchestrationResponseDelivery, OrchestrationResponseHeldError } from './orchestration-response-delivery';

const mocks = vi.hoisted(() => ({
  admitAutomatedWrite: vi.fn(() => ({ kind: 'admitted' as const, admissionId: 'admission-42' })),
  markDelivered: vi.fn(),
  markFailed: vi.fn(),
  requeueUndelivered: vi.fn(),
  registerRedeliveryHandler: vi.fn(),
  emitPluginHook: vi.fn(),
}));

vi.mock('../session/session-admission-service', () => ({
  getSessionAdmissionService: () => mocks,
}));
vi.mock('../plugins/hook-emitter', () => ({ emitPluginHook: mocks.emitPluginHook }));
vi.mock('../logging/logger', () => ({
  getLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

describe('OrchestrationResponseDelivery', () => {
  beforeEach(() => {
    mocks.emitPluginHook.mockClear();
    mocks.markDelivered.mockClear();
    mocks.markFailed.mockClear();
    mocks.requeueUndelivered.mockClear();
  });

  it('audits command completion only after response delivery succeeds', () => {
    let confirm!: (error?: Error) => void;
    const delivery = new OrchestrationResponseDelivery({
      emit: (_id, _response, done) => { confirm = done; },
      onChildCompletionRedelivered: vi.fn(),
    });

    delivery.inject('parent-1', 'spawn_child', true, { childId: 'child-42' });
    expect(mocks.emitPluginHook).not.toHaveBeenCalledWith('orchestration.command.completed', expect.anything());
    expect(mocks.markDelivered).not.toHaveBeenCalled();

    confirm();
    expect(mocks.emitPluginHook).toHaveBeenCalledWith('orchestration.command.completed',
      expect.objectContaining({ instanceId: 'parent-1', action: 'spawn_child' }));
    expect(mocks.markDelivered).toHaveBeenCalledWith('admission-42');
  });

  it('does not audit a command as delivered when the send fails', () => {
    let confirm!: (error?: Error) => void;
    const delivery = new OrchestrationResponseDelivery({
      emit: (_id, _response, done) => { confirm = done; },
      onChildCompletionRedelivered: vi.fn(),
    });

    delivery.inject('parent-1', 'spawn_child', true, { childId: 'child-42' });
    confirm(new Error('runtime closed'));

    expect(mocks.emitPluginHook).not.toHaveBeenCalledWith('orchestration.command.completed', expect.anything());
    expect(mocks.markFailed).toHaveBeenCalledWith('admission-42', 'runtime closed');
  });

  it.each([
    ['its own admission row', {}, 'admission-42'],
    ['no admission row of its own (a consensus result)', { alreadyAdmitted: true }, undefined],
  ])('requeues a response held for a provider limit that has %s, and does not fail or audit it', (_label, options, admissionId) => {
    let confirm!: (error?: Error) => void;
    const delivery = new OrchestrationResponseDelivery({
      emit: (_id, _response, done) => { confirm = done; },
      onChildCompletionRedelivered: vi.fn(),
    });

    delivery.inject('parent-1', 'consensus_query', true, { message: 'done' }, options);
    confirm(new OrchestrationResponseHeldError('usage limit'));

    expect(mocks.requeueUndelivered).toHaveBeenCalledWith(admissionId, expect.objectContaining({
      instanceId: 'parent-1', origin: 'orchestration', sourceMetadata: { action: 'consensus_query', success: true, data: { message: 'done' } },
    }), 'provider-limited');
    expect(mocks.markFailed).not.toHaveBeenCalled();
    expect(mocks.markDelivered).not.toHaveBeenCalled();
    expect(mocks.emitPluginHook).not.toHaveBeenCalled();
  });

  it('reports a child completion requeued for a respawn so restart reconciliation can account for it', () => {
    mocks.requeueUndelivered.mockReturnValueOnce('requeued-7');
    const requeued = vi.fn();
    let confirm!: (error?: Error) => void;
    const delivery = new OrchestrationResponseDelivery({
      emit: (_id, _response, done) => { confirm = done; },
      onChildCompletionRedelivered: vi.fn(),
      onChildCompletionRequeuedForRespawn: requeued,
    });

    delivery.inject('parent-1', 'child_completed', true, { childId: 'child-9' });
    confirm(new OrchestrationResponseHeldError('Instance adapter changed before orchestration response delivery', 'respawning'));

    expect(mocks.requeueUndelivered).toHaveBeenCalledWith('admission-42', expect.anything(), 'respawning');
    expect(requeued).toHaveBeenCalledWith('parent-1', 'child-9', 'requeued-7');
  });

  it('does not report a limit-held child completion as restart loss: it is still delivered later', () => {
    mocks.requeueUndelivered.mockReturnValueOnce('requeued-8');
    const requeued = vi.fn();
    let confirm!: (error?: Error) => void;
    const delivery = new OrchestrationResponseDelivery({
      emit: (_id, _response, done) => { confirm = done; },
      onChildCompletionRedelivered: vi.fn(),
      onChildCompletionRequeuedForRespawn: requeued,
    });

    delivery.inject('parent-1', 'child_completed', true, { childId: 'child-9' });
    confirm(new OrchestrationResponseHeldError('usage limit'));
    expect(mocks.requeueUndelivered).toHaveBeenCalledWith('admission-42', expect.anything(), 'provider-limited');
    expect(requeued).not.toHaveBeenCalled();
  });

  it('does not report a respawn requeue for a session that is gone', () => {
    mocks.requeueUndelivered.mockReturnValueOnce(null);
    const requeued = vi.fn();
    let confirm!: (error?: Error) => void;
    const delivery = new OrchestrationResponseDelivery({
      emit: (_id, _response, done) => { confirm = done; },
      onChildCompletionRedelivered: vi.fn(),
      onChildCompletionRequeuedForRespawn: requeued,
    });

    delivery.inject('parent-1', 'child_completed', true, { childId: 'child-9' });
    confirm(new OrchestrationResponseHeldError('Instance adapter changed before orchestration response delivery', 'respawning'));
    expect(requeued).not.toHaveBeenCalled();
  });
});
