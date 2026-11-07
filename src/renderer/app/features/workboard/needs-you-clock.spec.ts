import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NEEDS_YOU_RECENCY_MS } from '../../../../shared/attention/needs-you';
import { InstanceStore } from '../../core/state/instance.store';
import { LoopStore } from '../../core/state/loop.store';
import { AutomationStore } from '../../core/state/automation.store';
import { RepoJobStore } from '../../core/state/repo-job.store';
import { PermissionApprovalsStore } from '../../core/state/permission-approvals.store';
import { DocReviewStore } from '../doc-review/doc-review.store';
import { MemoryReviewStore } from '../memory-review/memory-review.store';
import type { Instance } from '../../core/state/instance/instance.types';
import { needsYouTestSources } from './needs-you.testing';
import { NeedsYouStore } from './needs-you.store';
import * as sources from './needs-you-sources';
import { WORKBOARD_RETENTION_WINDOW_MS } from './workboard-projection';

describe('NeedsYouStore clock transitions', () => {
  const now = signal(100);
  const instances = signal<Instance[]>([]);
  const recentRuns = vi.fn(() => []);
  const approvals = signal<{ id: string; instanceId: string; description: string; createdAt: number; expiresAt: number }[]>([]);
  const documents = signal<{ id: string; title: string; status: string; createdAt: number }[]>([]);
  const memories = signal<{ id: string; title: string; status: string; createdAt: number }[]>([]);
  const instance = (id: string, status: Instance['status'] = 'waiting_for_permission'): Instance => ({
    id, status, lastActivity: 100, displayName: id, workingDirectory: '/work', provider: 'claude', parentId: null,
  } as Instance);

  beforeEach(() => {
    vi.useFakeTimers(); vi.setSystemTime(100); localStorage.clear();
    now.set(100); instances.set([]); approvals.set([]); documents.set([]); memories.set([]); recentRuns.mockClear();
    TestBed.configureTestingModule({ providers: [
      ...needsYouTestSources(100),
      { provide: InstanceStore, useValue: { instances, selectedInstanceId: signal(null) } },
      { provide: LoopStore, useValue: { recentRuns, activeStates: signal(new Map()), banners: signal(new Map()) } },
      { provide: AutomationStore, useValue: { runs: signal([]), automations: signal([]) } },
      { provide: RepoJobStore, useValue: { jobs: signal([]) } },
      { provide: PermissionApprovalsStore, useValue: { pendingRequests: approvals, now } },
      { provide: DocReviewStore, useValue: { sessions: documents } },
      { provide: MemoryReviewStore, useValue: { proposals: memories } },
    ] });
  });
  afterEach(() => { TestBed.resetTestingModule(); vi.useRealTimers(); vi.restoreAllMocks(); });
  const tick = (time: number) => { vi.setSystemTime(time); now.set(time); TestBed.flushEffects(); };

  it.each([50, 200])('preserves identities and avoids rebuilding %i unchanged sessions on ticks', size => {
    instances.set(Array.from({ length: size }, (_, i) => instance(String(i))));
    const store = TestBed.inject(NeedsYouStore); TestBed.flushEffects();
    const work = store.workItems(), entries = store.entries(), answers = store.answerEntries(), ids = store.sessionIds();
    recentRuns.mockClear();
    for (let i = 1; i <= 10; i++) {
      tick(100 + i * 1000);
      expect(store.workItems()).toBe(work);
      expect(store.entries()).toBe(entries);
      expect(store.answerEntries()).toBe(answers);
      expect(store.sessionIds()).toBe(ids);
    }
    expect(recentRuns).not.toHaveBeenCalled();
    instances.set(Array.from({ length: size }, (_, i) => instance(`replacement-${i}`)));
    TestBed.flushEffects();
    expect(store.sessionIds().size).toBe(size);
    expect(store.sessionIds().has('replacement-0')).toBe(true);
    expect(store.sessionIds()).not.toBe(ids);
  });

  it('keeps snooze membership work linear for a changed population', () => {
    instances.set(Array.from({ length: 200 }, (_, i) => instance(String(i))));
    const store = TestBed.inject(NeedsYouStore); TestBed.flushEffects();
    store.snooze('session:0'); TestBed.flushEffects();
    const keys = vi.spyOn(sources, 'workboardEntryKey');
    instances.set([...instances(), instance('new')]); TestBed.flushEffects();
    expect(store.count()).toBe(200);
    expect(keys.mock.calls.length).toBeLessThan(201 * 4);
    expect(store.isSnoozed('session:0')).toBe(true);
  });

  it('expires timed requests at their deadline and keeps the next timed request first', () => {
    instances.set([instance('untimed')]);
    approvals.set([
      { id: 'first', instanceId: 'a', description: 'First', createdAt: 50, expiresAt: 5000 },
      { id: 'second', instanceId: 'b', description: 'Second', createdAt: 60, expiresAt: 6000 },
    ]);
    const store = TestBed.inject(NeedsYouStore); TestBed.flushEffects();
    tick(4999); expect(store.entries()[0].key).toBe('permission-request:first');
    tick(5000); expect(store.entries()[0].key).toBe('permission-request:second');
    tick(6000); expect(store.entries().map(entry => entry.key)).toEqual(['session:untimed']);
  });

  it('keeps exact terminal-retention and document-recency boundaries', () => {
    instances.set([instance('failed', 'failed')]);
    documents.set([{ id: 'review', title: 'Review', status: 'pending', createdAt: 200 }]);
    const store = TestBed.inject(NeedsYouStore); TestBed.flushEffects();
    expect(store.entries().some(entry => entry.key === 'doc-review:review')).toBe(false);
    tick(200); expect(store.entries().some(entry => entry.key === 'doc-review:review')).toBe(true);
    tick(100 + WORKBOARD_RETENTION_WINDOW_MS); expect(store.workItems()).toHaveLength(1);
    tick(101 + WORKBOARD_RETENTION_WINDOW_MS); expect(store.workItems()).toHaveLength(0);
    tick(200 + NEEDS_YOU_RECENCY_MS); expect(store.count()).toBe(1);
    tick(201 + NEEDS_YOU_RECENCY_MS); expect(store.count()).toBe(0);
  });

  it('re-raises an unchanged check only after its seen window expires', () => {
    memories.set([{ id: 'note', title: 'Review note', status: 'pending', createdAt: 50 }]);
    const store = TestBed.inject(NeedsYouStore); TestBed.flushEffects();
    store.markSeen('memory-review:note'); expect(store.count()).toBe(0);
    tick(100 + NEEDS_YOU_RECENCY_MS); expect(store.count()).toBe(0);
    tick(101 + NEEDS_YOU_RECENCY_MS); expect(store.count()).toBe(1);
  });
});
