import { signal, ɵresolveComponentResources as resolveComponentResources } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlanQueueItemDto } from '@contracts/schemas/plan-queue';
import { PlanQueueStore } from '../../../core/state/plan-queue.store';
import { PlanQueueQuestionsBannerComponent, planQueueDocumentLabel } from './plan-queue-questions-banner.component';

const specDirectory = dirname(fileURLToPath(import.meta.url));

await resolveComponentResources((url) => {
  for (const name of ['plan-queue-questions-banner.component.html', 'plan-queue-questions-banner.component.scss']) {
    if (url.endsWith(name)) return Promise.resolve(readFileSync(resolve(specDirectory, name), 'utf8'));
  }
  return Promise.reject(new Error(`Unexpected resource: ${url}`));
});

function question(id: string, documentPath: string): PlanQueueItemDto {
  return {
    id,
    runId: 'run-1',
    documentPath,
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
    question: { question: 'Pick one', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] },
    answer: null,
    parkReason: null,
    detail: null,
    verdict: null,
    createdAt: 1,
    updatedAt: 1,
  };
}

describe('PlanQueueQuestionsBannerComponent', () => {
  let fixture: ComponentFixture<PlanQueueQuestionsBannerComponent>;
  let store: {
    needsAnswerItems: ReturnType<typeof signal<PlanQueueItemDto[]>>;
    ensureWired: ReturnType<typeof vi.fn>;
    load: ReturnType<typeof vi.fn>;
  };
  let router: { navigate: ReturnType<typeof vi.fn> };

  function banner(): HTMLButtonElement | null {
    return fixture.nativeElement.querySelector('[data-testid="plan-queue-questions-banner"]');
  }

  async function show(items: PlanQueueItemDto[]): Promise<void> {
    store.needsAnswerItems.set(items);
    fixture.detectChanges();
    await fixture.whenStable();
  }

  beforeEach(async () => {
    store = {
      needsAnswerItems: signal<PlanQueueItemDto[]>([]),
      ensureWired: vi.fn(),
      load: vi.fn().mockResolvedValue(undefined),
    };
    router = { navigate: vi.fn().mockResolvedValue(true) };

    await TestBed.configureTestingModule({
      imports: [PlanQueueQuestionsBannerComponent],
      providers: [
        { provide: PlanQueueStore, useValue: store },
        { provide: Router, useValue: router },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(PlanQueueQuestionsBannerComponent);
    fixture.detectChanges();
    await fixture.whenStable();
  });

  it('wires and loads the store so questions appear without visiting the Plan Queue page', () => {
    expect(store.ensureWired).toHaveBeenCalledTimes(1);
    expect(store.load).toHaveBeenCalledTimes(1);
  });

  it('renders nothing while no question is open', () => {
    expect(banner()).toBeNull();
  });

  it('counts the open questions and names the first documents', async () => {
    await show([
      question('i1', '/repo/documents/plans/a/desk-fast-deploys_plan.md'),
      question('i2', '/repo/documents/plans/b/jim-access_plan.md'),
      question('i3', '/repo/documents/plans/c/pipeline-repair_plan.md'),
      question('i4', '/repo/documents/plans/d/work-finding_plan.md'),
    ]);

    const text = banner()?.textContent ?? '';
    expect(text).toContain('Plan Queue: 4 questions need your answer');
    expect(text).toContain('desk-fast-deploys, jim-access and 2 more');
  });

  it('uses the singular for one question', async () => {
    await show([question('i1', 'docs/plans/x_livetest.md')]);

    expect(banner()?.textContent).toContain('Plan Queue: 1 question needs your answer');
    expect(banner()?.textContent).toContain('x');
  });

  it('opens the Plan Queue page when clicked', async () => {
    await show([question('i1', 'docs/plans/x_plan.md')]);

    banner()?.click();

    expect(router.navigate).toHaveBeenCalledWith(['/plan-queue']);
  });

  it('disappears once the last question is answered', async () => {
    await show([question('i1', 'docs/plans/x_plan.md')]);
    await show([]);

    expect(banner()).toBeNull();
  });

  it('labels documents by name without the lifecycle suffix', () => {
    expect(planQueueDocumentLabel('/a/b/desk-shared-crm_plan.md')).toBe('desk-shared-crm');
    expect(planQueueDocumentLabel('C:\\a\\desk-colleague-sending_spec.md')).toBe('desk-colleague-sending');
    expect(planQueueDocumentLabel('docs/plans/foo_spec_planned.md')).toBe('foo');
    expect(planQueueDocumentLabel('docs/plans/foo_livetest.md')).toBe('foo');
  });
});
