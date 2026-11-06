import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PlanPageComponent } from './plan-page.component';
import { PlanModeIpcService } from '../../core/services/ipc/plan-mode-ipc.service';
import { RendererPollSchedulerService } from '../../core/services/renderer-poll-scheduler.service';
import { InstanceStore } from '../../core/state/instance.store';
import { InstanceStateService } from '../../core/state/instance/instance-state.service';
import { ToastService } from '../../core/services/toast.service';

// Real PlanHandoffDialogComponent, stubbed IPC: the page's own `@if (planHandoffOpen() && planState())`
// block and its `(closed)` binding are what is under test (plan 15a/15b).
describe('PlanPageComponent build-in-a-new-session hand-off (R6N4)', () => {
  const getPlanModeState = vi.fn();
  const previewPlanHandoff = vi.fn();
  const startPlanHandoff = vi.fn();
  const setSelectedInstance = vi.fn();
  const toastShow = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    getPlanModeState.mockReset().mockResolvedValue({
      success: true, data: { enabled: true, state: 'approved', planContent: 'the approved plan' },
    });
    previewPlanHandoff.mockReset().mockResolvedValue({ success: true, data: {
      planText: '1. Build the export screen.', truncated: false, source: 'plan-mode',
      planningContextTokens: 142_000, planTokensEstimate: 8,
      provider: 'claude', model: 'claude-sonnet-4-6', canStart: true,
    } });
    startPlanHandoff.mockReset().mockResolvedValue({ success: true, data: { newInstanceId: 'build-1' } });
    setSelectedInstance.mockReset();
    toastShow.mockReset();
    TestBed.configureTestingModule({
      providers: [
        { provide: PlanModeIpcService, useValue: {
          getPlanModeState, updatePlanContent: vi.fn(), approvePlan: vi.fn(), previewPlanHandoff, startPlanHandoff,
        } },
        { provide: InstanceStateService, useValue: { setSelectedInstance } },
        { provide: ToastService, useValue: { show: toastShow } },
        RendererPollSchedulerService,
        { provide: InstanceStore, useValue: {
          selectedInstanceId: () => 'session-2',
          instances: () => [{ id: 'session-2', displayName: 'Selected session' }],
        } },
      ],
    });
  });

  afterEach(() => {
    TestBed.resetTestingModule();
    vi.useRealTimers();
  });

  async function render(): Promise<ComponentFixture<PlanPageComponent>> {
    const fixture = TestBed.createComponent(PlanPageComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    return fixture;
  }

  async function flush(fixture: ComponentFixture<PlanPageComponent>): Promise<void> {
    for (let i = 0; i < 3; i++) {
      await fixture.whenStable();
      await Promise.resolve();
      fixture.detectChanges();
    }
  }

  const dialog = (fixture: ComponentFixture<PlanPageComponent>) =>
    (fixture.nativeElement as HTMLElement).querySelector('app-plan-handoff-dialog');
  const button = (fixture: ComponentFixture<PlanPageComponent>, label: string) =>
    Array.from((fixture.nativeElement as HTMLElement).querySelectorAll('button'))
      .find((b) => b.textContent?.trim() === label);

  it('opens the hand-off dialog from the approved state, and Cancel closes it again', async () => {
    const fixture = await render();
    expect(dialog(fixture), 'closed until asked for').toBeNull();

    button(fixture, 'Build in a new session')!.click();
    await flush(fixture);

    const open = dialog(fixture);
    expect(open, 'the dialog renders once the page button is clicked').not.toBeNull();
    expect(previewPlanHandoff).toHaveBeenCalledWith('session-2');
    expect((open!.querySelector('textarea') as HTMLTextAreaElement).value).toBe('1. Build the export screen.');
    expect(open!.textContent).toContain('Start new session');

    Array.from(open!.querySelectorAll('button')).find((b) => b.textContent?.trim() === 'Cancel')!.click();
    await flush(fixture);
    expect(dialog(fixture), 'the (closed) binding clears the open flag').toBeNull();
    expect(startPlanHandoff).not.toHaveBeenCalled();

    // The flag really went back to false: the page button opens it a second time.
    button(fixture, 'Build in a new session')!.click();
    await flush(fixture);
    expect(dialog(fixture)).not.toBeNull();
  });

  it('starts the build session for the loaded session, selects it and closes the dialog', async () => {
    const fixture = await render();
    button(fixture, 'Build in a new session')!.click();
    await flush(fixture);

    Array.from(dialog(fixture)!.querySelectorAll('button')).find((b) => b.textContent?.includes('Start new session'))!.click();
    await flush(fixture);

    expect(startPlanHandoff).toHaveBeenCalledWith(expect.objectContaining({
      instanceId: 'session-2', planText: '1. Build the export screen.',
    }));
    expect(startPlanHandoff.mock.calls[0][0].requestId, 'the page has no request card to dismiss').toBeUndefined();
    expect(setSelectedInstance).toHaveBeenCalledWith('build-1');
    expect(dialog(fixture), 'closed after a successful start').toBeNull();
  });

  it('does not render the dialog before the plan state has loaded', async () => {
    getPlanModeState.mockReturnValue(new Promise(() => undefined));
    const fixture = await render();
    fixture.componentInstance.planHandoffOpen.set(true);
    fixture.detectChanges();
    expect(dialog(fixture)).toBeNull();
  });
});
