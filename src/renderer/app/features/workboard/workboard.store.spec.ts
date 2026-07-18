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
