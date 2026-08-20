import { describe, expect, it, vi } from 'vitest';
import type { BrowserAuditStore } from './browser-audit-store';
import {
  BROWSER_AUDIT_READ_RETENTION_DAYS,
  runBrowserAuditRetentionMaintenance,
} from './browser-audit-retention-maintenance';

describe('LT-217: browser audit retention maintenance', () => {
  it('prunes read-class audit rows older than the configured retention boundary', () => {
    const pruneReadEntriesBefore = vi.fn().mockReturnValue(4);

    const removed = runBrowserAuditRetentionMaintenance({
      now: () => 10_000,
      retentionMs: 1_000,
      auditStore: { pruneReadEntriesBefore } as Pick<BrowserAuditStore, 'pruneReadEntriesBefore'>,
    });

    expect(pruneReadEntriesBefore).toHaveBeenCalledWith(9_000);
    expect(removed).toBe(4);
  });

  it('uses the fixed 90-day retention policy when no test override is injected', () => {
    const pruneReadEntriesBefore = vi.fn().mockReturnValue(0);
    const now = 100 * 24 * 60 * 60 * 1000;

    runBrowserAuditRetentionMaintenance({
      now: () => now,
      auditStore: { pruneReadEntriesBefore } as Pick<BrowserAuditStore, 'pruneReadEntriesBefore'>,
    });

    expect(BROWSER_AUDIT_READ_RETENTION_DAYS).toBe(90);
    expect(pruneReadEntriesBefore).toHaveBeenCalledWith(
      now - BROWSER_AUDIT_READ_RETENTION_DAYS * 24 * 60 * 60 * 1000,
    );
  });
});
