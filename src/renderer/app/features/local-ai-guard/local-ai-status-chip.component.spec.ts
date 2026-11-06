import { signal } from '@angular/core';
import { By } from '@angular/platform-browser';
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
import { AioTooltipDirective } from '../../shared/tooltip/aio-tooltip.directive';
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
  const error = signal<string | null>(null);
  const helperPauses = signal<import('../../../../shared/types/auxiliary-llm.types').AuxiliaryHelperPause[]>([]);
  const helperBudget = signal<{ resetsAt: number } | undefined>(undefined);
  const store = {
    isInitialized: initialized.asReadonly(),
    hasAuthoritativeSnapshot: hasAuthoritativeSnapshot.asReadonly(),
    aggregate: currentAggregate.asReadonly(),
    error: error.asReadonly(),
    helperBudget: helperBudget.asReadonly(),
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
    error.set(null);
    helperPauses.set([]);
    helperBudget.set(undefined);
    store.targets.set([]);
    TestBed.configureTestingModule({
      imports: [LocalAiStatusChipComponent],
      providers: [
        { provide: LocalAiGuardStore, useValue: store },
        { provide: Router, useValue: router },
      ],
    });
  });

  function render() {
    const fixture = TestBed.createComponent(LocalAiStatusChipComponent);
    fixture.detectChanges();
    const button = fixture.nativeElement.querySelector('button') as HTMLButtonElement | null;
    const tooltip = button
      ? fixture.debugElement.query(By.directive(AioTooltipDirective)).injector.get(AioTooltipDirective).appTooltip()
      : null;
    return { fixture, button, tooltip };
  }

  it.each(['not-configured', 'healthy'] as const)('shows nothing while the local models are %s', (state) => {
    currentAggregate.set(aggregate(state, state === 'not-configured' ? 0 : 2));

    const { fixture, button } = render();

    expect(button).toBeNull();
    expect(fixture.nativeElement.textContent.trim()).toBe('');
  });

  it('preserves the complete helper pause explanation on the real directive and shows it on keyboard focus', () => {
    helperPauses.set([{ slot: 'compression', pausedUntil: Date.now() + 60_000, failures: 2,
      startedAt: Date.now(), reason: 'Paused until retry after 2 failures' }]);
    const fixture = TestBed.createComponent(LocalAiStatusChipComponent); fixture.detectChanges();
    const button = fixture.debugElement.query(By.css('button'));
    const tip = button.injector.get(AioTooltipDirective).appTooltip();
    expect(button.nativeElement.hasAttribute('title')).toBe(false);
    const description = fixture.nativeElement.querySelector('[data-testid="local-ai-status-chip-description"]') as HTMLElement;
    expect(tip).toBe(description.textContent);
    expect(tip).toContain('compression: Paused until retry after 2 failures. Open Local models.');
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

  it('takes no room in the title bar while it shows nothing', () => {
    const { fixture } = render();

    expect(fixture.nativeElement.children.length).toBe(0);
    expect((fixture.nativeElement as HTMLElement).matches(':empty')).toBe(true);
  });

  it.each([
    ['checking', 'Local models: checking…', 'checking'],
    ['degraded', 'Local models: not working well', 'degraded'],
    ['unavailable', 'Local models: not reachable', 'unavailable'],
    ['paused', 'Local models: paused', 'paused'],
  ] as const)('shows the %s state in plain words', (state, text, tone) => {
    currentAggregate.set(aggregate(state, 2));

    const { button, tooltip } = render();

    expect(button?.textContent?.trim()).toBe(text);
    expect(button?.dataset['state']).toBe(tone);
    expect(tooltip).toContain('Open Local models');
  });

  it('uses one name for the feature and none of the old three', () => {
    for (const state of ['checking', 'degraded', 'unavailable', 'paused'] as const) {
      currentAggregate.set(aggregate(state, 1));
      TestBed.resetTestingModule();
      TestBed.configureTestingModule({
        imports: [LocalAiStatusChipComponent],
        providers: [{ provide: LocalAiGuardStore, useValue: store }, { provide: Router, useValue: router }],
      });
      const { button, tooltip } = render();
      const spoken = `${button?.textContent} ${tooltip}`;
      expect(spoken).not.toMatch(/Local AI|Guard|health cent(re|er)|target/i);
      expect(spoken).toContain('Local models');
    }
  });

  it('says in plain words when helpers are paused and until when', () => {
    helperPauses.set([{
      slot: 'compression',
      pausedUntil: new Date(2026, 9, 20, 14, 20).getTime(),
      failures: 2,
      startedAt: Date.now(),
      reason: 'Paused until retry after 2 failures',
    }]);

    const { button, tooltip } = render();

    expect(button?.textContent?.trim()).toBe('Local helpers paused until 14:20');
    expect(tooltip).toContain('compression: Paused until retry after 2 failures');
    expect(button?.dataset['state']).toBe('degraded');
  });

  it('keeps the detail a screen reader needs as a real description, not only a hover tooltip', () => {
    helperPauses.set([{
      slot: 'compression',
      pausedUntil: new Date(2026, 9, 20, 14, 20).getTime(),
      failures: 2,
      startedAt: Date.now(),
      reason: 'Paused until retry after 2 failures',
    }]);

    const { fixture, button } = render();

    // The button is named by its visible text; the longer sentence is its description.
    expect(button?.getAttribute('aria-label')).toBeNull();
    const describedBy = button?.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    const description = fixture.nativeElement.querySelector(`#${describedBy}`) as HTMLElement | null;
    expect(description?.textContent).toContain('compression: Paused until retry after 2 failures');
    expect(description?.textContent).toContain('Open Local models.');
    // And it is not part of the button, so the button's own text stays the short label.
    expect(button?.textContent?.trim()).toBe('Local helpers paused until 14:20');
  });

  it('takes the description away with the chip when the pause ends', () => {
    helperPauses.set([{
      slot: 'compression',
      pausedUntil: new Date(2026, 9, 20, 14, 20).getTime(),
      failures: 2,
      startedAt: Date.now(),
      reason: 'Paused until retry after 2 failures',
    }]);
    const { fixture } = render();
    expect(fixture.nativeElement.querySelector('[data-testid="local-ai-status-chip-description"]')).not.toBeNull();

    helperPauses.set([]);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('button')).toBeNull();
    expect(fixture.nativeElement.querySelector('[data-testid="local-ai-status-chip-description"]')).toBeNull();
    expect(fixture.nativeElement.textContent.trim()).toBe('');
  });

  it('shows helper pauses and lists the affected types and reason', () => {
    const at = Date.now() + 60_000;
    helperPauses.set([{ slot: 'compression', pausedUntil: at, failures: 2, startedAt: Date.now(), reason: 'Paused until retry after 2 failures' }]);
    const fixture = TestBed.createComponent(LocalAiStatusChipComponent); fixture.detectChanges();
    const button = fixture.nativeElement.querySelector('button') as HTMLButtonElement;
    expect(button.textContent).toContain('Local helpers paused until');
    expect(fixture.debugElement.query(By.css('button')).injector.get(AioTooltipDirective).appTooltip()).toContain('compression: Paused until retry after 2 failures');
  });

  it('shows a pause even when the models themselves are healthy', () => {
    currentAggregate.set(aggregate('healthy', 1));
    helperPauses.set([{
      slot: 'compression',
      pausedUntil: new Date(2026, 9, 20, 9, 5).getTime(),
      failures: 1,
      startedAt: Date.now(),
      reason: 'Slow',
    }]);

    const { button } = render();

    expect(button?.textContent?.trim()).toBe('Local helpers paused until 09:05');
  });

  it('says why every unwell target is unavailable, using the first failed check', () => {
    currentAggregate.set(aggregate('unavailable', 2));
    store.targets.set([
      target('a', 'unavailable', { model: 'insufficient-context' }),
      target('b', 'unavailable', { model: 'insufficient-context' }),
      target('old', 'unavailable', { worker: 'worker-offline' }, 'retired'),
    ]);
    const { fixture, button, tooltip } = render();
    expect(button?.textContent?.trim()).toBe('Local models: model context too small');
    expect(tooltip).toBe('Some of your local models are unavailable. Model context too small. Open Local models.');

    store.targets.set([target('a', 'unavailable', { worker: 'worker-offline', endpoint: 'endpoint-timeout' })]);
    fixture.detectChanges();
    expect(button?.textContent?.trim()).toBe('Local models: remote computer offline');
  });

  it('keeps the plain state when unwell targets fail for different reasons', () => {
    currentAggregate.set(aggregate('unavailable', 2));
    store.targets.set([
      target('a', 'unavailable', { model: 'insufficient-context' }),
      target('b', 'unavailable', { endpoint: 'connection-refused' }),
    ]);

    const { button } = render();

    expect(button?.textContent?.trim()).toBe('Local models: not reachable');
  });

  it('shows the helper models\' daily limit even while the models themselves are healthy', () => {
    currentAggregate.set(aggregate('healthy', 1));
    helperBudget.set({ resetsAt: Date.now() + 60_000 });

    const { button, tooltip } = render();

    expect(button?.textContent?.trim()).toBe('Local helpers: daily limit reached');
    expect(button?.dataset['state']).toBe('degraded');
    expect(tooltip).toBe('Helper models: daily limit reached. Paid fallbacks resume tomorrow. Open Local models.');

    helperBudget.set(undefined);
  });

  it('says the daily limit beside another state instead of hiding behind it', () => {
    currentAggregate.set(aggregate('unavailable', 1));
    helperBudget.set({ resetsAt: Date.now() + 60_000 });

    const { button, tooltip } = render();

    expect(button?.textContent?.trim()).toBe('Local models: not reachable · daily limit reached');
    expect(button?.dataset['state']).toBe('unavailable');
    expect(tooltip).toContain('Paid fallbacks resume tomorrow.');
  });

  it('is hidden only until initialization completes', () => {
    currentAggregate.set(aggregate('degraded', 1));
    initialized.set(false);
    const fixture = TestBed.createComponent(LocalAiStatusChipComponent);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('button')).toBeNull();

    initialized.set(true);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('button')).not.toBeNull();
  });

  it('says it could not check, with a reason, instead of calling something unchecked unavailable', () => {
    hasAuthoritativeSnapshot.set(false);

    const { button, tooltip } = render();

    expect(button?.textContent?.trim()).toBe("Local models: couldn't check");
    expect(button?.textContent).not.toMatch(/unavailable|not configured/i);
    expect(tooltip).toBe("Couldn't check your local models. Harness couldn't read their status. Open Local models.");
    expect(button?.dataset['state']).toBe('unavailable');
  });

  it('never prints text the store holds, even if it holds something private', () => {
    hasAuthoritativeSnapshot.set(false);
    error.set('private://token=secret');

    const { button, tooltip } = render();

    expect(`${button?.textContent} ${tooltip}`).not.toContain('token=secret');
  });

  it('opens the Local models page', () => {
    currentAggregate.set(aggregate('degraded', 1));
    const { button } = render();

    button?.click();

    expect(router.navigateByUrl).toHaveBeenCalledExactlyOnceWith('/local-ai');
  });

  it('keeps the test id the focus-return logic and the root shell rely on', () => {
    currentAggregate.set(aggregate('degraded', 1));

    const { button } = render();

    expect(button?.dataset['testid']).toBe('local-ai-status-chip');
  });
});
