import { signal, ɵresolveComponentResources as resolveComponentResources } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlanQueueHealth, PlanQueueItemDto, PlanQueueRouting, PlanQueueRunDto } from '@contracts/schemas/plan-queue';
import { CopilotAccountIpcService } from '../../core/services/ipc/copilot-account-ipc.service';
import { PlanQueueIpcService } from '../../core/services/ipc/plan-queue-ipc.service';
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
    retryProgress: ReturnType<typeof signal<{ done: number; total: number; stopping: boolean } | null>>;
    retryLandings: ReturnType<typeof vi.fn>;
    stopRetrying: ReturnType<typeof vi.fn>;
    needsAnswerItems: ReturnType<typeof signal<unknown[]>>;
    questionGroups: ReturnType<typeof signal<unknown[]>>;
    parkedItems: ReturnType<typeof signal<unknown[]>>;
    startSetAsideAgent: ReturnType<typeof vi.fn>;
    needJamesReal: ReturnType<typeof signal<unknown[]>>;
    policyGatedCount: ReturnType<typeof signal<number>>;
    queueHealth: ReturnType<typeof signal<PlanQueueHealth | null>>;
    ensureWired: ReturnType<typeof vi.fn>;
    load: ReturnType<typeof vi.fn>;
    refreshAlerts: ReturnType<typeof vi.fn>;
    startRun: ReturnType<typeof vi.fn>;
    answer: ReturnType<typeof vi.fn>;
    control: ReturnType<typeof vi.fn>;
    diffstat: ReturnType<typeof vi.fn>;
  };
  let settings: ReturnType<typeof signal<{ planQueueRouting: PlanQueueRouting; providersExcludedFromAutomation: string[] }>>;
  let providerAccounts: ReturnType<typeof vi.fn>;
  let setSelectedInstance: ReturnType<typeof vi.fn>;
  let rootInstances: ReturnType<typeof signal<Record<string, unknown>[]>>;
  let instances: ReturnType<typeof signal<Record<string, unknown>[]>>;
  let ipcControl: ReturnType<typeof vi.fn>;

  function clickTab(label: string): void {
    const tab = Array.from(fixture.nativeElement.querySelectorAll('[role="tab"]') as NodeListOf<HTMLButtonElement>)
      .find(button => button.textContent?.trim() === label)!;
    tab.click(); fixture.detectChanges();
  }

  beforeEach(async () => {
    settings = signal({ planQueueRouting: { workers: [], verifiers: [] }, providersExcludedFromAutomation: [] });
    providerAccounts = vi.fn().mockResolvedValue({ profiles: [], pools: {} });
    rootInstances = signal<Record<string, unknown>[]>([
      { id: 'inst-1', displayName: 'Root session', provider: 'claude', workingDirectory: '/repo-a' },
    ]);
    instances = signal<Record<string, unknown>[]>([]);
    ipcControl = vi.fn().mockResolvedValue({ success: true, data: null });
    store = {
      allRuns: signal([]),
      reconcilerAlerts: signal([]),
      isLoading: signal(false),
      lastError: signal(null),
      retryProgress: signal<{ done: number; total: number; stopping: boolean } | null>(null),
      retryLandings: vi.fn().mockResolvedValue(undefined),
      stopRetrying: vi.fn(),
      needsAnswerItems: signal([]),
      questionGroups: signal([]),
      parkedItems: signal([]),
      needJamesReal: signal([]),
      policyGatedCount: signal(0),
      queueHealth: signal<PlanQueueHealth | null>(null),
      ensureWired: vi.fn(),
      load: vi.fn().mockResolvedValue(undefined),
      refreshAlerts: vi.fn().mockResolvedValue(undefined),
      startRun: vi.fn().mockResolvedValue({ success: true, data: { run: makeRun(), excluded: [] } }),
      answer: vi.fn().mockResolvedValue(undefined),
      control: vi.fn().mockResolvedValue(undefined),
      diffstat: vi.fn().mockResolvedValue(''),
      startSetAsideAgent: vi.fn().mockResolvedValue('agent-1'),
    };
    setSelectedInstance = vi.fn();

    await TestBed.configureTestingModule({
      imports: [PlanQueuePageComponent],
      providers: [
        provideRouter([]),
        { provide: PlanQueueStore, useValue: store },
        { provide: PlanQueueIpcService, useValue: { control: ipcControl, preview: vi.fn().mockResolvedValue({ success: true, data: { found: 1, hiddenCopies: 0, hiddenCountComplete: true } }) } },
        {
          provide: SettingsStore,
          useValue: {
            settings,
            error: signal(null),
            clearError: vi.fn(),
            set: vi.fn().mockResolvedValue(undefined),
          },
        },
        { provide: ProviderAccountIpcService, useValue: { list: providerAccounts } },
        { provide: CopilotAccountIpcService, useValue: { list: vi.fn().mockResolvedValue([]) } },
        {
          provide: InstanceStore,
          useValue: { rootInstances, instances, setSelectedInstance },
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

  it('opens Now, hides empty alerts, and switches to Setup with the keyboard', () => {
    const tabs = Array.from(fixture.nativeElement.querySelectorAll('[role="tab"]')) as HTMLButtonElement[];
    expect(tabs.map(tab => tab.textContent?.trim())).toEqual(['Now', 'Set aside', 'Setup']);
    expect(tabs[0].getAttribute('aria-selected')).toBe('true');
    expect(fixture.nativeElement.querySelector('.pq-section-alerts')).toBeNull();
    tabs[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    fixture.detectChanges();
    expect(tabs[2].getAttribute('aria-selected')).toBe('true');
    expect(fixture.nativeElement.querySelector('app-plan-queue-account-rules-panel')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('app-plan-queue-folder-checklists-panel')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('.pq-section-start')).toBeNull();
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
    await fixture.whenStable();
    expect(store.startRun).toHaveBeenCalledWith({ parentInstanceId: 'inst-1', kind: 'plans', workspaceCwd: '/repo-a' });
  });

  it('previews bulk skip and leaves a job that starts before confirmation alone', async () => {
    const queued = { ...NEEDS_ANSWER_ITEM, state: 'queued' as const, question: null };
    store.allRuns.set([makeRun({ items: [queued, { ...queued, id: 'other', documentPath: 'other_plan.md' }] })]);
    fixture.detectChanges(); await fixture.whenStable();
    const button = Array.from(fixture.nativeElement.querySelectorAll('button') as NodeListOf<HTMLButtonElement>)
      .find(b => b.textContent?.includes('Skip all not started'));
    expect(button).toBeDefined(); button!.click(); fixture.detectChanges();
    expect(store.control).not.toHaveBeenCalled();
    expect(fixture.nativeElement.textContent).toContain('Will change');
    store.allRuns.set([makeRun({ items: [{ ...queued, state: 'working', workerInstanceId: 'worker' }, { ...queued, id: 'other', documentPath: 'other_plan.md' }] })]);
    fixture.detectChanges();
    const confirm = fixture.nativeElement.querySelector('.pq-confirm-skip') as HTMLButtonElement;
    confirm.click();
    expect(store.control).toHaveBeenCalledExactlyOnceWith({ action: 'skip-item', itemId: 'other' });
  });

  it('shows an attention banner when items need an answer', async () => {
    store.needsAnswerItems.set([{ id: 'item-1' }]);
    fixture.detectChanges();
    await fixture.whenStable();

    expect(fixture.nativeElement.textContent).toContain('1 item needs your answer');
  });

  it('owns its scrolling, because the Control Center content cell clips overflow', () => {
    const host = getComputedStyle(fixture.nativeElement as HTMLElement);
    expect(host.overflowY).toBe('auto');
    expect(host.height).toBe('100%');
  });

  it('keeps questions and current work in Now, retained work in Set aside, and accounts in Setup', async () => {
    store.needsAnswerItems.set([NEEDS_ANSWER_ITEM]);
    store.questionGroups.set([{ runId: 'run-x', kind: 'plans', workspaceCwd: '/repo', items: [NEEDS_ANSWER_ITEM] }]);
    store.needJamesReal.set([{ runId: 'run-1', itemId: 'item-1', documentPath: 'docs/x.md', check: 'c', reason: 'r' }]);
    store.parkedItems.set([PARKED_ITEM]); fixture.detectChanges(); await fixture.whenStable();
    const headings = () => Array.from(fixture.nativeElement.querySelectorAll('section.pq-section h2') as NodeListOf<HTMLElement>).map(h => h.textContent?.trim());
    expect(headings()).toEqual(['Needs your answer', 'Runs', 'Start a run', 'Queue health', 'Live checks that need you']);
    clickTab('Set aside'); expect(headings()).toEqual(['Set aside']);
    clickTab('Setup'); expect(headings()).toEqual(['Providers and accounts', 'Account rules', 'Checks for each project folder']);
  });

  it('shows the surfaced error from the store', async () => {
    store.lastError.set('Failed to start plan queue run');
    fixture.detectChanges();
    await fixture.whenStable();

    expect(fixture.nativeElement.textContent).toContain('Failed to start plan queue run');
  });

  it('links alerts to the existing housekeeping card and refreshes them', () => {
    store.reconcilerAlerts.set([{ kind: 'unowned-worktree', path: '/tmp/test' }]);
    clickTab('Set aside');
    const panel = fixture.nativeElement.querySelector('.pq-section-alerts') as HTMLElement;
    expect(panel.querySelector('a')?.getAttribute('href')).toBe('/settings?tab=doctor');
    panel.querySelector('button')!.click();
    expect(store.refreshAlerts).toHaveBeenCalledTimes(1);
  });

  it('shows Queue health in plain words in Now, and Refresh loads it again', () => {
    expect(fixture.nativeElement.querySelector('.pq-section-health')?.textContent).toContain('Not available yet.');
    store.queueHealth.set({
      windowDays: 14, since: 0,
      attemptsLanded: { count: 7, of: 10, share: 0.7 }, documentsLanded: { count: 5, of: 8, share: 0.625 },
      passesNotLanded: { count: 0, of: 6, share: 0 }, firstCheckPassed: { count: 3, of: 6, share: 0.5 },
      freeSlotToStart: { count: 2, medianMs: 30_000 }, checkTime: { count: 4, medianMs: 600_000 },
      landingTime: { count: 3, medianMs: 300_000, syncMs: null, mergeCheckMs: null, commitCheckMs: 240_000, publishMs: null },
      waiting: { waitingMs: 60_000, workingMs: 180_000, share: 0.25 }, setAsideRounds: { items: 1, rounds: 3 },
    });
    fixture.detectChanges();
    const section = fixture.nativeElement.querySelector('.pq-section-health') as HTMLElement;
    expect(section.querySelector('h2')?.textContent).toBe('Queue health, last 14 days');
    expect(section.textContent).toContain('Attempts that land');
    expect(section.textContent).toContain('70% (7 of 10 finished attempts)');
    expect(section.textContent).toContain('30 seconds typically (2 starts)');
    expect(section.textContent).toContain('3 rounds on 1 item');
    store.load.mockClear();
    (section.querySelector('.pq-health-refresh') as HTMLButtonElement).click();
    expect(store.load).toHaveBeenCalledTimes(1);
  });

  it('renders the empty-runs message with no runs loaded', () => {
    expect(fixture.nativeElement.textContent).toContain('No plan queue runs yet.');
  });

  it('shows the empty state when Set aside has no retained work', () => {
    clickTab('Set aside');
    expect(fixture.nativeElement.querySelector('#pq-panel-aside')?.textContent).toContain('No work set aside.');
  });

  it('renders loaded runs and forwards a pause action to the store control call', async () => {
    store.allRuns.set([makeRun({ id: 'run-x', status: 'running' })]);
    fixture.detectChanges();
    await fixture.whenStable();

    const runButtons = fixture.nativeElement.querySelectorAll('.pq-run-controls button');
    (runButtons[0] as HTMLButtonElement).click();

    expect(store.control).toHaveBeenCalledWith({ action: 'pause', runId: 'run-x' });
  });

  it('names each run’s parent session and moves the run to a session James chooses', async () => {
    instances.set([
      { id: 'inst-1', displayName: 'Owner', provider: 'codex', status: 'busy', parentId: null, workingDirectory: '/repo' },
      { id: 'inst-2', displayName: 'Taker', provider: 'codex', status: 'idle', parentId: null, workingDirectory: '/repo' },
      { id: 'inst-helper', displayName: 'Helper', provider: 'claude', status: 'idle', parentId: 'inst-1', workingDirectory: '/repo' },
      { id: 'inst-queue', displayName: 'Queue · a', provider: 'claude', status: 'idle', parentId: null, workingDirectory: '/repo', metadata: { planQueueRole: 'worker' } },
      { id: 'inst-failed', displayName: 'Broken', provider: 'claude', status: 'failed', parentId: null, workingDirectory: '/repo' },
      { id: 'inst-set-aside', displayName: 'Sort out set-aside work: repo', provider: 'claude', status: 'idle', parentId: null, workingDirectory: '/repo',
        metadata: { planQueueSetAsideFolder: '/repo' } },
    ]);
    store.allRuns.set([makeRun({ id: 'run-x', status: 'running', parentInstanceId: 'inst-1' })]);
    fixture.detectChanges();
    await fixture.whenStable();

    const owner = fixture.nativeElement.querySelector('.pq-run-owner') as HTMLElement;
    expect(owner.textContent).toContain('Parent session: Owner (codex) — /repo');
    (owner.querySelector('.pq-run-owner-change') as HTMLButtonElement).click();
    fixture.detectChanges();
    const select = owner.querySelector('select') as HTMLSelectElement;
    expect(Array.from(select.options).map(option => option.textContent?.trim())).toEqual(['Choose a session…', 'Taker (codex) — /repo']);
    select.value = 'inst-2';
    select.dispatchEvent(new Event('change'));
    fixture.detectChanges();
    (owner.querySelector('.pq-run-owner-confirm') as HTMLButtonElement).click();
    await fixture.whenStable();

    expect(ipcControl).toHaveBeenCalledWith({ action: 'handover', runId: 'run-x', targetInstanceId: 'inst-2' });
    expect(store.control).not.toHaveBeenCalled();
  });

  it('names a helper session that owns a run, and says when the owner is no longer open', async () => {
    store.allRuns.set([makeRun({ id: 'run-x', status: 'running', parentInstanceId: 'inst-helper' })]);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.pq-run-owner')?.textContent).toContain('Parent session: a session that is no longer open');

    instances.set([{ id: 'inst-helper', displayName: 'Helper', provider: 'claude', status: 'idle', parentId: 'inst-1', workingDirectory: '/repo' }]);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.pq-run-owner')?.textContent).toContain('Parent session: Helper (claude) — /repo');
  });

  it('forwards Setup controls after Choose a checker, retaining Cancel and Skip confirmations', async () => {
    const parked = { ...PARKED_ITEM, parkReason: 'no-diverse-verifier' as const };
    const working = { ...NEEDS_ANSWER_ITEM, id: 'working', state: 'working' as const, question: null, workerInstanceId: 'worker-live' };
    const queued = { ...NEEDS_ANSWER_ITEM, id: 'queued', state: 'queued' as const, question: null };
    store.allRuns.set([makeRun({ id: 'run-x', items: [parked, working, queued] })]);
    store.parkedItems.set([parked]);
    clickTab('Set aside');
    const choose = Array.from(fixture.nativeElement.querySelectorAll('button') as NodeListOf<HTMLButtonElement>)
      .find(button => button.textContent?.trim() === 'Choose a checker')!;
    choose.click(); fixture.detectChanges(); await fixture.whenStable();
    expect(fixture.nativeElement.querySelector('#pq-tab-setup').getAttribute('aria-selected')).toBe('true');
    const setup = fixture.nativeElement.querySelector('#pq-panel-setup') as HTMLElement;
    const pause = Array.from(setup.querySelectorAll('.pq-run-controls button')).find(button => button.textContent?.trim() === 'Pause') as HTMLButtonElement;
    pause.click();
    expect(store.control).toHaveBeenCalledExactlyOnceWith({ action: 'pause', runId: 'run-x' });
    store.control.mockClear();
    store.allRuns.set([makeRun({ id: 'run-x', status: 'paused', items: [parked, working, queued] })]);
    fixture.detectChanges();
    (setup.querySelector('.pq-resume') as HTMLButtonElement).click();
    expect(store.control).toHaveBeenCalledExactlyOnceWith({ action: 'resume', runId: 'run-x' });
    store.control.mockClear();
    (setup.querySelector('.pq-cancel') as HTMLButtonElement).click(); fixture.detectChanges();
    expect(store.control).not.toHaveBeenCalled();
    (setup.querySelector('.pq-confirm-yes') as HTMLButtonElement).click();
    expect(store.control).toHaveBeenCalledExactlyOnceWith({ action: 'cancel', runId: 'run-x' });
    store.control.mockClear();
    const documents = setup.querySelector('.pq-run-documents') as HTMLDetailsElement;
    documents.open = true; fixture.detectChanges();
    (setup.querySelector('.pq-item-skip') as HTMLButtonElement).click(); fixture.detectChanges();
    expect(store.control).not.toHaveBeenCalled();
    (setup.querySelector('.pq-skip-confirm-yes') as HTMLButtonElement).click();
    expect(store.control).toHaveBeenCalledExactlyOnceWith({ action: 'skip-item', itemId: 'queued' });
    store.control.mockClear();
    store.allRuns.set([makeRun({ id: 'run-x', items: [parked, working] })]);
    clickTab('Now');
    const nowPause = Array.from(fixture.nativeElement.querySelectorAll('.pq-run-controls button') as NodeListOf<HTMLButtonElement>)
      .find(button => button.textContent?.trim() === 'Pause')!;
    nowPause.click();
    expect(store.control).toHaveBeenCalledExactlyOnceWith({ action: 'pause', runId: 'run-x' });
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

    clickTab('Set aside');
    (fixture.nativeElement.querySelector('.pq-discard') as HTMLButtonElement).click();
    fixture.detectChanges();
    (fixture.nativeElement.querySelector('.pq-confirm-yes') as HTMLButtonElement).click();

    expect(store.control).toHaveBeenCalledWith({ action: 'discard-item', itemId: 'item-parked' });
  });

  it('opens the Set aside agent session once it has started, and stays put if it could not', async () => {
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    await fixture.componentInstance.onSortOut('/repo');
    expect(store.startSetAsideAgent).toHaveBeenCalledWith('/repo');
    expect(setSelectedInstance).toHaveBeenCalledWith('agent-1');
    expect(navigate).toHaveBeenCalledWith(['/']);

    setSelectedInstance.mockClear();
    navigate.mockClear();
    store.startSetAsideAgent.mockResolvedValue(null);
    await fixture.componentInstance.onSortOut('/repo');
    expect(setSelectedInstance).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('warns that Discard deletes work', async () => {
    store.parkedItems.set([PARKED_ITEM]);
    clickTab('Set aside');
    expect(fixture.nativeElement.textContent).toContain('including any work that never reached main');
    expect(fixture.nativeElement.textContent).not.toContain('safe clean-up');
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
    clickTab('Set aside');
    fixture.nativeElement.querySelector('.pq-retry-landing').click();
    expect(store.control).toHaveBeenCalledWith({ action: 'retry-landing', itemId: 'item-parked' });
  });

  it('sends Try merging all again to the store and shows its progress with a way to stop', async () => {
    store.parkedItems.set([{ ...PARKED_ITEM, parkReason: 'land-blocked',
      verdict: { verdict: 'PASS', findings: [], gatesRun: [], documentComplete: true, needJames: [] },
    }]); fixture.detectChanges(); await fixture.whenStable();
    clickTab('Set aside');
    fixture.nativeElement.querySelector('.pq-bulk-retry').click(); fixture.detectChanges();
    fixture.nativeElement.querySelector('.pq-bulk-confirm').click();
    expect(store.retryLandings).toHaveBeenCalledWith(['item-parked']);
    store.retryProgress.set({ done: 0, total: 1, stopping: false }); fixture.detectChanges();
    fixture.nativeElement.querySelector('.pq-stop-retrying').click();
    expect(store.stopRetrying).toHaveBeenCalled();
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
    expect(fixture.nativeElement.querySelectorAll('.pq-run')).toHaveLength(2);
    expect(fixture.nativeElement.querySelector('.pq-history summary').textContent).toContain('History (50)');
    pause.click(); resume.click();
    expect(store.control).toHaveBeenCalledWith({ action: 'pause-all' });
    expect(store.control).toHaveBeenCalledWith({ action: 'resume-all' });
  });

  it('folds terminal runs into history and preserves routing changes when an old run is opened', async () => {
    const history = Array.from({ length: 50 }, (_, index) => makeRun({ id: `inert-${index}`, status: 'completed', startedAt: 100 + index }));
    const completed = makeRun({ id: 'old-completed', status: 'completed', startedAt: 2,
      items: [{ ...PARKED_ITEM, runId: 'old-completed' }] });
    const cancelled = makeRun({ id: 'old-cancelled', status: 'cancelled', kind: 'livetests', startedAt: 1,
      items: [{ ...PARKED_ITEM, runId: 'old-cancelled', branchName: null, parkReason: 'triage-failed' }] });
    store.allRuns.set([...history, completed, cancelled, makeRun({ id: 'running' }), makeRun({ id: 'paused', status: 'paused' })]);
    fixture.detectChanges(); await fixture.whenStable();
    expect(fixture.nativeElement.querySelectorAll('.pq-run')).toHaveLength(2);
    expect(fixture.nativeElement.querySelector('.pq-pause-all').textContent).toContain('Pause all (1 running)');
    expect(fixture.nativeElement.querySelector('.pq-resume-all').textContent).toContain('Resume all (1 paused)');
    const rows = fixture.nativeElement.querySelectorAll('.pq-history-run') as NodeListOf<HTMLDetailsElement>;
    expect(rows).toHaveLength(52);
    for (const row of [rows[50], rows[51]]) {
      row.open = true; row.dispatchEvent(new Event('toggle')); fixture.detectChanges(); await fixture.whenStable();
      const change = row.querySelector('.pq-run-change') as HTMLButtonElement;
      expect(change.textContent?.trim()).toBe('Change');
      change.click(); fixture.detectChanges(); await fixture.whenStable();
      expect(row.querySelector('app-plan-queue-routing-panel')).not.toBeNull();
      expect(row.querySelector('.pq-routing-move-progress')).toBeNull();
      // Each old run still holds a set-aside job, which only its owner can act on, so it can be moved.
      expect(row.querySelector('.pq-run-owner-change')).not.toBeNull();
    }
    expect(fixture.nativeElement.querySelectorAll('.pq-section-runs > app-plan-queue-run-list .pq-run-owner')).toHaveLength(2);
    expect(store.control).not.toHaveBeenCalled();
  });

  it('opens Change for the selected run, saves its routing, and keeps saved defaults separate', async () => {
    store.control.mockResolvedValue({ success: true, data: null });
    store.allRuns.set([makeRun({ id: 'edit-me', status: 'paused', config: { ...makeRun().config, routing: { workers: [{ provider: 'claude', model: 'opus' }], verifiers: [] } } })]);
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
    expect(store.control).toHaveBeenCalledWith({ action: 'set-routing', runId: 'edit-me', routing: { workers: [{ provider: 'claude', model: 'sonnet' }], verifiers: [] } });
    // The saved choice's editor stays closed: only this run's editor is open.
    expect(fixture.nativeElement.querySelectorAll('app-plan-queue-routing-panel')).toHaveLength(1);
    expect(editor.querySelector('.pq-routing-move-progress')).toBeNull();
  });

  it('keeps the saved choice in Setup and opens its editor with Change', async () => {
    store.allRuns.set(Array.from({ length: 30 }, (_, index) => makeRun({ id: `run-${index}` })));
    settings.set({ planQueueRouting: { workers: [{ provider: 'codex', model: 'gpt-6.1-sol' }, { provider: 'claude' }], verifiers: [] }, providersExcludedFromAutomation: [] });
    fixture.detectChanges();
    await fixture.whenStable();

    clickTab('Setup');
    const section = fixture.nativeElement.querySelector('.pq-section-routing') as HTMLElement;
    expect(fixture.nativeElement.querySelector('.pq-section-runs')).toBeNull();
    expect(section.querySelector('.pq-defaults-summary')?.textContent?.trim())
      .toBe('Workers: codex/gpt-6.1-sol, then claude · Checkers: automatic');
    expect(section.querySelector('app-plan-queue-routing-panel')).toBeNull();

    const change = section.querySelector('.pq-defaults-change') as HTMLButtonElement;
    expect(change.getAttribute('aria-expanded')).toBe('false');
    expect(change.getAttribute('aria-label')).toBe('Change providers and accounts');
    change.click();
    fixture.detectChanges();
    await fixture.whenStable();
    expect(section.querySelector('app-plan-queue-routing-panel')).not.toBeNull();
    expect(change.textContent?.trim()).toBe('Close');
    expect(change.getAttribute('aria-expanded')).toBe('true');
    expect(change.getAttribute('aria-label')).toBe('Close providers and accounts');

    settings.set({ planQueueRouting: { workers: [], verifiers: [] }, providersExcludedFromAutomation: [] });
    fixture.detectChanges();
    expect(section.querySelector('.pq-defaults-summary')?.textContent?.trim())
      .toBe('Workers: same as the session that starts the run · Checkers: automatic');
  });

  it('names accounts in the summaries, and reads a saved value in the old shape', async () => {
    providerAccounts.mockResolvedValue({ profiles: [{ id: 'legacy', provider: 'codex', label: 'ChatGPT SUAS' }], pools: {} });
    settings.set({ planQueueRouting: { worker: { provider: 'codex', accountProfileIds: ['legacy'] }, verifiers: [] } as unknown as PlanQueueRouting, providersExcludedFromAutomation: [] });
    store.allRuns.set([makeRun({ id: 'labelled', config: { ...makeRun().config, routing: { workers: [{ provider: 'codex', accountProfileIds: ['legacy'] }], verifiers: [] } } })]);
    fixture.componentInstance.ngOnInit();
    await new Promise((resolve) => setTimeout(resolve, 0));
    fixture.detectChanges();
    await fixture.whenStable();

    clickTab('Setup');
    expect(fixture.nativeElement.querySelector('.pq-defaults-summary')?.textContent?.trim())
      .toBe('Workers: codex (accounts: ChatGPT SUAS) · Checkers: automatic');
    clickTab('Now');
    expect(fixture.nativeElement.querySelector('.pq-run-routing')?.textContent?.trim())
      .toBe('Workers: codex (accounts: ChatGPT SUAS) · Checkers: automatic');
  });

});
