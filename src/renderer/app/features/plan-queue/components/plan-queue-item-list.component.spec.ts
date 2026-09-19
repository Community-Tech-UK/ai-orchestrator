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
const questionCardTemplate = readFileSync(
  resolve(specDirectory, './plan-queue-question-card.component.html'),
  'utf8',
);

await resolveComponentResources((url) => {
  if (url.endsWith('plan-queue-item-list.component.html')) return Promise.resolve(template);
  if (url.endsWith('plan-queue-item-list.component.scss')) return Promise.resolve(styles);
  if (url.endsWith('plan-queue-question-card.component.html')) return Promise.resolve(questionCardTemplate);
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
    expect(text).toContain('Round 2');
    expect(text).toContain('1 errored round(s)');
  });

  it('shows the park reason when the item is parked', () => {
    fixture.componentRef.setInput('items', [makeItem({ state: 'parked', parkReason: 'round-limit' })]);
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Hit the round limit');
  });

  it('shows free-text detail when present', () => {
    fixture.componentRef.setInput('items', [makeItem({ detail: 'Merge conflict in src/foo.ts' })]);
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Merge conflict in src/foo.ts');
  });

  it('renders a question card inline for a needs-answer item and forwards the answer with its item id', () => {
    fixture.componentRef.setInput('items', [
      makeItem({
        id: 'item-needs',
        state: 'needs-answer',
        question: { question: 'Pick one', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] },
      }),
    ]);
    fixture.detectChanges();

    const emitted: { itemId: string; optionId: string }[] = [];
    fixture.componentInstance.answer.subscribe((e) => emitted.push(e));

    const radios = fixture.nativeElement.querySelectorAll('input[type="radio"]') as NodeListOf<HTMLInputElement>;
    expect(radios).toHaveLength(2);
    radios[0].dispatchEvent(new Event('change'));
    fixture.detectChanges();
    (fixture.nativeElement.querySelector('.pq-question-submit') as HTMLButtonElement).click();

    expect(emitted).toEqual([{ itemId: 'item-needs', optionId: 'a' }]);
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

  it('renders a waiting worker\'s question card, but none for a terminal item', () => {
    const question = { question: 'Continue?', options: [{ id: 'continue', label: 'Carry on' }, { id: 'park', label: 'Park' }] };
    fixture.componentRef.setInput('items', [
      makeItem({ id: 'asks', state: 'fixing', question }),
      makeItem({ id: 'done', state: 'parked', question }),
    ]);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelectorAll('app-plan-queue-question-card')).toHaveLength(1);
  });

  it('emits skipItem with the item id', () => {
    fixture.componentRef.setInput('items', [makeItem({ id: 'item-skip', state: 'queued' })]);
    fixture.detectChanges();

    const emitted: string[] = [];
    fixture.componentInstance.skipItem.subscribe((id) => emitted.push(id));
    (fixture.nativeElement.querySelector('.pq-item-skip') as HTMLButtonElement).click();

    expect(emitted).toEqual(['item-skip']);
  });
});
