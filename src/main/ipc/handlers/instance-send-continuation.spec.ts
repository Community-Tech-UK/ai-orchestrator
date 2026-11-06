import { describe, expect, it, vi } from 'vitest';
import { InstanceSendInputPayloadSchema } from '@contracts/schemas/instance';
import { sendInstanceInput } from './instance-send-continuation';
import { SAFE_CONTINUATION } from '../../../shared/turn-continuation';
import { InterruptedContextQueue } from '../../instance/instance-interrupted-context';

describe('continuation dispatch', () => {
  function setup(outcome = 'interrupted') {
    const manager = {
      getInstance: () => ({ lastTurnOutcome: outcome, outputBuffer: [
        { type: 'user', content: 'ORIGINAL_REQUEST' }, { type: 'assistant', content: 'PARTIAL_OUTPUT' },
      ], retainedPrompts: [] }),
      sendInput: vi.fn().mockResolvedValue(undefined),
    };
    return manager;
  }

  it('validates and transports the explicit continuation flag', () => {
    expect(InstanceSendInputPayloadSchema.parse({ instanceId: 'session', message: SAFE_CONTINUATION, continueInterrupted: true }))
      .toHaveProperty('continueInterrupted', true);
  });

  it('attaches saved context out of band and sends only the short continuation', async () => {
    const manager = setup();
    const context = { queue: vi.fn() };
    await sendInstanceInput(manager, { instanceId: 'session', message: SAFE_CONTINUATION, continueInterrupted: true }, context);
    expect(context.queue).toHaveBeenCalledWith('session', expect.stringContaining('ORIGINAL_REQUEST'));
    expect(manager.sendInput).toHaveBeenCalledWith('session', SAFE_CONTINUATION, undefined, { isRetry: undefined });
    expect(manager.sendInput.mock.calls[0][1]).not.toContain('ORIGINAL_REQUEST');
  });

  it('rejects a stale continuation once another turn has finished', async () => {
    const manager = setup('completed');
    const context = { queue: vi.fn() };
    await expect(sendInstanceInput(manager, { instanceId: 'session', message: SAFE_CONTINUATION, continueInterrupted: true }, context))
      .rejects.toThrow('no longer interrupted');
    expect(manager.sendInput).not.toHaveBeenCalled();
    expect(context.queue).not.toHaveBeenCalled();
  });

  it('does not alter ordinary input or attach old context to it', async () => {
    const manager = setup('completed');
    const context = { queue: vi.fn() };
    await sendInstanceInput(manager, { instanceId: 'session', message: 'A fresh question' }, context);
    expect(manager.sendInput).toHaveBeenCalledWith('session', 'A fresh question', undefined, { isRetry: undefined });
    expect(context.queue).not.toHaveBeenCalled();
  });

  it('forwards queued input to the automatic-input pause gate', async () => {
    const manager = setup('completed');
    const context = { queue: vi.fn() };
    await sendInstanceInput(manager, { instanceId: 'session', message: 'Queued follow-up', automatedInput: true }, context);
    expect(manager.sendInput).toHaveBeenCalledWith('session', 'Queued follow-up', undefined, { isRetry: undefined, automatedInput: true });
    expect(context.queue).not.toHaveBeenCalled();
  });

  it.each([false, true])('preserves durable queue ownership with continuation=%s', async continueInterrupted => {
    const manager = setup(continueInterrupted ? 'interrupted' : 'completed');
    await sendInstanceInput(manager, {
      instanceId: 'session', message: 'Queued follow-up', automatedInput: true,
      queuedAdmissionId: 'queued-row-1', continueInterrupted,
    }, { queue: vi.fn() });
    expect(manager.sendInput.mock.calls[0][3]).toHaveProperty('queuedAdmissionId', 'queued-row-1');
    expect(manager.sendInput.mock.calls[0][3]).toHaveProperty('automatedInput', true);
    expect(manager.sendInput.mock.calls[0][1]).toBe(continueInterrupted ? SAFE_CONTINUATION : 'Queued follow-up');
  });

  it.each(['backoff', 'quota-park', 'auth-required'])('rejects Continue while the runtime is waiting for %s', async kind => {
    const manager = { ...setup(), getInstance: () => ({ lastTurnOutcome: 'interrupted', status: 'waiting_for_input', outputBuffer: [], waitReason: { kind } }) };
    const context = { queue: vi.fn() };
    await expect(sendInstanceInput(manager, { instanceId: 'session', message: SAFE_CONTINUATION, continueInterrupted: true }, context))
      .rejects.toThrow('not ready');
    expect(manager.sendInput).not.toHaveBeenCalled();
    expect(context.queue).not.toHaveBeenCalled();
  });

  it('does not leave interrupted context attached to the next ordinary message after a rejected send', async () => {
    const manager = setup();
    manager.sendInput.mockRejectedValue(new Error('Dispatch rejected'));
    const context = new InterruptedContextQueue();
    await expect(sendInstanceInput(manager, { instanceId: 'session', message: SAFE_CONTINUATION, continueInterrupted: true }, context))
      .rejects.toThrow('Dispatch rejected');
    expect(context.prepare('session').value).toBeUndefined();
  });
});
