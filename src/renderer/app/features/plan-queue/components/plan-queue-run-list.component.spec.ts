import { ɵresolveComponentResources as resolveComponentResources } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import type { PlanQueueItemDto, PlanQueueRunDto } from '@contracts/schemas/plan-queue';
import { PlanQueueRunListComponent, planQueueRoutingSummary, planQueueStateCounts } from './plan-queue-run-list.component';

const specDirectory = dirname(fileURLToPath(import.meta.url));
const resources: Record<string, string> = {
  'plan-queue-run-list.component.html': readFileSync(resolve(specDirectory, './plan-queue-run-list.component.html'), 'utf8'),
  'plan-queue-run-list.component.scss': readFileSync(resolve(specDirectory, './plan-queue-run-list.component.scss'), 'utf8'),
  'plan-queue-item-list.component.html': readFileSync(resolve(specDirectory, './plan-queue-item-list.component.html'), 'utf8'),
  'plan-queue-item-list.component.scss': readFileSync(resolve(specDirectory, './plan-queue-item-list.component.scss'), 'utf8'),
  'plan-queue-run-controls.component.html': readFileSync(resolve(specDirectory, './plan-queue-run-controls.component.html'), 'utf8'),
  'plan-queue-run-controls.component.scss': readFileSync(resolve(specDirectory, './plan-queue-run-controls.component.scss'), 'utf8'),
};

await resolveComponentResources((url) => {
  const match = Object.keys(resources).find((name) => url.endsWith(name));
  if (match) return Promise.resolve(resources[match]);
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
    startedAt: 1_700_000_000_000,
    endedAt: null,
    items: [],
    ...overrides,
  };
}

function makeItem(overrides: Partial<PlanQueueItemDto> = {}): PlanQueueItemDto {
  return {
    id: 'item-1',
    runId: 'run-1',
    documentPath: 'docs/plans/a_plan.md',
    state: 'queued',
    round: 0,
    erroredRounds: 0,
    branchName: null,
    worktreePath: null,
    baseCommit: null,
    checkpointCommit: null,
    landedCommit: null,
    workerInstanceId: null,
    verifierInstanceId: null,
    question: null,
    answer: null,
    parkReason: null,
    detail: null,
    verdict: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe('PlanQueueRunListComponent', () => {
  let fixture: ComponentFixture<PlanQueueRunListComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [PlanQueueRunListComponent] }).compileComponents();
    fixture = TestBed.createComponent(PlanQueueRunListComponent);
  });

  it('renders one card per run with its workspace and document count', () => {
    fixture.componentRef.setInput('runs', [
      makeRun({ id: 'run-a', workspaceCwd: '/repo-a' }),
      makeRun({ id: 'run-b', workspaceCwd: '/repo-b' }),
    ]);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelectorAll('.pq-run')).toHaveLength(2);
    expect(fixture.nativeElement.textContent).toContain('/repo-a');
    expect(fixture.nativeElement.textContent).toContain('/repo-b');
  });

  it('keeps unpriced usage visible and averages only fully priced merges', () => {
    fixture.componentRef.setInput('runs', [makeRun({
      spend: { tokens: 17_200_400, costUsd: 109, exactUsd: 8, unpricedTokens: 17_200_000 },
      items: [
        makeItem({ id: 'first', state: 'landed', spend: { tokens: 100, costUsd: 3, exactUsd: 3 } }),
        makeItem({ id: 'second', state: 'landed', spend: { tokens: 100, costUsd: 5, exactUsd: 5 } }),
        makeItem({ id: 'partial', state: 'landed', spend: { tokens: 17_200_100, costUsd: 2, exactUsd: 0, unpricedTokens: 17_200_000 } }),
        makeItem({ id: 'unfinished', state: 'working', spend: { tokens: 100, costUsd: 99, exactUsd: 0 } }),
      ],
    })]);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.pq-run-spend')?.textContent)
      .toBe('$109.00 known (estimated) · 17.2M tokens not priced across 4 documents · 3 merged ($4.00 each among fully priced merges)');
    expect(fixture.nativeElement.textContent).toContain('$2.00 known (estimated) · 17.2M tokens not priced');
  });

  it('does not present an entirely unpriced merge as a free one', () => {
    const spend = { tokens: 10, costUsd: 0, exactUsd: 0, unpricedTokens: 10 };
    fixture.componentRef.setInput('runs', [makeRun({ spend, items: [makeItem({ state: 'landed', spend })] })]);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.pq-run-spend')?.textContent)
      .toBe('10 tokens not priced across 1 document · 1 merged (cost per merge not known)');
    expect(fixture.nativeElement.textContent).not.toContain('$0.00');
  });

  it('labels the average estimated when a fully priced merge includes an estimate', () => {
    fixture.componentRef.setInput('runs', [makeRun({ spend: { tokens: 20, costUsd: 6, exactUsd: 4 }, items: [
      makeItem({ id: 'exact', state: 'landed', spend: { tokens: 10, costUsd: 3, exactUsd: 3 } }),
      makeItem({ id: 'estimate', state: 'landed', spend: { tokens: 10, costUsd: 3, exactUsd: 1 } }),
    ] })]);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.pq-run-spend')?.textContent)
      .toBe('$6.00 (estimated) across 2 documents · 2 merged ($3.00 (estimated) each among fully priced merges)');
  });

  it('forwards a run control action with the correct run id', () => {
    fixture.componentRef.setInput('runs', [makeRun({ id: 'run-x', status: 'running' })]);
    fixture.detectChanges();

    const emitted: string[] = [];
    fixture.componentInstance.pauseRun.subscribe((id) => emitted.push(id));
    (fixture.nativeElement.querySelector('button') as HTMLButtonElement).click();

    expect(emitted).toEqual(['run-x']);
  });

  it('keeps each run\'s documents collapsed behind a state-count summary, with no answer controls', () => {
    const question = { question: 'Pick one', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] };
    fixture.componentRef.setInput('runs', [
      makeRun({
        id: 'run-x',
        items: [
          makeItem({ id: 'i-1', state: 'landed' }),
          makeItem({ id: 'i-2', state: 'needs-answer', question }),
          makeItem({ id: 'i-3', state: 'needs-answer', question }),
          makeItem({ id: 'i-4', state: 'parked' }),
        ],
      }),
    ]);
    fixture.detectChanges();

    const details = fixture.nativeElement.querySelector('details.pq-run-documents') as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(details.querySelector('summary')?.textContent).toContain('4 documents');
    expect(details.querySelector('summary')?.textContent).toContain('2 Needs your answer, 1 Merged, 1 Set aside');
    expect(fixture.nativeElement.querySelectorAll('input[type="radio"]')).toHaveLength(0);
    // The run controls stay outside the collapsed list.
    expect(details.querySelector('.pq-run-controls')).toBeNull();
    expect(fixture.nativeElement.querySelector('.pq-run-head .pq-run-controls')).not.toBeNull();
  });

  it('distinguishes cancellation leftovers from deliberate skips in the summary and document cards', () => {
    fixture.componentRef.setInput('runs', [makeRun({ status: 'cancelled', items: [
      makeItem({ id: 'unreached', state: 'skipped', detail: 'Run cancelled by James.' }),
      makeItem({ id: 'skipped', state: 'skipped', detail: 'Skipped by James.' }),
    ] })]);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.pq-run-documents summary')?.textContent).toContain('1 Skipped, 1 Not reached');
    expect(Array.from(fixture.nativeElement.querySelectorAll('.pq-item-state'), (node: Element) => node.textContent?.trim()))
      .toEqual(['Not reached', 'Skipped']);
  });

  it('shows current providers and accounts, falling back to the stored worker for older runs', () => {
    const base = makeRun().config;
    fixture.componentRef.setInput('runs', [
      makeRun({ id: 'run-default', config: { ...base, routing: { workers: [], verifiers: [] } } }),
      makeRun({
        id: 'run-fixed',
        config: {
          ...base,
          routing: {
            workers: [{ provider: 'claude', model: 'opus', accountProfileIds: ['acc-a', 'acc-b'] }],
            verifiers: [{ provider: 'codex' }, { provider: 'copilot', model: 'gpt', copilotProfileId: 'cp-1' }],
          },
        },
      }),
      makeRun({ id: 'run-old' }),
    ]);
    fixture.detectChanges();

    const lines = Array.from(fixture.nativeElement.querySelectorAll('.pq-run-routing') as NodeListOf<HTMLElement>)
      .map((line) => line.textContent?.trim());
    expect(lines).toEqual([
      'Workers: default provider · Checkers: automatic',
      'Workers: claude/opus (accounts: acc-a, acc-b) · Checkers: codex, copilot/gpt (account: cp-1)',
      'Workers: claude · Checkers: automatic',
    ]);
  });

  it('offers Change for active runs and terminal runs with resumable parked work', () => {
    const parked = makeItem({ state: 'parked', branchName: 'queue/kept' });
    fixture.componentRef.setInput('runs', [
      makeRun({ id: 'running' }),
      makeRun({ id: 'paused', status: 'paused' }),
      makeRun({ id: 'completed-resumable', status: 'completed', items: [parked] }),
      makeRun({ id: 'cancelled-resumable', status: 'cancelled', items: [parked] }),
      makeRun({ id: 'completed-empty', status: 'completed' }),
      makeRun({ id: 'cancelled-triage-failed', status: 'cancelled', items: [{ ...parked, branchName: null, parkReason: 'triage-failed' }] }),
    ]);
    fixture.detectChanges();
    const cards = Array.from(fixture.nativeElement.querySelectorAll('.pq-run') as NodeListOf<HTMLElement>);
    expect(cards.map(card => card.querySelector('.pq-run-change') !== null)).toEqual([true, true, true, true, false, true]);
  });

  it('forwards a skip from the document list with the item id', () => {
    fixture.componentRef.setInput('runs', [makeRun({ config: { ...makeRun().config, maxRounds: 7 }, items: [makeItem({ id: 'item-q', state: 'queued', round: 2 })] })]);
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('Round 2 of 7');
    const emitted: string[] = [];
    fixture.componentInstance.skipItem.subscribe((id) => emitted.push(id));
    (fixture.nativeElement.querySelector('.pq-item-skip') as HTMLButtonElement).click();

    expect(emitted).toEqual([]);
    fixture.detectChanges();
    (fixture.nativeElement.querySelector('.pq-skip-confirm-yes') as HTMLButtonElement).click();
    expect(emitted).toEqual(['item-q']);
  });
});

describe('planQueueStateCounts', () => {
  it('counts documents by state, what needs James first', () => {
    expect(planQueueStateCounts([
      makeItem({ state: 'skipped' }),
      makeItem({ state: 'working' }),
      makeItem({ state: 'needs-answer' }),
      makeItem({ state: 'working' }),
    ])).toBe('1 Needs your answer, 2 Working, 1 Skipped');
  });

  it('counts held documents separately from queued and awaiting a slot', () => {
    expect(planQueueStateCounts([
      makeItem({ state: 'queued', heldAt: 123 }),
      makeItem({ state: 'awaiting-slot', heldAt: 123 }),
      makeItem({ state: 'queued' }),
    ])).toBe('2 Paused, 1 Queued');
  });

  it('is empty for a run with no documents', () => {
    expect(planQueueStateCounts([])).toBe('');
  });
});

describe('planQueueRoutingSummary', () => {
  it('names accounts by their labels when it knows them', () => {
    const labels = new Map([['codex:legacy', 'ChatGPT SUAS'], ['copilot:cp-1', 'Personal Copilot']]);
    const accountLabel = (provider: string, id: string) => labels.get(`${provider}:${id}`) ?? id;
    expect(planQueueRoutingSummary({
      workers: [{ provider: 'codex', accountProfileIds: ['legacy', 'unknown-id'] }],
      verifiers: [{ provider: 'copilot', copilotProfileId: 'cp-1' }],
    }, { accountLabel })).toBe('Workers: codex (accounts: ChatGPT SUAS, unknown-id) · Checkers: copilot (account: Personal Copilot)');
  });

  it('lists ranked worker choices in order', () => {
    expect(planQueueRoutingSummary({ workers: [{ provider: 'codex', model: 'gpt-6.1-sol' }, { provider: 'claude' }], verifiers: [] }))
      .toBe('Workers: codex/gpt-6.1-sol, then claude · Checkers: automatic');
  });

  it('names the step-up choice only when one is set', () => {
    expect(planQueueRoutingSummary({ workers: [{ provider: 'claude', model: 'haiku' }], verifiers: [], stepUp: { provider: 'claude', model: 'opus' } }))
      .toBe('Workers: claude/haiku · Checkers: automatic · If stuck: claude/opus');
  });

  it('reads an empty worker list as the default provider and no checkers as automatic', () => {
    expect(planQueueRoutingSummary({ workers: [], verifiers: [] })).toBe('Workers: default provider · Checkers: automatic');
  });

  it('lists provider, model and accounts without empty brackets', () => {
    expect(planQueueRoutingSummary({ workers: [{ provider: 'codex', accountProfileIds: [] }], verifiers: [] }))
      .toBe('Workers: codex · Checkers: automatic');
  });
});
