import { ComponentFixture, TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActivityStatusComponent } from './activity-status.component';

const NOW = 1_700_000_000_000;

describe('ActivityStatusComponent', () => {
  let fixture: ComponentFixture<ActivityStatusComponent>;

  beforeEach(async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    await TestBed.configureTestingModule({
      imports: [ActivityStatusComponent],
    }).compileComponents();
    fixture = TestBed.createComponent(ActivityStatusComponent);
    fixture.componentRef.setInput('status', 'busy');
  });

  afterEach(() => {
    fixture.destroy();
    vi.restoreAllMocks();
  });

  function renderElapsed(elapsedMs: number): string {
    fixture.componentRef.setInput('busySince', NOW - elapsedMs);
    fixture.detectChanges();
    const elapsed = fixture.nativeElement.querySelector('.elapsed-time') as HTMLElement | null;
    return elapsed?.textContent?.trim() ?? '';
  }

  it('keeps seconds below one minute and minutes plus seconds below one hour', () => {
    expect(renderElapsed(59_999)).toBe('59s');
    expect(renderElapsed(59 * 60_000 + 59_999)).toBe('59m 59s');
  });

  it('switches to hours and minutes at one hour', () => {
    expect(renderElapsed(60 * 60_000)).toBe('1h 0m');
    expect(renderElapsed(23 * 60 * 60_000 + 59 * 60_000 + 59_999)).toBe('23h 59m');
  });

  it('switches to days, hours, and minutes at 24 hours', () => {
    expect(renderElapsed(24 * 60 * 60_000)).toBe('1d 0h 0m');
    expect(renderElapsed((43 * 60 + 50) * 60_000 + 45_999)).toBe('1d 19h 50m');
  });
});
