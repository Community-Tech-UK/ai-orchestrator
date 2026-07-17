import { describe, expect, it, vi } from 'vitest';
import { BrowserExistingTabOperations } from './browser-existing-tab-operations';
import type { BrowserExistingTabAttachment } from './browser-extension-tab-store';
import type { BrowserTargetPersistenceScan } from './browser-target-persistence-sentinel';

function makeAttachment(
  overrides: Partial<BrowserExistingTabAttachment> = {},
): BrowserExistingTabAttachment {
  return {
    profileId: 'existing-tab:n.node-1:1:2',
    targetId: 'existing-tab:n.node-1:1:2:target',
    tabId: 2,
    windowId: 1,
    nodeId: 'node-1',
    url: 'https://ads.google.com/campaigns',
    origin: 'https://ads.google.com',
    allowedOrigins: [],
    attachedAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function makeOps(overrides: {
  sendCommand?: ReturnType<typeof vi.fn>;
  sentinel?: {
    scan: ReturnType<typeof vi.fn>;
    needsPreWriteCheck: ReturnType<typeof vi.fn>;
  };
  writeJournal?: {
    recordIntent: ReturnType<typeof vi.fn>;
    recordOutcome: ReturnType<typeof vi.fn>;
  };
  lastDisconnectAt?: number;
  reliabilityEvents?: { record: ReturnType<typeof vi.fn> };
} = {}) {
  const sendCommand = overrides.sendCommand ?? vi.fn().mockResolvedValue({ ok: true });
  const ops = new BrowserExistingTabOperations({
    extensionCommandStore: { sendCommand },
    extensionTabStore: { attachTab: vi.fn(), detachTab: vi.fn() } as never,
    isRemoteExtensionContactFresh: () => true,
    describeRemoteExtensionContact: () => 'fresh',
    grantStore: { listGrants: vi.fn(() => []), consumeGrant: vi.fn() },
    approvalStore: { createRequest: vi.fn() } as never,
    result: vi.fn((params) => params) as never,
    autoApproveApproval: () => null,
    ...(overrides.sentinel ? { persistenceSentinel: overrides.sentinel } : {}),
    ...(overrides.writeJournal ? { writeJournal: overrides.writeJournal as never } : {}),
    getLastChannelDisconnectAt: () => overrides.lastDisconnectAt,
    ...(overrides.reliabilityEvents ? { reliabilityEvents: overrides.reliabilityEvents } : {}),
  });
  return { ops, sendCommand };
}

const okScan: BrowserTargetPersistenceScan = { state: 'ok', checkedAt: 1 };

describe('BrowserExistingTabOperations mutation guards', () => {
  it('dispatches without guards when no sentinel is wired', async () => {
    const { ops, sendCommand } = makeOps();
    await ops.sendCommand(makeAttachment(), 'click', { uid: '1' });
    expect(sendCommand).toHaveBeenCalledTimes(1);
  });

  it('skips guards for read commands even with a sentinel', async () => {
    const sentinel = {
      scan: vi.fn(),
      needsPreWriteCheck: vi.fn(() => true),
    };
    const { ops, sendCommand } = makeOps({ sentinel });
    await ops.sendCommand(makeAttachment(), 'read_control', { selector: '#x' });
    expect(sendCommand).toHaveBeenCalledTimes(1);
    expect(sentinel.scan).not.toHaveBeenCalled();
  });

  it('refuses the first write after a disconnect when the session is stale', async () => {
    const sentinel = {
      scan: vi.fn().mockResolvedValue({
        state: 'session_stale',
        matchedPattern: 'session expired',
        checkedAt: 2,
      }),
      needsPreWriteCheck: vi.fn(() => true),
    };
    const events = { record: vi.fn() };
    const { ops, sendCommand } = makeOps({
      sentinel,
      lastDisconnectAt: 100,
      reliabilityEvents: events,
    });

    await expect(ops.sendCommand(makeAttachment(), 'type', { selector: '#a', value: 'x' }))
      .rejects.toThrow(/^browser_target_session_stale/);
    // Only the sentinel's scan hit the store — the mutation itself never fired.
    expect(sentinel.scan).toHaveBeenCalledTimes(1);
    expect(sendCommand).not.toHaveBeenCalledWith(expect.objectContaining({ command: 'type' }));
    expect(events.record).toHaveBeenCalledWith(
      'write_rejected_session_stale',
      expect.objectContaining({ nodeId: 'node-1' }),
    );
  });

  it('fails a dispatched write whose post-write scan reports the app rejected the save', async () => {
    const sentinel = {
      scan: vi.fn().mockResolvedValue({
        state: 'save_failed',
        matchedPattern: 'changes failed to save',
        checkedAt: 2,
      }),
      needsPreWriteCheck: vi.fn(() => false),
    };
    const journal = {
      recordIntent: vi.fn().mockResolvedValue(7),
      recordOutcome: vi.fn().mockResolvedValue(undefined),
    };
    const events = { record: vi.fn() };
    const { ops, sendCommand } = makeOps({ sentinel, writeJournal: journal, reliabilityEvents: events });

    await expect(ops.sendCommand(makeAttachment(), 'click', { uid: '9' }))
      .rejects.toThrow(/^browser_target_save_rejected/);
    expect(sendCommand).toHaveBeenCalledWith(expect.objectContaining({ command: 'click' }));
    expect(journal.recordOutcome).toHaveBeenCalledWith(expect.objectContaining({
      seq: 7,
      outcome: 'succeeded',
      scan: expect.objectContaining({ state: 'save_failed' }),
    }));
    expect(events.record).toHaveBeenCalledWith(
      'write_rejected_save_failed',
      expect.objectContaining({
        detail: expect.objectContaining({ origin: 'https://ads.google.com' }),
      }),
    );
  });

  it('returns the dispatch result and journals ok on a clean write', async () => {
    const sentinel = {
      scan: vi.fn().mockResolvedValue(okScan),
      needsPreWriteCheck: vi.fn(() => false),
    };
    const journal = {
      recordIntent: vi.fn().mockResolvedValue(1),
      recordOutcome: vi.fn().mockResolvedValue(undefined),
    };
    const dispatched = { tab: { url: 'https://ads.google.com/campaigns' } };
    const sendCommand = vi.fn().mockResolvedValue(dispatched);
    const { ops } = makeOps({ sentinel, writeJournal: journal, sendCommand });

    await expect(ops.sendCommand(makeAttachment(), 'type', { selector: '#a', value: 'x' }))
      .resolves.toBe(dispatched);
    expect(journal.recordOutcome).toHaveBeenCalledWith(expect.objectContaining({
      outcome: 'succeeded',
      scan: okScan,
    }));
  });

  it('journals a failed dispatch with the channel-taxonomy outcome', async () => {
    const sentinel = {
      scan: vi.fn().mockResolvedValue(okScan),
      needsPreWriteCheck: vi.fn(() => false),
    };
    const journal = {
      recordIntent: vi.fn().mockResolvedValue(3),
      recordOutcome: vi.fn().mockResolvedValue(undefined),
    };
    const sendCommand = vi.fn().mockRejectedValue(
      new Error('browser_extension_command_not_delivered (queued)'),
    );
    const { ops } = makeOps({ sentinel, writeJournal: journal, sendCommand });

    await expect(ops.sendCommand(makeAttachment(), 'click', { uid: '1' }))
      .rejects.toThrow(/not_delivered/);
    expect(journal.recordOutcome).toHaveBeenCalledWith(expect.objectContaining({
      seq: 3,
      outcome: 'failed',
      reason: expect.stringContaining('not_delivered'),
    }));
  });

  it('proceeds when the pre-write scan is ok or unknown', async () => {
    const sentinel = {
      scan: vi.fn()
        .mockResolvedValueOnce(okScan)
        .mockResolvedValue(okScan),
      needsPreWriteCheck: vi.fn(() => true),
    };
    const { ops, sendCommand } = makeOps({ sentinel, lastDisconnectAt: 100 });
    await ops.sendCommand(makeAttachment(), 'click', { uid: '1' });
    expect(sendCommand).toHaveBeenCalledWith(expect.objectContaining({ command: 'click' }));
    // pre-write + post-write scans
    expect(sentinel.scan).toHaveBeenCalledTimes(2);
  });
});
