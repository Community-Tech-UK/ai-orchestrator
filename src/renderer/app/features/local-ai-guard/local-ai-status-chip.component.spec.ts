import { By } from '@angular/platform-browser';
import { AioTooltipDirective } from '../../shared/tooltip/aio-tooltip.directive';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  LocalAiAggregateStatus,
  LocalAiFailureCode,
  LocalAiHealthLayer,
  LocalAiTargetStatus,
} from '../../../../shared/types/local-ai-guard.types';
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

function target(
  targetId: string,
  state: LocalAiTargetStatus['state'],
  failures: Partial<Record<LocalAiHealthLayer, LocalAiFailureCode>>,
  lifecycle: LocalAiTargetStatus['lifecycle'] = 'enrolled',
): LocalAiTargetStatus {
  const layers: LocalAiTargetStatus['layers'] = {};
  for (const [layer, failureCode] of Object.entries(failures) as [LocalAiHealthLayer, LocalAiFailureCode][]) {
    layers[layer] = {
      targetId, layer, checkType: 'lightweight', ok: false, required: true,
      affectedRoles: [], checkedAt: 1, durationMs: 1, failureCode, evidence: {},
    };
  }
  return {
    targetId, lifecycle, state, routableRoles: [], layers,
    consecutiveFailures: 1, consecutiveSuccesses: 0, flapping: false, checkedAt: 1,
  };
}

describe('LocalAiStatusChipComponent', () => {
  const initialized = signal(true);
  const hasAuthoritativeSnapshot = signal(true);
  const currentAggregate = signal(aggregate('not-configured'));
  const helperPauses = signal<import('../../../../shared/types/auxiliary-llm.types').AuxiliaryHelperPause[]>([]);
  const store = {
    isInitialized: initialized.asReadonly(),
    hasAuthoritativeSnapshot: hasAuthoritativeSnapshot.asReadonly(),
    aggregate: currentAggregate.asReadonly(),
    helperBudget: signal(undefined).asReadonly(),
    helperPauses: helperPauses.asReadonly(),
    targets: signal<LocalAiTargetStatus[]>([]),
  };
  const router = { navigateByUrl: vi.fn(async () => true) };

  beforeEach(() => {
    TestBed.resetTestingModule();
    vi.clearAllMocks();
    initialized.set(true);
    hasAuthoritativeSnapshot.set(true);
    currentAggregate.set(aggregate('not-configured'));
    helperPauses.set([]);
    store.targets.set([]);
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

  it('says why every unwell target is unavailable, using the first failed check', () => {
    currentAggregate.set(aggregate('unavailable', 2));
    store.targets.set([
      target('a', 'unavailable', { model: 'insufficient-context' }),
      target('b', 'unavailable', { model: 'insufficient-context' }),
      target('old', 'unavailable', { worker: 'worker-offline' }, 'retired'),
    ]);
    const fixture = TestBed.createComponent(LocalAiStatusChipComponent);
    fixture.detectChanges();
    const button = fixture.nativeElement.querySelector('button') as HTMLButtonElement;
    expect(button.textContent).toContain('Local AI: Unavailable, model context too small');
    expect(button.getAttribute('aria-label')).toBe(
      'Local AI Guard: Unavailable, model context too small. 2 enrolled targets. Open Local AI health centre.',
    );

    store.targets.set([target('a', 'unavailable', { worker: 'worker-offline', endpoint: 'endpoint-timeout' })]);
    fixture.detectChanges();
    expect(button.textContent).toContain('Local AI: Unavailable, remote computer offline');
  });

  it('keeps the plain state when unwell targets fail for different reasons', () => {
    currentAggregate.set(aggregate('unavailable', 2));
    store.targets.set([
      target('a', 'unavailable', { model: 'insufficient-context' }),
      target('b', 'unavailable', { endpoint: 'connection-refused' }),
    ]);
    const fixture = TestBed.createComponent(LocalAiStatusChipComponent);
    fixture.detectChanges();
    const text = (fixture.nativeElement.querySelector('button') as HTMLButtonElement).textContent ?? '';
    expect(text).toContain('Local AI: Unavailable');
    expect(text).not.toContain(',');
  });

  it('preserves the complete helper pause explanation and name on the real directive', () => {
    helperPauses.set([{ slot: 'compression', pausedUntil: Date.now() + 60_000, failures: 2,
      startedAt: Date.now(), reason: 'Paused until retry after 2 failures' }]);
    const fixture = TestBed.createComponent(LocalAiStatusChipComponent); fixture.detectChanges();
    const button = fixture.debugElement.query(By.css('button'));
    const tip = button.injector.get(AioTooltipDirective).appTooltip();
    expect(button.nativeElement.hasAttribute('title')).toBe(false);
    expect(tip).toBe(button.nativeElement.getAttribute('aria-label'));
    expect(tip).toContain('compression: Paused until retry after 2 failures. Open Local AI health centre.');
    const element = button.nativeElement as HTMLElement;
    const matches = element.matches.bind(element);
    vi.spyOn(element, 'matches').mockImplementation(selector => selector === ':focus-visible' || matches(selector));
    element.dispatchEvent(new FocusEvent('focus')); fixture.detectChanges();
    expect(document.querySelector('[role="tooltip"]')?.textContent).toContain(tip);
  });

  it('hides the chip while every target is healthy', () => {
    currentAggregate.set(aggregate('healthy', 2));
    const fixture = TestBed.createComponent(LocalAiStatusChipComponent);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('button')).toBeNull();

    currentAggregate.set(aggregate('degraded', 2));
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('button')).not.toBeNull();
  });

  it('still shows a healthy aggregate when helpers are paused', () => {
    currentAggregate.set(aggregate('healthy', 1));
    helperPauses.set([{ slot: 'compression', pausedUntil: Date.now() + 60_000, failures: 2, startedAt: Date.now(), reason: 'Paused until retry after 2 failures' }]);
    const fixture = TestBed.createComponent(LocalAiStatusChipComponent);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('button')?.dataset['state']).toBe('degraded');
  });

  it('shows helper pauses and lists the affected types and reason', () => {
    const at = Date.now() + 60_000;
    helperPauses.set([{ slot: 'compression', pausedUntil: at, failures: 2, startedAt: Date.now(), reason: 'Paused until retry after 2 failures' }]);
    const fixture = TestBed.createComponent(LocalAiStatusChipComponent); fixture.detectChanges();
    const button = fixture.nativeElement.querySelector('button') as HTMLButtonElement;
    expect(button.textContent).toContain('Local AI: helpers paused until');
    expect(fixture.debugElement.query(By.css('button')).injector.get(AioTooltipDirective).appTooltip()).toContain('compression: Paused until retry after 2 failures');
  });

  it('is hidden until initialization completes', () => {
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
    currentAggregate.set(aggregate('degraded', 1));
    const fixture = TestBed.createComponent(LocalAiStatusChipComponent);
    fixture.detectChanges();

    const button = fixture.nativeElement.querySelector('button') as HTMLButtonElement;
    expect(button.textContent).toContain('1 target');
    expect(button.getAttribute('aria-label')).toContain('1 enrolled target.');
  });

  it('shows a helper retry deadline and its reason without calling the target paused', () => {
    currentAggregate.set(aggregate('healthy', 1));
    helperPauses.set([{
      slot: 'compression', pausedUntil: Date.now() + 60_000, failures: 2,
      startedAt: Date.now(), reason: 'Paused after 2 failures',
    }]);
    const fixture = TestBed.createComponent(LocalAiStatusChipComponent);
    fixture.detectChanges();

    const button = fixture.nativeElement.querySelector('button') as HTMLButtonElement;
    expect(button.textContent).toContain('helpers paused until');
    expect(button.dataset['state']).toBe('degraded');
    expect(button.getAttribute('aria-label')).toContain('compression: Paused after 2 failures');
  });
});
