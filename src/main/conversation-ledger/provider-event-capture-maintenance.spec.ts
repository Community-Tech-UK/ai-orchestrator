import { describe, expect, it, vi } from 'vitest';
import type { ConversationLedgerService } from './conversation-ledger-service';
import { runProviderEventCaptureMaintenance } from './provider-event-capture-maintenance';

describe('provider event capture maintenance', () => {
  it('prunes captures older than the configured retention boundary', async () => {
    const pruneProviderEventCapturesBefore = vi.fn().mockResolvedValue(4);

    const removed = await runProviderEventCaptureMaintenance({
      now: () => 10_000,
      retentionMs: 1_000,
      ledger: { pruneProviderEventCapturesBefore } as Pick<
        ConversationLedgerService,
        'pruneProviderEventCapturesBefore'
      >,
    });

    expect(pruneProviderEventCapturesBefore).toHaveBeenCalledWith(9_000);
    expect(removed).toBe(4);
  });
});
