import { describe, expect, it, vi } from 'vitest';
import { OrchestrationEngine } from './orchestration-engine';
import type { OrchestrationCommandReceipt } from './orchestration-command-receipts';

describe('OrchestrationEngine', () => {
  it('appends dispatched commands through the event store and supports drain()', async () => {
    const append = vi.fn();
    const receipts = new Map<string, OrchestrationCommandReceipt>();
    const engine = new OrchestrationEngine({
      append,
      recordCommandReceipt: vi.fn((receipt: OrchestrationCommandReceipt) => {
        receipts.set(receipt.commandId, receipt);
      }),
      getCommandReceipt: vi.fn((commandId: string) => receipts.get(commandId)),
    } as never);

    const { event, receipt } = engine.dispatch({
      commandId: 'command-1',
      type: 'verification.requested',
      aggregateId: 'verify-1',
      payload: { instanceId: 'inst-1' },
      metadata: { source: 'test' },
    });

    await engine.drain();

    expect(append).toHaveBeenCalledWith(event);
    expect(receipt).toEqual(expect.objectContaining({
      commandId: 'command-1',
      status: 'accepted',
      eventId: event?.id,
    }));
  });

  it('returns the existing receipt for duplicate command IDs', () => {
    const append = vi.fn();
    const receipts = new Map<string, OrchestrationCommandReceipt>();
    const engine = new OrchestrationEngine({
      append,
      recordCommandReceipt: vi.fn((receipt: OrchestrationCommandReceipt) => {
        receipts.set(receipt.commandId, receipt);
      }),
      getCommandReceipt: vi.fn((commandId: string) => receipts.get(commandId)),
    } as never);

    const first = engine.dispatch({
      commandId: 'command-dup',
      type: 'verification.requested',
      aggregateId: 'verify-1',
      payload: { instanceId: 'inst-1' },
    });
    const duplicate = engine.dispatch({
      commandId: 'command-dup',
      type: 'verification.completed',
      aggregateId: 'verify-2',
      payload: { instanceId: 'inst-2' },
    });

    expect(first.duplicate).toBe(false);
    expect(duplicate.duplicate).toBe(true);
    expect(duplicate.event).toBeUndefined();
    expect(duplicate.receipt).toEqual(first.receipt);
    expect(append).toHaveBeenCalledTimes(1);
  });

  it('records rejected receipts for invalid commands', () => {
    const append = vi.fn();
    const receipts = new Map<string, OrchestrationCommandReceipt>();
    const engine = new OrchestrationEngine({
      append,
      recordCommandReceipt: vi.fn((receipt: OrchestrationCommandReceipt) => {
        receipts.set(receipt.commandId, receipt);
      }),
      getCommandReceipt: vi.fn((commandId: string) => receipts.get(commandId)),
    } as never);

    const result = engine.dispatch({
      commandId: 'command-invalid',
      type: 'verification.requested',
      aggregateId: '',
      payload: { instanceId: 'inst-1' },
    });

    expect(result.receipt.status).toBe('rejected');
    expect(result.receipt.reason).toContain('Aggregate ID');
    expect(result.event).toBeUndefined();
    expect(append).not.toHaveBeenCalled();
  });
});
