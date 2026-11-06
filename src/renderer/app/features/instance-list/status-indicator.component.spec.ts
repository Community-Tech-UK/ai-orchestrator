import { ComponentFixture, TestBed } from '@angular/core/testing';
import { StatusIndicatorComponent } from './status-indicator.component';
import type { InstanceStatus } from '../../core/state/instance.store';
import type { InstanceWaitReason } from '../../../../shared/types/instance-wait-reason.types';

describe('StatusIndicatorComponent', () => {
  let fixture: ComponentFixture<StatusIndicatorComponent>;

  async function setStatus(
    status: InstanceStatus,
    backgroundWorkCount = 0,
    waitReason: InstanceWaitReason | null = null,
  ): Promise<void> {
    fixture = TestBed.createComponent(StatusIndicatorComponent);
    fixture.componentRef.setInput('status', status);
    fixture.componentRef.setInput('backgroundWorkCount', backgroundWorkCount);
    fixture.componentRef.setInput('waitReason', waitReason);
    fixture.detectChanges();
    await fixture.whenStable();
  }

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [StatusIndicatorComponent],
    }).compileComponents();
  });

  it('shows the spinning-ring indicator while genuinely busy', async () => {
    await setStatus('busy');
    expect(fixture.componentInstance.showSpinnerIndicator()).toBe(true);
  });

  it('pulses (rather than sitting static) while waiting for user input', async () => {
    await setStatus('waiting_for_input');
    expect(fixture.componentInstance.showSpinnerIndicator()).toBe(false);
    expect(fixture.componentInstance.isPulsing()).toBe(true);
  });

  it('pulses while waiting for permission', async () => {
    await setStatus('waiting_for_permission');
    expect(fixture.componentInstance.isPulsing()).toBe(true);
  });

  it('sits static (no spin, no pulse) once fully settled', async () => {
    await setStatus('idle');
    expect(fixture.componentInstance.showSpinnerIndicator()).toBe(false);
    expect(fixture.componentInstance.isPulsing()).toBe(false);
  });

  it('shows a distinct waiting state, not a settled dot, when idle with background work', async () => {
    await setStatus('idle', 1);
    expect(fixture.componentInstance.isBackgroundWaiting()).toBe(true);
    expect(fixture.componentInstance.showSpinnerIndicator()).toBe(false);
    expect(fixture.componentInstance.isPulsing()).toBe(false);
    expect(fixture.componentInstance.label()).toBe('Working — waiting on background work');
    const dot = fixture.nativeElement.querySelector('.status-indicator') as HTMLElement;
    expect(dot.classList).toContain('background-waiting');
  });

  it('keeps the busy spinner while a turn runs alongside background work', async () => {
    await setStatus('busy', 1);
    expect(fixture.componentInstance.isBackgroundWaiting()).toBe(false);
    expect(fixture.componentInstance.showSpinnerIndicator()).toBe(true);
  });

  describe('words and colours come from the one status presenter', () => {
    function dot(): HTMLElement {
      return (fixture.nativeElement.querySelector('.status-indicator, .status-spinner')) as HTMLElement;
    }

    it('tells a question from an approval', async () => {
      await setStatus('waiting_for_input');
      expect(fixture.componentInstance.label()).toBe('Needs your answer — the agent asked you a question');
      expect(dot().getAttribute('aria-label')).toBe(fixture.componentInstance.label());

      await setStatus('waiting_for_permission');
      expect(fixture.componentInstance.label()).toMatch(/^Needs your OK — /);
    });

    it('uses the plain words, not the old developer ones', async () => {
      const seen: string[] = [];
      for (const status of ['busy', 'thinking_deeply', 'respawning', 'hibernated', 'degraded', 'terminated'] as const) {
        await setStatus(status);
        seen.push(fixture.componentInstance.visibleLabel());
      }
      expect(seen).toEqual(['Working', 'Thinking', 'Restarting', 'Asleep', 'Problem', 'Stopped']);
    });

    it('draws a recovering session in the same teal as a thinking one', async () => {
      await setStatus('respawning');
      const recovering = fixture.componentInstance.color();
      await setStatus('thinking_deeply');
      expect(fixture.componentInstance.color()).toBe(recovering);
      expect(recovering).toBe('#4fa3a5');
    });

    it('offers its name through the shared tooltip, never a native title', async () => {
      await setStatus('idle');
      expect(dot().hasAttribute('title')).toBe(false);
      expect(dot().getAttribute('aria-label')).toBe('Ready');
    });

    it('shows a session parked on a usage limit as asleep rather than ready', async () => {
      await setStatus('idle', 0, { kind: 'quota-park', provider: 'claude', resumeAt: Date.now() + 60_000 });
      expect(fixture.componentInstance.label()).toBe('Asleep — paused until your Claude allowance resets');
      expect(fixture.componentInstance.isPulsing()).toBe(false);
      expect(fixture.componentInstance.color()).toBe('#4b5563');
    });

    it('names a signed-out account by its family, not its raw provider id', async () => {
      await setStatus('idle', 0, { kind: 'auth-required', provider: 'opencode', since: 1 });
      expect(fixture.componentInstance.label()).toBe('Problem — signed out of MiMo');
    });
  });
});
