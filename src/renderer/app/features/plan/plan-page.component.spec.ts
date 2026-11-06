import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PlanPageComponent } from './plan-page.component';
import { PlanModeIpcService } from '../../core/services/ipc/plan-mode-ipc.service';
import { RendererPollSchedulerService } from '../../core/services/renderer-poll-scheduler.service';
import { InstanceStore } from '../../core/state/instance.store';

describe('PlanPageComponent', () => {
  const getPlanModeState = vi.fn();
  const updatePlanContent = vi.fn();
  const approvePlan = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    updatePlanContent.mockReset().mockResolvedValue({ success: true });
    approvePlan.mockReset().mockResolvedValue({ success: true });
    getPlanModeState.mockReset();
    getPlanModeState.mockResolvedValue({
      success: true,
      data: { enabled: true, state: 'planning', planContent: 'the plan' },
    });
    TestBed.configureTestingModule({
      providers: [
        { provide: PlanModeIpcService, useValue: { getPlanModeState, updatePlanContent, approvePlan } },
        RendererPollSchedulerService,
        { provide: InstanceStore, useValue: {
          selectedInstanceId: () => 'session-2',
          instances: () => [
            { id: 'session-1', displayName: 'First session' },
            { id: 'session-2', displayName: 'Selected session' },
          ],
        } },
      ],
    });
  });

  afterEach(() => {
    TestBed.resetTestingModule();
    vi.useRealTimers();
  });

  async function render() {
    const fixture = TestBed.createComponent(PlanPageComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    return fixture;
  }

  it('loads the selected session without an instance-id text field', async () => {
    const fixture = await render();
    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelector('input[type="text"]')).toBeNull();
    expect((root.querySelector('select') as HTMLSelectElement).value).toBe('session-2');
    expect(getPlanModeState).toHaveBeenCalledWith('session-2');
  });

  it('shows the session name in both identity labels without exposing its identifier', async () => {
    const fixture = await render();
    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelector('.state-instance')?.textContent?.trim()).toBe('Selected session');
    expect(root.querySelector('.meta-value')?.textContent?.trim()).toBe('Selected session');
    expect(root.textContent).not.toContain('session-2');
  });

  it('maps the main process planning shape to an editable plan and Approve', async () => {
    const fixture = await render();
    const root = fixture.nativeElement as HTMLElement;
    expect((root.querySelector('textarea') as HTMLTextAreaElement).value).toBe('the plan');
    expect(root.textContent).toContain('Approve Plan');
  });

  it('maps a disabled plan to idle', async () => {
    getPlanModeState.mockResolvedValue({ success: true, data: { enabled: false, state: 'off' } });
    const fixture = await render();
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('not currently in plan mode');
  });

  it('words the idle state as a session, not an instance (R5M3)', async () => {
    getPlanModeState.mockResolvedValue({ success: true, data: { enabled: false, state: 'off' } });
    const fixture = await render();
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('This session is not currently in plan mode.');
    expect(text).not.toMatch(/This instance/i);
  });

  it('offers a fresh build session for an approved plan', async () => {
    getPlanModeState.mockResolvedValue({
      success: true, data: { enabled: true, state: 'approved', planContent: 'the plan' },
    });
    const fixture = await render();
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('Build in a new session');
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('Approved');
  });

  it('preserves an unsaved draft across the actual five-second scheduler poll and submits it', async () => {
    const fixture = await render();
    const root = fixture.nativeElement as HTMLElement;
    const textarea = root.querySelector('textarea')!;
    textarea.value = 'my unsaved revision';
    textarea.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(5000);
    fixture.detectChanges();
    expect(getPlanModeState).toHaveBeenCalledTimes(2);
    expect(textarea.value).toBe('my unsaved revision');
    Array.from(root.querySelectorAll('button')).find((b) => b.textContent?.trim() === 'Update Plan')!.click();
    await fixture.whenStable();
    expect(updatePlanContent).toHaveBeenCalledWith('session-2', 'my unsaved revision');
  });

  it('accepts server changes on a clean draft, and seeds an intentional session switch', async () => {
    const fixture = await render();
    const root = fixture.nativeElement as HTMLElement;
    getPlanModeState.mockResolvedValue({ success: true, data: {
      enabled: true, state: 'planning', planContent: 'new server version',
    } });
    await vi.advanceTimersByTimeAsync(5000);
    fixture.detectChanges();
    expect(root.querySelector('textarea')!.value).toBe('new server version');
    root.querySelector('textarea')!.value = 'old session draft';
    root.querySelector('textarea')!.dispatchEvent(new Event('input'));
    getPlanModeState.mockResolvedValue({ success: true, data: {
      enabled: true, state: 'planning', planContent: 'first session plan',
    } });
    const select = root.querySelector('select')!;
    select.value = 'session-1';
    select.dispatchEvent(new Event('change'));
    await fixture.whenStable();
    fixture.detectChanges();
    expect(getPlanModeState).toHaveBeenLastCalledWith('session-1');
    expect(root.querySelector('textarea')!.value).toBe('first session plan');
  });

  it('approves the edited draft and reflects the successful state transition', async () => {
    const fixture = await render();
    const root = fixture.nativeElement as HTMLElement;
    root.querySelector('textarea')!.value = 'approved revision';
    root.querySelector('textarea')!.dispatchEvent(new Event('input'));
    getPlanModeState.mockResolvedValue({ success: true, data: {
      enabled: true, state: 'approved', planContent: 'approved revision',
    } });
    Array.from(root.querySelectorAll('button')).find((b) => b.textContent?.trim() === 'Approve Plan')!.click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(approvePlan).toHaveBeenCalledWith('session-2', 'approved revision');
    expect(root.querySelector('textarea')).toBeNull();
    expect(root.querySelector('.plan-display')?.textContent).toContain('approved revision');
  });

  it('keeps edits made during an update and on failed updates', async () => {
    const fixture = await render();
    const root = fixture.nativeElement as HTMLElement;
    const edit = (value: string) => {
      root.querySelector('textarea')!.value = value;
      root.querySelector('textarea')!.dispatchEvent(new Event('input'));
    };
    edit('submitted');
    let finish!: (value: { success: boolean }) => void;
    updatePlanContent.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    const update = fixture.componentInstance.updatePlan();
    edit('newer draft');
    getPlanModeState.mockResolvedValue({ success: true, data: {
      enabled: true, state: 'planning', planContent: 'submitted',
    } });
    finish({ success: true });
    await update;
    fixture.detectChanges();
    expect(root.querySelector('textarea')!.value).toBe('newer draft');
    updatePlanContent.mockResolvedValueOnce({ success: false, error: { message: 'Failed update' } });
    await fixture.componentInstance.updatePlan();
    await vi.advanceTimersByTimeAsync(5000);
    fixture.detectChanges();
    expect(root.querySelector('textarea')!.value).toBe('newer draft');
    expect(root.textContent).toContain('Failed update');
  });

  it('marks an echoed successful save clean so later server updates remain visible', async () => {
    const fixture = await render();
    const root = fixture.nativeElement as HTMLElement;
    root.querySelector('textarea')!.value = 'saved draft';
    root.querySelector('textarea')!.dispatchEvent(new Event('input'));
    getPlanModeState.mockResolvedValue({ success: true, data: {
      enabled: true, state: 'planning', planContent: 'saved draft',
    } });
    await fixture.componentInstance.updatePlan();
    getPlanModeState.mockResolvedValue({ success: true, data: {
      enabled: true, state: 'planning', planContent: 'later server update',
    } });
    await vi.advanceTimersByTimeAsync(5000);
    fixture.detectChanges();
    expect(root.querySelector('textarea')!.value).toBe('later server update');
  });

  it('allows approval of a newly typed plan and disables approval of an empty draft', async () => {
    getPlanModeState.mockResolvedValue({ success: true, data: { enabled: true, state: 'planning' } });
    const fixture = await render();
    const root = fixture.nativeElement as HTMLElement;
    const button = Array.from(root.querySelectorAll('button')).find((b) => b.textContent?.trim() === 'Approve Plan')!;
    expect(button.disabled).toBe(true);
    root.querySelector('textarea')!.value = 'new plan';
    root.querySelector('textarea')!.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    expect(button.disabled).toBe(false);
    root.querySelector('textarea')!.value = '   ';
    root.querySelector('textarea')!.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    expect(button.disabled).toBe(true);
  });
});
