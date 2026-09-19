import { signal, ɵresolveComponentResources as resolveComponentResources } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlanQueueRunDto } from '@contracts/schemas/plan-queue';
import { InstanceStore } from '../../core/state/instance.store';
import { PlanQueueStore } from '../../core/state/plan-queue.store';
import { PlanQueuePageComponent } from './plan-queue-page.component';

const specDirectory = dirname(fileURLToPath(import.meta.url));
const componentsDirectory = resolve(specDirectory, './components');

/** Every template/style this page transitively renders, keyed by filename. */
const resources = new Map<string, string>();
for (const dir of [specDirectory, componentsDirectory]) {
  for (const name of readdirSync(dir)) {
    if (name.endsWith('.html') || name.endsWith('.scss')) {
      resources.set(name, readFileSync(resolve(dir, name), 'utf8'));
    }
  }
}

await resolveComponentResources((url) => {
  for (const [name, content] of resources) {
    if (url.endsWith(name)) return Promise.resolve(content);
  }
  if (url.endsWith('.html') || url.endsWith('.scss')) return Promise.resolve('');
  return Promise.reject(new Error(`Unexpected resource: ${url}`));
});

function makeRun(overrides: Partial<PlanQueueRunDto> = {}): PlanQueueRunDto {
  return {
    id: 'run-1',
    parentInstanceId: 'inst-1',
    kind: 'plans',
    workspaceCwd: '/repo',
    status: 'running',
    config: {
      workerSlots: 3,
      verificationSlots: 2,
      maxRounds: 3,
      maxLoadAverage: 30,
      postMergeGate: [],
      verifierGates: [],
      relaxSettings: false,
    },
    workerProvider: 'claude',
    relaxedSettings: [],
    startedAt: 1,
    endedAt: null,
    items: [],
    ...overrides,
  };
}

describe('PlanQueuePageComponent', () => {
  let fixture: ComponentFixture<PlanQueuePageComponent>;
  let store: {
    allRuns: ReturnType<typeof signal<PlanQueueRunDto[]>>;
    reconcilerAlerts: ReturnType<typeof signal<unknown[]>>;
    isLoading: ReturnType<typeof signal<boolean>>;
    lastError: ReturnType<typeof signal<string | null>>;
    needsAnswerItems: ReturnType<typeof signal<unknown[]>>;
    parkedItems: ReturnType<typeof signal<unknown[]>>;
    needJamesReal: ReturnType<typeof signal<unknown[]>>;
    policyGatedCount: ReturnType<typeof signal<number>>;
    ensureWired: ReturnType<typeof vi.fn>;
    load: ReturnType<typeof vi.fn>;
    refreshAlerts: ReturnType<typeof vi.fn>;
    startRun: ReturnType<typeof vi.fn>;
    answer: ReturnType<typeof vi.fn>;
    control: ReturnType<typeof vi.fn>;
    diffstat: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    store = {
      allRuns: signal([]),
      reconcilerAlerts: signal([]),
      isLoading: signal(false),
      lastError: signal(null),
      needsAnswerItems: signal([]),
      parkedItems: signal([]),
      needJamesReal: signal([]),
      policyGatedCount: signal(0),
      ensureWired: vi.fn(),
      load: vi.fn().mockResolvedValue(undefined),
      refreshAlerts: vi.fn().mockResolvedValue(undefined),
      startRun: vi.fn().mockResolvedValue({ success: true, data: { run: makeRun(), excluded: [] } }),
      answer: vi.fn().mockResolvedValue(undefined),
      control: vi.fn().mockResolvedValue(undefined),
      diffstat: vi.fn().mockResolvedValue(''),
    };

    await TestBed.configureTestingModule({
      imports: [PlanQueuePageComponent],
      providers: [
        { provide: PlanQueueStore, useValue: store },
        {
          provide: InstanceStore,
          useValue: {
            rootInstances: signal([
              { id: 'inst-1', displayName: 'Root session', provider: 'claude', workingDirectory: '/repo-a' },
            ]),
          },
        },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(PlanQueuePageComponent);
    fixture.detectChanges();
    await fixture.whenStable();
  });

  it('wires the store and loads on init', () => {
    expect(store.ensureWired).toHaveBeenCalledTimes(1);
    expect(store.load).toHaveBeenCalledTimes(1);
  });

  it('maps root instances into parent session options for the start form', () => {
    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('Root session (claude)');
    expect(text).toContain('/repo-a');
  });

  it('starts a run via the store when the start form emits', async () => {
    const select = fixture.nativeElement.querySelector('select') as HTMLSelectElement;
    select.value = 'inst-1';
    select.dispatchEvent(new Event('change'));
    fixture.detectChanges();
    await fixture.whenStable();

    (fixture.nativeElement.querySelector('button[type="submit"]') as HTMLButtonElement).click();

    expect(store.startRun).toHaveBeenCalledWith({ parentInstanceId: 'inst-1', kind: 'plans', workspaceCwd: '/repo-a' });
  });

  it('shows an attention banner when items need an answer', async () => {
    store.needsAnswerItems.set([{ id: 'item-1' }]);
    fixture.detectChanges();
    await fixture.whenStable();

    expect(fixture.nativeElement.textContent).toContain('1 item(s) need your answer');
  });

  it('shows the surfaced error from the store', async () => {
    store.lastError.set('Failed to start plan queue run');
    fixture.detectChanges();
    await fixture.whenStable();

    expect(fixture.nativeElement.textContent).toContain('Failed to start plan queue run');
  });

  it('refreshes alerts via the store when the alerts panel asks', () => {
    (fixture.nativeElement.querySelector('.pq-alerts-head button') as HTMLButtonElement).click();
    expect(store.refreshAlerts).toHaveBeenCalledTimes(1);
  });

  it('renders the empty-runs message with no runs loaded', () => {
    expect(fixture.nativeElement.textContent).toContain('No plan queue runs yet.');
  });

  it('renders loaded runs and forwards a pause action to the store control call', async () => {
    store.allRuns.set([makeRun({ id: 'run-x', status: 'running' })]);
    fixture.detectChanges();
    await fixture.whenStable();

    const runButtons = fixture.nativeElement.querySelectorAll('.pq-run-controls button');
    (runButtons[0] as HTMLButtonElement).click();

    expect(store.control).toHaveBeenCalledWith({ action: 'pause', runId: 'run-x' });
  });

  it('forwards an answer event to store.answer with the item and option ids', async () => {
    store.allRuns.set([
      makeRun({
        id: 'run-x',
        items: [
          {
            id: 'item-1',
            runId: 'run-x',
            documentPath: 'docs/plans/a_plan.md',
            state: 'needs-answer',
            round: 1,
            erroredRounds: 0,
            branchName: null,
            worktreePath: null,
            baseCommit: null,
            checkpointCommit: null,
            landedCommit: null,
            workerInstanceId: null,
            verifierInstanceId: null,
            question: { question: 'Pick one', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] },
            answer: null,
            parkReason: null,
            detail: null,
            verdict: null,
            createdAt: 1,
            updatedAt: 1,
          },
        ],
      }),
    ]);
    fixture.detectChanges();
    await fixture.whenStable();

    const radio = fixture.nativeElement.querySelector('.pq-question-options input[type="radio"]') as HTMLInputElement;
    radio.dispatchEvent(new Event('change'));
    fixture.detectChanges();
    (fixture.nativeElement.querySelector('.pq-question-submit') as HTMLButtonElement).click();

    expect(store.answer).toHaveBeenCalledWith('item-1', radio.value);
  });

  it('shows parked work and forwards a discard confirmation to store.control', async () => {
    store.parkedItems.set([
      {
        id: 'item-parked',
        runId: 'run-x',
        documentPath: 'docs/plans/a_plan.md',
        state: 'parked',
        round: 3,
        erroredRounds: 1,
        branchName: 'plan-queue/a-plan',
        worktreePath: null,
        baseCommit: null,
        checkpointCommit: null,
        landedCommit: null,
        workerInstanceId: null,
        verifierInstanceId: null,
        question: null,
        answer: null,
        parkReason: 'round-limit',
        detail: null,
        verdict: null,
        createdAt: 1,
        updatedAt: 1,
      },
    ]);
    fixture.detectChanges();
    await fixture.whenStable();

    (fixture.nativeElement.querySelector('.pq-discard') as HTMLButtonElement).click();
    fixture.detectChanges();
    (fixture.nativeElement.querySelector('.pq-confirm-yes') as HTMLButtonElement).click();

    expect(store.control).toHaveBeenCalledWith({ action: 'discard-item', itemId: 'item-parked' });
  });

  it('shows the need-James panel only when there is something to report', async () => {
    expect(fixture.nativeElement.querySelector('.pq-need-james')).toBeNull();

    store.needJamesReal.set([{ runId: 'run-1', itemId: 'item-1', documentPath: 'docs/x.md', check: 'c', reason: 'r' }]);
    fixture.detectChanges();
    await fixture.whenStable();

    expect(fixture.nativeElement.querySelector('.pq-need-james')).not.toBeNull();
  });
});
