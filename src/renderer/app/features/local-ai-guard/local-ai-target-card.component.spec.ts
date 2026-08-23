import { ComponentFixture, TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  LocalAiIncident,
  LocalAiTargetStatus,
} from '../../../../shared/types/local-ai-guard.types';
import { LocalAiGuardStore } from '../../core/state/local-ai-guard.store';
import { LocalAiTargetCardComponent } from './local-ai-target-card.component';

const NOW = 10_000;

function status(): LocalAiTargetStatus {
  return {
    targetId: 'target-1',
    lifecycle: 'enrolled',
    state: 'healthy',
    routableRoles: ['compression'],
    layers: {},
    consecutiveFailures: 0,
    consecutiveSuccesses: 3,
    flapping: false,
    checkedAt: NOW - 1_000,
  };
}

function incident(overrides: Partial<LocalAiIncident> = {}): LocalAiIncident {
  return {
    id: 'incident-1',
    targetId: 'target-1',
    state: 'open',
    severity: 'warning',
    failureCode: 'configuration-drift',
    affectedLayers: ['model'],
    affectedRoles: ['compression'],
    openedAt: NOW - 5_000,
    updatedAt: NOW - 2_000,
    fallbackCount: 2,
    knownCostUsd: 0,
    estimatedCostUsd: 0,
    unpricedDispatchCount: 0,
    ...overrides,
  };
}

describe('LocalAiTargetCardComponent', () => {
  const store = {
    operationKey: vi.fn((): string | null => null),
    operationError: vi.fn((): boolean => false),
    recoveryAttempts: vi.fn((): unknown[] => []),
    repairFor: vi.fn(() => null),
  };
  let fixture: ComponentFixture<LocalAiTargetCardComponent>;

  beforeEach(() => {
    vi.clearAllMocks();
    store.operationKey.mockReturnValue(null);
    store.operationError.mockReturnValue(false);
    store.recoveryAttempts.mockReturnValue([]);
    store.repairFor.mockReturnValue(null);
    TestBed.configureTestingModule({
      imports: [LocalAiTargetCardComponent],
      providers: [{ provide: LocalAiGuardStore, useValue: store }],
    });
    fixture = TestBed.createComponent(LocalAiTargetCardComponent);
    fixture.componentRef.setInput('status', status());
    fixture.componentRef.setInput('now', NOW);
  });

  function fallbackImpactText(): string {
    fixture.detectChanges();
    const strongs = Array.from(
      fixture.nativeElement.querySelectorAll('.evidence-summary strong') as
        NodeListOf<HTMLElement>,
    );
    // "Fallback impact" is the fourth summary tile.
    return strongs[3]?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
  }

  it('renders a priced total plainly when every dispatch was priced', () => {
    fixture.componentRef.setInput('incidents', [incident({ knownCostUsd: 1.5 })]);
    expect(fallbackImpactText()).toBe('2 paid fallbacks · $1.50 measured');
  });

  it('LT-193: distinguishes an unpriced dispatch from a zero-cost one', () => {
    fixture.componentRef.setInput('incidents', [
      incident({ knownCostUsd: 0, estimatedCostUsd: 0, unpricedDispatchCount: 3 }),
    ]);
    const text = fallbackImpactText();
    expect(text).toBe('2 paid fallbacks · cost unknown (3 unpriced)');
    expect(text).not.toContain('$0');
  });

  it('LT-193: appends the unpriced count to a priced total rather than hiding it', () => {
    fixture.componentRef.setInput('incidents', [
      incident({ knownCostUsd: 0.75, unpricedDispatchCount: 2 }),
    ]);
    expect(fallbackImpactText()).toBe('2 paid fallbacks · $0.75 measured + 2 unpriced');
  });

  it('renders "no recorded cost" only when nothing at all was unpriced or priced', () => {
    fixture.componentRef.setInput('incidents', [incident()]);
    expect(fallbackImpactText()).toBe('2 paid fallbacks · no recorded cost');
  });
});
