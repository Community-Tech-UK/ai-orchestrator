import { ɵresolveComponentResources as resolveComponentResources } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import type { PlanQueueItemDto } from '@contracts/schemas/plan-queue';
import { PlanQueueItemListComponent, planQueueDocumentBasename, planQueueVerdictSummary } from './plan-queue-item-list.component';

const specDirectory = dirname(fileURLToPath(import.meta.url));
const template = readFileSync(resolve(specDirectory, './plan-queue-item-list.component.html'), 'utf8');
const styles = readFileSync(resolve(specDirectory, './plan-queue-item-list.component.scss'), 'utf8');

await resolveComponentResources((url) => {
  if (url.endsWith('plan-queue-item-list.component.html')) return Promise.resolve(template);
  if (url.endsWith('plan-queue-item-list.component.scss')) return Promise.resolve(styles);
  if (url.endsWith('.html') || url.endsWith('.scss')) return Promise.resolve('');
  return Promise.reject(new Error(`Unexpected resource: ${url}`));
});

function makeItem(overrides: Partial<PlanQueueItemDto> = {}): PlanQueueItemDto {
  return {
    id: 'item-1',
    runId: 'run-1',
    documentPath: 'docs/plans/2026-09-18-thing_plan.md',
    state: 'working',
    round: 1,
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

describe('planQueueDocumentBasename', () => {
  it('returns just the filename from a nested path', () => {
    expect(planQueueDocumentBasename('docs/plans/foo_plan.md')).toBe('foo_plan.md');
  });

  it('returns the path unchanged when there is no slash', () => {
    expect(planQueueDocumentBasename('foo_plan.md')).toBe('foo_plan.md');
  });
});

describe('planQueueVerdictSummary', () => {
  it('returns an empty string for no verdict', () => {
    expect(planQueueVerdictSummary(null)).toBe('');
  });

  it('reports no findings when the findings array is empty', () => {
    expect(planQueueVerdictSummary({ verdict: 'PASS', findings: [], gatesRun: [], documentComplete: true, needJames: [] }))
      .toBe('PASS — no findings');
  });

  it('summarises findings by severity', () => {
    expect(
      planQueueVerdictSummary({
        verdict: 'FAIL',
        findings: [
          { severity: 'critical', confidence: 75, summary: 'a' },
          { severity: 'critical', confidence: 75, summary: 'b' },
          { severity: 'low', confidence: 75, summary: 'c' },
        ],
        gatesRun: [],
        documentComplete: false,
        needJames: [],
      }),
    ).toBe('FAIL — 2 critical, 1 low');
  });
});

describe('PlanQueueItemListComponent', () => {
  let fixture: ComponentFixture<PlanQueueItemListComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [PlanQueueItemListComponent],
    }).compileComponents();
    fixture = TestBed.createComponent(PlanQueueItemListComponent);
    fixture.componentRef.setInput('maxRounds', 3);
  });

  it('shows an empty message when there are no items', () => {
    fixture.componentRef.setInput('items', []);
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('No documents in this run');
  });

  it('renders document basename, state, round, and errored-round count', () => {
    fixture.componentRef.setInput('items', [makeItem({ round: 2, erroredRounds: 1 })]);
    fixture.detectChanges();

    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('2026-09-18-thing_plan.md');
    expect(text).toContain('Working');
    expect(text).toContain('Round 2 of 3');
    expect(text).toContain('1 errored round(s)');
  });

  it('shows recorded cost beside the actual round cap', () => {
    fixture.componentRef.setInput('items', [makeItem({ round:2,spend:{tokens:100,costUsd:3.1,exactUsd:2} })]);
    fixture.detectChanges(); expect(fixture.nativeElement.textContent).toContain('Round 2 of 3 · $3.10');
  });

  it('shows the park reason when the item is parked', () => {
    fixture.componentRef.setInput('items', [makeItem({ state: 'parked', parkReason: 'round-limit' })]);
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Still failing after the last check');
  });

  it('shows free-text detail when present', () => {
    fixture.componentRef.setInput('items', [makeItem({ detail: 'Merge conflict in src/foo.ts' })]);
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Merge conflict in src/foo.ts');
  });

  it('points a needs-answer item to the questions section instead of repeating its card', () => {
    fixture.componentRef.setInput('items', [
      makeItem({
        id: 'item-needs',
        state: 'needs-answer',
        question: { question: 'Pick one', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] },
      }),
    ]);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelectorAll('input[type="radio"]')).toHaveLength(0);
    expect(fixture.nativeElement.querySelector('.pq-item-awaiting-answer')?.textContent).toContain('Needs your answer');
  });

  it('offers Skip only for items that have not started, as the coordinator requires', () => {
    fixture.componentRef.setInput('items', [
      makeItem({ id: 'a', state: 'queued' }),
      makeItem({ id: 'b', state: 'needs-answer' }),
      makeItem({ id: 'c', state: 'working' }),
      makeItem({ id: 'd', state: 'verifying' }),
      makeItem({ id: 'e', state: 'landed' }),
    ]);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelectorAll('.pq-item-skip')).toHaveLength(2);
  });

  it('flags a waiting worker\'s open question, but not a terminal item\'s stale one', () => {
    const question = { question: 'Continue?', options: [{ id: 'continue', label: 'Carry on' }, { id: 'park', label: 'Park' }] };
    fixture.componentRef.setInput('items', [
      makeItem({ id: 'asks', state: 'fixing', question }),
      makeItem({ id: 'done', state: 'parked', question }),
    ]);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelectorAll('.pq-item-awaiting-answer')).toHaveLength(1);
  });

  it('Skip asks first and emits only after Skip it', () => {
    fixture.componentRef.setInput('items', [makeItem({ id: 'item-skip', state: 'queued' })]);
    fixture.detectChanges();

    const emitted: string[] = [];
    fixture.componentInstance.skipItem.subscribe((id) => emitted.push(id));
    (fixture.nativeElement.querySelector('.pq-item-skip') as HTMLButtonElement).click();

    expect(emitted).toEqual([]);
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain("Skip 2026-09-18-thing_plan.md? It won't be worked in this run.");
    (fixture.nativeElement.querySelector('.pq-skip-confirm-yes') as HTMLButtonElement).click();
    expect(emitted).toEqual(['item-skip']);
  });
  it('Keep it cancels a pending Skip without emitting', () => {
    fixture.componentRef.setInput('items', [makeItem({ state: 'queued' })]); fixture.detectChanges();
    const emitted: string[] = []; fixture.componentInstance.skipItem.subscribe(id => emitted.push(id));
    fixture.nativeElement.querySelector('.pq-item-skip').click(); fixture.detectChanges();
    fixture.nativeElement.querySelector('.pq-skip-confirm-no').click(); fixture.detectChanges();
    expect(emitted).toEqual([]); expect(fixture.nativeElement.querySelector('.pq-item-skip')).not.toBeNull();
  });
  it('refuses a confirmed Skip if the item started while confirmation was open', () => {
    fixture.componentRef.setInput('items', [makeItem({ state: 'queued' })]); fixture.detectChanges();
    const emitted: string[] = []; fixture.componentInstance.skipItem.subscribe(id => emitted.push(id));
    fixture.nativeElement.querySelector('.pq-item-skip').click(); fixture.detectChanges();
    fixture.componentRef.setInput('items', [makeItem({ state: 'working' })]); fixture.detectChanges();
    fixture.componentInstance.confirmSkip('item-1'); expect(emitted).toEqual([]);
  });
  it('triage-failed has a plain label', () => {
    fixture.componentRef.setInput('items', [makeItem({ state: 'parked', parkReason: 'triage-failed' })]); fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain("Couldn't check if it's ready");
  });

  it('labels held queued and checker documents Paused', () => {
    fixture.componentRef.setInput('items', [makeItem({ id: 'a', state: 'queued', heldAt: 123 }), makeItem({ id: 'b', state: 'awaiting-slot', heldAt: 123 })]);
    fixture.detectChanges();
    expect(Array.from(fixture.nativeElement.querySelectorAll('.pq-item-state') as NodeListOf<HTMLElement>).map(el => el.textContent?.trim())).toEqual(['Paused', 'Paused']);
  });

  it('hides Skip for queued work that is held or already owns a branch or worktree', () => {
    fixture.componentRef.setInput('items', [
      makeItem({ id: 'held', state: 'queued', heldAt: 123 }),
      makeItem({ id: 'branch', state: 'queued', branchName: 'queue/saved-work' }),
      makeItem({ id: 'worktree', state: 'queued', worktreePath: '/repo/.worktrees/saved-work' }),
      makeItem({ id: 'new', state: 'queued' }),
    ]);
    fixture.detectChanges();
    const rows = Array.from(fixture.nativeElement.querySelectorAll('.pq-item') as NodeListOf<HTMLElement>);
    expect(rows.map(row => row.querySelector('.pq-item-skip') !== null)).toEqual([false, false, false, true]);
  });

  it('refuses a confirmed Skip if queued work acquired a branch before confirmation', () => {
    fixture.componentRef.setInput('items', [makeItem({ state: 'queued' })]);
    fixture.detectChanges();
    const emitted: string[] = [];
    fixture.componentInstance.skipItem.subscribe(id => emitted.push(id));
    fixture.nativeElement.querySelector('.pq-item-skip').click(); fixture.detectChanges();
    fixture.componentRef.setInput('items', [makeItem({ state: 'queued', branchName: 'queue/saved-work' })]);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.pq-item-skip-confirm')).toBeNull();
    fixture.componentInstance.confirmSkip('item-1');
    expect(emitted).toEqual([]);
  });

});
