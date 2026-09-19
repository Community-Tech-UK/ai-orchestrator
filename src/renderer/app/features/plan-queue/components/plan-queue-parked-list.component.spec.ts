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
    expect(fixture.nativeElement.textContent).toContain('No parked work');
  });

  it('renders the branch name and park reason', () => {
    fixture.componentRef.setInput('items', [makeItem()]);
    fixture.detectChanges();

    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('plan-queue/foo-plan');
    expect(text).toContain('Hit the round limit');
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
    fixture.componentRef.setInput('items', [makeItem({ id: 'item-a' })]);
    fixture.detectChanges();
    const emitted: string[] = [];
    fixture.componentInstance.resumeItem.subscribe((id) => emitted.push(id));

    (fixture.nativeElement.querySelector('button') as HTMLButtonElement).click();

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

    const buttons = fixture.nativeElement.querySelectorAll('.pq-parked-actions button');
    (buttons[1] as HTMLButtonElement).click();
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
});
