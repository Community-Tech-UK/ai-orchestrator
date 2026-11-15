import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DraftService } from '../services/draft.service';
import { SessionWatcherIpcService } from '../services/ipc/session-watcher-ipc.service';
import { InstanceStateService } from './instance/instance-state.service';
import { SettingsStore } from './settings.store';
import { SessionWatcherTypingReporter, TYPING_HOLD_MS, TYPING_REPORT_INTERVAL_MS } from './session-watcher-typing.service';

describe('SessionWatcherTypingReporter', () => {
  const NOW = Date.UTC(2026, 10, 15, 12);
  const reportTyping = vi.fn().mockResolvedValue({ success: true });
  const level = signal('planned-work');
  const queues = signal(new Map<string, unknown[]>());
  let drafts: DraftService;
  const reports = () => reportTyping.mock.calls.map(([payload]) => payload as { instanceId: string; untilMs: number });
  const settle = async () => { TestBed.tick(); await vi.advanceTimersByTimeAsync(300); };

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    vi.setSystemTime(NOW);
    vi.clearAllMocks();
    level.set('planned-work');
    queues.set(new Map());
    TestBed.configureTestingModule({ providers: [
      { provide: SessionWatcherIpcService, useValue: { reportTyping } },
      { provide: InstanceStateService, useValue: { messageQueue: queues, getInstance: (id: string) => (id.startsWith('inst') ? { id } : undefined) } },
      { provide: SettingsStore, useValue: { get: () => level() } },
    ] });
    drafts = TestBed.inject(DraftService);
    TestBed.inject(SessionWatcherTypingReporter).start();
  });
  afterEach(() => { vi.useRealTimers(); TestBed.resetTestingModule(); });

  it('reports a two-minute hold as soon as a message box has fresh text', async () => {
    drafts.setDraft('inst-1', 'hel');
    await settle();
    expect(reports()).toHaveLength(1);
    expect(reports()[0]?.instanceId).toBe('inst-1');
    expect(reports()[0]?.untilMs).toBeGreaterThanOrEqual(NOW + TYPING_HOLD_MS);
    expect(reports()[0]?.untilMs).toBeLessThanOrEqual(NOW + 1_000 + TYPING_HOLD_MS);
  });

  it('reports at most once every 30 seconds while the typing goes on', async () => {
    drafts.setDraft('inst-1', 'h');
    await settle();
    for (const text of ['he', 'hel', 'hell', 'hello']) { drafts.setDraft('inst-1', text); await settle(); }
    expect(reports()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(TYPING_REPORT_INTERVAL_MS);
    drafts.setDraft('inst-1', 'hello!');
    await settle();
    expect(reports()).toHaveLength(2);
    expect(reports()[1]?.untilMs).toBeGreaterThan(reports()[0]!.untilMs);
  });

  it('releases the hold at once when the message box is emptied', async () => {
    drafts.setDraft('inst-1', 'hello');
    await settle();
    drafts.clearDraft('inst-1');
    await settle();
    expect(reports().at(-1)).toEqual({ instanceId: 'inst-1', untilMs: 0 });
    expect(reports()).toHaveLength(2);
  });

  it('holds nothing for a draft left alone for more than two minutes, and says so only once', async () => {
    drafts.setDraft('inst-1', 'forgotten');
    await settle();
    await vi.advanceTimersByTimeAsync(TYPING_HOLD_MS + TYPING_REPORT_INTERVAL_MS);
    expect(reports().at(-1)).toEqual({ instanceId: 'inst-1', untilMs: 0 });
    const count = reports().length;
    await vi.advanceTimersByTimeAsync(5 * TYPING_REPORT_INTERVAL_MS);
    expect(reports()).toHaveLength(count);
  });

  it('keeps the hold going from the timer while the person stays at it', async () => {
    drafts.setDraft('inst-1', 'a');
    await settle();
    await vi.advanceTimersByTimeAsync(TYPING_REPORT_INTERVAL_MS);
    drafts.setDraft('inst-1', 'ab');
    await vi.advanceTimersByTimeAsync(TYPING_REPORT_INTERVAL_MS);
    expect(reports().filter((item) => item.untilMs > 0).length).toBeGreaterThanOrEqual(2);
  });

  it('holds while messages for the session are queued to send, and releases once they are gone', async () => {
    queues.set(new Map([['inst-2', [{ message: 'later' }]]]));
    await settle();
    expect(reports()).toHaveLength(1);
    expect(reports()[0]?.instanceId).toBe('inst-2');
    expect(reports()[0]?.untilMs).toBeGreaterThanOrEqual(NOW + TYPING_HOLD_MS);
    expect(reports()[0]?.untilMs).toBeLessThanOrEqual(NOW + 1_000 + TYPING_HOLD_MS);
    queues.set(new Map());
    await settle();
    expect(reports().at(-1)).toEqual({ instanceId: 'inst-2', untilMs: 0 });
  });

  it('ignores a draft that belongs to no session', async () => {
    drafts.setDraft('__verification__', 'notes');
    await settle();
    expect(reports()).toEqual([]);
  });

  it.each(['off', 'flag-only'])('reports nothing while the setting is %s', async (value) => {
    level.set(value);
    drafts.setDraft('inst-1', 'hello');
    queues.set(new Map([['inst-2', [{ message: 'later' }]]]));
    await settle();
    await vi.advanceTimersByTimeAsync(TYPING_REPORT_INTERVAL_MS * 2);
    expect(reports()).toEqual([]);
  });
});
