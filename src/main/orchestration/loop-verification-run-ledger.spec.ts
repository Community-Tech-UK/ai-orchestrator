import { describe, expect, it } from 'vitest';
import { LoopVerificationRunLedger } from './loop-verification-run-ledger';
import type { VerificationRun } from './verification-run-store';

describe('LoopVerificationRunLedger read seam', () => {
  it('returns durable rows supplied by the injected reader', () => {
    const ledger = new LoopVerificationRunLedger();
    const rows = [{ id: 'verify-1' }] as unknown as VerificationRun[];
    ledger.setRunReader({
      listForLoop: (loopRunId) => {
        expect(loopRunId).toBe('loop-1');
        return rows;
      },
    });

    expect(ledger.listForLoop('loop-1')).toBe(rows);
  });

  it('fails open when no durable reader is available', () => {
    const ledger = new LoopVerificationRunLedger();
    ledger.setRunReader(null);

    expect(ledger.listForLoop('loop-1')).toBeUndefined();
  });
});
