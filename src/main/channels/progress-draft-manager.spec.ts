import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  ProgressDraftManager,
  reportChannelToolProgress,
  collapseChannelProgressDraft,
  channelSupportsMessageEditing,
  type ProgressDraftChannel,
} from './progress-draft-manager';
import { DRAFT_CREATION_DELAY_MS, DRAFT_MIN_EDIT_INTERVAL_MS } from './progress-draft-compositor';

function makeAdapter(): ProgressDraftChannel & {
  sendMessage: ReturnType<typeof vi.fn>;
  editMessage: ReturnType<typeof vi.fn>;
} {
  let nextId = 1;
  return {
    sendMessage: vi.fn(async (_chatId: string, _content: string) => ({ messageId: `m${nextId++}` })),
    editMessage: vi.fn(async () => undefined),
  };
}

describe('ProgressDraftManager', () => {
  let manager: ProgressDraftManager;

  beforeEach(() => {
    manager = new ProgressDraftManager();
  });

  it('creates no message before the creation delay elapses (short-task skip)', () => {
    const adapter = makeAdapter();
    manager.reportProgress(
      { key: 'k1', chatId: 'c1', replyToMessageId: 'm1', taskStartedAt: 0, now: DRAFT_CREATION_DELAY_MS - 1 },
      adapter,
    );
    expect(adapter.sendMessage).not.toHaveBeenCalled();
  });

  it('completing before the delay elapses never sends or edits anything', async () => {
    const adapter = makeAdapter();
    manager.reportProgress(
      { key: 'k1', chatId: 'c1', replyToMessageId: 'm1', taskStartedAt: 0, now: 2_000 },
      adapter,
    );
    await manager.complete('k1', adapter, 'success', 3_000);
    expect(adapter.sendMessage).not.toHaveBeenCalled();
    expect(adapter.editMessage).not.toHaveBeenCalled();
  });

  it('creates the draft message once the creation delay elapses', async () => {
    const adapter = makeAdapter();
    manager.reportProgress(
      {
        key: 'k1', chatId: 'c1', replyToMessageId: 'm1', taskStartedAt: 0,
        detail: 'Running Bash…', now: DRAFT_CREATION_DELAY_MS,
      },
      adapter,
    );
    await flushMicrotasks();
    expect(adapter.sendMessage).toHaveBeenCalledTimes(1);
    const [chatId, content, options] = adapter.sendMessage.mock.calls[0];
    expect(chatId).toBe('c1');
    expect(content).toContain('Working on it');
    expect(content).toContain('Running Bash…');
    expect(options).toEqual({ replyTo: 'm1' });
  });

  it('edits (never re-sends) on a subsequent changed report after the min edit interval', async () => {
    const adapter = makeAdapter();
    manager.reportProgress(
      { key: 'k1', chatId: 'c1', replyToMessageId: 'm1', taskStartedAt: 0, detail: 'Running Bash…', now: DRAFT_CREATION_DELAY_MS },
      adapter,
    );
    await flushMicrotasks();

    manager.reportProgress(
      {
        key: 'k1', chatId: 'c1', replyToMessageId: 'm1', taskStartedAt: 0, detail: 'Running Grep…',
        now: DRAFT_CREATION_DELAY_MS + DRAFT_MIN_EDIT_INTERVAL_MS,
      },
      adapter,
    );
    await flushMicrotasks();

    expect(adapter.sendMessage).toHaveBeenCalledTimes(1);
    expect(adapter.editMessage).toHaveBeenCalledTimes(1);
    expect(adapter.editMessage).toHaveBeenCalledWith('c1', 'm1', expect.stringContaining('Running Grep…'));
  });

  it('skips an edit before the minimum interval has passed', async () => {
    const adapter = makeAdapter();
    manager.reportProgress(
      { key: 'k1', chatId: 'c1', replyToMessageId: 'm1', taskStartedAt: 0, detail: 'Running Bash…', now: DRAFT_CREATION_DELAY_MS },
      adapter,
    );
    await flushMicrotasks();

    manager.reportProgress(
      {
        key: 'k1', chatId: 'c1', replyToMessageId: 'm1', taskStartedAt: 0, detail: 'Running Grep…',
        now: DRAFT_CREATION_DELAY_MS + 1_000, // well under DRAFT_MIN_EDIT_INTERVAL_MS
      },
      adapter,
    );
    await flushMicrotasks();

    expect(adapter.editMessage).not.toHaveBeenCalled();
  });

  it('skips an edit when the content did not change, even after the interval passes', async () => {
    const adapter = makeAdapter();
    manager.reportProgress(
      { key: 'k1', chatId: 'c1', replyToMessageId: 'm1', taskStartedAt: 0, detail: 'Running Bash…', now: DRAFT_CREATION_DELAY_MS },
      adapter,
    );
    await flushMicrotasks();

    manager.reportProgress(
      {
        key: 'k1', chatId: 'c1', replyToMessageId: 'm1', taskStartedAt: 0, detail: 'Running Bash…',
        now: DRAFT_CREATION_DELAY_MS + DRAFT_MIN_EDIT_INTERVAL_MS + 10_000,
      },
      adapter,
    );
    await flushMicrotasks();

    expect(adapter.editMessage).not.toHaveBeenCalled();
  });

  it('collapses to a one-line success receipt on completion', async () => {
    const adapter = makeAdapter();
    manager.reportProgress(
      { key: 'k1', chatId: 'c1', replyToMessageId: 'm1', taskStartedAt: 0, now: DRAFT_CREATION_DELAY_MS },
      adapter,
    );
    await flushMicrotasks();

    await manager.complete('k1', adapter, 'success', 60_000);

    expect(adapter.editMessage).toHaveBeenCalledWith('c1', 'm1', expect.stringContaining('Done in'));
  });

  it('collapses to a distinct failure note on failure', async () => {
    const adapter = makeAdapter();
    manager.reportProgress(
      { key: 'k1', chatId: 'c1', replyToMessageId: 'm1', taskStartedAt: 0, now: DRAFT_CREATION_DELAY_MS },
      adapter,
    );
    await flushMicrotasks();

    await manager.complete('k1', adapter, 'failure', 60_000);

    expect(adapter.editMessage).toHaveBeenCalledWith('c1', 'm1', expect.stringContaining('Hit a problem'));
  });

  it('is idempotent/no-op completing a key with no active draft', async () => {
    const adapter = makeAdapter();
    await expect(manager.complete('never-started', adapter, 'success')).resolves.toBeUndefined();
    expect(adapter.editMessage).not.toHaveBeenCalled();
  });

  it('forgets the draft after completion, so a later report on the same key starts a fresh draft', async () => {
    const adapter = makeAdapter();
    manager.reportProgress(
      { key: 'k1', chatId: 'c1', replyToMessageId: 'm1', taskStartedAt: 0, now: DRAFT_CREATION_DELAY_MS },
      adapter,
    );
    await flushMicrotasks();
    await manager.complete('k1', adapter, 'success', 20_000);
    expect(manager.hasDraft('k1')).toBe(false);

    // A second turn on the same key, later in wall-clock time.
    manager.reportProgress(
      { key: 'k1', chatId: 'c2', replyToMessageId: 'm2', taskStartedAt: 100_000, now: 100_000 + DRAFT_CREATION_DELAY_MS },
      adapter,
    );
    await flushMicrotasks();
    expect(adapter.sendMessage).toHaveBeenCalledTimes(2);
    expect(adapter.sendMessage.mock.calls[1][0]).toBe('c2');
  });

  it('a new turn reporting progress while the prior turn\'s completion is still in flight starts its own fresh draft, not swallowed by the finalized one', async () => {
    const adapter = makeAdapter();
    // Hold the collapse edit open so the prior turn's complete() call is
    // still pending (finalized=true, but not yet deleted from the map) when
    // the next turn's first report arrives.
    let releaseCollapse: (() => void) | undefined;
    adapter.editMessage.mockImplementationOnce(() => new Promise<void>((resolve) => {
      releaseCollapse = resolve;
    }));

    manager.reportProgress(
      { key: 'k1', chatId: 'c1', replyToMessageId: 'm1', taskStartedAt: 0, now: DRAFT_CREATION_DELAY_MS },
      adapter,
    );
    await flushMicrotasks();
    expect(adapter.sendMessage).toHaveBeenCalledTimes(1);

    const completion = manager.complete('k1', adapter, 'success', DRAFT_CREATION_DELAY_MS + 10_000);
    await flushMicrotasks(); // finalized=true is now set, collapse edit is in flight (held open)

    // A brand-new turn on the SAME key starts immediately, before the prior
    // completion has resolved.
    manager.reportProgress(
      {
        key: 'k1', chatId: 'c2', replyToMessageId: 'm2',
        taskStartedAt: DRAFT_CREATION_DELAY_MS + 10_000, now: DRAFT_CREATION_DELAY_MS + 10_000 + DRAFT_CREATION_DELAY_MS,
      },
      adapter,
    );
    await flushMicrotasks();

    // The new turn's draft was created (not silently dropped).
    expect(adapter.sendMessage).toHaveBeenCalledTimes(2);
    expect(adapter.sendMessage.mock.calls[1][0]).toBe('c2');
    expect(manager.hasDraft('k1')).toBe(true);

    // Release the stale collapse edit and let it settle — it must not
    // delete the new (unrelated) draft state that replaced it.
    releaseCollapse?.();
    await completion;
    expect(manager.hasDraft('k1')).toBe(true);

    // The new turn's own completion still collapses cleanly.
    await manager.complete('k1', adapter, 'success', DRAFT_CREATION_DELAY_MS + 10_000 + DRAFT_CREATION_DELAY_MS + 20_000);
    expect(manager.hasDraft('k1')).toBe(false);
    expect(adapter.editMessage).toHaveBeenLastCalledWith('c2', 'm2', expect.stringContaining('Done in'));
  });

  it('final state wins: a completion racing an in-flight/queued edit always finishes last', async () => {
    const adapter = makeAdapter();
    // Make sendMessage/editMessage resolve on a controllable delay so we can
    // interleave calls deterministically.
    let releaseEdit: (() => void) | undefined;
    adapter.editMessage.mockImplementationOnce(() => new Promise<void>((resolve) => {
      releaseEdit = resolve;
    }));

    manager.reportProgress(
      { key: 'k1', chatId: 'c1', replyToMessageId: 'm1', taskStartedAt: 0, detail: 'first', now: DRAFT_CREATION_DELAY_MS },
      adapter,
    );
    await flushMicrotasks();
    expect(adapter.sendMessage).toHaveBeenCalledTimes(1);

    // Queue an in-flight edit (its promise is held open by releaseEdit).
    manager.reportProgress(
      {
        key: 'k1', chatId: 'c1', replyToMessageId: 'm1', taskStartedAt: 0, detail: 'second',
        now: DRAFT_CREATION_DELAY_MS + DRAFT_MIN_EDIT_INTERVAL_MS,
      },
      adapter,
    );
    await flushMicrotasks();
    expect(adapter.editMessage).toHaveBeenCalledTimes(1);
    expect(adapter.editMessage).toHaveBeenLastCalledWith('c1', 'm1', expect.stringContaining('second'));

    // Completion arrives while that edit is still in flight.
    const completion = manager.complete('k1', adapter, 'success', DRAFT_CREATION_DELAY_MS + 90_000);

    // Release the in-flight edit; the queued collapse must run after it.
    releaseEdit?.();
    await completion;

    expect(adapter.editMessage).toHaveBeenCalledTimes(2);
    expect(adapter.editMessage).toHaveBeenLastCalledWith('c1', 'm1', expect.stringContaining('Done in'));
  });

  it('logs and disables further edits on an edit failure, without throwing or blocking completion', async () => {
    const adapter = makeAdapter();
    adapter.editMessage.mockRejectedValueOnce(new Error('rate limited'));

    manager.reportProgress(
      { key: 'k1', chatId: 'c1', replyToMessageId: 'm1', taskStartedAt: 0, detail: 'first', now: DRAFT_CREATION_DELAY_MS },
      adapter,
    );
    await flushMicrotasks();

    manager.reportProgress(
      {
        key: 'k1', chatId: 'c1', replyToMessageId: 'm1', taskStartedAt: 0, detail: 'second',
        now: DRAFT_CREATION_DELAY_MS + DRAFT_MIN_EDIT_INTERVAL_MS,
      },
      adapter,
    );
    await flushMicrotasks();
    expect(adapter.editMessage).toHaveBeenCalledTimes(1); // the failing edit

    // A further report should not attempt another edit (editing disabled).
    manager.reportProgress(
      {
        key: 'k1', chatId: 'c1', replyToMessageId: 'm1', taskStartedAt: 0, detail: 'third',
        now: DRAFT_CREATION_DELAY_MS + 2 * DRAFT_MIN_EDIT_INTERVAL_MS,
      },
      adapter,
    );
    await flushMicrotasks();
    expect(adapter.editMessage).toHaveBeenCalledTimes(1);

    // Completion still resolves cleanly (best-effort collapse attempt, no throw).
    await expect(manager.complete('k1', adapter, 'success', 60_000)).resolves.toBeUndefined();
  });
});

describe('progress-draft-manager router wiring helpers', () => {
  let manager: ProgressDraftManager;

  beforeEach(() => {
    manager = new ProgressDraftManager();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('channelSupportsMessageEditing treats a missing method as unsupported', () => {
    expect(channelSupportsMessageEditing({})).toBe(false);
    expect(channelSupportsMessageEditing({ supportsMessageEditing: () => true })).toBe(true);
  });

  it('reportChannelToolProgress returns false and does not touch the manager on a non-edit adapter', () => {
    const adapter = { ...makeAdapter(), supportsMessageEditing: () => false };
    const handled = reportChannelToolProgress(manager, adapter, {
      key: 'k1', chatId: 'c1', replyToMessageId: 'm1', taskStartedAt: 0, toolName: 'Bash', now: DRAFT_CREATION_DELAY_MS,
    });
    expect(handled).toBe(false);
    expect(manager.hasDraft('k1')).toBe(false);
  });

  it('reportChannelToolProgress returns true and feeds the manager on an edit-capable adapter', async () => {
    const adapter = { ...makeAdapter(), supportsMessageEditing: () => true };
    const handled = reportChannelToolProgress(manager, adapter, {
      key: 'k1', chatId: 'c1', replyToMessageId: 'm1', taskStartedAt: 0, toolName: 'Bash', now: DRAFT_CREATION_DELAY_MS,
    });
    expect(handled).toBe(true);
    await flushMicrotasks();
    expect(adapter.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('collapseChannelProgressDraft no-ops on a non-edit adapter', async () => {
    const adapter = { ...makeAdapter(), supportsMessageEditing: () => false };
    await expect(collapseChannelProgressDraft(manager, adapter, 'k1', 'idle')).resolves.toBeUndefined();
    expect(adapter.editMessage).not.toHaveBeenCalled();
  });

  it('collapseChannelProgressDraft maps a non-terminal-success status to the failure receipt', async () => {
    const adapter = { ...makeAdapter(), supportsMessageEditing: () => true };
    reportChannelToolProgress(manager, adapter, {
      key: 'k1', chatId: 'c1', replyToMessageId: 'm1', taskStartedAt: 0, toolName: 'Bash', now: DRAFT_CREATION_DELAY_MS,
    });
    await flushMicrotasks();

    await collapseChannelProgressDraft(manager, adapter, 'k1', 'failed');

    expect(adapter.editMessage).toHaveBeenCalledWith('c1', 'm1', expect.stringContaining('Hit a problem'));
  });
});

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}
