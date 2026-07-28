import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LocalAiAggregateStatus } from '../../../../shared/types/local-ai-guard.types';
import { LocalAiGuardStore } from '../../core/state/local-ai-guard.store';
import { LocalAiStatusChipComponent } from './local-ai-status-chip.component';

function aggregate(
  state: LocalAiAggregateStatus['state'],
  enrolled = state === 'not-configured' ? 0 : 1,
): LocalAiAggregateStatus {
  return {
    state,
    enrolled,
    healthy: state === 'healthy' ? enrolled : 0,
    degraded: state === 'degraded' ? enrolled : 0,
    unavailable: state === 'unavailable' ? enrolled : 0,
    paused: state === 'paused' ? enrolled : 0,
  };
}

describe('LocalAiStatusChipComponent', () => {
  const initialized = signal(true);
  const hasAuthoritativeSnapshot = signal(true);
  const currentAggregate = signal(aggregate('not-configured'));
  const store = {
    isInitialized: initialized.asReadonly(),
    hasAuthoritativeSnapshot: hasAuthoritativeSnapshot.asReadonly(),
    aggregate: currentAggregate.asReadonly(),
  };
  const router = { navigateByUrl: vi.fn(async () => true) };

  beforeEach(() => {
    TestBed.resetTestingModule();
    vi.clearAllMocks();
    initialized.set(true);
    hasAuthoritativeSnapshot.set(true);
    currentAggregate.set(aggregate('not-configured'));
    TestBed.configureTestingModule({
      imports: [LocalAiStatusChipComponent],
      providers: [
        { provide: LocalAiGuardStore, useValue: store },
        { provide: Router, useValue: router },
      ],
    });
  });

  it.each([
    ['not-configured', 'Not configured', 'neutral'],
    ['checking', 'Checking', 'checking'],
    ['healthy', 'Healthy', 'healthy'],
    ['degraded', 'Degraded', 'degraded'],
    ['unavailable', 'Unavailable', 'unavailable'],
    ['paused', 'Paused', 'paused'],
  ] as const)('shows the %s aggregate state with an accessible label', (state, label, tone) => {
    currentAggregate.set(aggregate(state, state === 'not-configured' ? 0 : 2));
    const fixture = TestBed.createComponent(LocalAiStatusChipComponent);
    fixture.detectChanges();

    const button = fixture.nativeElement.querySelector('button') as HTMLButtonElement;
    expect(button.textContent).toContain(`Local AI: ${label}`);
    expect(button.textContent).toContain(state === 'not-configured' ? '0 targets' : '2 targets');
    expect(button.dataset['state']).toBe(tone);
    expect(button.getAttribute('aria-label')).toBe(
      `Local AI Guard: ${label}. ${state === 'not-configured' ? 0 : 2} enrolled targets. Open Local AI health centre.`,
    );
  });

  it('is hidden only until initialization completes', () => {
    initialized.set(false);
    const fixture = TestBed.createComponent(LocalAiStatusChipComponent);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('button')).toBeNull();

    initialized.set(true);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('button')).not.toBeNull();
  });

  it('reports status unavailable instead of not configured without an authoritative snapshot', () => {
    hasAuthoritativeSnapshot.set(false);
    const fixture = TestBed.createComponent(LocalAiStatusChipComponent);
    fixture.detectChanges();

    const button = fixture.nativeElement.querySelector('button') as HTMLButtonElement;
    expect(button.textContent).toContain('Local AI: Status unavailable');
    expect(button.textContent).not.toContain('Not configured');
    expect(button.getAttribute('aria-label')).toBe(
      'Local AI Guard: Status unavailable. Open Local AI health centre.',
    );
    expect(button.dataset['state']).toBe('unavailable');
  });

  it('navigates to the Local AI health centre', () => {
    const fixture = TestBed.createComponent(LocalAiStatusChipComponent);
    fixture.detectChanges();

    fixture.nativeElement.querySelector('button').click();

    expect(router.navigateByUrl).toHaveBeenCalledExactlyOnceWith('/local-ai');
  });

  it('uses singular target grammar in visible and accessible copy', () => {
    currentAggregate.set(aggregate('healthy', 1));
    const fixture = TestBed.createComponent(LocalAiStatusChipComponent);
    fixture.detectChanges();

    const button = fixture.nativeElement.querySelector('button') as HTMLButtonElement;
    expect(button.textContent).toContain('1 target');
    expect(button.getAttribute('aria-label')).toContain('1 enrolled target.');
  });
});
