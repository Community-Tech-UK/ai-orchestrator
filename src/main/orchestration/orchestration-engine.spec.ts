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
      commandType: 'verification.request',
      aggregateId: 'verify-1',
      payload: { id: 'verify-1', instanceId: 'inst-1' },
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
      commandType: 'verification.request',
      aggregateId: 'verify-1',
      payload: { id: 'verify-1', instanceId: 'inst-1' },
    });
    const duplicate = engine.dispatch({
      commandId: 'command-dup',
      commandType: 'verification.complete',
      aggregateId: 'verify-2',
      payload: { id: 'verify-2', instanceId: 'inst-2' },
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
      commandType: 'verification.request',
      aggregateId: '',
      payload: { id: 'verify-invalid', instanceId: 'inst-1' },
    });

    expect(result.receipt.status).toBe('rejected');
    expect(result.receipt.reason).toContain('Aggregate ID');
    expect(result.event).toBeUndefined();
    expect(append).not.toHaveBeenCalled();
  });

  it('rejects commands whose payload identity conflicts with the aggregate ID', () => {
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
      commandId: 'command-mismatch',
      commandType: 'debate.start',
      aggregateId: 'debate-1',
      payload: { debateId: 'debate-2', query: 'Mismatch' },
    });

    expect(result.receipt.status).toBe('rejected');
    expect(result.receipt.reason).toContain('Aggregate ID mismatch');
    expect(append).not.toHaveBeenCalled();
  });
});
