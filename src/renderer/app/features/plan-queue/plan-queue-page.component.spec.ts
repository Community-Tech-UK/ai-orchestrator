import { signal, ɵresolveComponentResources as resolveComponentResources } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlanQueueItemDto, PlanQueueRunDto } from '@contracts/schemas/plan-queue';
import { CopilotAccountIpcService } from '../../core/services/ipc/copilot-account-ipc.service';
import { ProviderAccountIpcService } from '../../core/services/ipc/provider-account-ipc.service';
import { InstanceStore } from '../../core/state/instance.store';
import { PlanQueueStore } from '../../core/state/plan-queue.store';
import { SettingsStore } from '../../core/state/settings.store';
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

const NEEDS_ANSWER_ITEM: PlanQueueItemDto = {
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
};

const PARKED_ITEM: PlanQueueItemDto = {
  ...NEEDS_ANSWER_ITEM,
  id: 'item-parked',
  state: 'parked',
  round: 3,
  erroredRounds: 1,
  branchName: 'plan-queue/a-plan',
  question: null,
  parkReason: 'round-limit',
};

describe('PlanQueuePageComponent', () => {
  let fixture: ComponentFixture<PlanQueuePageComponent>;
  let store: {
    allRuns: ReturnType<typeof signal<PlanQueueRunDto[]>>;
    reconcilerAlerts: ReturnType<typeof signal<unknown[]>>;
    isLoading: ReturnType<typeof signal<boolean>>;
    lastError: ReturnType<typeof signal<string | null>>;
    needsAnswerItems: ReturnType<typeof signal<unknown[]>>;
    questionGroups: ReturnType<typeof signal<unknown[]>>;
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
      questionGroups: signal([]),
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
          provide: SettingsStore,
          useValue: {
            settings: signal({ planQueueRouting: { worker: null, verifiers: [] }, providersExcludedFromAutomation: [] }),
            error: signal(null),
            clearError: vi.fn(),
            set: vi.fn().mockResolvedValue(undefined),
          },
        },
        { provide: ProviderAccountIpcService, useValue: { list: vi.fn().mockResolvedValue({ profiles: [], pools: {} }) } },
        { provide: CopilotAccountIpcService, useValue: { list: vi.fn().mockResolvedValue([]) } },
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

  it('owns its scrolling, because the Control Center content cell clips overflow', () => {
    const host = getComputedStyle(fixture.nativeElement as HTMLElement);
    expect(host.overflowY).toBe('auto');
    expect(host.height).toBe('100%');
  });

  it('leads with the questions, then runs, providers, start, livetest checks, parked work and alerts, each with a purpose line', async () => {
    store.needsAnswerItems.set([NEEDS_ANSWER_ITEM]);
    store.questionGroups.set([{ runId: 'run-x', kind: 'plans', workspaceCwd: '/repo', items: [NEEDS_ANSWER_ITEM] }]);
    store.needJamesReal.set([{ runId: 'run-1', itemId: 'item-1', documentPath: 'docs/x.md', check: 'c', reason: 'r' }]);
    store.parkedItems.set([PARKED_ITEM]);
    fixture.detectChanges();
    await fixture.whenStable();

    const sections = Array.from(fixture.nativeElement.querySelectorAll('section.pq-section') as NodeListOf<HTMLElement>);
    expect(sections.map((section) => section.querySelector('h2')?.textContent?.trim())).toEqual([
      'Needs your answer',
      'Runs',
      'Providers and accounts',
      'Start a run',
      'Needs James (livetests)',
      'Parked work',
      'Reconciler alerts',
    ]);
    for (const section of sections) {
      expect(section.querySelector('.pq-purpose, .pq-routing-purpose')?.textContent?.trim()).toBeTruthy();
    }
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

  it('forwards an answer from the questions section to store.answer with the item and option ids', async () => {
    store.needsAnswerItems.set([NEEDS_ANSWER_ITEM]);
    store.questionGroups.set([{ runId: 'run-x', kind: 'plans', workspaceCwd: '/repo', items: [NEEDS_ANSWER_ITEM] }]);
    fixture.detectChanges();
    await fixture.whenStable();

    const radio = fixture.nativeElement.querySelector('.pq-section-questions .pq-question-options input[type="radio"]') as HTMLInputElement;
    radio.dispatchEvent(new Event('change'));
    fixture.detectChanges();
    (fixture.nativeElement.querySelector('.pq-question-submit') as HTMLButtonElement).click();

    expect(store.answer).toHaveBeenCalledWith('item-1', radio.value);
  });

  it('shows parked work and forwards a discard confirmation to store.control', async () => {
    store.parkedItems.set([PARKED_ITEM]);
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
  it('forwards Try merging again to the retry-landing control action', async () => {
    store.parkedItems.set([{ ...PARKED_ITEM, parkReason: 'land-blocked',
      verdict: { verdict: 'PASS', findings: [], gatesRun: [], documentComplete: true, needJames: [] },
    }]); fixture.detectChanges(); await fixture.whenStable();
    fixture.nativeElement.querySelector('.pq-retry-landing').click();
    expect(store.control).toHaveBeenCalledWith({ action: 'retry-landing', itemId: 'item-parked' });
  });

  it('shows counted global controls only for running and paused runs and dispatches them', () => {
    expect(fixture.nativeElement.querySelector('.pq-pause-all')).toBeNull();
    expect(fixture.nativeElement.querySelector('.pq-resume-all')).toBeNull();
    store.allRuns.set([makeRun(), makeRun({ id: 'paused', status: 'paused' }), makeRun({ id: 'done', status: 'completed' })]);
    fixture.detectChanges();
    const pause = fixture.nativeElement.querySelector('.pq-pause-all') as HTMLButtonElement;
    const resume = fixture.nativeElement.querySelector('.pq-resume-all') as HTMLButtonElement;
    expect(pause.textContent).toContain('Pause all (1 running)');
    expect(resume.textContent).toContain('Resume all (1 paused)');
    pause.click(); resume.click();
    expect(store.control).toHaveBeenCalledWith({ action: 'pause-all' });
    expect(store.control).toHaveBeenCalledWith({ action: 'resume-all' });
    expect(fixture.nativeElement.querySelector('.pq-section-runs .pq-purpose').textContent).toContain("Pause stops the run's sessions now");
  });

  it('counts and controls active runs older than fifty recent finished runs', () => {
    const history = Array.from({ length: 50 }, (_, index) => makeRun({ id: `finished-${index}`, status: 'completed', startedAt: 100 + index }));
    store.allRuns.set([...history,
      makeRun({ id: 'old-running', startedAt: 1 }),
      makeRun({ id: 'old-paused', status: 'paused', startedAt: 2, kind: 'livetests' }),
    ]);
    fixture.detectChanges();
    const pause = fixture.nativeElement.querySelector('.pq-pause-all') as HTMLButtonElement;
    const resume = fixture.nativeElement.querySelector('.pq-resume-all') as HTMLButtonElement;
    expect(pause.textContent).toContain('Pause all (1 running)');
    expect(resume.textContent).toContain('Resume all (1 paused)');
    expect(fixture.nativeElement.querySelectorAll('.pq-run')).toHaveLength(52);
    pause.click(); resume.click();
    expect(store.control).toHaveBeenCalledWith({ action: 'pause-all' });
    expect(store.control).toHaveBeenCalledWith({ action: 'resume-all' });
  });

  it('offers Change immediately for old completed and cancelled parked runs while bulk counts stay active-only', async () => {
    const history = Array.from({ length: 50 }, (_, index) => makeRun({ id: `inert-${index}`, status: 'completed', startedAt: 100 + index }));
    const completed = makeRun({ id: 'old-completed', status: 'completed', startedAt: 2,
      items: [{ ...PARKED_ITEM, runId: 'old-completed' }] });
    const cancelled = makeRun({ id: 'old-cancelled', status: 'cancelled', kind: 'livetests', startedAt: 1,
      items: [{ ...PARKED_ITEM, runId: 'old-cancelled', branchName: null, parkReason: 'triage-failed' }] });
    store.allRuns.set([...history, completed, cancelled,
      makeRun({ id: 'running' }), makeRun({ id: 'paused', status: 'paused' }),
    ]);
    fixture.detectChanges(); await fixture.whenStable();
    const cards = Array.from(fixture.nativeElement.querySelectorAll('.pq-run') as NodeListOf<HTMLElement>);
    expect(cards).toHaveLength(54);
    expect(cards.slice(0, 50).every(card => card.querySelector('.pq-run-change') === null)).toBe(true);
    expect(fixture.nativeElement.querySelector('.pq-pause-all').textContent).toContain('Pause all (1 running)');
    expect(fixture.nativeElement.querySelector('.pq-resume-all').textContent).toContain('Resume all (1 paused)');
    for (const card of cards.slice(50, 52)) {
      const change = card.querySelector('.pq-run-change') as HTMLButtonElement;
      expect(change.textContent?.trim()).toBe('Change');
      change.click(); fixture.detectChanges(); await fixture.whenStable();
      expect(card.querySelector('app-plan-queue-routing-panel')).not.toBeNull();
      expect(card.querySelector('.pq-routing-move-progress')).toBeNull();
    }
    expect(store.control).not.toHaveBeenCalled();
  });

  it('opens Change for the selected run, saves its routing, and keeps saved defaults separate', async () => {
    store.control.mockResolvedValue({ success: true, data: null });
    store.allRuns.set([makeRun({ id: 'edit-me', status: 'paused', config: { ...makeRun().config, routing: { worker: { provider: 'claude', model: 'opus' }, verifiers: [] } } })]);
    fixture.detectChanges();
    (fixture.nativeElement.querySelector('.pq-run-change') as HTMLButtonElement).click();
    fixture.detectChanges(); await fixture.whenStable();
    const editor = fixture.nativeElement.querySelector('.pq-run app-plan-queue-routing-panel') as HTMLElement;
    const model = editor.querySelector('.pq-routing-workers input[type="text"]') as HTMLInputElement;
    expect(model.value).toBe('opus');
    model.value = 'sonnet'; model.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    (editor.querySelector('.pq-routing-save') as HTMLButtonElement).click();
    await fixture.whenStable();
    expect(store.control).toHaveBeenCalledWith({ action: 'set-routing', runId: 'edit-me', routing: { worker: { provider: 'claude', model: 'sonnet' }, verifiers: [] } });
    expect(fixture.nativeElement.querySelectorAll('app-plan-queue-routing-panel')).toHaveLength(2);
    expect(editor.querySelector('.pq-routing-move-progress')).toBeNull();
  });

});
