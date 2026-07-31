import { ComponentFixture, TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OperationalDecision } from '@contracts/schemas/workboard';
import { LoopStore } from '../../core/state/loop.store';
import { WorkboardIpcService } from '../../core/services/ipc/workboard-ipc.service';
import { WorkboardDecisionTimelineComponent } from './workboard-decision-timeline.component';
import type { WorkboardItem } from './workboard.types';

const NOW = 1_700_000_000_000;

function item(overrides: Partial<WorkboardItem> = {}): WorkboardItem {
  return {
    id: 'loop-run:loop-1',
    primary: {
      kind: 'loop-run', id: 'loop-1', rawStatus: 'provider-limit',
      phase: 'blocked', lane: 'waiting', updatedAt: NOW, terminal: false,
    },
    relations: [],
    lane: 'waiting',
    title: 'Fix the flaky test',
    workspaceId: '/repo/project',
    workingDirectory: '/repo/project',
    statusLabel: 'Provider limit',
    updatedAt: NOW,
    loopRunId: 'loop-1',
    instanceId: 'inst-1',
    ...overrides,
  };
}

function decision(overrides: Partial<OperationalDecision> = {}): OperationalDecision {
  return {
    id: 'pl:evt-1',
    at: NOW - 5_000,
    source: 'provider-limit',
    title: 'Paused: Claude hit its usage limit',
    resultingStatus: 'provider-limit',
    resumeAt: NOW + 60_000,
    ...overrides,
  };
}

describe('WorkboardDecisionTimelineComponent', () => {
  let fixture: ComponentFixture<WorkboardDecisionTimelineComponent>;
  let getDecisionsForItem: ReturnType<typeof vi.fn>;
  let resume: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    getDecisionsForItem = vi.fn(async () => ({ success: true, data: [] as OperationalDecision[] }));
    resume = vi.fn(async () => undefined);

    await TestBed.configureTestingModule({
      imports: [WorkboardDecisionTimelineComponent],
      providers: [
        { provide: WorkboardIpcService, useValue: { getDecisionsForItem } },
        { provide: LoopStore, useValue: { resume } },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(WorkboardDecisionTimelineComponent);
  });

  it('renders nothing for an item with no correlating ids and never calls the IPC bridge', async () => {
    fixture.componentRef.setInput('item', item({ loopRunId: undefined, instanceId: undefined, automationRunId: undefined }));
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(getDecisionsForItem).not.toHaveBeenCalled();
    expect(fixture.nativeElement.querySelector('.wb-decisions')).toBeNull();
  });

  it('renders nothing while the timeline is empty (never a placeholder)', async () => {
    fixture.componentRef.setInput('item', item());
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(getDecisionsForItem).toHaveBeenCalledWith({ loopRunId: 'loop-1', automationRunId: undefined, instanceId: 'inst-1' });
    expect(fixture.nativeElement.querySelector('.wb-decisions')).toBeNull();
  });

  it('renders plain-language entries with relative time, detail, and resume text', async () => {
    getDecisionsForItem.mockResolvedValue({
      success: true,
      data: [decision({ detail: 'Recorded via loop-quota' })],
    });
    fixture.componentRef.setInput('item', item());
    fixture.componentRef.setInput('now', NOW);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const text = (fixture.nativeElement.textContent as string).replace(/\s+/g, ' ');
    expect(text).toContain('Paused: Claude hit its usage limit');
    expect(text).toContain('Recorded via loop-quota');
    expect(text).toContain('Resumes');
  });

  it('dispatches the existing resume-loop command through LoopStore, not a new mutation', async () => {
    getDecisionsForItem.mockResolvedValue({
      success: true,
      data: [decision({ operatorAction: { kind: 'resume-loop', label: 'Resume now', loopRunId: 'loop-1' } })],
    });
    fixture.componentRef.setInput('item', item());
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const button = fixture.nativeElement.querySelector('.wb-decisions-action') as HTMLButtonElement;
    expect(button).not.toBeNull();
    expect(button.textContent?.trim()).toBe('Resume now');
    button.click();
    await fixture.whenStable();

    expect(resume).toHaveBeenCalledWith('loop-1');
  });

  it('renders nothing when the IPC call fails, tolerating the failure silently', async () => {
    getDecisionsForItem.mockResolvedValue({ success: false, error: { message: 'Not in Electron' } });
    fixture.componentRef.setInput('item', item());
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.wb-decisions')).toBeNull();
  });

  it('re-queries when the selected item changes to a different correlated item', async () => {
    fixture.componentRef.setInput('item', item());
    fixture.detectChanges();
    await fixture.whenStable();
    expect(getDecisionsForItem).toHaveBeenCalledTimes(1);

    fixture.componentRef.setInput('item', item({ id: 'loop-run:loop-2', loopRunId: 'loop-2' }));
    fixture.detectChanges();
    await fixture.whenStable();

    expect(getDecisionsForItem).toHaveBeenCalledTimes(2);
    expect(getDecisionsForItem).toHaveBeenLastCalledWith({ loopRunId: 'loop-2', automationRunId: undefined, instanceId: 'inst-1' });
  });

  it('does not re-query when the same item re-renders with an unchanged correlation key', async () => {
    fixture.componentRef.setInput('item', item());
    fixture.detectChanges();
    await fixture.whenStable();
    expect(getDecisionsForItem).toHaveBeenCalledTimes(1);

    fixture.componentRef.setInput('item', item());
    fixture.detectChanges();
    await fixture.whenStable();

    expect(getDecisionsForItem).toHaveBeenCalledTimes(1);
  });
});
