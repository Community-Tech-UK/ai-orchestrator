import { ɵresolveComponentResources as resolveComponentResources } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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
    sourceRef: 'docs/plans/2026-09-18-thing_plan.md',
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
      .toBe('Passed — no findings');
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
    ).toBe('Changes needed — 2 critical, 1 low');
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

  it.each([
    [['item-1', 'other'], 'Checked together with 1 other job'],
    [['item-1', 'second', 'third'], 'Checked together with 2 other jobs'],
  ])('renders group coverage without exposing its internal identifiers: %s', (memberItemIds, label) => {
    fixture.componentRef.setInput('items', [makeItem({ verdict: {
      verdict: 'PASS', findings: [], documentComplete: true, needJames: [],
      gatesRun: [{ command: 'check', exitCode: 0, checkGroup: { id: 'internal-group', baseTip: 'base-tip', memberItemIds } }],
    } })]);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.pq-item-check-group')?.textContent?.trim()).toBe(label);
    expect(fixture.nativeElement.textContent).not.toContain('internal-group');
    expect(fixture.nativeElement.textContent).not.toContain('base-tip');
  });

  it('shows the worker\'s report on the row, with its deferred checks and follow-ups behind the full report', () => {
    fixture.componentRef.setInput('items', [makeItem({ workerReport: {
      summary: 'Added the report tool.', asBuilt: 'Edited /Users/example/work/repo/src/tool.ts and its tests.',
      checksRun: [{ command: 'npm run lint', exitCode: 0 }, { command: 'npm run build:main', exitCode: 1 }],
      deferredChecks: [{ title: 'Claude calls the tool', steps: 'Start a queue run on Claude.', expectedResult: 'A report appears on the row.', whyDeferred: 'It needs a rebuilt app.' }],
      followUps: ['The old signal is still used by other providers.'],
    } })]);
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelector('.pq-item-report-summary')?.textContent).toContain('Added the report tool.');
    const details = root.querySelector('.pq-item-report details') as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(details.textContent).toContain('npm run lint: Passed');
    expect(details.textContent).toContain('npm run build:main: Failed');
    expect(details.textContent).toContain('Claude calls the tool: It needs a rebuilt app.');
    expect(details.textContent).toContain('The old signal is still used by other providers.');
    expect(details.textContent).not.toContain('/Users/');
  });

  it('shows no report block until the worker has reported', () => {
    fixture.componentRef.setInput('items', [makeItem({ workerReport: null }), makeItem({ id: 'item-2' })]);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.pq-item-report')).toBeNull();
  });

  it('shows the same live step line as the session list while Harness checks the job', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    try {
      vi.setSystemTime(100 * 60_000);
      const local = TestBed.createComponent(PlanQueueItemListComponent);
      local.componentRef.setInput('maxRounds', 3);
      local.componentRef.setInput('items', [
        makeItem({ state: 'verifying', detail: 'Running checks', stage: { name: 'checks', startedAt: 88 * 60_000 } }),
        makeItem({ id: 'item-2' }),
      ]);
      local.detectChanges();
      const lines = () => Array.from(local.nativeElement.querySelectorAll('.pq-item-stage') as NodeListOf<HTMLElement>).map(line => line.textContent?.trim());
      expect(lines()).toEqual(['Checking 2026-09-18-thing: tests running, 12 min']);
      await vi.advanceTimersByTimeAsync(60_000);
      local.detectChanges();
      expect(lines()).toEqual(['Checking 2026-09-18-thing: tests running, 13 min']);
      local.destroy();
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it('names a step job by its place in the plan and says which step it waits for', () => {
    fixture.componentRef.setInput('items', [
      makeItem({ id: 'one', state: 'working', step: { number: 1, position: 1, of: 5, waitingFor: null } }),
      makeItem({ id: 'two', state: 'queued', step: { number: 2, position: 2, of: 5, waitingFor: 1 } }),
      makeItem({ id: 'whole', state: 'queued' }),
    ]);
    fixture.detectChanges();
    const text = (selector: string) => Array.from(fixture.nativeElement.querySelectorAll(selector) as NodeListOf<HTMLElement>).map(node => node.textContent?.trim());
    expect(text('.pq-item-step')).toEqual(['Step 1 of 5', 'Step 2 of 5']);
    expect(text('.pq-item-step-wait')).toEqual(['Waiting for Step 1']);
  });

  it('does not say "Step 8 of 5" when the steps before it are already ticked off', () => {
    fixture.componentRef.setInput('items', [makeItem({ step: { number: 8, position: 5, of: 5, waitingFor: null } })]);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.pq-item-step')?.textContent?.trim()).toBe('Step 8 (job 5 of 5)');
  });

  it('omits group coverage for receipts from a solo or legacy check', () => {
    fixture.componentRef.setInput('items', [makeItem({ verdict: {
      verdict: 'PASS', findings: [], documentComplete: true, needJames: [], gatesRun: [{ command: 'check', exitCode: 0 }],
    } })]);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.pq-item-check-group')).toBeNull();
  });

  it('reveals the whole document path on keyboard focus even when the basename fits', () => {
    const item = makeItem(); fixture.componentRef.setInput('items', [item]); fixture.detectChanges();
    const documentName = fixture.nativeElement.querySelector('.pq-item-doc') as HTMLElement;
    const matches = documentName.matches.bind(documentName);
    vi.spyOn(documentName, 'matches').mockImplementation(selector => selector === ':focus-visible' || matches(selector));
    documentName.focus(); fixture.detectChanges();
    expect(document.querySelector('[role="tooltip"]')?.textContent).toContain(item.sourceRef);
    expect(documentName.hasAttribute('title')).toBe(false);
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
    expect(text).toContain('1 round ended with an error');
  });

  it('shows the total across attempts only when there is one to show', () => {
    fixture.componentRef.setInput('items', [makeItem({ round: 2, totalRounds: 11 })]);
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Round 2 of 3 · 11 in total');
    fixture.componentRef.setInput('items', [makeItem({ round: 2 })]);
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).not.toContain('in total');
  });

  it('shows recorded cost beside the actual round cap', () => {
    fixture.componentRef.setInput('items', [makeItem({ round:2,spend:{tokens:100,costUsd:3.1,exactUsd:2} })]);
    fixture.detectChanges(); expect(fixture.nativeElement.textContent).toContain('Round 2 of 3 · $3.10');
  });

  it('says when a document was handed to the stronger worker, naming it and the failed checks', () => {
    fixture.componentRef.setInput('items', [makeItem({ id: 'plain' }), makeItem({ id: 'handed', steppedUpAt: 5 })]);
    fixture.componentRef.setInput('stepUp', { provider: 'claude', model: 'opus' });
    fixture.detectChanges();
    const lines = Array.from(fixture.nativeElement.querySelectorAll('.pq-item-stepped-up') as NodeListOf<HTMLElement>)
      .map((line) => line.textContent!.replace(/\s+/g, ' ').trim());
    expect(lines).toEqual(['Handed to a stronger worker (claude / opus) after 3 failed checks']);
    // The run's step-up choice was removed since: the record of the handover stays.
    fixture.componentRef.setInput('stepUp', null);
    fixture.detectChanges();
    expect((fixture.nativeElement.querySelector('.pq-item-stepped-up') as HTMLElement).textContent!.replace(/\s+/g, ' ').trim())
      .toBe('Handed to a stronger worker after 3 failed checks');
  });

  it('shows the park reason when the item is parked', () => {
    fixture.componentRef.setInput('items', [makeItem({ state: 'parked', parkReason: 'round-limit' })]);
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Ran out of rounds (1 of 3)');
  });

  it('uses the historical readiness headline consistently with the set-aside card', () => {
    fixture.componentRef.setInput('items', [makeItem({ state: 'parked', parkReason: 'worker-error',
      detail: 'Triage could not classify this document after two attempts' })]);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.pq-item-park-reason')?.textContent).toContain("Couldn't check readiness (old classification step)");
  });

  it('shows free-text detail when present', () => {
    fixture.componentRef.setInput('items', [makeItem({ detail: 'Merge conflict in src/foo.ts' })]);
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Merge conflict in src/foo.ts');
  });

  it('folds long details, removes absolute paths, and reports what was not checked', () => {
    fixture.componentRef.setInput('items', [makeItem({ detail: '/Users/example/private/project/file.ts ' + 'x'.repeat(3000),
      verdict: { verdict: 'PASS', findings: [], gatesRun: [], needJames: [], documentComplete: true, notChecked: ['Windows sign-in needs an authenticated worker.'] } })]);
    fixture.detectChanges();
    const detail = fixture.nativeElement.querySelector('details') as HTMLDetailsElement;
    expect(detail.open).toBe(false);
    expect(detail.textContent).not.toContain('/Users/');
    expect(fixture.nativeElement.textContent).toContain('Not checked: Windows sign-in needs an authenticated worker.');
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
