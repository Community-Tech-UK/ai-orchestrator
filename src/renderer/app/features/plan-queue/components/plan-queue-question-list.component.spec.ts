import { ɵresolveComponentResources as resolveComponentResources } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import type { PlanQueueItemDto } from '@contracts/schemas/plan-queue';
import type { PlanQueueQuestionGroup } from '../../../core/state/plan-queue.store';
import { PLAN_QUEUE_QUESTIONS_OPEN_LIMIT, PlanQueueQuestionListComponent } from './plan-queue-question-list.component';

const specDirectory = dirname(fileURLToPath(import.meta.url));
const resources: Record<string, string> = Object.fromEntries(
  [
    'plan-queue-question-list.component.html',
    'plan-queue-question-list.component.scss',
    'plan-queue-question-card.component.html',
    'plan-queue-question-card.component.scss',
  ].map((name) => [name, readFileSync(resolve(specDirectory, name), 'utf8')]),
);

await resolveComponentResources((url) => {
  const match = Object.keys(resources).find((name) => url.endsWith(name));
  if (match) return Promise.resolve(resources[match]);
  if (url.endsWith('.html') || url.endsWith('.scss')) return Promise.resolve('');
  return Promise.reject(new Error(`Unexpected resource: ${url}`));
});

const question = { question: 'Pick one', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] };

function makeItem(overrides: Partial<PlanQueueItemDto> = {}): PlanQueueItemDto {
  return {
    id: 'item-1',
    runId: 'run-1',
    documentPath: '/repo/docs/plans/2026-09-18-thing_plan.md',
    state: 'needs-answer',
    round: 0,
    erroredRounds: 0,
    branchName: null,
    worktreePath: null,
    baseCommit: null,
    checkpointCommit: null,
    landedCommit: null,
    workerInstanceId: null,
    verifierInstanceId: null,
    question,
    answer: null,
    parkReason: null,
    detail: null,
    verdict: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function group(overrides: Partial<PlanQueueQuestionGroup> = {}): PlanQueueQuestionGroup {
  return { runId: 'run-1', kind: 'plans', workspaceCwd: '/repo', items: [makeItem()], ...overrides };
}

describe('PlanQueueQuestionListComponent', () => {
  let fixture: ComponentFixture<PlanQueueQuestionListComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [PlanQueueQuestionListComponent] }).compileComponents();
    fixture = TestBed.createComponent(PlanQueueQuestionListComponent);
  });

  it('labels each run group and each card with its document', () => {
    fixture.componentRef.setInput('groups', [
      group({ runId: 'run-a', workspaceCwd: '/repo-a', items: [makeItem({ id: 'a-1' }), makeItem({ id: 'a-2', documentPath: '/repo-a/other_plan.md' })] }),
      group({ runId: 'run-b', kind: 'livetests', workspaceCwd: '/repo-b', items: [makeItem({ id: 'b-1' })] }),
    ]);
    fixture.detectChanges();

    const heads = Array.from(fixture.nativeElement.querySelectorAll('.pq-question-group-head') as NodeListOf<HTMLElement>)
      .map((head) => Array.from(head.querySelectorAll('span')).map((span) => span.textContent?.trim()));
    expect(heads).toEqual([['plans', '/repo-a', '2 question(s)'], ['livetests', '/repo-b', '1 question(s)']]);
    const docs = Array.from(fixture.nativeElement.querySelectorAll('.pq-question-doc') as NodeListOf<HTMLElement>)
      .map((doc) => doc.textContent?.trim());
    expect(docs).toEqual(['2026-09-18-thing_plan.md', 'other_plan.md', '2026-09-18-thing_plan.md']);
    expect(fixture.nativeElement.querySelectorAll('app-plan-queue-question-card')).toHaveLength(3);
  });

  it('forwards the chosen option with the item id of the card that was answered', () => {
    fixture.componentRef.setInput('groups', [group({ items: [makeItem({ id: 'first' }), makeItem({ id: 'second' })] })]);
    fixture.detectChanges();

    const emitted: { itemId: string; optionId: string }[] = [];
    fixture.componentInstance.answer.subscribe((event) => emitted.push(event));
    const cards = fixture.nativeElement.querySelectorAll('.pq-question-card') as NodeListOf<HTMLElement>;
    const secondCardRadios = cards[1].querySelectorAll('input[type="radio"]') as NodeListOf<HTMLInputElement>;
    secondCardRadios[1].dispatchEvent(new Event('change'));
    fixture.detectChanges();
    (cards[1].querySelector('.pq-question-submit') as HTMLButtonElement).click();

    expect(emitted).toEqual([{ itemId: 'second', optionId: 'b' }]);
  });

  it('shows a handful of questions open, and folds a backlog per run so the runs stay reachable', () => {
    const items = (count: number, prefix: string) => Array.from({ length: count }, (_, i) => makeItem({ id: `${prefix}-${i}` }));
    fixture.componentRef.setInput('groups', [group({ runId: 'small', items: items(2, 's') })]);
    fixture.detectChanges();
    const openStates = () => Array.from(fixture.nativeElement.querySelectorAll('details.pq-question-group') as NodeListOf<HTMLDetailsElement>)
      .map((details) => details.open);
    expect(openStates()).toEqual([true]);

    fixture.componentRef.setInput('groups', [
      group({ runId: 'a', items: items(3, 'a') }),
      group({ runId: 'b', items: items(PLAN_QUEUE_QUESTIONS_OPEN_LIMIT, 'b') }),
    ]);
    fixture.detectChanges();
    expect(openStates()).toEqual([false, false]);
    expect(fixture.nativeElement.querySelector('details.pq-question-group summary')?.textContent).toContain('3 question(s)');
  });

  it('keeps a group open or folded as James left it when the question count crosses the limit', () => {
    const limit = PLAN_QUEUE_QUESTIONS_OPEN_LIMIT;
    const items = (count: number) => Array.from({ length: count }, (_, i) => makeItem({ id: `q-${i}` }));
    const details = () => fixture.nativeElement.querySelector('details.pq-question-group') as HTMLDetailsElement;
    const show = (count: number) => {
      fixture.componentRef.setInput('groups', [group({ runId: 'a', items: items(count) })]);
      fixture.detectChanges();
    };

    // Starts open; James folds it; a question arrives and one is answered.
    show(limit);
    expect(details().open).toBe(true);
    details().open = false;
    show(limit + 1);
    show(limit);
    expect(details().open).toBe(false);

    // Starts folded for a new run; James opens it; answering then a new arrival never folds it.
    fixture.componentRef.setInput('groups', [group({ runId: 'b', items: items(limit + 1) })]);
    fixture.detectChanges();
    expect(details().open).toBe(false);
    details().open = true;
    fixture.componentRef.setInput('groups', [group({ runId: 'b', items: items(limit) })]);
    fixture.detectChanges();
    fixture.componentRef.setInput('groups', [group({ runId: 'b', items: items(limit + 1) })]);
    fixture.detectChanges();
    expect(details().open).toBe(true);
  });
});
