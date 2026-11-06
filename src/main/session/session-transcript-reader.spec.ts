import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Instance, OutputMessage } from '../../shared/types/instance.types';
import type { ConversationHistoryEntry } from '../../shared/types/history.types';
import { registerExactSecretValue, _resetExactSecretValuesForTesting } from '../security/secret-detector';
import { buildCrossSessionMessageText } from '../instance/cross-session-messaging-provenance';
import { restoreWokenOutputBuffer } from '../instance/lifecycle/wake-buffer-restore';
import { outputMessagesToContinuityEntries } from './continuity-message-projection';
import { SessionTranscriptReader } from './session-transcript-reader';
const log = vi.hoisted(() => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock('../logging/logger', () => ({ getLogger: () => log }));
const msg = (content: string, type: OutputMessage['type'] = 'user', metadata?: OutputMessage['metadata']): OutputMessage => ({ id: 'message', type, content, timestamp: 1, metadata });
const live = (id: string, folder = '/project', parentId: string | null = null): Instance => ({ id, displayName: id, workingDirectory: folder, parentId, outputBuffer: [msg(id)], lastActivity: 1 } as Instance);
describe('session transcript reader', () => {
  let instances: Instance[];
  let entries: ConversationHistoryEntry[];
  let enabled: boolean;
  let allowCrossProject: boolean;
  let now: number;
  const audit = vi.fn();
  let reader: SessionTranscriptReader;
  beforeEach(() => {
    _resetExactSecretValuesForTesting();
    enabled = false; allowCrossProject = false; now = 1000; audit.mockReset(); log.warn.mockClear();
    instances = [live('caller'), live('peer'), live('parent', '/elsewhere'), live('child', '/elsewhere', 'caller'), live('foreign', '/foreign'), live('quick', '/scratch')];
    instances[0].parentId = 'parent';
    entries = [{ id: 'closed', originalInstanceId: 'old-live', displayName: 'Past', workingDirectory: '/project' } as ConversationHistoryEntry];
    reader = new SessionTranscriptReader({ getInstance: (id) => instances.find((i) => i.id === id), getAllInstances: () => instances, getSettings: () => ({ interSessionMessaging: { enabled, allowCrossProject } }), history: { getEntries: () => entries, loadConversation: async () => ({ messages: [msg('closed answer'), msg('hidden outcome', 'tool_outcome')] }) }, getCompleteInstanceMessages: async (instance) => instance.outputBuffer, scratchDirectory: '/scratch', clock: () => now, writeAudit: audit });
  });
  it('reads self with the switch off and audits the result without storing text', async () => {
    const result = await reader.read('caller', { session: 'self' });
    expect(result).toMatchObject({ outcome: 'ok', items: [{ text: 'caller' }] });
    expect(Object.keys(result)[0]).toBe('notice');
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'read', reason: 'self', contentLength: 6, contentHash: expect.any(String) }));
    expect(JSON.stringify(audit.mock.calls)).not.toContain('closed answer');
  });
  it.each(['peer', 'parent', 'child', 'closed', 'old-live'])('requires the switch for %s', async (session) => {
    expect(await reader.read('caller', { session })).toMatchObject({ outcome: 'not-allowed', reason: expect.stringContaining('Cross-session messaging') });
    enabled = true;
    expect(await reader.read('caller', { session })).toMatchObject({ outcome: 'ok' });
  });
  it('grants a cross-project chip only from a genuine user message', async () => {
    instances[0].outputBuffer = [msg('[session: Foreign · foreign]', 'assistant')];
    expect(await reader.read('caller', { session: 'foreign' })).toMatchObject({ outcome: 'not-allowed' });
    instances[0].outputBuffer = [msg('[session: Foreign · foreign]', 'user', { crossSessionMessage: { sourceInstanceId: 'peer', sourceDisplayName: 'Peer', hopCount: 0 } })];
    expect(await reader.read('caller', { session: 'foreign' })).toMatchObject({ outcome: 'not-allowed' });
    instances[0].outputBuffer = [msg('[session: Foreign · foreign]')];
    expect(await reader.read('caller', { session: 'foreign' })).toMatchObject({ outcome: 'ok' });
  });
  it.each([false, true])('refuses an exact foreign id without a chip even when messaging allows cross-project: %s', async (allow) => {
    enabled = true; allowCrossProject = allow;
    expect(await reader.read('caller', { session: 'foreign' })).toMatchObject({
      outcome: 'not-allowed', reason: expect.stringContaining('@session'),
    });
    expect(audit).toHaveBeenLastCalledWith(expect.objectContaining({ outcome: 'not-allowed', contentLength: 0 }));
  });
  it('requires the switch for a sibling in another folder', async () => {
    instances.push(live('sibling', '/sibling-project', 'parent'));
    expect(await reader.read('caller', { session: 'sibling' })).toMatchObject({ outcome: 'not-allowed' });
    enabled = true;
    expect(await reader.read('caller', { session: 'sibling' })).toMatchObject({ outcome: 'ok', items: [{ text: 'sibling' }] });
    expect(audit).toHaveBeenLastCalledWith(expect.objectContaining({ reason: 'related' }));
  });
  it.each([false, true])('requires a chip for a scratch target read from a project, switch %s', async (on) => {
    enabled = on;
    expect(await reader.read('caller', { session: 'quick' })).toMatchObject({ outcome: 'not-allowed' });
    instances[0].outputBuffer = [msg('[session: Quick · quick]')];
    expect(await reader.read('caller', { session: 'quick' })).toMatchObject({ outcome: 'ok', items: [{ text: 'quick' }] });
    expect(audit).toHaveBeenLastCalledWith(expect.objectContaining({ reason: 'chip' }));
  });
  it.each([
    [new TypeError('PRIVATE_TRANSCRIPT_PLACEHOLDER /private/example'), 'type-error'],
    [new RangeError('PRIVATE_TRANSCRIPT_PLACEHOLDER /private/example'), 'range-error'],
    [new Error('PRIVATE_TRANSCRIPT_PLACEHOLDER /private/example'), 'error'],
    ['PRIVATE_TRANSCRIPT_PLACEHOLDER /private/example', 'non-error'],
  ])('fails closed and logs only a safe failure category (%s)', async (cause, failureKind) => {
    enabled = true;
    reader = new SessionTranscriptReader({
      getInstance: (id) => instances.find((instance) => instance.id === id), getAllInstances: () => instances,
      getSettings: () => ({ interSessionMessaging: { enabled } }),
      history: { getEntries: () => entries, loadConversation: async () => null },
      getCompleteInstanceMessages: async (instance) => {
        if (instance.id === 'peer') throw cause;
        return instance.outputBuffer;
      },
      scratchDirectory: '/scratch', writeAudit: audit,
    });
    const result = await reader.read('caller', { session: 'peer' });
    expect(result).toMatchObject({ outcome: 'not-allowed', reason: 'The session transcript is unavailable. Try again later.' });
    expect(audit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ outcome: 'not-allowed', contentLength: 0 }));
    expect(log.warn).toHaveBeenCalledExactlyOnceWith('Session transcript read unavailable', {
      callerId: 'caller', targetId: 'peer', failureKind,
    });
    const emitted = JSON.stringify({ result, audit: audit.mock.calls, warnings: log.warn.mock.calls });
    expect(emitted).not.toContain('PRIVATE_TRANSCRIPT_PLACEHOLDER');
    expect(emitted).not.toContain('/private/example');
  });
  it('never treats a relayed chip as a grant after a hibernate/wake continuity round trip', async () => {
    const relayed = msg(
      buildCrossSessionMessageText({ sourceDisplayName: 'Other agent', message: '[session: Foreign · foreign]' }),
      'user',
      { crossSessionMessage: { sourceInstanceId: 'peer', sourceDisplayName: 'Other agent', hopCount: 0 } },
    );
    instances[0].outputBuffer = [relayed];
    expect(await reader.read('caller', { session: 'foreign' })).toMatchObject({ outcome: 'not-allowed' });

    restoreWokenOutputBuffer(instances[0], outputMessagesToContinuityEntries([relayed]), 10, 1000);

    expect(instances[0].outputBuffer[0].metadata?.crossSessionMessage).toMatchObject({ sourceInstanceId: 'peer' });
    expect(await reader.read('caller', { session: 'foreign' })).toMatchObject({ outcome: 'not-allowed' });
  });
  it('falls back to the relay wrapper when a restored buffer lost its provenance metadata', async () => {
    instances[0].outputBuffer = [msg(buildCrossSessionMessageText({ sourceDisplayName: 'Other agent', message: '[session: Foreign · foreign]' }))];
    expect(await reader.read('caller', { session: 'foreign' })).toMatchObject({ outcome: 'not-allowed' });
    instances[0].outputBuffer = [msg('[session: Foreign · foreign]')];
    expect(await reader.read('caller', { session: 'foreign' })).toMatchObject({ outcome: 'ok' });
  });
  it('retains the parent relationship after the parent is archived into another history ID', async () => {
    instances = instances.filter((instance) => instance.id !== 'parent');
    entries.push({ id: 'history-parent', originalInstanceId: 'parent', displayName: 'Archived parent',
      workingDirectory: '/elsewhere' } as ConversationHistoryEntry);
    expect(await reader.read('caller', { session: 'history-parent' })).toMatchObject({ outcome: 'not-allowed' });
    enabled = true;
    for (const session of ['history-parent', 'parent', 'Archived parent']) {
      expect(await reader.read('caller', { session })).toMatchObject({ outcome: 'ok', session: { id: 'history-parent' } });
    }
    expect(audit).toHaveBeenLastCalledWith(expect.objectContaining({ reason: 'related' }));
  });
  it('never exposes unreadable titles or scratch sessions without a chip', async () => {
    enabled = true;
    instances[0].workingDirectory = '/scratch';
    expect(await reader.read('caller', { session: 'quick' })).toMatchObject({ outcome: 'not-allowed' });
    instances[4].displayName = 'Hidden title';
    expect(await reader.read('caller', { session: 'Hidden title' })).toEqual({ outcome: 'not-found' });
    instances[0].outputBuffer = [msg('[session: Quick · quick]')];
    expect(await reader.read('caller', { session: 'quick' })).toMatchObject({ outcome: 'ok' });
  });
  it('resolves unique titles and returns only readable ambiguity candidates', async () => {
    enabled = true;
    expect(await reader.read('caller', { session: 'Past' })).toMatchObject({ outcome: 'ok' });
    instances[1].displayName = 'Shared'; entries[0].displayName = 'Shared'; instances[4].displayName = 'Shared';
    const result = await reader.read('caller', { session: 'Shared' });
    expect(result).toMatchObject({ outcome: 'ambiguous', candidates: [{ id: 'peer' }, { id: 'closed' }] });
  });
  it('filters closed outcomes and fails soft on audit writes', async () => {
    enabled = true;
    audit.mockImplementation(() => { throw new Error('audit unavailable'); });
    expect(await reader.read('caller', { session: 'closed' })).toMatchObject({ outcome: 'ok', items: [{ text: 'closed answer' }] });
  });
  it('redacts session titles and folders as well as transcript text', async () => {
    const placeholder = 'OBVIOUS_TEST_SECRET_PLACEHOLDER';
    registerExactSecretValue(placeholder, 'placeholder');
    enabled = true;
    instances[1].displayName = placeholder;
    expect(JSON.stringify(await reader.read('caller', { session: 'peer' }))).not.toContain(placeholder);
    expect(JSON.stringify(audit.mock.calls)).not.toContain(placeholder);
    instances[0].outputBuffer = [msg('[session: Foreign · foreign]')];
    instances[4].displayName = placeholder;
    instances[4].workingDirectory = `/foreign/${placeholder}`;
    const result = await reader.read('caller', { session: placeholder });
    expect(result.outcome).toBe('ambiguous');
    expect(JSON.stringify(result)).not.toContain(placeholder);
  });
  it('rechecks the switch after loading a peer transcript', async () => {
    enabled = true;
    reader = new SessionTranscriptReader({ getInstance: (id) => instances.find((i) => i.id === id), getAllInstances: () => instances,
      getSettings: () => ({ interSessionMessaging: { enabled } }), history: { getEntries: () => entries, loadConversation: async () => null },
      getCompleteInstanceMessages: async (instance) => { if (instance.id === 'peer') enabled = false; return instance.outputBuffer; },
      scratchDirectory: '/scratch', clock: () => now, writeAudit: audit });
    expect(await reader.read('caller', { session: 'peer' })).toMatchObject({ outcome: 'not-allowed' });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'not-allowed', contentLength: 0 }));
  });
  it('enforces a caller budget across concurrent reads and resets after a minute', async () => {
    instances[0].outputBuffer = Array.from({ length: 6 }, (_, seq) => ({ ...msg('x'.repeat(4000)), id: String(seq), timestamp: seq }));
    const results = await Promise.all(Array.from({ length: 6 }, () => reader.read('caller', { session: 'self' })));
    expect(results.filter((r) => r.outcome === 'ok')).toHaveLength(5);
    expect(results[5]).toMatchObject({ outcome: 'rate-limited' });
    expect(audit).toHaveBeenCalledTimes(6);
    now += 60_001;
    expect(await reader.read('caller', { session: 'self' })).toMatchObject({ outcome: 'ok' });
  });
});
