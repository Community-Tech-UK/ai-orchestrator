/**
 * The session list's rows for Plan Queue steps that have no session. Drives the real component and the real
 * placement service against a seeded queue store, with a fake clock, and asserts what a user would read.
 */
import { ChangeDetectionStrategy, Component, signal, ɵresolveComponentResources as resolveComponentResources } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { Router } from '@angular/router';
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlanQueueItemDto, PlanQueueItemStage, PlanQueueRunDto } from '@contracts/schemas/plan-queue';
import { DEFAULT_PLAN_QUEUE_CONFIG } from '@contracts/schemas/plan-queue';
import { InstanceStore } from '../../core/state/instance.store';
import { PlanQueueStore } from '../../core/state/plan-queue.store';
import { ScratchDirectoryService } from '../../core/services/scratch-directory.service';
import type { Instance } from '../../../../shared/types/instance.types';
import { PlanQueueStageRowsComponent } from './plan-queue-stage-rows.component';

await resolveComponentResources(async (url: string) =>
  (url.endsWith('.html') ? readFileSync(join(__dirname, basename(url)), 'utf8') : ''));

const MIN = 60_000;
const START = Date.UTC(2026, 10, 5, 10, 0, 0);

function job(id: string, stage: PlanQueueItemStage | null, overrides: Partial<PlanQueueItemDto> = {}): PlanQueueItemDto {
  return {
    id, runId: 'run', documentPath: `/repo/docs/plans/${id}_plan.md`, state: 'verifying', round: 0, erroredRounds: 0,
    branchName: null, worktreePath: null, baseCommit: null, checkpointCommit: null, landedCommit: null,
    workerInstanceId: null, verifierInstanceId: null, question: null, answer: null, parkReason: null, detail: null,
    verdict: null, createdAt: 1, updatedAt: 1, ...(stage ? { stage } : {}), ...overrides,
  };
}

function run(items: PlanQueueItemDto[], overrides: Partial<PlanQueueRunDto> = {}): PlanQueueRunDto {
  return {
    id: 'run', parentInstanceId: 'parent', kind: 'plans', workspaceCwd: '/Repo', status: 'running',
    config: DEFAULT_PLAN_QUEUE_CONFIG.plans, workerProvider: 'claude', relaxedSettings: [], startedAt: 1, endedAt: null,
    items, ...overrides,
  };
}

@Component({
  standalone: true,
  imports: [PlanQueueStageRowsComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section data-parent><app-plan-queue-stage-rows [parentInstanceId]="parentId()" [depth]="1" /></section>
    <section data-project><app-plan-queue-stage-rows [projectKey]="projectKey()" /></section>`,
})
class HostComponent {
  readonly parentId = signal<string | null>('parent');
  readonly projectKey = signal<string | null>('/repo');
}

describe('PlanQueueStageRowsComponent', () => {
  let fixture: ComponentFixture<HostComponent>;
  let runs: ReturnType<typeof signal<PlanQueueRunDto[]>>;
  let instances: ReturnType<typeof signal<Instance[]>>;
  let ensureLoaded: ReturnType<typeof vi.fn>;
  let navigate: ReturnType<typeof vi.fn>;

  const rows = (where: 'parent' | 'project') =>
    Array.from(fixture.nativeElement.querySelectorAll(`[data-${where}] .pq-stage-row .pq-stage-text`) as NodeListOf<HTMLElement>)
      .map(row => row.textContent!.replace(/\s+/g, ' ').trim());

  async function show(next: PlanQueueRunDto[]): Promise<void> {
    runs.set(next);
    fixture.detectChanges();
    await fixture.whenStable();
  }

  async function advance(ms: number): Promise<void> {
    await vi.advanceTimersByTimeAsync(ms);
    fixture.detectChanges();
    await fixture.whenStable();
  }

  function create(): void {
    fixture = TestBed.createComponent(HostComponent);
    fixture.detectChanges();
  }

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(START);
    runs = signal<PlanQueueRunDto[]>([]);
    instances = signal<Instance[]>([{ id: 'parent', status: 'idle', metadata: {} } as Instance]);
    ensureLoaded = vi.fn();
    navigate = vi.fn().mockResolvedValue(true);
    await TestBed.configureTestingModule({
      imports: [HostComponent],
      providers: [
        { provide: PlanQueueStore, useValue: { allRuns: runs, ensureLoaded } },
        { provide: InstanceStore, useValue: { instances } },
        { provide: ScratchDirectoryService, useValue: { isScratch: () => false } },
        { provide: Router, useValue: { navigate } },
      ],
    }).compileComponents();
    create();
  });

  afterEach(() => {
    fixture.destroy();
    TestBed.resetTestingModule();
    vi.useRealTimers();
  });

  it('shows nothing, and runs no clock, while no job is in such a step', async () => {
    await show([run([job('working', null, { state: 'working' })])]);
    expect(fixture.nativeElement.querySelector('.pq-stage')).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    expect(ensureLoaded).toHaveBeenCalledTimes(1);
  });

  it.each([
    [{ name: 'checks', startedAt: START - 12 * MIN }, 'Checking alpha: tests running, 12 min'],
    [{ name: 'landing', startedAt: START - 9 * MIN }, 'Landing alpha: commit checks running, 9 min'],
    [{ name: 'waiting-for-checks', startedAt: START - 4 * MIN, checkWait: 'other-checks' }, 'alpha: waiting for a free check slot, 4 min'],
    [{ name: 'waiting-to-land', startedAt: START - 2 * MIN }, 'alpha: waiting for another job to finish landing, 2 min'],
  ] as const)('shows one job in step %o under the session that started the run', async (stage, expected) => {
    await show([run([job('alpha', stage)])]);
    expect(rows('parent')).toEqual([expected]);
    expect(rows('project')).toEqual([]);
    const group = fixture.nativeElement.querySelector('[data-parent] .pq-stage') as HTMLElement;
    // One level in from its depth-1 parent, where that session's own helpers sit.
    expect(group.style.paddingLeft).toBe('42px');
  });

  it('shows two jobs in different steps as one summary that expands to each job', async () => {
    await show([run([
      job('alpha', { name: 'checks', startedAt: START - 12 * MIN }),
      job('beta', { name: 'landing', startedAt: START - 9 * MIN }, { state: 'landing' }),
    ])]);
    expect(rows('parent')).toEqual(['Plan Queue: 1 checking, 1 landing']);
    const summary = fixture.nativeElement.querySelector('.pq-stage-summary') as HTMLButtonElement;
    expect(summary.getAttribute('aria-expanded')).toBe('false');
    summary.click();
    fixture.detectChanges();
    expect(summary.getAttribute('aria-expanded')).toBe('true');
    expect(rows('parent')).toEqual([
      'Plan Queue: 1 checking, 1 landing',
      'Checking alpha: tests running, 12 min',
      'Landing beta: commit checks running, 9 min',
    ]);
  });

  it('moves the time on while the step runs, and disappears when it ends', async () => {
    await show([run([job('alpha', { name: 'checks', startedAt: START - 12 * MIN })])]);
    expect(rows('parent')).toEqual(['Checking alpha: tests running, 12 min']);
    await advance(60_000);
    expect(rows('parent')).toEqual(['Checking alpha: tests running, 13 min']);
    await show([run([job('alpha', null, { verifierInstanceId: 'checker' })])]);
    expect(rows('parent')).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('says plainly when a step is taking longer than usual', async () => {
    await show([run([
      job('alpha', { name: 'checks', startedAt: START - 47 * MIN }),
      job('beta', { name: 'waiting-for-checks', startedAt: START - 5 * MIN }, { state: 'awaiting-slot' }),
    ])]);
    expect(rows('parent')).toEqual(['Plan Queue: 1 checking, 1 waiting, 1 taking longer than usual']);
    (fixture.nativeElement.querySelector('.pq-stage-summary') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(rows('parent')[1]).toBe('Checking alpha: tests running, 47 min (longer than usual)');
  });

  it('after a restart, times the step from when it started, not from when the list opened', async () => {
    fixture.destroy();
    TestBed.resetTestingModule();
    // The app comes back 25 minutes into the check; the queue's stored start time is all the list has.
    vi.setSystemTime(START + 25 * MIN);
    runs = signal<PlanQueueRunDto[]>([run([job('alpha', { name: 'checks', startedAt: START })])]);
    await TestBed.configureTestingModule({
      imports: [HostComponent],
      providers: [
        { provide: PlanQueueStore, useValue: { allRuns: runs, ensureLoaded } },
        { provide: InstanceStore, useValue: { instances } },
        { provide: ScratchDirectoryService, useValue: { isScratch: () => false } },
        { provide: Router, useValue: { navigate } },
      ],
    }).compileComponents();
    create();
    await fixture.whenStable();
    expect(rows('parent')).toEqual(['Checking alpha: tests running, 25 min']);
  });

  it('shows a run at the top of its project when the session that started it is gone', async () => {
    instances.set([{ id: 'parent', status: 'superseded', metadata: {} } as Instance]);
    await show([run([job('alpha', { name: 'checks', startedAt: START - 3 * MIN })])]);
    expect(rows('parent')).toEqual([]);
    expect(rows('project')).toEqual(['Checking alpha: tests running, 3 min']);
    instances.set([]);
    fixture.detectChanges();
    expect(rows('project')).toEqual(['Checking alpha: tests running, 3 min']);
    // A session the list never shows (an internal helper) cannot hold the rows either.
    instances.set([{ id: 'parent', status: 'idle', metadata: { hideFromProjectRail: true } } as unknown as Instance]);
    fixture.detectChanges();
    expect(rows('parent')).toEqual([]);
    expect(rows('project')).toEqual(['Checking alpha: tests running, 3 min']);
    fixture.componentInstance.projectKey.set('/elsewhere');
    fixture.detectChanges();
    expect(rows('project')).toEqual([]);
  });

  it('shows nothing for a paused run', async () => {
    await show([run([job('alpha', { name: 'checks', startedAt: START })], { status: 'paused' })]);
    expect(rows('parent')).toEqual([]);
    expect(rows('project')).toEqual([]);
  });

  it('opens the Plan Queue page from a job row, and says so in its tooltip', async () => {
    await show([run([job('alpha', { name: 'checks', startedAt: START })])]);
    const row = fixture.nativeElement.querySelector('.pq-stage-line') as HTMLButtonElement;
    row.dispatchEvent(new MouseEvent('mouseenter'));
    vi.advanceTimersByTime(2000);
    fixture.detectChanges();
    const tooltips = Array.from(document.querySelectorAll('[role="tooltip"]')).map(tip => tip.textContent?.trim());
    expect(tooltips).toEqual(['Harness is running this job\'s checks itself, so no session shows it. Opens Plan Queue.']);
    row.dispatchEvent(new MouseEvent('mouseleave'));
    vi.advanceTimersByTime(2000);
    row.click();
    expect(navigate).toHaveBeenCalledWith(['/plan-queue']);
  });
});
