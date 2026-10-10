import { describe, expect, it, vi } from 'vitest';
import type { ConversationData, ConversationHistoryEntry } from '../../shared/types/history.types';
import type { Instance, OutputMessage } from '../../shared/types/instance.types';
import { memoizeConversationLoads, mergePreviouslyArchivedMessages } from './archive-message-merge';

vi.mock('../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

function message(
  id: string,
  timestamp: number,
  content = `content ${id}`,
  type: OutputMessage['type'] = 'assistant',
): OutputMessage {
  return { id, type, content, timestamp };
}

const REVIVAL: Pick<Instance, 'metadata' | 'status'> = { status: 'idle', metadata: { continuityRevival: true } };

function entry(id: string): ConversationHistoryEntry {
  return {
    id,
    displayName: id,
    createdAt: 1,
    endedAt: 1_000,
    historyThreadId: 'thread-merge',
    workingDirectory: '/tmp/merge',
    messageCount: 0,
    firstUserMessage: '',
    lastUserMessage: '',
    status: 'completed',
    originalInstanceId: `instance-${id}`,
    parentId: null,
    sessionId: `session-${id}`,
  };
}

function loader(byEntry: Record<string, OutputMessage[] | null | Error>) {
  return async (entryId: string): Promise<ConversationData | null> => {
    const value = byEntry[entryId];
    if (value instanceof Error) throw value;
    return value ? { entry: entry(entryId), messages: value } : null;
  };
}

describe('mergePreviouslyArchivedMessages', () => {
  it('returns the transcript untouched when there is no previous archive', async () => {
    const transcript = [message('a', 1)];
    await expect(mergePreviouslyArchivedMessages(REVIVAL, transcript, [], loader({}))).resolves.toBe(transcript);
  });

  it('carries forward archived messages missing from a descendant transcript, in time order', async () => {
    const previous = [message('a', 1), message('b', 2), message('c', 3), message('d', 4)];
    const transcript = [message('b', 2), message('c', 3), message('e', 5)];

    const merged = await mergePreviouslyArchivedMessages(REVIVAL, transcript, [entry('e1')], loader({ e1: previous }));

    expect(merged.map((item) => item.id)).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('prefers the live copy of a message present in both', async () => {
    const live = message('b', 2, 'live edit');
    const merged = await mergePreviouslyArchivedMessages(
      REVIVAL,
      [live],
      [entry('e1')],
      loader({ e1: [message('a', 1), message('b', 2, 'stale')] }),
    );

    expect(merged).toEqual([message('a', 1), live]);
  });

  it('does not duplicate a renumbered message with the same type, time and content', async () => {
    const merged = await mergePreviouslyArchivedMessages(
      REVIVAL,
      [message('shared', 1), message('renumbered', 2, 'same text')],
      [entry('e1')],
      loader({ e1: [message('shared', 1), message('original-id', 2, 'same text')] }),
    );

    expect(merged.map((item) => item.id)).toEqual(['shared', 'renumbered']);
  });

  it('leaves an archive that shares no message id replaced (a different runtime generation)', async () => {
    const transcript = [message('source-user', 1), message('source-reply', 2)];

    const merged = await mergePreviouslyArchivedMessages(
      REVIVAL,
      transcript,
      [entry('fork')],
      loader({ fork: [message('fork-user', 5, 'copy of source-user')] }),
    );

    expect(merged).toBe(transcript);
  });

  it('skips unreadable or missing archives and still merges the readable one', async () => {
    const merged = await mergePreviouslyArchivedMessages(
      REVIVAL,
      [message('b', 2)],
      [entry('broken'), entry('missing'), entry('good')],
      loader({ broken: new Error('corrupt gzip'), missing: null, good: [message('a', 1), message('b', 2)] }),
    );

    expect(merged.map((item) => item.id)).toEqual(['a', 'b']);
  });

  it('keeps every archived parallel tool call that shares type, time and content', async () => {
    // Parallel calls from one turn are stamped in the same millisecond with the
    // same "Using tool: Read" text; only their ids differ.
    const call = (id: string) => message(id, 7, 'Using tool: Read', 'tool_use');
    const merged = await mergePreviouslyArchivedMessages(
      REVIVAL,
      [message('anchor', 1)],
      [entry('e1')],
      loader({ e1: [message('anchor', 1), call('read-1'), call('read-2'), call('read-3')] }),
    );

    expect(merged.map((item) => item.id)).toEqual(['anchor', 'read-1', 'read-2', 'read-3']);
  });

  it('does not let a live message matched by id also absorb a look-alike archived message', async () => {
    const call = (id: string) => message(id, 7, 'Using tool: Read', 'tool_use');
    const merged = await mergePreviouslyArchivedMessages(
      REVIVAL,
      [call('read-1')],
      [entry('e1')],
      loader({ e1: [call('read-1'), call('read-2')] }),
    );

    // Same millisecond: the carried message sorts ahead of the live one.
    expect(merged.map((item) => item.id)).toEqual(['read-2', 'read-1']);
  });

  it('lets each live message stand in for at most one renumbered archived copy', async () => {
    const merged = await mergePreviouslyArchivedMessages(
      REVIVAL,
      [message('anchor', 1), message('woken-copy', 7, 'same text')],
      [entry('e1')],
      loader({ e1: [message('anchor', 1), message('original-a', 7, 'same text'), message('original-b', 7, 'same text')] }),
    );

    expect(merged.map((item) => item.id)).toEqual(['anchor', 'original-b', 'woken-copy']);
  });

  it('does not carry restore notices forward', async () => {
    const notice: OutputMessage = {
      ...message('old-restore-notice', 2, 'Session restored from history', 'system'),
      metadata: { isRestoreNotice: true },
    };
    const merged = await mergePreviouslyArchivedMessages(
      REVIVAL,
      [message('anchor', 1)],
      [entry('e1')],
      loader({ e1: [message('anchor', 1), notice, message('kept', 3)] }),
    );

    expect(merged.map((item) => item.id)).toEqual(['anchor', 'kept']);
  });
});

describe('mergePreviouslyArchivedMessages after a wake renumbered every id', () => {
  it('still recognises the revival as a descendant and keeps the full archive', async () => {
    // wake-buffer-restore gives each buffered message a fresh restored-* id.
    const merged = await mergePreviouslyArchivedMessages(
      REVIVAL,
      [message('restored-0-x', 2, 'content b'), message('restored-1-x', 3, 'content c')],
      [entry('e1')],
      loader({ e1: [message('a', 1, 'content a'), message('b', 2, 'content b'), message('c', 3, 'content c'), message('d', 4, 'content d')] }),
    );

    expect(merged.map((item) => item.id)).toEqual(['a', 'restored-0-x', 'restored-1-x', 'd']);
  });

  it('matches an archived error against its woken system copy instead of keeping both', async () => {
    // Continuity stores errors as system messages, so wake brings them back as system.
    const merged = await mergePreviouslyArchivedMessages(
      REVIVAL,
      [message('restored-0-x', 2, 'Rate limited', 'system')],
      [entry('e1')],
      loader({ e1: [message('a', 1), message('err', 2, 'Rate limited', 'error')] }),
    );

    expect(merged.map((item) => item.id)).toEqual(['a', 'restored-0-x']);
  });

  it('does not treat a shared restore notice as proof of descent', async () => {
    const notice = (id: string): OutputMessage => ({
      ...message(id, 5, 'Session restored from history', 'system'),
      metadata: { isRestoreNotice: true },
    });
    const transcript = [notice('live-notice'), message('fresh', 6)];

    const merged = await mergePreviouslyArchivedMessages(
      REVIVAL,
      transcript,
      [entry('e1')],
      loader({ e1: [message('unrelated', 1), notice('archived-notice')] }),
    );

    expect(merged).toBe(transcript);
  });
});

describe('mergePreviouslyArchivedMessages scope', () => {
  const previous = [message('a', 1), message('b', 2), message('discarded-branch', 3)];
  const transcript = [message('a', 1), message('b', 2), message('edited-resend', 4)];

  it('replaces as before for an instance that is not a crash revival (edit-and-resend fork)', async () => {
    const fork: Pick<Instance, 'metadata' | 'status'> = { status: 'idle', metadata: { reason: 'crash-recovery' } };

    const merged = await mergePreviouslyArchivedMessages(fork, transcript, [entry('e1')], loader({ e1: previous }));

    expect(merged).toBe(transcript);
  });

  it('replaces as before for a superseded revival generation', async () => {
    const superseded: Pick<Instance, 'metadata' | 'status'> = {
      status: 'superseded',
      metadata: { continuityRevival: true },
    };

    const merged = await mergePreviouslyArchivedMessages(superseded, transcript, [entry('e1')], loader({ e1: previous }));

    expect(merged).toBe(transcript);
  });

  it('does not carry legacy redaction placeholders forward', async () => {
    const merged = await mergePreviouslyArchivedMessages(
      REVIVAL,
      [message('a', 1)],
      [entry('e1')],
      loader({ e1: [message('a', 1), message('placeholder', 2, '[REDACTED TOOL OUTPUT]', 'tool_result')] }),
    );

    expect(merged.map((item) => item.id)).toEqual(['a']);
  });
});

describe('memoizeConversationLoads', () => {
  it('reads each entry once and shares the result', async () => {
    const load = vi.fn(async (entryId: string): Promise<ConversationData | null> => (
      { entry: entry(entryId), messages: [] }
    ));
    const memoized = memoizeConversationLoads(load);

    const [first, second] = await Promise.all([memoized('e1'), memoized('e1')]);
    await memoized('e2');

    expect(first).toBe(second);
    expect(load).toHaveBeenCalledTimes(2);
  });
});
