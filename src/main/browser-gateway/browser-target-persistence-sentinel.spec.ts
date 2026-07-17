import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserExistingTabAttachment } from './browser-extension-tab-store';
import {
  BrowserTargetPersistenceSentinel,
  buildPersistenceScanExpression,
  isAppStateMutatingCommand,
  persistenceFailureError,
} from './browser-target-persistence-sentinel';

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

describe('isAppStateMutatingCommand', () => {
  it('covers app-state writes and excludes reads/navigation', () => {
    for (const command of ['click', 'type', 'fill_form', 'select', 'upload_file', 'evaluate']) {
      expect(isAppStateMutatingCommand(command)).toBe(true);
    }
    for (const command of ['snapshot', 'read_control', 'query_elements', 'navigate', 'find_or_open', 'download_file']) {
      expect(isAppStateMutatingCommand(command)).toBe(false);
    }
  });
});

describe('buildPersistenceScanExpression', () => {
  it('embeds the generic pattern sets and alert-surface selectors', () => {
    const expression = buildPersistenceScanExpression('https://example.com');
    expect(expression).toContain('you got disconnected');
    expect(expression).toContain('failed to save');
    expect(expression).toContain('[role="alert"]');
    expect(expression).toContain('document.title');
  });

  it('adds per-origin adapter patterns', () => {
    const generic = buildPersistenceScanExpression('https://example.com');
    const ads = buildPersistenceScanExpression('https://ads.google.com');
    expect(ads).toContain('changes may not be saved');
    expect(generic).not.toContain('changes may not be saved');
  });
});

describe('BrowserTargetPersistenceSentinel', () => {
  beforeEach(() => {
    BrowserTargetPersistenceSentinel._resetForTesting();
  });

  it('classifies scan results and records last-ok per target', async () => {
    const sentinel = new BrowserTargetPersistenceSentinel({ now: () => 100 });
    const attachment = makeAttachment();
    const sendCommand = vi.fn().mockResolvedValue({ s: 'ok' });

    const scan = await sentinel.scan(attachment, sendCommand);

    expect(scan).toEqual({ state: 'ok', checkedAt: 100 });
    expect(sendCommand).toHaveBeenCalledWith(expect.objectContaining({
      command: 'evaluate',
      queueKey: expect.stringContaining('node-1'),
      payload: expect.objectContaining({ awaitPromise: false }),
    }));
    expect(sentinel.needsPreWriteCheck(attachment, 50)).toBe(false);
    expect(sentinel.needsPreWriteCheck(attachment, 150)).toBe(true);
  });

  it('reports save_failed with the matched built-in pattern only', async () => {
    const sentinel = new BrowserTargetPersistenceSentinel({ now: () => 100 });
    const scan = await sentinel.scan(
      makeAttachment(),
      vi.fn().mockResolvedValue({ s: 'save_failed', m: 'changes failed to save' }),
    );
    expect(scan).toEqual({
      state: 'save_failed',
      matchedPattern: 'changes failed to save',
      checkedAt: 100,
    });
  });

  it('unwraps a { result } envelope', async () => {
    const sentinel = new BrowserTargetPersistenceSentinel({ now: () => 100 });
    const scan = await sentinel.scan(
      makeAttachment(),
      vi.fn().mockResolvedValue({ result: { s: 'session_stale', m: 'session expired' } }),
    );
    expect(scan.state).toBe('session_stale');
    expect(scan.matchedPattern).toBe('session expired');
  });

  it('degrades to unknown on scan failure and unparseable results', async () => {
    const sentinel = new BrowserTargetPersistenceSentinel({ now: () => 100 });
    const attachment = makeAttachment();
    expect((await sentinel.scan(attachment, vi.fn().mockRejectedValue(new Error('boom')))).state)
      .toBe('unknown');
    expect((await sentinel.scan(attachment, vi.fn().mockResolvedValue('nonsense'))).state)
      .toBe('unknown');
  });

  it('requires a pre-write check only after a disconnect newer than the last ok scan', async () => {
    const now = { value: 100 };
    const sentinel = new BrowserTargetPersistenceSentinel({ now: () => now.value });
    const attachment = makeAttachment();

    expect(sentinel.needsPreWriteCheck(attachment, undefined)).toBe(false);
    expect(sentinel.needsPreWriteCheck(attachment, 90)).toBe(true);

    await sentinel.scan(attachment, vi.fn().mockResolvedValue({ s: 'ok' }));
    expect(sentinel.needsPreWriteCheck(attachment, 90)).toBe(false);

    sentinel.forgetTarget(attachment.targetId);
    expect(sentinel.needsPreWriteCheck(attachment, 90)).toBe(true);
  });
});

describe('persistenceFailureError', () => {
  it('encodes the reason codes and advice', () => {
    expect(persistenceFailureError('session_stale', 'pre_write', 'session expired').message)
      .toMatch(/^browser_target_session_stale .*NOT executed/);
    expect(persistenceFailureError('save_failed', 'post_write', undefined).message)
      .toMatch(/^browser_target_save_rejected .*NOT persisted/);
  });
});
