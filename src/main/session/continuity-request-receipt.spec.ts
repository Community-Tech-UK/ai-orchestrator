import { describe, expect, it } from 'vitest';
import { buildRequestReceiptMetadata, readRequestReceipt } from '../../shared/utils/request-receipt-message';
import { outputMessageToContinuityEntry, continuityEntryToOutputMessage } from './continuity-message-projection';
import { noticeToMetadata } from './continuity-notice-metadata';

describe('request receipt continuity facts', () => {
  it('keeps the shared receipt facts through disk JSON and history projection', () => {
    const original = {
      id: 'receipt-1', type: 'system' as const, timestamp: 123,
      content: 'You allowed once: Read',
      metadata: { ...buildRequestReceiptMetadata({ requestId: 'request-1', outcome: 'allowed', subject: 'Read', requestedAt: 100 }), severity: 'info' },
    };
    const entry = outputMessageToContinuityEntry(original);
    const restored = continuityEntryToOutputMessage(JSON.parse(JSON.stringify(entry)));
    expect(restored.metadata).toEqual(original.metadata);
    expect(readRequestReceipt(restored)).toEqual(readRequestReceipt(original));
    expect(outputMessageToContinuityEntry(restored)).toEqual(entry);
  });

  it('bounds receipt fields and drops corrupt values and arbitrary metadata on reload', () => {
    const restored = noticeToMetadata({
      presentationKind: 'request-receipt', requestId: 'request-1', audience: 'attention',
      outcome: 'invented', subject: 's'.repeat(1000), requestedAt: Infinity,
      arbitrary: { credential: 'PRIVATE_PLACEHOLDER' },
    } as never);
    expect(restored['outcome']).toBeUndefined();
    expect(restored['requestedAt']).toBeUndefined();
    expect(restored['subject']).toHaveLength(200);
    expect(restored).not.toHaveProperty('arbitrary');
    for (const invalid of [-1, NaN, 1.5, 9e15, '100']) {
      expect(noticeToMetadata({ presentationKind: 'request-receipt', requestedAt: invalid } as never)).not.toHaveProperty('requestedAt');
    }
  });
});
