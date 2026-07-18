/**
 * TasksPageComponent — RepoJobStore wiring
 *
 * Deliberately not a full TestBed render: the page template embeds
 * `<app-task-preflight-card>`, whose inputs use the signal `input()` API.
 * This repo's vitest config does not include the Angular compiler plugin
 * needed to generate signal-input metadata, so binding to that child via
 * `fixture.detectChanges()` is unreliable here (same gotcha documented in
 * `loop-past-runs-panel.component.spec.ts`). Instead this spec constructs
 * the component with mocked dependencies and exercises its public
 * signals/methods directly — the same pattern used by
 * `cost-page.component.spec.ts`.
 *
 * Button enablement (`[disabled]="loading()"`, `[disabled]="submitting()"`,
 * and the cancel button's `job.status !== 'queued' && job.status !== 'running'`
 * check) is unchanged by the RepoJobStore refactor — confirmed by diff, the
 * template's `disabled` bindings were not touched — so this spec focuses on
 * proving the underlying signals/delegation the template reads from.
 */

import { TestBed } from '@angular/core/testing';
import { ComponentFixture } from '@angular/core/testing';
import { computed, signal } from '@angular/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActivatedRoute, Router } from '@angular/router';
import { TasksPageComponent } from './tasks-page.component';
import { RepoJobStore } from '../../core/state/repo-job.store';
import { RepoJobIpcService } from '../../core/services/ipc/repo-job-ipc.service';
import { VcsIpcService } from '../../core/services/ipc/vcs-ipc.service';
import { TaskIpcService } from '../../core/services/ipc/task-ipc.service';
import { SessionShareIpcService } from '../../core/services/ipc/session-share-ipc.service';
import { SettingsStore } from '../../core/state/settings.store';
import type { RepoJobRecord, RepoJobStats } from '../../../../shared/types/repo-job.types';

const ZERO_STATS: RepoJobStats = { queued: 0, running: 0, completed: 0, failed: 0, cancelled: 0, total: 0 };

function makeJob(id: string, overrides: Partial<RepoJobRecord> = {}): RepoJobRecord {
  return {
    id,
    taskId: `task-${id}`,
    name: `Job ${id}`,
    type: 'pr-review',
    status: 'queued',
    workingDirectory: '/repo',
    workflowTemplateId: 'wf-1',
    useWorktree: false,
    progress: 0,
    createdAt: 0,
    repoContext: { gitAvailable: true, isRepo: true, changedFiles: [] },
    submission: { type: 'pr-review', workingDirectory: '/repo' },
    ...overrides,
  };
}

describe('TasksPageComponent — RepoJobStore wiring', () => {
  let fixture: ComponentFixture<TasksPageComponent>;
  let component: TasksPageComponent;
  let storeJobs: ReturnType<typeof signal<readonly RepoJobRecord[]>>;
  let storeStats: ReturnType<typeof signal<RepoJobStats>>;
  let storeLoading: ReturnType<typeof signal<boolean>>;
  let storeError: ReturnType<typeof signal<string | null>>;
  let storeRefresh: ReturnType<typeof vi.fn>;
  let storeCancel: ReturnType<typeof vi.fn>;
  let storeRerun: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    storeJobs = signal<readonly RepoJobRecord[]>([]);
    storeStats = signal<RepoJobStats>(ZERO_STATS);
    storeLoading = signal(false);
    storeError = signal<string | null>(null);
    storeRefresh = vi.fn(async () => true);
    storeCancel = vi.fn(async () => true);
    storeRerun = vi.fn(async () => true);

    const repoJobStoreStub = {
      jobs: storeJobs.asReadonly(),
      stats: storeStats.asReadonly(),
      loading: storeLoading.asReadonly(),
      error: storeError.asReadonly(),
      refresh: storeRefresh,
      cancel: storeCancel,
      rerun: storeRerun,
    };

    TestBed.configureTestingModule({
      imports: [TasksPageComponent],
      providers: [
        { provide: RepoJobStore, useValue: repoJobStoreStub },
        {
          provide: RepoJobIpcService,
          useValue: { submitJob: vi.fn().mockResolvedValue({ success: true, data: makeJob('new') }) },
        },
        { provide: VcsIpcService, useValue: { vcsIsRepo: vi.fn().mockResolvedValue({ success: false }) } },
        { provide: TaskIpcService, useValue: { taskGetPreflight: vi.fn().mockResolvedValue({ success: false }) } },
        { provide: SessionShareIpcService, useValue: { saveForInstance: vi.fn() } },
        {
          provide: SettingsStore,
          useValue: { defaultWorkingDirectory: computed(() => '') },
        },
        { provide: ActivatedRoute, useValue: { snapshot: { queryParamMap: { get: () => null } } } },
        { provide: Router, useValue: { navigate: vi.fn() } },
      ],
    });

    fixture = TestBed.createComponent(TasksPageComponent);
    component = fixture.componentInstance;
  });

  afterEach(() => {
    fixture.destroy();
    TestBed.resetTestingModule();
  });

  it('renders jobs sourced from RepoJobStore.jobs()', () => {
    storeJobs.set([makeJob('job-1'), makeJob('job-2')]);

    expect(component.filteredJobs().map((job) => job.id)).toEqual(['job-1', 'job-2']);
  });

  it('exposes RepoJobStore.stats() and RepoJobStore.loading() directly', () => {
    storeStats.set({ ...ZERO_STATS, queued: 3, total: 3 });
    storeLoading.set(true);

    expect(component.stats()).toEqual({ ...ZERO_STATS, queued: 3, total: 3 });
    expect(component.loading()).toBe(true);
  });

  it('manual Refresh calls store.refresh(true)', async () => {
    storeRefresh.mockClear();

    await component.refresh();

    expect(storeRefresh).toHaveBeenCalledWith(true);
  });

  it('refresh(false) (the polling path) calls store.refresh(false)', async () => {
    storeRefresh.mockClear();

    await component.refresh(false);

    expect(storeRefresh).toHaveBeenCalledWith(false);
  });

  it('constructor kicks off one initial showLoading refresh', () => {
    // The constructor already ran during TestBed.createComponent() in beforeEach.
    expect(storeRefresh).toHaveBeenCalledWith(true);
  });

  it('surfaces the store error message when refresh() fails', async () => {
    storeRefresh.mockResolvedValueOnce(false);
    storeError.set('stats unavailable');

    await component.refresh();

    expect(component.error()).toBe('stats unavailable');
  });

  it('status filter narrows filteredJobs to matching jobs', () => {
    storeJobs.set([
      makeJob('job-1', { status: 'queued' }),
      makeJob('job-2', { status: 'completed' }),
    ]);

    component.statusFilter.set('completed');

    expect(component.filteredJobs().map((job) => job.id)).toEqual(['job-2']);
  });

  it('type filter narrows filteredJobs to matching jobs', () => {
    storeJobs.set([
      makeJob('job-1', { type: 'pr-review' }),
      makeJob('job-2', { type: 'repo-health-audit' }),
    ]);

    component.typeFilter.set('repo-health-audit');

    expect(component.filteredJobs().map((job) => job.id)).toEqual(['job-2']);
  });

  it('status and type filters combine (AND, not OR)', () => {
    storeJobs.set([
      makeJob('job-1', { status: 'queued', type: 'pr-review' }),
      makeJob('job-2', { status: 'queued', type: 'repo-health-audit' }),
      makeJob('job-3', { status: 'completed', type: 'pr-review' }),
    ]);

    component.statusFilter.set('queued');
    component.typeFilter.set('pr-review');

    expect(component.filteredJobs().map((job) => job.id)).toEqual(['job-1']);
  });

  it('the Cancel button click handler calls store.cancel(jobId)', async () => {
    await component.cancel('job-1');

    expect(storeCancel).toHaveBeenCalledWith('job-1');
  });

  it('the Rerun button click handler calls store.rerun(jobId)', async () => {
    await component.rerun('job-1');

    expect(storeRerun).toHaveBeenCalledWith('job-1');
  });

  it('a failed cancel surfaces the store error and does not clear it optimistically', async () => {
    storeCancel.mockResolvedValueOnce(false);
    storeError.set('cannot cancel');

    await component.cancel('job-1');

    expect(component.error()).toBe('cannot cancel');
  });

  it('a failed rerun surfaces the store error', async () => {
    storeRerun.mockResolvedValueOnce(false);
    storeError.set('cannot rerun');

    await component.rerun('job-1');

    expect(component.error()).toBe('cannot rerun');
  });

  it('a successful cancel clears any prior page error', async () => {
    component.error.set('previous failure');
    storeCancel.mockResolvedValueOnce(true);

    await component.cancel('job-1');

    expect(component.error()).toBeNull();
  });
});
