import { ɵresolveComponentResources as resolveComponentResources } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import type { PlanQueueRunDto } from '@contracts/schemas/plan-queue';
import { PlanQueueRunControlsComponent } from './plan-queue-run-controls.component';

const specDirectory = dirname(fileURLToPath(import.meta.url));
const template = readFileSync(resolve(specDirectory, './plan-queue-run-controls.component.html'), 'utf8');
const styles = readFileSync(resolve(specDirectory, './plan-queue-run-controls.component.scss'), 'utf8');

await resolveComponentResources((url) => {
  if (url.endsWith('plan-queue-run-controls.component.html')) return Promise.resolve(template);
  if (url.endsWith('plan-queue-run-controls.component.scss')) return Promise.resolve(styles);
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

describe('PlanQueueRunControlsComponent', () => {
  let fixture: ComponentFixture<PlanQueueRunControlsComponent>;

  async function render(run: PlanQueueRunDto): Promise<void> {
    await TestBed.configureTestingModule({ imports: [PlanQueueRunControlsComponent] }).compileComponents();
    fixture = TestBed.createComponent(PlanQueueRunControlsComponent);
    fixture.componentRef.setInput('run', run);
    fixture.detectChanges();
  }

  beforeEach(() => {
    TestBed.resetTestingModule();
  });

  it('shows Pause and Cancel for a running run', async () => {
    await render(makeRun({ status: 'running' }));
    expect(fixture.nativeElement.textContent).toContain('Pause');
    expect(fixture.nativeElement.textContent).toContain('Cancel');
    expect(fixture.nativeElement.textContent).not.toContain('Resume');
  });

  it('shows Resume and Cancel for a paused run', async () => {
    await render(makeRun({ status: 'paused' }));
    expect(fixture.nativeElement.textContent).toContain('Resume');
    expect(fixture.nativeElement.textContent).toContain('Cancel');
    expect(fixture.nativeElement.textContent).not.toContain('Pause');
  });

  it('shows no action buttons for a completed run', async () => {
    await render(makeRun({ status: 'completed' }));
    expect(fixture.nativeElement.querySelectorAll('button')).toHaveLength(0);
  });

  it('emits pauseRun with the run id', async () => {
    await render(makeRun({ id: 'run-x', status: 'running' }));
    const emitted: string[] = [];
    fixture.componentInstance.pauseRun.subscribe((id) => emitted.push(id));
    (fixture.nativeElement.querySelector('button') as HTMLButtonElement).click();
    expect(emitted).toEqual(['run-x']);
  });

  it('requires a confirm click before emitting cancelRun', async () => {
    await render(makeRun({ id: 'run-x', status: 'running' }));
    const emitted: string[] = [];
    fixture.componentInstance.cancelRun.subscribe((id) => emitted.push(id));

    (fixture.nativeElement.querySelector('.pq-cancel') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(emitted).toHaveLength(0);
    expect(fixture.nativeElement.textContent).toContain('Cancel this run?');

    (fixture.nativeElement.querySelector('.pq-confirm-yes') as HTMLButtonElement).click();
    expect(emitted).toEqual(['run-x']);
  });

  it('lets James back out of the cancel confirmation without cancelling', async () => {
    await render(makeRun({ id: 'run-x', status: 'running' }));
    const emitted: string[] = [];
    fixture.componentInstance.cancelRun.subscribe((id) => emitted.push(id));

    (fixture.nativeElement.querySelector('.pq-cancel') as HTMLButtonElement).click();
    fixture.detectChanges();
    (fixture.nativeElement.querySelectorAll('button')[1] as HTMLButtonElement).click();
    fixture.detectChanges();

    expect(emitted).toHaveLength(0);
    expect(fixture.nativeElement.textContent).toContain('Pause');
  });
});
