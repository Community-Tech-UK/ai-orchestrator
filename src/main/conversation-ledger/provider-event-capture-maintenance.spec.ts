import { describe, expect, it, vi } from 'vitest';
import { PROVIDER_EVENT_CAPTURE_RETENTION_DAYS, runProviderEventCaptureMaintenance } from './provider-event-capture-maintenance';

describe('provider event capture maintenance', () => {
  it('sweeps in 20,000-row steps and yields between steps, then compacts bounded pages', async () => {
    const calls: string[] = [];
    const pruneProviderEventCapturesBefore = vi.fn().mockImplementationOnce(async () => { calls.push('delete'); return 20_000; })
      .mockImplementationOnce(async () => { calls.push('delete'); return 4; });
    const compactLedgerStorage = vi.fn().mockResolvedValueOnce({ pagesFreed: 2, freePages: 1 })
      .mockResolvedValueOnce({ pagesFreed: 1, freePages: 0 });
    const removed = await runProviderEventCaptureMaintenance({ now: () => 10_000, retentionMs: 1_000,
      ledger: { pruneProviderEventCapturesBefore, compactLedgerStorage },
      yield: async () => { calls.push('yield'); } });
    expect(removed).toBe(20_004);
    expect(pruneProviderEventCapturesBefore).toHaveBeenCalledWith(9_000, 20_000);
    expect(calls.slice(0, 3)).toEqual(['delete', 'yield', 'delete']);
    expect(compactLedgerStorage).toHaveBeenCalledTimes(2);
    expect(compactLedgerStorage).toHaveBeenCalledWith(25_600);
  });

  it('still sweeps without a capture-enabled dependency and stops on no compaction progress', async () => {
    const compactLedgerStorage = vi.fn().mockResolvedValue({ pagesFreed: 0, freePages: 100 });
    const removed = await runProviderEventCaptureMaintenance({ ledger: {
      pruneProviderEventCapturesBefore: vi.fn().mockResolvedValue(3), compactLedgerStorage }, yield: async () => undefined });
    expect(removed).toBe(3);
    expect(compactLedgerStorage).toHaveBeenCalledOnce();
  });

  it('uses the fixed 30-day retention and skips compaction if nothing was removed', async () => {
    const pruneProviderEventCapturesBefore = vi.fn().mockResolvedValue(0);
    const compactLedgerStorage = vi.fn();
    const now = 40 * 24 * 60 * 60 * 1000;
    await runProviderEventCaptureMaintenance({ now: () => now, ledger: { pruneProviderEventCapturesBefore, compactLedgerStorage } });
    expect(PROVIDER_EVENT_CAPTURE_RETENTION_DAYS).toBe(30);
    expect(pruneProviderEventCapturesBefore).toHaveBeenCalledWith(now - 30 * 24 * 60 * 60 * 1000, 20_000);
    expect(compactLedgerStorage).not.toHaveBeenCalled();
  });
});
