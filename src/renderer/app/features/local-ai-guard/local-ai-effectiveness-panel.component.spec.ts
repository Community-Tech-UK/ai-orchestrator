import {
  ɵresolveComponentResources as resolveComponentResources,
} from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  LocalAiEffectivenessSummary,
  LocalAiTarget,
} from '../../../../shared/types/local-ai-guard.types';
import { LocalAiGuardStore } from '../../core/state/local-ai-guard.store';
import { LocalAiEffectivenessPanelComponent } from './local-ai-effectiveness-panel.component';

const specDirectory = dirname(fileURLToPath(import.meta.url));

await resolveComponentResources((url) => {
  const resource = url.split('/').at(-1);
  if (
    resource === 'local-ai-effectiveness-panel.component.html'
    || resource === 'local-ai-effectiveness-panel.component.scss'
  ) {
    return Promise.resolve(readFileSync(resolve(specDirectory, resource), 'utf8'));
  }
  if (url.endsWith('.html') || url.endsWith('.scss')) return Promise.resolve('');
  return Promise.reject(new Error(`Unexpected resource: ${url}`));
});

function summary(
  overrides: Partial<LocalAiEffectivenessSummary> = {},
): LocalAiEffectivenessSummary {
  return {
    window: '24h',
    localTasks: 3,
    localTokens: 12_500,
    proposedFallbacks: 2,
    allowedFallbacks: 1,
    deferredFallbacks: 1,
    blockedFallbacks: 0,
    knownCostUsd: 1.25,
    estimatedCostUsd: 0.75,
    unpricedDispatchCount: 0,
    avoidedEstimatedTokens: 9_000,
    avoidedEstimatedCostUsd: 2.5,
    byTarget: { 'target-1': 4, 'target-2': 1 },
    byModel: { 'qwen3:14b': 3, 'claude-sonnet': 2 },
    bySlot: { compression: 4, titleGeneration: 1 },
    byIncident: { 'incident-1': 2 },
    ...overrides,
  };
}

describe('LocalAiEffectivenessPanelComponent', () => {
  const store = {
    effectiveness: vi.fn((): LocalAiEffectivenessSummary | null => summary()),
    effectivenessWindow: vi.fn((): LocalAiEffectivenessSummary['window'] => '24h'),
    effectivenessLoading: vi.fn(() => false),
    effectivenessError: vi.fn((): string | null => null),
    loadEffectiveness: vi.fn(async () => undefined),
    knownTarget: vi.fn((targetId: string): LocalAiTarget | null =>
      targetId === 'target-1'
        ? ({ id: targetId, label: 'Studio endpoint' } as LocalAiTarget)
        : null),
  };
  let fixture: ComponentFixture<LocalAiEffectivenessPanelComponent>;

  beforeEach(async () => {
    vi.clearAllMocks();
    store.effectiveness.mockReturnValue(summary());
    store.effectivenessWindow.mockReturnValue('24h');
    store.effectivenessLoading.mockReturnValue(false);
    store.effectivenessError.mockReturnValue(null);
    await TestBed.configureTestingModule({
      imports: [LocalAiEffectivenessPanelComponent],
      providers: [{ provide: LocalAiGuardStore, useValue: store }],
    }).compileComponents();
    fixture = TestBed.createComponent(LocalAiEffectivenessPanelComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  });

  it('renders the local completion rate, exact totals, and separately labelled cost classes', () => {
    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('60%');
    expect(text).toContain('3 of 5 eligible tasks');
    expect(text).toContain('3 local tasks');
    expect(text).toContain('12,500 local tokens');
    expect(text).toContain('2 proposed');
    expect(text).toContain('1 allowed');
    expect(text).toContain('1 deferred');
    expect(text).toContain('0 blocked');
    expect(text).toContain('$1.25 measured cloud cost');
    expect(text).toContain('$0.75 estimated cloud cost');
    expect(text).toContain('9,000 estimated avoided tokens');
    expect(text).toContain('$2.50 estimated avoided cost');
  });

  it('preserves exact sub-cent measured, estimated, and avoided-estimated costs', async () => {
    store.effectiveness.mockReturnValue(summary({
      knownCostUsd: 0.004,
      estimatedCostUsd: 0.018,
      avoidedEstimatedCostUsd: 0.025,
    }));
    await recreate();

    const costText = costMetricText();
    expect(costText).toEqual([
      '$0.004 measured cloud cost',
      '$0.018 estimated cloud cost',
      '9,000 estimated avoided tokens',
      '$0.025 estimated avoided cost',
    ]);
    expect(costText.join(' ')).not.toMatch(/\$0\.00 measured|\$0\.02 estimated|\$0\.03 estimated avoided/);
  });

  it('keeps normal cents readable, removes binary tails, and never displays a tiny nonzero cost as zero', async () => {
    store.effectiveness.mockReturnValue(summary({
      knownCostUsd: 1.25,
      estimatedCostUsd: 0.1 + 0.2,
      avoidedEstimatedCostUsd: 1e-21,
    }));
    await recreate();

    const costText = costMetricText();
    expect(costText[0]).toBe('$1.25 measured cloud cost');
    expect(costText[1]).toBe('$0.30 estimated cloud cost');
    expect(costText[3]).toBe('$1e-21 estimated avoided cost');
    expect(costText.join(' ')).not.toContain('0.30000000000000004');
    expect(costText[3]).not.toContain('$0.00');
  });

  it('distinguishes zero from fixed-point and scientific tiny-value boundaries', async () => {
    store.effectiveness.mockReturnValue(summary({
      knownCostUsd: 0,
      estimatedCostUsd: 1e-20,
      avoidedEstimatedCostUsd: 1e-21,
    }));
    await recreate();

    const costText = costMetricText();
    expect(costText[0]).toBe('$0.00 measured cloud cost');
    expect(costText[1]).toBe('$0.00000000000000000001 estimated cloud cost');
    expect(costText[3]).toBe('$1e-21 estimated avoided cost');
  });

  it('LT-193: shows the unpriced-dispatch metric only when it is nonzero, and it never claims zero cost', async () => {
    expect(fixture.nativeElement.querySelector('.unpriced')).toBeNull();

    store.effectiveness.mockReturnValue(summary({
      knownCostUsd: 0,
      estimatedCostUsd: 0,
      unpricedDispatchCount: 7,
    }));
    await recreate();

    const unpriced = fixture.nativeElement.querySelector('.unpriced') as HTMLElement | null;
    expect(unpriced).not.toBeNull();
    expect(unpriced?.textContent).toContain('7 unpriced');
    expect(unpriced?.textContent).toContain('cost unknown, not zero');
  });

  it('gives every visual an accessible text equivalent and renders every breakdown', () => {
    const visuals = Array.from(
      fixture.nativeElement.querySelectorAll('[data-effectiveness-visual]') as
        NodeListOf<HTMLElement>,
    );
    expect(visuals.length).toBeGreaterThan(0);
    for (const visual of visuals) {
      expect(visual.getAttribute('aria-label')).toBeTruthy();
      expect(visual.textContent?.trim()).not.toBe('');
    }

    expect(fixture.nativeElement.textContent).toContain('Studio endpoint');
    click('Models');
    expect(fixture.nativeElement.textContent).toContain('qwen3:14b');
    click('Helper slots');
    expect(fixture.nativeElement.textContent).toContain('Compression');
    click('Incidents');
    expect(fixture.nativeElement.textContent).toContain('incident-1');
  });

  it('queries each time window without mutating target or incident state', async () => {
    const targetBefore = store.knownTarget('target-1');

    click('7 days');
    await fixture.whenStable();
    click('30 days');
    await fixture.whenStable();

    expect(store.loadEffectiveness.mock.calls).toEqual([['24h'], ['7d'], ['30d']]);
    expect(store.knownTarget('target-1')).toEqual(targetBefore);
  });

  it('renders loading, unavailable, and genuinely empty states', async () => {
    store.effectivenessLoading.mockReturnValue(true);
    store.effectiveness.mockReturnValue(null);
    await recreate();
    expect(fixture.nativeElement.textContent).toContain('Loading effectiveness');

    store.effectivenessLoading.mockReturnValue(false);
    store.effectivenessError.mockReturnValue('Effectiveness data could not be loaded.');
    await recreate();
    expect(fixture.nativeElement.textContent).toContain('Effectiveness data unavailable');

    store.effectivenessError.mockReturnValue(null);
    store.effectiveness.mockReturnValue(summary({
      localTasks: 0,
      localTokens: 0,
      proposedFallbacks: 0,
      allowedFallbacks: 0,
      deferredFallbacks: 0,
      knownCostUsd: 0,
      estimatedCostUsd: 0,
      avoidedEstimatedTokens: 0,
      avoidedEstimatedCostUsd: 0,
      byTarget: {},
      byModel: {},
      bySlot: {},
      byIncident: {},
    }));
    await recreate();
    expect(fixture.nativeElement.textContent).toContain('No eligible Local AI work in this period');
  });

  function click(label: string): void {
    const button = Array.from(
      fixture.nativeElement.querySelectorAll('button') as NodeListOf<HTMLButtonElement>,
    ).find((candidate) => candidate.textContent?.trim() === label);
    if (!button) throw new Error(`Missing button: ${label}`);
    button.click();
    fixture.detectChanges();
  }

  async function recreate(): Promise<void> {
    fixture.destroy();
    fixture = TestBed.createComponent(LocalAiEffectivenessPanelComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  }

  function costMetricText(): string[] {
    return Array.from(
      fixture.nativeElement.querySelectorAll('.cost-metrics dd') as
        NodeListOf<HTMLElement>,
    ).map((element) => element.textContent?.trim() ?? '');
  }
});
