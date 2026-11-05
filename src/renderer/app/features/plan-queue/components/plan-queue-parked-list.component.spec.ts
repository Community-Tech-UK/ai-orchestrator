import { ɵresolveComponentResources as resolveComponentResources } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlanQueueItemDto } from '@contracts/schemas/plan-queue';
import { PlanQueueStore } from '../../../core/state/plan-queue.store';
import { PlanQueueParkedListComponent } from './plan-queue-parked-list.component';

const specDirectory = dirname(fileURLToPath(import.meta.url));
const template = readFileSync(resolve(specDirectory, './plan-queue-parked-list.component.html'), 'utf8');
const styles = readFileSync(resolve(specDirectory, './plan-queue-parked-list.component.scss'), 'utf8');

await resolveComponentResources((url) => {
  if (url.endsWith('plan-queue-parked-list.component.html')) return Promise.resolve(template);
  if (url.endsWith('plan-queue-parked-list.component.scss')) return Promise.resolve(styles);
  if (url.endsWith('.html') || url.endsWith('.scss')) return Promise.resolve('');
  return Promise.reject(new Error(`Unexpected resource: ${url}`));
});

function makeItem(overrides: Partial<PlanQueueItemDto> = {}): PlanQueueItemDto {
  return {
    id: 'item-1',
    runId: 'run-1',
    documentPath: 'docs/plans/foo_plan.md',
    state: 'parked',
    round: 3,
    erroredRounds: 1,
    branchName: 'plan-queue/foo-plan',
    worktreePath: '/tmp/wt',
    baseCommit: 'abc',
    checkpointCommit: 'def',
    landedCommit: null,
    workerInstanceId: 'inst-worker',
    verifierInstanceId: 'inst-verifier',
    question: null,
    answer: null,
    parkReason: 'round-limit',
    detail: null,
    verdict: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe('PlanQueueParkedListComponent', () => {
  let fixture: ComponentFixture<PlanQueueParkedListComponent>;
  const store = { diffstat: vi.fn() };

  it('offers one Sort out button per folder, biggest first, and says what it does', () => {
    fixture.componentRef.setInput('runs', [
      { id: 'run-1', workspaceCwd: '/work/small', config: {} },
      { id: 'run-2', workspaceCwd: '/work/big', config: {} },
    ]);
    fixture.componentRef.setInput('items', [
      makeItem({ id: 'a', runId: 'run-1' }),
      makeItem({ id: 'b', runId: 'run-2', documentPath: 'docs/plans/b_plan.md' }),
      makeItem({ id: 'c', runId: 'run-2', documentPath: 'docs/plans/c_plan.md' }),
    ]);
    fixture.detectChanges();
    const element = fixture.nativeElement as HTMLElement;
    const buttons = [...element.querySelectorAll<HTMLButtonElement>('.pq-sort-out-start')];
    expect(buttons.map((button) => button.textContent?.trim())).toEqual(['Sort out big (2 jobs)', 'Sort out small (1 job)']);
    expect(element.querySelector('.pq-sort-out p')?.textContent).toContain("It can't delete work or merge without checks");
    expect(element.querySelector('.pq-sort-out p')?.textContent).toContain('uses provider usage');
    const started: string[] = [];
    fixture.componentInstance.sortOut.subscribe((folder) => started.push(folder));
    buttons[0].click();
    expect(started).toEqual(['/work/big']);
  });

  it('offers no Sort out button when nothing is set aside', () => {
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).querySelector('.pq-sort-out')).toBeNull();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    store.diffstat.mockResolvedValue('1 file changed, 4 insertions(+)');
    await TestBed.configureTestingModule({
      imports: [PlanQueueParkedListComponent],
      providers: [{ provide: PlanQueueStore, useValue: store }],
    }).compileComponents();
    fixture = TestBed.createComponent(PlanQueueParkedListComponent);
  });

  it('shows an empty message with no parked items', () => {
    fixture.componentRef.setInput('items', []);
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('No work set aside');
  });

  it('heads multiple ready documents once and keeps them before other set-aside work', () => {
    const verdict = { verdict: 'PASS' as const, findings: [], gatesRun: [], documentComplete: true, needJames: [] };
    fixture.componentRef.setInput('items', [makeItem({ id: 'other', documentPath: 'other.md', updatedAt: 4 }),
      makeItem({ id: 'first', documentPath: 'first.md', parkReason: 'land-blocked', verdict }),
      makeItem({ id: 'second', documentPath: 'second.md', parkReason: 'land-blocked', verdict })]);
    fixture.detectChanges();
    expect(Array.from(fixture.nativeElement.querySelectorAll('h3'), (node: Element) => node.textContent)
      .filter(text => text === 'Ready to review and merge')).toHaveLength(1);
    expect(Array.from(fixture.nativeElement.querySelectorAll('.pq-parked-doc'), (node: Element) => node.textContent).at(-1)).toBe('other.md');
  });

  it('renders the document name, branch name and park reason', () => {
    fixture.componentRef.setInput('items', [makeItem()]);
    fixture.detectChanges();

    const text = fixture.nativeElement.textContent as string;
    expect(fixture.nativeElement.querySelector('.pq-parked-doc')?.textContent).toBe('foo_plan.md');
    expect(text).toContain('plan-queue/foo-plan');
    expect(text).toContain('Ran out of rounds');
  });

  it('fetches and renders the diffstat for each item', async () => {
    fixture.componentRef.setInput('items', [makeItem({ id: 'item-a' })]);
    fixture.detectChanges();
    await Promise.resolve();
    await Promise.resolve();
    fixture.detectChanges();

    expect(store.diffstat).toHaveBeenCalledWith('item-a');
    expect(fixture.nativeElement.textContent).toContain('1 file changed, 4 insertions(+)');
  });

  it('resumes immediately without a confirmation step', () => {
    fixture.componentRef.setInput('items', [makeItem({ id: 'item-a', parkReason: 'worker-error' })]);
    fixture.detectChanges();
    const emitted: string[] = [];
    fixture.componentInstance.resumeItem.subscribe((id) => emitted.push(id));

    (fixture.nativeElement.querySelector('.pq-resume-item') as HTMLButtonElement).click();

    expect(emitted).toEqual(['item-a']);
  });

  it('requires a confirm click before emitting discardItem', () => {
    fixture.componentRef.setInput('items', [makeItem({ id: 'item-a' })]);
    fixture.detectChanges();
    const emitted: string[] = [];
    fixture.componentInstance.discardItem.subscribe((id) => emitted.push(id));

    (fixture.nativeElement.querySelector('.pq-discard') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(emitted).toHaveLength(0);
    expect(fixture.nativeElement.textContent).toContain('cannot be undone');

    (fixture.nativeElement.querySelector('.pq-confirm-yes') as HTMLButtonElement).click();
    expect(emitted).toEqual(['item-a']);
  });

  it('requires a confirm click before emitting landAnyway', () => {
    fixture.componentRef.setInput('items', [makeItem({ id: 'item-a' })]);
    fixture.detectChanges();
    const emitted: string[] = [];
    fixture.componentInstance.landAnyway.subscribe((id) => emitted.push(id));

    (fixture.nativeElement.querySelector('.pq-merge-without-checks') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(emitted).toHaveLength(0);
    expect(fixture.nativeElement.textContent).toContain('never passed verification');

    (fixture.nativeElement.querySelector('.pq-confirm-yes') as HTMLButtonElement).click();
    expect(emitted).toEqual(['item-a']);
  });

  it('lets James back out of a discard confirmation', () => {
    fixture.componentRef.setInput('items', [makeItem({ id: 'item-a' })]);
    fixture.detectChanges();
    const emitted: string[] = [];
    fixture.componentInstance.discardItem.subscribe((id) => emitted.push(id));

    (fixture.nativeElement.querySelector('.pq-discard') as HTMLButtonElement).click();
    fixture.detectChanges();
    const buttons = fixture.nativeElement.querySelectorAll('.pq-parked-confirm button');
    (buttons[1] as HTMLButtonElement).click();
    fixture.detectChanges();

    expect(emitted).toHaveLength(0);
    expect(fixture.nativeElement.querySelector('.pq-parked-actions')).toBeTruthy();
  });
  it('shows a land-blocked PASS detail sentence and Try merging again without new worker rounds', () => {
    fixture.componentRef.setInput('items', [makeItem({
      parkReason: 'land-blocked',
      detail: "Couldn't merge: you have uncommitted changes to docs/shared.md in your main checkout. Commit or set them aside, then Try merging again.",
      verdict: { verdict: 'PASS', findings: [], gatesRun: [], documentComplete: true, needJames: [] },
    })]); fixture.detectChanges();
    const emitted: string[] = []; fixture.componentInstance.retryLanding.subscribe(id => emitted.push(id));
    expect(fixture.nativeElement.textContent).toContain('uncommitted changes to docs/shared.md');
    fixture.nativeElement.querySelector('.pq-retry-landing').click(); expect(emitted).toEqual(['item-1']);
  });
  it('Land anyway on a PASSed item says it passed verification', () => {
    fixture.componentRef.setInput('items', [makeItem({ parkReason: 'land-blocked',
      verdict: { verdict: 'PASS', findings: [], gatesRun: [], documentComplete: true, needJames: [] },
    })]); fixture.detectChanges();
    fixture.componentInstance.requestConfirm('item-1', 'land-anyway'); fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('It passed verification, but its last merge was blocked.');
    expect(fixture.nativeElement.textContent).not.toContain('never passed verification');
  });
  it.each([['land-blocked', 'FAIL'], ['round-limit', 'PASS'], ['merge-conflict', 'PASS']] as const)(
    'offers no merge retry for %s with %s', (parkReason, verdict) => {
      fixture.componentRef.setInput('items', [makeItem({ parkReason,
        verdict: { verdict, findings: [], gatesRun: [], documentComplete: true, needJames: [] },
      })]); fixture.detectChanges(); expect(fixture.nativeElement.querySelector('.pq-retry-landing')).toBeNull();
    },
  );

  it('groups older attempts and folds long details with absolute paths removed', () => {
    fixture.componentRef.setInput('items', [makeItem({ id: 'old' }), makeItem({ id: 'new', updatedAt: 2,
      detail: '/Users/example/private/report.txt ' + 'saved evidence '.repeat(250) })]);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.pq-parked-item .pq-parked-detail').textContent).not.toContain('/Users/');
    expect(fixture.nativeElement.querySelector('.pq-parked-detail').open).toBe(false);
    expect(fixture.nativeElement.querySelector('.pq-earlier-tries summary').textContent).toContain('1 earlier try');
    expect(fixture.nativeElement.querySelector('.pq-earlier-tries').open).toBe(false);
  });

  it('requires the bulk preview before resuming and exposes no bulk merge or discard', () => {
    fixture.componentRef.setInput('items', [makeItem({ id: 'first', documentPath: 'a.md' }), makeItem({ id: 'second', documentPath: 'b.md' })]);
    fixture.detectChanges();
    const emitted: string[] = [];
    fixture.componentInstance.resumeItem.subscribe(id => emitted.push(id));
    fixture.nativeElement.querySelector('.pq-bulk-resume').click(); fixture.detectChanges();
    expect(emitted).toEqual([]);
    expect(fixture.nativeElement.querySelector('.pq-bulk-preview').textContent).toContain('Will change (2)');
    expect(fixture.nativeElement.querySelector('.pq-bulk-preview').textContent).toContain('Left alone (0)');
    expect(fixture.nativeElement.querySelector('.pq-bulk-preview').textContent).not.toContain('Discard');
    fixture.nativeElement.querySelector('.pq-bulk-confirm').click();
    expect(emitted).toEqual(['first', 'second']);
  });

  it('keeps Resume and Discard available for older work with no recorded reason', () => {
    fixture.componentRef.setInput('items', [makeItem({ parkReason: null })]); fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.pq-resume-item')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('.pq-discard')).not.toBeNull();
  });

  it('shows the checker findings in a bulk-resume preview before confirmation', () => {
    fixture.componentRef.setInput('items', [makeItem({ verdict: { verdict: 'FAIL', documentComplete: false,
      findings: [{ severity: 'high', confidence: 95, summary: 'The saved retry is never resumed.' }], gatesRun: [], needJames: [] } })]);
    fixture.detectChanges(); fixture.nativeElement.querySelector('.pq-bulk-resume').click(); fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.pq-bulk-preview').textContent).toContain('The saved retry is never resumed.');
  });

});
