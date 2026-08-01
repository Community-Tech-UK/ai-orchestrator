import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LoopRunSummaryPayload } from '@contracts/schemas/loop';
import type { Automation, AutomationRun } from '../../../../shared/types/automation.types';
import type { RepoJobRecord } from '../../../../shared/types/repo-job.types';
import { InstanceStore } from '../../core/state/instance/instance.store';
import { AutomationStore } from '../../core/state/automation.store';
import { LoopStore, type RefreshRecentRunsResult } from '../../core/state/loop.store';
import { RepoJobStore } from '../../core/state/repo-job.store';
import { toWorkspaceId } from '../../../../shared/utils/workspace-key';
import { WorkboardStore } from './workboard.store';
import type { WorkboardInstanceInput } from './workboard.types';

const NOW = 1_700_000_000_000;

function instance(overrides: Partial<WorkboardInstanceInput> = {}): WorkboardInstanceInput {
  return {
    id: 'inst-1',
    status: 'busy',
    displayName: 'Build',
    workingDirectory: '/repo/project',
    provider: 'claude',
    lastActivity: NOW,
    ...overrides,
  };
}

function loop(overrides: Partial<LoopRunSummaryPayload> = {}): LoopRunSummaryPayload {
  return {
    id: 'loop-1',
    chatId: 'chat-1',
    status: 'running',
    totalIterations: 1,
    totalTokens: 0,
    totalCostCents: 0,
    startedAt: NOW,
    endedAt: null,
    endReason: null,
    workspaceCwd: '/repo/project',
    initialPrompt: 'do it',
    iterationPrompt: null,
    ...overrides,
  };
}

function fakeInstanceStore() {
  return {
    instances: signal<WorkboardInstanceInput[]>([]),
    setSelectedInstance: vi.fn(),
  };
}
function fakeAutomationStore() {
  return {
    automations: signal<Automation[]>([]),
    runs: signal<AutomationRun[]>([]),
    error: signal<string | null>(null),
    refresh: vi.fn(async () => { /* noop */ }),
  };
}
function fakeLoopStore() {
  return {
    recentRuns: signal<LoopRunSummaryPayload[]>([]),
    refreshRecentRuns: vi.fn(
      async (): Promise<RefreshRecentRunsResult> => ({ ok: true, runs: [] as LoopRunSummaryPayload[] }),
    ),
    ensureWired: vi.fn(),
  };
}
function fakeRepoJobStore() {
  return {
    jobs: signal<RepoJobRecord[]>([]),
    stats: signal({}),
    error: signal<string | null>(null),
    refresh: vi.fn(async () => true),
  };
}

describe('WorkboardStore', () => {
  let instanceStore: ReturnType<typeof fakeInstanceStore>;
  let automationStore: ReturnType<typeof fakeAutomationStore>;
  let loopStore: ReturnType<typeof fakeLoopStore>;
  let repoJobStore: ReturnType<typeof fakeRepoJobStore>;
  let store: WorkboardStore;

  beforeEach(() => {
    instanceStore = fakeInstanceStore();
    automationStore = fakeAutomationStore();
    loopStore = fakeLoopStore();
    repoJobStore = fakeRepoJobStore();

    TestBed.configureTestingModule({
      providers: [
        WorkboardStore,
        { provide: InstanceStore, useValue: instanceStore },
        { provide: AutomationStore, useValue: automationStore },
        { provide: LoopStore, useValue: loopStore },
        { provide: RepoJobStore, useValue: repoJobStore },
      ],
    });
    store = TestBed.inject(WorkboardStore);
    store.advanceClock(NOW);
  });

  it('wires the loop store once on init', () => {
    expect(loopStore.ensureWired).toHaveBeenCalledTimes(1);
  });

  it('recomputes items when a source signal changes (no manual rebuild)', () => {
    expect(store.items()).toHaveLength(0);
    instanceStore.instances.set([instance({ id: 'inst-1' })]);
    expect(store.items()).toHaveLength(1);
    instanceStore.instances.set([instance({ id: 'inst-1' }), instance({ id: 'inst-2' })]);
    expect(store.items()).toHaveLength(2);
  });

  it('exposes All workspaces first, deduped and sorted', () => {
    instanceStore.instances.set([
      instance({ id: 'a', workingDirectory: '/repo/zebra' }),
      instance({ id: 'b', workingDirectory: '/repo/zebra' }),
      instance({ id: 'c', workingDirectory: '/repo/apple' }),
    ]);
    const options = store.workspaceOptions();
    expect(options[0]).toMatchObject({ id: 'all', label: 'All workspaces' });
    expect(options.slice(1).map((o) => o.label)).toEqual(['apple', 'zebra']);
  });

  it('filters every lane when a workspace is selected', () => {
    instanceStore.instances.set([
      instance({ id: 'a', status: 'busy', workingDirectory: '/repo/apple' }),
      instance({ id: 'b', status: 'waiting_for_input', workingDirectory: '/repo/zebra' }),
    ]);
    expect(store.visibleCount()).toBe(2);

    store.selectWorkspace(toWorkspaceId('/repo/apple'));
    expect(store.visibleCount()).toBe(1);
    expect(store.lanes().working).toHaveLength(1);
    expect(store.lanes()['needs-you']).toHaveLength(0);
  });

  it('reflects correlated items in lane counts and arrays', () => {
    repoJobStore.jobs.set([
      { ...jobRecord('job-1', 'running'), instanceId: 'inst-1' },
    ]);
    instanceStore.instances.set([instance({ id: 'inst-1', status: 'waiting_for_permission' })]);

    const lanes = store.lanes();
    // Correlated into one card in the most-urgent lane.
    expect(store.items()).toHaveLength(1);
    expect(lanes['needs-you']).toHaveLength(1);
    expect(lanes.working).toHaveLength(0);
  });

  it('carries the WS-C2 shared attentionLevel — not a re-derived lane — on items', () => {
    instanceStore.instances.set([instance({ id: 'inst-1', status: 'waiting_for_permission' })]);
    const [item] = store.items();
    // Split finer than the `needs-you` lane: a live permission prompt is `blocked`.
    expect(item.attentionLevel).toBe('blocked');
    expect(item.primary.attentionLevel).toBe('blocked');

    instanceStore.instances.set([instance({ id: 'inst-1', status: 'error' })]);
    expect(store.items()[0]?.attentionLevel).toBe('failed');
  });

  it('selecting an instance-linked item moves InstanceStore selection', () => {
    instanceStore.instances.set([instance({ id: 'inst-1' })]);
    store.selectItem('instance:inst-1');
    expect(store.selectedItemId()).toBe('instance:inst-1');
    expect(instanceStore.setSelectedInstance).toHaveBeenCalledWith('inst-1');
  });

  it('selecting a non-instance item updates only Workboard selection', () => {
    automationStore.runs.set([automationRun('run-1', 'running')]);
    store.selectItem('automation-run:run-1');
    expect(store.selectedItemId()).toBe('automation-run:run-1');
    expect(instanceStore.setSelectedInstance).not.toHaveBeenCalled();
  });

  it('never moves instance selection on a passive source update', () => {
    instanceStore.instances.set([instance({ id: 'inst-1' })]);
    // No user selectItem call — a passive projection update must not select.
    expect(instanceStore.setSelectedInstance).not.toHaveBeenCalled();
  });

  it('clears selection when the selected item expires from the projection', () => {
    instanceStore.instances.set([instance({ id: 'inst-1' })]);
    store.selectItem('instance:inst-1');
    expect(store.selectedWorkboardItem()).not.toBeNull();

    instanceStore.instances.set([]);
    TestBed.flushEffects();
    expect(store.selectedItemId()).toBeNull();
    expect(store.selectedWorkboardItem()).toBeNull();
  });

  it('refreshes all three sources in parallel and reports partial errors without clearing others', async () => {
    loopStore.recentRuns.set([loop({ id: 'loop-keep' })]);
    loopStore.refreshRecentRuns.mockResolvedValueOnce({ ok: false, error: 'loop offline' });
    repoJobStore.refresh.mockResolvedValueOnce(false);
    repoJobStore.error.set('jobs offline');

    await store.refresh();

    expect(loopStore.refreshRecentRuns).toHaveBeenCalled();
    expect(automationStore.refresh).toHaveBeenCalled();
    expect(repoJobStore.refresh).toHaveBeenCalledWith(false);
    expect(store.loopError()).toBe('loop offline');
    expect(store.repoJobError()).toBe('jobs offline');
    expect(store.automationError()).toBeNull();
    // A failed loop refresh does not clear the other sources' held data.
    expect(store.items().some((i) => i.id === 'loop-run:loop-keep')).toBe(true);
  });

  describe('WS-C2 snooze with hand-raise', () => {
    it('hides a snoozed item from its lane and visibleCount without affecting workspace options', () => {
      instanceStore.instances.set([instance({ id: 'inst-1', status: 'busy' })]);
      expect(store.isSnoozed('instance:inst-1')).toBe(false);
      expect(store.visibleCount()).toBe(1);

      store.snoozeItem('instance:inst-1');

      expect(store.isSnoozed('instance:inst-1')).toBe(true);
      expect(store.lanes().working).toHaveLength(0);
      expect(store.visibleCount()).toBe(0);
      // Unaffected: still one correlated item, and the workspace picker
      // still lists the (now-hidden) item's workspace.
      expect(store.items()).toHaveLength(1);
      expect(store.workspaceOptions().map((o) => o.id)).toContain(toWorkspaceId('/repo/project'));
    });

    it('an explicit unsnooze re-shows the item immediately', () => {
      instanceStore.instances.set([instance({ id: 'inst-1', status: 'busy' })]);
      store.snoozeItem('instance:inst-1');
      expect(store.visibleCount()).toBe(0);

      store.unsnoozeItem('instance:inst-1');

      expect(store.isSnoozed('instance:inst-1')).toBe(false);
      expect(store.visibleCount()).toBe(1);
      expect(store.lanes().working).toHaveLength(1);
    });

    it('hand-raise: auto-clears a snooze once the item becomes blocked', () => {
      instanceStore.instances.set([instance({ id: 'inst-1', status: 'busy' })]);
      store.snoozeItem('instance:inst-1');
      expect(store.visibleCount()).toBe(0);

      instanceStore.instances.set([instance({ id: 'inst-1', status: 'waiting_for_permission' })]);
      TestBed.flushEffects();

      expect(store.isSnoozed('instance:inst-1')).toBe(false);
      expect(store.lanes()['needs-you']).toHaveLength(1);
      expect(store.visibleCount()).toBe(1);
    });

    it('hand-raise: auto-clears a snooze once the item fails', () => {
      instanceStore.instances.set([instance({ id: 'inst-1', status: 'busy' })]);
      store.snoozeItem('instance:inst-1');

      instanceStore.instances.set([instance({ id: 'inst-1', status: 'error' })]);
      TestBed.flushEffects();

      expect(store.isSnoozed('instance:inst-1')).toBe(false);
      expect(store.visibleCount()).toBe(1);
    });

    it('hand-raise: auto-clears a snooze once the item completes (idle)', () => {
      instanceStore.instances.set([instance({ id: 'inst-1', status: 'busy' })]);
      store.snoozeItem('instance:inst-1');

      instanceStore.instances.set([instance({ id: 'inst-1', status: 'idle' })]);
      TestBed.flushEffects();

      expect(store.isSnoozed('instance:inst-1')).toBe(false);
      expect(store.visibleCount()).toBe(1);
    });

    it('a snooze survives a still-working or still-waiting transition', () => {
      instanceStore.instances.set([instance({ id: 'inst-1', status: 'busy' })]);
      store.snoozeItem('instance:inst-1');

      // busy -> processing: both `working`, does not clear.
      instanceStore.instances.set([instance({ id: 'inst-1', status: 'processing' })]);
      TestBed.flushEffects();
      expect(store.isSnoozed('instance:inst-1')).toBe(true);
      expect(store.visibleCount()).toBe(0);

      // processing -> hibernating: `working` -> `waiting`, still does not clear.
      instanceStore.instances.set([instance({ id: 'inst-1', status: 'hibernating' })]);
      TestBed.flushEffects();
      expect(store.isSnoozed('instance:inst-1')).toBe(true);
      expect(store.visibleCount()).toBe(0);
    });

    it('drops a snooze once its item leaves the projection entirely', () => {
      instanceStore.instances.set([instance({ id: 'inst-1', status: 'busy' })]);
      store.snoozeItem('instance:inst-1');

      instanceStore.instances.set([]);
      TestBed.flushEffects();

      expect(store.isSnoozed('instance:inst-1')).toBe(false);
    });
  });
});

function jobRecord(id: string, status: RepoJobRecord['status']): RepoJobRecord {
  return {
    id,
    taskId: `task-${id}`,
    name: 'PR review',
    type: 'pr-review',
    status,
    workingDirectory: '/repo/project',
    workflowTemplateId: 'tmpl',
    useWorktree: false,
    progress: 10,
    createdAt: NOW,
    repoContext: { gitAvailable: true, isRepo: true, changedFiles: [] },
    submission: { type: 'pr-review', workingDirectory: '/repo/project' },
  };
}

function automationRun(id: string, status: AutomationRun['status']): AutomationRun {
  return {
    id,
    automationId: 'auto-1',
    status,
    trigger: 'scheduled',
    scheduledAt: NOW,
    startedAt: NOW,
    finishedAt: null,
    instanceId: null,
    loopRunId: null,
    error: null,
    outputSummary: null,
    outputFullRef: null,
    idempotencyKey: null,
    triggerSource: null,
    deliveryMode: 'notify',
    seenAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    configSnapshot: null,
    attempt: 1,
    maxAttempts: 1,
  };
}
