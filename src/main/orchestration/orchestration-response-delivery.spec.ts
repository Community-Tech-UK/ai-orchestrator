import { beforeEach, describe, expect, it, vi } from 'vitest';

import { OrchestrationResponseDelivery } from './orchestration-response-delivery';

const mocks = vi.hoisted(() => ({
  admitAutomatedWrite: vi.fn(() => ({ kind: 'admitted' as const, admissionId: 'admission-42' })),
  markDelivered: vi.fn(),
  markFailed: vi.fn(),
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
});
