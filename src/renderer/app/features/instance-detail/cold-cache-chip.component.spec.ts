import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ColdCacheResumeService } from './cold-cache-resume.service';
import { ColdCacheChipComponent } from './cold-cache-chip.component';

describe('ColdCacheChipComponent', () => {
  const offer = signal<{ offer: false } | { offer: true; tokens: number; idleMinutes: number }>({ offer: true, tokens: 152_000, idleMinutes: 192 });
  const phase = signal<'idle' | 'compacting' | 'failed'>('idle');
  const preference = signal(true);
  const cancelPendingSend = vi.fn();
  const setPreferCompact = vi.fn((_id: string, value: boolean) => preference.set(value));

  beforeEach(() => {
    offer.set({ offer: true, tokens: 152_000, idleMinutes: 192 });
    phase.set('idle'); preference.set(true);
    cancelPendingSend.mockClear(); setPreferCompact.mockClear();
    TestBed.configureTestingModule({ providers: [{ provide: ColdCacheResumeService, useValue: {
      offerFor: () => offer(), phaseFor: () => phase(), preferCompact: () => preference(),
      setPreferCompact, cancelPendingSend,
    } }] });
  });

  function render() {
    const fixture = TestBed.createComponent(ColdCacheChipComponent);
    fixture.componentRef.setInput('instanceId', 'one'); fixture.detectChanges();
    return fixture;
  }

  it('shows the cold cost and a pressed compact-first toggle', () => {
    const fixture = render();
    expect(fixture.nativeElement.textContent).toContain('away 3 h 12 min');
    expect(fixture.nativeElement.textContent).toContain('about 152K tokens');
    const button = fixture.nativeElement.querySelector('button') as HTMLButtonElement;
    expect(button.getAttribute('aria-pressed')).toBe('true');
    button.click(); fixture.detectChanges();
    expect(setPreferCompact).toHaveBeenCalledWith('one', false);
    expect(button.textContent).toContain('Send with full history');
  });

  it('offers Cancel while compacting and explains a failure', () => {
    phase.set('compacting');
    const fixture = render();
    (fixture.nativeElement.querySelector('button') as HTMLButtonElement).click();
    expect(cancelPendingSend).toHaveBeenCalledWith('one');
    phase.set('failed'); fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[role="alert"]')?.textContent).toContain('nothing was sent');
  });
});
