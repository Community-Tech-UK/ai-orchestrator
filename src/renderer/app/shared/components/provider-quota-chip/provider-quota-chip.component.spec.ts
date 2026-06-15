/**
 * Unit tests for ProviderQuotaChipComponent.
 *
 * Covers:
 * - Empty state rendering (no snapshots)
 * - Plan-tier rendering (snapshots exist but no numerical windows)
 * - Worst-window rendering (numerical windows present)
 * - Colour banding by ratio (green / yellow / orange / red)
 * - Reset-time formatting (resets in Xd Yh Zm)
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
  readonly refresh = vi.fn(async () => { /* noop */ });
  private worst = signal<{ provider: ProviderId; window: ProviderQuotaWindow } | null>(null);
  private snaps = signal<Record<ProviderId, ProviderQuotaSnapshot | null>>({
    claude: null, codex: null, gemini: null, copilot: null, cursor: null,
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

function makeSnapshot(
  provider: ProviderId,
  plan: string | undefined,
  ok = true,
  windows: ProviderQuotaWindow[] = [],
  takenAt = Date.now(),
): ProviderQuotaSnapshot {
  return {
    provider,
    takenAt,
    source: 'cli-result',
    ok,
    plan,
    windows,
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
      expect(text).toContain('CC');
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

    it('formats reset durations over 24 hours as days and remaining hours', () => {
      const now = 1_700_000_000_000;
      (component as unknown as { nowMs: { set(value: number): void } }).nowMs.set(now);
      const resetsAt = now + ((4 * 24 + 9) * 60 + 33) * 60_000;
      const weeklyWindow = makeWindow(18, 100, resetsAt);
      store.setSnapshot('claude', makeSnapshot('claude', 'max', true, [weeklyWindow]));
      store.setWorst({ provider: 'claude', window: weeklyWindow });
      fixture.detectChanges();

      const host = fixture.nativeElement as HTMLElement;
      const button = host.querySelector('button[data-testid="quota-toggle"]') as HTMLButtonElement;
      button.click();
      fixture.detectChanges();

      const popoverText = host.querySelector('[data-testid="quota-popover"]')?.textContent ?? '';
      expect(popoverText).toContain('resets in 4d 9h 33m');
      expect(popoverText).not.toContain('105h 33m');
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

  describe('strip and popover', () => {
    it('renders one compact provider entry per snapshot and opens details on click', () => {
      store.setSnapshot('claude', makeSnapshot('claude', 'max', true, [makeWindow(95, 100)]));
      store.setSnapshot('codex', makeSnapshot('codex', 'plus', true, [
        { ...makeWindow(4, 100), id: 'codex.weekly', label: 'Codex weekly' },
      ]));
      store.setSnapshot('gemini', makeSnapshot('gemini', 'personal', true, [
        { ...makeWindow(3, 100), id: 'gemini.daily', label: 'Gemini daily' },
      ]));
      store.setSnapshot('copilot', makeSnapshot('copilot', 'pro', true, [
        { ...makeWindow(2, 100), id: 'copilot.monthly', label: 'Copilot monthly' },
      ]));
      store.setSnapshot('cursor', makeSnapshot('cursor', 'pro', true, [
        { ...makeWindow(1, 100), id: 'cursor.included', label: 'Cursor included' },
      ]));
      store.setWorst({ provider: 'claude', window: makeWindow(95, 100) });
      fixture.detectChanges();

      const host = fixture.nativeElement as HTMLElement;
      const entries = host.querySelectorAll('[data-testid="quota-strip"] .provider-entry');
      expect(entries).toHaveLength(5);
      expect(host.querySelector('[data-testid="quota-strip"]')?.textContent).toContain('CC');
      expect(host.querySelector('[data-testid="quota-strip"]')?.textContent).toContain('CX');
      expect(host.querySelector('[data-testid="quota-strip"]')?.textContent).toContain('GM');
      expect(host.querySelector('[data-testid="quota-strip"]')?.textContent).toContain('CP');
      expect(host.querySelector('[data-testid="quota-strip"]')?.textContent).toContain('CU');
      expect(host.querySelector('[data-testid="quota-strip"]')?.textContent).toContain('CC95%');
      expect(host.querySelector('[data-testid="quota-strip"]')?.textContent).toContain('CX4%');
      expect(host.querySelector('[data-testid="quota-strip"]')?.textContent).toContain('GM3%');
      expect(host.querySelector('[data-testid="quota-strip"]')?.textContent).toContain('CP2%');
      expect(host.querySelector('[data-testid="quota-strip"]')?.textContent).toContain('CU1%');

      const button = host.querySelector('button[data-testid="quota-toggle"]') as HTMLButtonElement;
      expect(button).toBeTruthy();
      button.click();
      fixture.detectChanges();

      const popover = host.querySelector('[data-testid="quota-popover"]');
      expect(popover?.textContent).toContain('5-hour messages');
      expect(popover?.textContent).toContain('Codex weekly');
      expect(popover?.textContent).toContain('Cursor included');
    });

    it('colors each strip entry by its own percentage rather than inheriting the worst provider color', () => {
      store.setSnapshot('claude', makeSnapshot('claude', 'max', true, [makeWindow(100, 100)]));
      store.setSnapshot('codex', makeSnapshot('codex', 'plus', true, [
        { ...makeWindow(7, 100), id: 'codex.weekly', label: 'Codex weekly' },
      ]));
      store.setSnapshot('gemini', makeSnapshot('gemini', 'personal', true, [
        { ...makeWindow(46, 100), id: 'gemini.daily', label: 'Gemini daily' },
      ]));
      store.setSnapshot('copilot', makeSnapshot('copilot', 'pro', true, [
        { ...makeWindow(83, 100), id: 'copilot.monthly', label: 'Copilot monthly' },
      ]));
      store.setSnapshot('cursor', makeSnapshot('cursor', 'pro', true, [
        { ...makeWindow(9, 100), id: 'cursor.included', label: 'Cursor included' },
      ]));
      store.setWorst({ provider: 'claude', window: makeWindow(100, 100) });
      fixture.detectChanges();

      const host = fixture.nativeElement as HTMLElement;
      const entries = Array.from(host.querySelectorAll<HTMLElement>('[data-testid="quota-strip"] .provider-entry'));
      const findEntry = (code: string) => entries.find((entry) => entry.textContent?.startsWith(code));

      const claude = findEntry('CC');
      const codex = findEntry('CX');
      const gemini = findEntry('GM');
      const copilot = findEntry('CP');
      const cursor = findEntry('CU');

      expect(claude?.style.color).toBeTruthy();
      expect(codex?.style.color).toBeTruthy();
      expect(gemini?.style.color).toBeTruthy();
      expect(copilot?.style.color).toBeTruthy();
      expect(cursor?.style.color).toBeTruthy();
      expect(codex?.style.color).not.toBe(claude?.style.color);
      expect(gemini?.style.color).not.toBe(claude?.style.color);
      expect(cursor?.style.color).not.toBe(claude?.style.color);
    });

    it('summarizes Codex by weekly usage when both 5-hour and weekly windows are present', () => {
      store.setSnapshot('codex', makeSnapshot('codex', 'plus', true, [
        { ...makeWindow(16, 100), id: 'codex.5h', label: '5-hour' },
        { ...makeWindow(8, 100), id: 'codex.weekly', label: 'Weekly' },
      ]));
      store.setWorst({ provider: 'codex', window: makeWindow(16, 100) });
      fixture.detectChanges();

      const host = fixture.nativeElement as HTMLElement;
      const stripText = host.querySelector('[data-testid="quota-strip"]')?.textContent ?? '';

      expect(stripText).toContain('CX8%');
      expect(stripText).not.toContain('CX16%');
    });

    it('summarizes Claude by weekly usage even when 5-hour or credits windows are higher', () => {
      store.setSnapshot('claude', makeSnapshot('claude', 'max', true, [
        { ...makeWindow(0, 100), id: 'claude.5h', label: '5-hour session' },
        { ...makeWindow(12, 100), id: 'claude.weekly', label: 'Weekly (all models)' },
        { ...makeWindow(0, 100), id: 'claude.weekly-sonnet', label: 'Weekly (Sonnet)' },
        { ...makeWindow(83, 100), id: 'claude.credits', label: 'Extra usage credits' },
      ]));
      store.setWorst({ provider: 'claude', window: makeWindow(83, 100) });
      fixture.detectChanges();

      const host = fixture.nativeElement as HTMLElement;
      const stripText = host.querySelector('[data-testid="quota-strip"]')?.textContent ?? '';

      expect(stripText).toContain('CC12%');
      expect(stripText).not.toContain('CC83%');
      expect(stripText).not.toContain('CC0%');
    });

    it('shows per-provider freshness and refresh controls in the detail popover', () => {
      const now = Date.now();
      (component as unknown as { nowMs: { set(value: number): void } }).nowMs.set(now);
      const fourMinutesAgo = now - 4 * 60 * 1000;
      store.setSnapshot('codex', makeSnapshot('codex', 'plus', true, [
        { ...makeWindow(4, 100), id: 'codex.weekly', label: 'Codex weekly' },
      ], fourMinutesAgo));
      fixture.detectChanges();

      const host = fixture.nativeElement as HTMLElement;
      const button = host.querySelector('button[data-testid="quota-toggle"]') as HTMLButtonElement;
      button.click();
      fixture.detectChanges();

      const detail = host.querySelector('[data-testid="quota-provider-codex"]');
      expect(detail?.textContent).toContain('updated 4m ago');
      const refresh = detail?.querySelector('button[data-testid="quota-refresh-codex"]') as HTMLButtonElement;
      expect(refresh).toBeTruthy();

      refresh.click();
      fixture.detectChanges();

      expect(store.refresh).toHaveBeenCalledWith('codex');
    });

    it('keeps the detail popover open for inside clicks and closes it for outside clicks', () => {
      store.setSnapshot('codex', makeSnapshot('codex', 'plus', true, [
        { ...makeWindow(4, 100), id: 'codex.weekly', label: 'Codex weekly' },
      ]));
      fixture.detectChanges();

      const host = fixture.nativeElement as HTMLElement;
      const button = host.querySelector('button[data-testid="quota-toggle"]') as HTMLButtonElement;

      button.click();
      fixture.detectChanges();

      expect(host.querySelector('[data-testid="quota-popover"]')).toBeTruthy();

      const refresh = host.querySelector('button[data-testid="quota-refresh-codex"]') as HTMLButtonElement;
      refresh.click();
      fixture.detectChanges();

      expect(host.querySelector('[data-testid="quota-popover"]')).toBeTruthy();

      document.body.click();
      fixture.detectChanges();

      expect(host.querySelector('[data-testid="quota-popover"]')).toBeFalsy();
    });
  });
});
