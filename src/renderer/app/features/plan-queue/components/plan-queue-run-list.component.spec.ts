import { ɵresolveComponentResources as resolveComponentResources } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import type { PlanQueueRunDto } from '@contracts/schemas/plan-queue';
import { PlanQueueRunListComponent } from './plan-queue-run-list.component';

const specDirectory = dirname(fileURLToPath(import.meta.url));
const resources: Record<string, string> = {
  'plan-queue-run-list.component.html': readFileSync(resolve(specDirectory, './plan-queue-run-list.component.html'), 'utf8'),
  'plan-queue-run-list.component.scss': readFileSync(resolve(specDirectory, './plan-queue-run-list.component.scss'), 'utf8'),
  'plan-queue-item-list.component.html': readFileSync(resolve(specDirectory, './plan-queue-item-list.component.html'), 'utf8'),
  'plan-queue-item-list.component.scss': readFileSync(resolve(specDirectory, './plan-queue-item-list.component.scss'), 'utf8'),
  'plan-queue-run-controls.component.html': readFileSync(resolve(specDirectory, './plan-queue-run-controls.component.html'), 'utf8'),
  'plan-queue-run-controls.component.scss': readFileSync(resolve(specDirectory, './plan-queue-run-controls.component.scss'), 'utf8'),
  'plan-queue-question-card.component.html': readFileSync(resolve(specDirectory, './plan-queue-question-card.component.html'), 'utf8'),
  'plan-queue-question-card.component.scss': readFileSync(resolve(specDirectory, './plan-queue-question-card.component.scss'), 'utf8'),
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

  it('forwards a run control action with the correct run id', () => {
    fixture.componentRef.setInput('runs', [makeRun({ id: 'run-x', status: 'running' })]);
    fixture.detectChanges();

    const emitted: string[] = [];
    fixture.componentInstance.pauseRun.subscribe((id) => emitted.push(id));
    (fixture.nativeElement.querySelector('button') as HTMLButtonElement).click();

    expect(emitted).toEqual(['run-x']);
  });

  it('forwards an item answer event unchanged', () => {
    fixture.componentRef.setInput('runs', [
      makeRun({
        id: 'run-x',
        items: [
          {
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
          },
        ],
      }),
    ]);
    fixture.detectChanges();

    const emitted: { itemId: string; optionId: string }[] = [];
    fixture.componentInstance.answer.subscribe((e) => emitted.push(e));

    const radio = fixture.nativeElement.querySelector('input[type="radio"]') as HTMLInputElement;
    radio.dispatchEvent(new Event('change'));
    fixture.detectChanges();
    (fixture.nativeElement.querySelector('.pq-question-submit') as HTMLButtonElement).click();

    expect(emitted).toEqual([{ itemId: 'item-1', optionId: radio.value }]);
  });
});
