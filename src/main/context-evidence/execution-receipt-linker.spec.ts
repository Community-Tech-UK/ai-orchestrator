import { describe, expect, it } from 'vitest';
import { ExecutionReceiptLinker } from './execution-receipt-linker';

describe('ExecutionReceiptLinker', () => {
  it('links existing receipt identity to evidence without replacing provenance fields', () => {
    const linker = new ExecutionReceiptLinker();
    const original = {
      receiptId: 'receipt-1', source: 'verification-ledger' as const,
      conversationId: 'conversation-1', status: 'succeeded' as const, executedAt: 100,
      providerReceiptRef: 'provider-receipt-1',
    };

    const link = linker.link(original, ['evidence-1', 'evidence-1', 'evidence-2'], 101);

    expect(link).toMatchObject({
      receiptId: 'receipt-1', source: 'verification-ledger',
      evidenceIds: ['evidence-1', 'evidence-2'], recordedAt: 101,
    });
    expect(original).toHaveProperty('providerReceiptRef', 'provider-receipt-1');
    expect(original).not.toHaveProperty('evidenceIds');
  });

  it('is idempotent for the same receipt link and rejects conflicting provenance', () => {
    const linker = new ExecutionReceiptLinker();
    const receipt = fixture();
    const first = linker.link(receipt, ['evidence-1'], 101);
    expect(linker.link(receipt, ['evidence-1'], 999)).toBe(first);
    expect(() => linker.link({ ...receipt, conversationId: 'conversation-2' }, ['evidence-1'], 102))
      .toThrow('EXECUTION_RECEIPT_LINK_CONFLICT');
  });

  it('accepts only current successful receipts from the canonical conversation', () => {
    const linker = new ExecutionReceiptLinker();
    linker.link(fixture(), ['evidence-1'], 101);
    expect(linker.hasCurrentSuccess('conversation-1', 200, 150)).toBe(true);
    expect(linker.hasCurrentSuccess('conversation-2', 200, 150)).toBe(false);
    expect(linker.hasCurrentSuccess('conversation-1', 10, 150)).toBe(false);
  });

  it('does not treat failed execution as completion proof', () => {
    const linker = new ExecutionReceiptLinker();
    linker.link({ ...fixture(), status: 'failed' }, ['evidence-1'], 101);
    expect(linker.hasCurrentSuccess('conversation-1', 200, 150)).toBe(false);
  });
});

function fixture() {
  return {
    receiptId: 'receipt-1', source: 'tool' as const, conversationId: 'conversation-1',
    status: 'succeeded' as const, executedAt: 100,
  };
}
