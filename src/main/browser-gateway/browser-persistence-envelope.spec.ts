import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { guardAppStateMutation } from './browser-app-write-guard';
import { runAssertPersisted } from './browser-assert-persisted-operation';
import type { BrowserExistingTabAttachment } from './browser-extension-tab-store';
import { BrowserTargetPersistenceSentinel } from './browser-target-persistence-sentinel';
import { BrowserWriteJournal } from './browser-write-journal';

const attachment: BrowserExistingTabAttachment = {
  profileId: 'fixture', targetId: 'fixture-target', tabId: 2, windowId: 1,
  nodeId: 'fixture-node', url: 'https://example.com/form', origin: 'https://example.com',
  allowedOrigins: [], attachedAt: 1, updatedAt: 1,
};

describe('extension evaluate envelopes in persistence checks', () => {
  let directory: string | undefined;
  let journal: BrowserWriteJournal | undefined;
  afterEach(async () => {
    await journal?.flushPending();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it.each(['ok', 'session_stale', 'save_failed'] as const)('decodes the extension object envelope for %s', async (state) => {
    const sentinel = new BrowserTargetPersistenceSentinel({ now: () => 100 });
    const scan = await sentinel.scan(attachment, async () => ({
      type: 'object', json: JSON.stringify({ s: state, m: 'session expired' }),
    }));
    expect(scan.state).toBe(state);
    expect(sentinel.needsPreWriteCheck(attachment, 50)).toBe(state !== 'ok');
  });

  it('decodes a result-wrapped extension envelope', async () => {
    const sentinel = new BrowserTargetPersistenceSentinel();
    expect((await sentinel.scan(attachment, async () => ({
      result: { type: 'object', json: '{"s":"save_failed","m":"failed to save"}' },
    }))).state).toBe('save_failed');
  });

  it.each([
    { type: 'object', json: '{"s":' },
    { type: 'object', json: '{"s":"ok"}', truncated: true },
    { type: 'string', json: '{"s":"ok"}' },
    { type: 'object', json: 'null' },
    { type: 'object', json: '[]' },
    { type: 'object', json: '{"s":"other"}' },
  ])('keeps invalid or truncated scans unknown: %j', async (envelope) => {
    const sentinel = new BrowserTargetPersistenceSentinel();
    expect((await sentinel.scan(attachment, async () => envelope)).state).toBe('unknown');
    expect(sentinel.needsPreWriteCheck(attachment, 50)).toBe(true);
  });

  it('refuses a stale first write after disconnect before dispatch', async () => {
    const sentinel = new BrowserTargetPersistenceSentinel();
    const dispatch = vi.fn(async () => ({ ok: true }));
    await expect(guardAppStateMutation({
      sentinel, getLastChannelDisconnectAt: () => 1,
      rawSendCommand: async () => ({ type: 'object', json: '{"s":"session_stale","m":"session expired"}' }),
    }, attachment, 'type', { selector: '#name', value: 'fixture' }, dispatch))
      .rejects.toThrow(/^browser_target_session_stale/);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('records a rejected save and refuses persistence even when the DOM value matches', async () => {
    directory = await mkdtemp(join(tmpdir(), 'aio-r2-journal-'));
    journal = new BrowserWriteJournal({ rootDir: directory });
    const sentinel = new BrowserTargetPersistenceSentinel();
    const rawSendCommand = async () => ({ type: 'object', json: '{"s":"save_failed","m":"failed to save"}' });
    await expect(guardAppStateMutation({ sentinel, rawSendCommand, writeJournal: journal },
      attachment, 'type', { selector: '#name', value: 'fixture' }, async () => ({ ok: true })))
      .rejects.toThrow(/^browser_target_save_rejected/);
    await journal.flushPending();
    expect(await journal.list(attachment.profileId, attachment.targetId)).toMatchObject([
      { outcome: 'succeeded', persistence: 'save_failed', matchedPattern: 'failed to save' },
    ]);
    expect(await runAssertPersisted({
      scan: () => sentinel.scan(attachment, rawSendCommand), readControl: async () => ({ value: 'fixture' }),
    }, [{ selector: '#name', value: 'fixture' }])).toMatchObject({
      persisted: false, signalState: 'save_failed', matchedPattern: 'failed to save', confidence: 'verified',
    });
  });
});
