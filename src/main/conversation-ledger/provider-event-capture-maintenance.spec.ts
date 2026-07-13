import { describe, expect, it, vi } from 'vitest';
import type { ConversationLedgerService } from './conversation-ledger-service';
import {
  PROVIDER_EVENT_CAPTURE_RETENTION_DAYS,
  runProviderEventCaptureMaintenance,
} from './provider-event-capture-maintenance';

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

  it('uses the fixed 30-day retention policy when no test override is injected', async () => {
    const pruneProviderEventCapturesBefore = vi.fn().mockResolvedValue(0);
    const now = 40 * 24 * 60 * 60 * 1000;

    await runProviderEventCaptureMaintenance({
      now: () => now,
      ledger: { pruneProviderEventCapturesBefore } as Pick<
        ConversationLedgerService,
        'pruneProviderEventCapturesBefore'
      >,
    });

    expect(PROVIDER_EVENT_CAPTURE_RETENTION_DAYS).toBe(30);
    expect(pruneProviderEventCapturesBefore).toHaveBeenCalledWith(
      now - PROVIDER_EVENT_CAPTURE_RETENTION_DAYS * 24 * 60 * 60 * 1000,
    );
  });
});
