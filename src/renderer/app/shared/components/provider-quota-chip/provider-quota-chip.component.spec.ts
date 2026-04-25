/**
 * Unit tests for ProviderQuotaChipComponent.
 *
 * Covers:
 * - Empty state rendering (no snapshots)
 * - Plan-tier rendering (snapshots exist but no numerical windows)
 * - Worst-window rendering (numerical windows present)
 * - Colour banding by ratio (green / yellow / orange / red)
 * - Reset-time formatting (resets in Xh Ym)
 * - Calls store.initialize() on construction
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { signal, computed } from '@angular/core';
import { ProviderQuotaChipComponent } from './provider-quota-chip.component';
import { ProviderQuotaStore } from '../../../core/state/provider-quota.store';
import type {
  ProviderId,
  ProviderQuotaSnapshot,
  ProviderQuotaWindow,
} from '../../../../../shared/types/provider-quota.types';

/** Minimal store stub — replaces the real one for testing. */
class FakeProviderQuotaStore {
  readonly initialize = vi.fn(async () => { /* noop */ });
  private worst = signal<{ provider: ProviderId; window: ProviderQuotaWindow } | null>(null);
  private snaps = signal<Record<ProviderId, ProviderQuotaSnapshot | null>>({
    claude: null, codex: null, gemini: null, copilot: null,
  });

  readonly mostConstrainedWindow = computed(() => this.worst());
  readonly snapshots = computed(() => this.snaps());

  setWorst(value: { provider: ProviderId; window: ProviderQuotaWindow } | null): void {
    this.worst.set(value);
  }
  setSnapshot(provider: ProviderId, snap: ProviderQuotaSnapshot | null): void {
    this.snaps.update((s) => ({ ...s, [provider]: snap }));
  }
}

function makeWindow(used: number, limit: number, resetsAt: number | null = null): ProviderQuotaWindow {
  return {
    kind: 'rolling-window',
    id: 'claude.5h-messages',
    label: '5-hour messages',
    unit: 'messages',
    used,
    limit,
    remaining: Math.max(0, limit - used),
    resetsAt,
  };
}

function makeSnapshot(provider: ProviderId, plan: string | undefined, ok = true): ProviderQuotaSnapshot {
  return {
    provider,
    takenAt: Date.now(),
    source: 'cli-result',
    ok,
    plan,
    windows: [],
  };
}

describe('ProviderQuotaChipComponent', () => {
  let fixture: ComponentFixture<ProviderQuotaChipComponent>;
  let component: ProviderQuotaChipComponent;
  let store: FakeProviderQuotaStore;

  beforeEach(async () => {
    store = new FakeProviderQuotaStore();
    await TestBed.configureTestingModule({
      imports: [ProviderQuotaChipComponent],
      providers: [{ provide: ProviderQuotaStore, useValue: store }],
    }).compileComponents();

    fixture = TestBed.createComponent(ProviderQuotaChipComponent);
    component = fixture.componentInstance;
  });

  describe('lifecycle', () => {
    it('calls store.initialize() on init', () => {
      fixture.detectChanges();
      expect(store.initialize).toHaveBeenCalledTimes(1);
    });
  });

  describe('empty state', () => {
    it('renders a placeholder when no snapshots exist', () => {
      fixture.detectChanges();
      const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
      expect(text).toMatch(/—|no quota|—/);
    });

    it('reports empty mode in the variant signal', () => {
      fixture.detectChanges();
      expect(component.variant()).toBe('empty');
    });
  });

  describe('plan-tier mode (snapshot ok but no windows)', () => {
    beforeEach(() => {
      store.setSnapshot('claude', makeSnapshot('claude', 'max'));
      fixture.detectChanges();
    });

    it('reports plan mode in the variant signal', () => {
      expect(component.variant()).toBe('plan');
    });

    it('shows the provider name and plan tier', () => {
      const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
      expect(text.toLowerCase()).toContain('claude');
      expect(text.toLowerCase()).toContain('max');
    });
  });

  describe('numerical-window mode', () => {
    it('shows used/limit when within the green band (<50%)', () => {
      store.setWorst({ provider: 'claude', window: makeWindow(10, 100) });
      fixture.detectChanges();
      const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
      expect(text).toContain('10');
      expect(text).toContain('100');
      expect(component.colourBand()).toBe('green');
    });

    it('uses yellow band for 50–74%', () => {
      store.setWorst({ provider: 'claude', window: makeWindow(60, 100) });
      fixture.detectChanges();
      expect(component.colourBand()).toBe('yellow');
    });

    it('uses orange band for 75–89%', () => {
      store.setWorst({ provider: 'claude', window: makeWindow(80, 100) });
      fixture.detectChanges();
      expect(component.colourBand()).toBe('orange');
    });

    it('uses red band for 90% and above', () => {
      store.setWorst({ provider: 'claude', window: makeWindow(95, 100) });
      fixture.detectChanges();
      expect(component.colourBand()).toBe('red');
    });

    it('reports window mode in the variant signal', () => {
      store.setWorst({ provider: 'claude', window: makeWindow(50, 100) });
      fixture.detectChanges();
      expect(component.variant()).toBe('window');
    });

    it('renders a "resets in" hint when resetsAt is in the future', () => {
      const inTwoHours = Date.now() + 2 * 60 * 60 * 1000;
      store.setWorst({ provider: 'claude', window: makeWindow(50, 100, inTwoHours) });
      fixture.detectChanges();
      const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
      expect(text.toLowerCase()).toMatch(/resets|reset/);
    });

    it('does not render reset hint when resetsAt is null', () => {
      store.setWorst({ provider: 'claude', window: makeWindow(50, 100, null) });
      fixture.detectChanges();
      const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
      expect(text.toLowerCase()).not.toMatch(/resets/);
    });
  });

  describe('priority — window mode wins over plan mode', () => {
    it('shows the worst window when both windows and plan-only snapshots exist', () => {
      store.setSnapshot('copilot', makeSnapshot('copilot', 'unknown'));
      store.setWorst({ provider: 'claude', window: makeWindow(60, 100) });
      fixture.detectChanges();
      expect(component.variant()).toBe('window');
    });
  });
});
