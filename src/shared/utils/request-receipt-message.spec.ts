import { describe, expect, it } from 'vitest';
import {
  REQUEST_RECEIPT_KIND,
  buildRequestReceiptMetadata,
  readRequestReceipt,
} from './request-receipt-message';
import { resolveSystemMessageAudience } from './system-message-audience';

describe('buildRequestReceiptMetadata', () => {
  it('marks the line as one the person should see, never as a routine notice', () => {
    const metadata = buildRequestReceiptMetadata({ requestId: 'uar-1', outcome: 'answered' });

    expect(metadata).toEqual({
      audience: 'attention',
      presentationKind: 'request-receipt',
      requestId: 'uar-1',
      outcome: 'answered',
    });
    expect(resolveSystemMessageAudience({ type: 'system', metadata: { ...metadata } })).toBe('attention');
    expect(REQUEST_RECEIPT_KIND).toBe('request-receipt');
  });

  it('carries the tool and the time the request arrived only when they are known', () => {
    expect(buildRequestReceiptMetadata({
      requestId: 'perm-1', outcome: 'allowed', subject: 'Bash', requestedAt: 1234,
    })).toMatchObject({ subject: 'Bash', requestedAt: 1234 });
    expect(Object.keys(buildRequestReceiptMetadata({ requestId: 'perm-1', outcome: 'denied' })))
      .not.toContain('subject');
  });

  it('leaves out a blank tool name', () => {
    expect(buildRequestReceiptMetadata({ requestId: 'perm-1', outcome: 'denied', subject: '  ' }))
      .not.toHaveProperty('subject');
  });
});

describe('readRequestReceipt', () => {
  const metadata = buildRequestReceiptMetadata({
    requestId: 'perm-2', outcome: 'timeout', subject: 'WebFetch', requestedAt: 99,
  });

  it('reads back what was built', () => {
    expect(readRequestReceipt({ type: 'system', content: 'No answer in 5 minutes; nothing ran', metadata: { ...metadata } }))
      .toEqual({
        requestId: 'perm-2',
        text: 'No answer in 5 minutes; nothing ran',
        outcome: 'timeout',
        subject: 'WebFetch',
        requestedAt: 99,
      });
  });

  it('ignores anything that is not a receipt', () => {
    expect(readRequestReceipt({ type: 'system', content: 'Restarted', metadata: {} })).toBeNull();
    expect(readRequestReceipt({ type: 'system', content: 'Restarted' })).toBeNull();
    expect(readRequestReceipt({ type: 'assistant', content: 'hi', metadata: { ...metadata } })).toBeNull();
    expect(readRequestReceipt({
      type: 'system', content: 'x', metadata: { presentationKind: 'something-else', requestId: 'a' },
    })).toBeNull();
  });

  it('needs a request id to be a receipt at all', () => {
    expect(readRequestReceipt({
      type: 'system', content: 'x', metadata: { presentationKind: 'request-receipt' },
    })).toBeNull();
    expect(readRequestReceipt({
      type: 'system', content: 'x', metadata: { presentationKind: 'request-receipt', requestId: '' },
    })).toBeNull();
  });

  it('tolerates a receipt written before outcomes were recorded', () => {
    expect(readRequestReceipt({
      type: 'system', content: 'You answered: Bun', metadata: { presentationKind: 'request-receipt', requestId: 'q1' },
    })).toEqual({ requestId: 'q1', text: 'You answered: Bun' });
  });
});
