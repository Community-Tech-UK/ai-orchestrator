import { ComponentFixture, TestBed } from '@angular/core/testing';
import { StatusIndicatorComponent } from './status-indicator.component';
import type { InstanceStatus } from '../../core/state/instance.store';

describe('StatusIndicatorComponent', () => {
  let fixture: ComponentFixture<StatusIndicatorComponent>;

  async function setStatus(status: InstanceStatus, backgroundWorkCount = 0): Promise<void> {
    fixture = TestBed.createComponent(StatusIndicatorComponent);
    fixture.componentRef.setInput('status', status);
    fixture.componentRef.setInput('backgroundWorkCount', backgroundWorkCount);
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
    expect(fixture.componentInstance.label()).toBe('Waiting on background work');
    const dot = fixture.nativeElement.querySelector('.status-indicator') as HTMLElement;
    expect(dot.classList).toContain('background-waiting');
  });

  it('keeps the busy spinner while a turn runs alongside background work', async () => {
    await setStatus('busy', 1);
    expect(fixture.componentInstance.isBackgroundWaiting()).toBe(false);
    expect(fixture.componentInstance.showSpinnerIndicator()).toBe(true);
  });
});
