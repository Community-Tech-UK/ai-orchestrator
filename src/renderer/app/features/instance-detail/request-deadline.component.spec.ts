import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RequestDeadlineComponent } from './request-deadline.component';

describe('RequestDeadlineComponent', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_000_000); });
  afterEach(() => vi.useRealTimers());

  function mount(expiresAt: number) {
    const fixture = TestBed.createComponent(RequestDeadlineComponent);
    fixture.componentRef.setInput('expiresAt', expiresAt);
    fixture.detectChanges();
    return fixture;
  }
  const text = (fixture: ReturnType<typeof mount>) => (fixture.nativeElement as HTMLElement).textContent?.trim();

  it('counts down every second and ends on "expiring…"', async () => {
    const fixture = mount(1_000_000 + 3_000);
    expect(text(fixture)).toBe('3s left');
    await vi.advanceTimersByTimeAsync(1000);
    fixture.detectChanges();
    expect(text(fixture)).toBe('2s left');
    await vi.advanceTimersByTimeAsync(2000);
    fixture.detectChanges();
    expect(text(fixture)).toBe('expiring…');
  });

  it('stops its timer when the card goes away', () => {
    const fixture = mount(1_000_000 + 60_000);
    expect(vi.getTimerCount()).toBe(1);
    fixture.destroy();
    expect(vi.getTimerCount()).toBe(0);
  });
});
