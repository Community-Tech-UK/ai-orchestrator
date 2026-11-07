import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ScheduledCountdownComponent } from './scheduled-countdown.component';

describe('scheduled countdown', () => {
  afterEach(() => { TestBed.resetTestingModule(); vi.useRealTimers(); });
  it('ticks without new server data and identifies a due wakeup that is waiting for idle', async () => {
    vi.useFakeTimers(); vi.setSystemTime(100000);
    const fixture = TestBed.createComponent(ScheduledCountdownComponent);
    fixture.componentRef.setInput('deadline', 940000); fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('in 14 min');
    await vi.advanceTimersByTimeAsync(60000); fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('in 13 min');
    fixture.componentRef.setInput('deadline', 100000); fixture.componentRef.setInput('waitingForIdle', true); fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Due now, waiting for the session to be idle');
    fixture.destroy();
  });
  it('counts long waits in hours and days', () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    const fixture = TestBed.createComponent(ScheduledCountdownComponent);
    for (const [deadline, text] of [[3_540_000, 'in 59 min'], [3_600_000, 'in 1 hour'], [3_660_000, 'in 2 hours'], [82_800_000, 'in 23 hours'], [86_400_000, 'in 1 day'],
      [86_460_000, 'in 2 days'], [3 * 86_400_000, 'in 3 days']] as const) {
      fixture.componentRef.setInput('deadline', deadline); fixture.detectChanges();
      expect(fixture.nativeElement.textContent).toContain(text);
    }
    fixture.destroy();
  });
});
