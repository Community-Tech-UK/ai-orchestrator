import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NeedsYouStore } from './needs-you.store';
import { InstanceStore } from '../../core/state/instance.store';
import { LoopStore } from '../../core/state/loop.store';
import { AutomationStore } from '../../core/state/automation.store';
import { RepoJobStore } from '../../core/state/repo-job.store';
import { PermissionApprovalsStore } from '../../core/state/permission-approvals.store';
import { BrowserApprovalsStore } from '../../core/state/browser-approvals.store';
import { PlanQueueStore } from '../../core/state/plan-queue.store';
import { PendingRequestStore } from '../../core/state/pending-request.store';
import { LocalAiGuardStore } from '../../core/state/local-ai-guard.store';
import { SideChatStore } from '../../core/state/side-chat.store';
import { ToolLoopAlertStore } from '../../core/state/tool-loop-alert.store';
import { LoopIpcService } from '../../core/services/ipc/loop-ipc.service';
import { ElectronIpcService } from '../../core/services/ipc/electron-ipc.service';
import { DocReviewStore } from '../doc-review/doc-review.store';
import { MemoryReviewStore } from '../memory-review/memory-review.store';
import type { Instance } from '../../core/state/instance/instance.types';
import type { LoopOutstandingItemPayload, LoopRunSummaryPayload, LoopStatePayload } from '@contracts/schemas/loop';
import type { LoopBanner } from '../../core/state/loop-store.types';

type OutstandingReply = Awaited<ReturnType<LoopIpcService['listOutstanding']>>;
const outstandingItem: LoopOutstandingItemPayload = {
  id: 'open-item', loopRunId: 'loop', chatId: 'a', workspaceCwd: '/work/app',
  kind: 'decision-applied', status: 'open', loopStatus: 'paused', firstSeenRound: 1,
  riskClass: null, userResponse: null, recommendedAnswer: null,
  text: 'Use the existing helper', createdAt: 6, updatedAt: 6, resolvedAt: null,
};

describe('NeedsYouStore', () => {
  const instances = signal<Instance[]>([]), selectedInstanceId = signal<string | null>(null);
  const permissions = signal([]), now = signal(Date.now());
  const activeStates = signal(new Map<string, LoopStatePayload>()), banners = signal(new Map<string, LoopBanner | null>());
  const recentRuns = signal<LoopRunSummaryPayload[]>([]);
  const setAttentionBadge = vi.fn().mockResolvedValue({ success: true });
  const refreshRecentRuns = vi.fn().mockResolvedValue({ ok: true });
  const listOutstanding = vi.fn().mockResolvedValue({ success: true, data: { items: [] } });
  const refreshRepo = vi.fn().mockResolvedValue(true), refreshMemory = vi.fn().mockResolvedValue(undefined);
  const failure = (status: Instance['status'] = 'failed', lastActivity = 42): Instance => ({
    id: 'a', displayName: 'Fix login', status, lastActivity, workingDirectory: '/work/app', provider: 'claude', parentId: null,
  } as Instance);
  beforeEach(() => {
    vi.useFakeTimers(); vi.setSystemTime(100); localStorage.clear(); vi.clearAllMocks();
    listOutstanding.mockReset().mockResolvedValue({ success: true, data: { items: [] } });
    instances.set([failure()]); selectedInstanceId.set(null); now.set(Date.now());
    activeStates.set(new Map()); banners.set(new Map()); recentRuns.set([]);
    TestBed.configureTestingModule({ providers: [
      { provide: InstanceStore, useValue: { instances, selectedInstanceId } },
      { provide: LoopStore, useValue: { recentRuns, activeStates, banners, ensureWired: vi.fn(), refreshRecentRuns } },
      { provide: AutomationStore, useValue: { runs: signal([]), automations: signal([]), refresh: vi.fn().mockResolvedValue(undefined) } },
      { provide: RepoJobStore, useValue: { jobs: signal([]), refresh: refreshRepo } },
      { provide: PermissionApprovalsStore, useValue: { pendingRequests: permissions, now, startPolling: vi.fn() } },
      { provide: BrowserApprovalsStore, useValue: { pendingRequests: signal([]) } },
      { provide: PlanQueueStore, useValue: { needsAnswerItems: signal([]), ensureWired: vi.fn(), load: vi.fn().mockResolvedValue(undefined) } },
      { provide: PendingRequestStore, useValue: { forInstance: () => [] } },
      { provide: LocalAiGuardStore, useValue: { pendingFallbacks: signal([]) } },
      { provide: SideChatStore, useValue: { attentionList: signal([]), initialize: vi.fn().mockResolvedValue(undefined) } },
      { provide: ToolLoopAlertStore, useValue: { liveIds: signal(new Set()), alertFor: () => null } },
      { provide: LoopIpcService, useValue: { listOutstanding, onOutstandingChanged: vi.fn(() => vi.fn()) } },
      { provide: ElectronIpcService, useValue: { getApi: () => ({ setAttentionBadge }) } },
      { provide: DocReviewStore, useValue: { sessions: signal([]) } },
      { provide: MemoryReviewStore, useValue: { proposals: signal([]), refresh: refreshMemory } },
    ] });
  });
  afterEach(() => { TestBed.resetTestingModule(); vi.useRealTimers(); vi.restoreAllMocks(); });
  it('keeps a new failure version visible until the selected session is selected again', () => {
    selectedInstanceId.set('a');
    const store = TestBed.inject(NeedsYouStore);
    TestBed.flushEffects();
    expect(store.count()).toBe(0);
    instances.set([failure('failed', 43)]);
    TestBed.flushEffects();
    expect(store.count()).toBe(1);
    selectedInstanceId.set(null); TestBed.flushEffects();
    selectedInstanceId.set('a'); TestBed.flushEffects();
    expect(store.count()).toBe(0);
  });
  it('raises a newly failing still-selected session without hiding its answers', () => {
    instances.set([failure('idle')]); selectedInstanceId.set('a');
    const store = TestBed.inject(NeedsYouStore);
    TestBed.flushEffects();
    instances.set([failure('failed', 43)]); TestBed.flushEffects();
    expect(store.count()).toBe(1);
    instances.set([failure('waiting_for_permission', 44)]); TestBed.flushEffects();
    selectedInstanceId.set(null); TestBed.flushEffects();
    selectedInstanceId.set('a'); TestBed.flushEffects();
    expect(store.count()).toBe(1);
    expect(store.answerEntries()).toHaveLength(1);
  });
  it('persists seen checks, re-raises a new failure version, and marks selected sessions seen', () => {
    const store = TestBed.inject(NeedsYouStore);
    expect(store.count()).toBe(1);
    store.markSeen('session:a'); expect(store.count()).toBe(0);
    expect(localStorage.getItem('harness.needs-you.seen.v1')).toContain('session:a');
    // A second store is a fresh reload over the same durable seen map.
    const reloaded = TestBed.runInInjectionContext(() => new NeedsYouStore());
    expect(reloaded.count()).toBe(0);
    instances.set([failure('failed', 43)]); expect(store.count()).toBe(1);
    selectedInstanceId.set('a'); TestBed.flushEffects(); expect(store.count()).toBe(0);
  });
  it('never marks answers seen and preserves the LT-481 snooze baseline until attention rises', () => {
    const store = TestBed.inject(NeedsYouStore);
    store.snooze('session:a'); TestBed.flushEffects(); expect(store.count()).toBe(0);
    // A status update at the same level does not clear the snooze.
    instances.set([failure('error', 43)]); TestBed.flushEffects(); expect(store.count()).toBe(0);
    instances.set([failure('waiting_for_permission', 44)]); TestBed.flushEffects();
    expect(store.count()).toBe(1); expect(store.answerEntries()).toHaveLength(1);
    expect(store.isSnoozed('session:a')).toBe(false);
    store.markSeen('session:a'); expect(store.count()).toBe(1);
  });
  it('never lets a snooze hide a question or approval someone is waiting on', () => {
    instances.set([failure('waiting_for_permission', 44)]);
    const store = TestBed.inject(NeedsYouStore);
    expect(store.answerEntries()).toHaveLength(1);
    store.snooze('session:a'); TestBed.flushEffects();
    expect(store.isSnoozed('session:a')).toBe(false); expect(store.snoozedCount()).toBe(0);
    expect(store.count()).toBe(1); expect(store.answerEntries()).toHaveLength(1); expect(store.sessionIds().has('a')).toBe(true);
    store.clearSnoozes(); expect(store.count()).toBe(1);
  });
  it('shows a snoozed session again the moment it starts waiting, before the clean-up effect has run', () => {
    instances.set([failure('processing', 43)]);
    const store = TestBed.inject(NeedsYouStore);
    store.snooze('session:a'); TestBed.flushEffects(); expect(store.isSnoozed('session:a')).toBe(true);
    instances.set([failure('waiting_for_permission', 44)]);
    // No flushEffects: the answer must not wait for the effect that drops the snooze.
    expect(store.answerEntries()).toHaveLength(1); expect(store.count()).toBe(1);
  });
  it('keeps an applied decision counted when its session is seen or the entry is opened', async () => {
    listOutstanding.mockResolvedValueOnce({ success: true, data: { items: [{
      id: 'd', kind: 'decision-applied', status: 'open', firstSeenRound: 1, riskClass: null,
      userResponse: null, text: 'Use the existing helper', chatId: 'a', createdAt: 6, updatedAt: 6,
    }] } });
    const store = TestBed.inject(NeedsYouStore); await store.refreshOutstanding();
    expect(store.count()).toBe(2);
    store.markSeenForInstance('a'); expect(store.count()).toBe(1);
    store.markSeen('loop-decision:d'); store.snooze('loop-decision:d');
    expect(store.count()).toBe(1); expect(store.entries()[0].kind).toBe('applied');
  });
  it('promotes live sign-off and step-failed pauses, while stranded and manual pauses stay uncounted', () => {
    instances.set([]);
    recentRuns.set([{ id: 'l', chatId: 'chat', status: 'paused', initialPrompt: 'Build', iterationPrompt: null,
      workspaceCwd: '/work', totalIterations: 1, totalTokens: 0, totalCostCents: 0, startedAt: 1, endedAt: null, endReason: null }]);
    const store = TestBed.inject(NeedsYouStore); expect(store.count()).toBe(0);
    const state = { id: 'l', chatId: 'chat', status: 'paused' } as LoopStatePayload;
    activeStates.set(new Map([['chat', state]])); expect(store.count()).toBe(0);
    activeStates.set(new Map([['chat', { ...state, lastCompletionOutcome: 'unverifiable' }]]));
    expect(store.pausedForYou().get('l')).toBe('sign-off'); expect(store.entries()[0].kind).toBe('answer');
    banners.set(new Map([['chat', { kind: 'no-progress', loopRunId: 'l', signalId: 'STEP_FAILED', message: 'A step failed', shownAt: 2 }]]));
    expect(store.pausedForYou().get('l')).toBe('step-failed');
    expect(store.workItems()[0].statusLabel).toBe('Paused: a step failed');
  });
  it('debounces distinct badge counts and initializes the global sources once', async () => {
    const store = TestBed.inject(NeedsYouStore); store.init(); store.init();
    TestBed.flushEffects(); await vi.advanceTimersByTimeAsync(500);
    expect(setAttentionBadge).toHaveBeenCalledExactlyOnceWith(1);
    instances.set([{ ...failure(), contextUsage: { used: 1, total: 100, percentage: 1 } }]);
    TestBed.flushEffects(); await vi.advanceTimersByTimeAsync(500);
    expect(setAttentionBadge).toHaveBeenCalledTimes(1);
    expect(refreshRecentRuns).toHaveBeenCalledTimes(1);
    expect(listOutstanding).toHaveBeenCalledWith({ status: 'open', limit: 500 });
    window.dispatchEvent(new Event('focus')); await Promise.resolve();
    expect(refreshRepo).toHaveBeenCalledTimes(2); expect(refreshMemory).toHaveBeenCalledTimes(2);
  });

  it('reports failed outstanding refreshes once per episode while retaining entries and count', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const store = TestBed.inject(NeedsYouStore);
    listOutstanding.mockResolvedValueOnce({ success: true, data: { items: [outstandingItem] } });
    await store.refreshOutstanding();
    expect(store.count()).toBe(2);
    expect(warn).not.toHaveBeenCalled();

    listOutstanding.mockResolvedValueOnce({ success: false, error: { message: 'Internal response details' } });
    await store.refreshOutstanding();
    listOutstanding.mockRejectedValueOnce(new Error('Internal transport details'));
    await store.refreshOutstanding();
    expect(store.outstanding()).toEqual([outstandingItem]);
    expect(store.count()).toBe(2);
    expect(warn).toHaveBeenCalledExactlyOnceWith('Unable to refresh open loop items. Keeping the last successful list.');

    await store.refreshOutstanding();
    expect(store.outstanding()).toEqual([]);
    expect(store.count()).toBe(1);
    listOutstanding.mockRejectedValueOnce(new Error('Internal transport details'));
    await store.refreshOutstanding();
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenLastCalledWith('Unable to refresh open loop items. Keeping the last successful list.');
  });

  it.each(['rejection', 'unsuccessful reply'])('ignores an older %s after a newer successful refresh', async mode => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const store = TestBed.inject(NeedsYouStore);
    let finish!: (value: OutstandingReply) => void;
    let fail!: (error: Error) => void;
    listOutstanding.mockImplementationOnce(() => new Promise<OutstandingReply>((resolve, reject) => { finish = resolve; fail = reject; }));
    const older = store.refreshOutstanding();
    listOutstanding.mockResolvedValueOnce({ success: true, data: { items: [outstandingItem] } });
    await store.refreshOutstanding();
    if (mode === 'rejection') fail(new Error('Obsolete transport details'));
    else finish({ success: false, error: { message: 'Obsolete response details' } });
    await older;
    expect(store.outstanding()).toEqual([outstandingItem]);
    expect(warn).not.toHaveBeenCalled();
    listOutstanding.mockRejectedValueOnce(new Error('Current transport details'));
    await store.refreshOutstanding();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('does not let an older success clear a current failure episode or replace retained entries', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const store = TestBed.inject(NeedsYouStore);
    listOutstanding.mockResolvedValueOnce({ success: true, data: { items: [outstandingItem] } });
    await store.refreshOutstanding();
    let finish!: (value: OutstandingReply) => void;
    listOutstanding.mockImplementationOnce(() => new Promise<OutstandingReply>(resolve => { finish = resolve; }));
    const older = store.refreshOutstanding();
    listOutstanding.mockRejectedValueOnce(new Error('Current transport details'));
    await store.refreshOutstanding();
    finish({ success: true, data: { items: [] } });
    await older;
    listOutstanding.mockRejectedValueOnce(new Error('Repeated transport details'));
    await store.refreshOutstanding();
    expect(store.outstanding()).toEqual([outstandingItem]);
    expect(store.count()).toBe(2);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
