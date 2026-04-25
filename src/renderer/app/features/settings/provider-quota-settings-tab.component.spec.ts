/**
 * Unit tests for ProviderQuotaSettingsTabComponent.
 *
 * Covers:
 * - Renders one row per provider
 * - Loads persisted intervals from the store
 * - Selecting an interval calls store.setPollInterval
 * - "Refresh now" calls store.refresh
 * - "Refresh all" calls store.refreshAll
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { signal, computed } from '@angular/core';
import { ProviderQuotaSettingsTabComponent } from './provider-quota-settings-tab.component';
import { ProviderQuotaStore } from '../../core/state/provider-quota.store';
import type {
  ProviderId,
  ProviderQuotaSnapshot,
} from '../../../../shared/types/provider-quota.types';

class FakeStore {
  private snaps = signal<Record<ProviderId, ProviderQuotaSnapshot | null>>({
    claude: null, codex: null, gemini: null, copilot: null,
  });
  readonly snapshots = computed(() => this.snaps());
  readonly mostConstrainedWindow = computed(() => null);
  readonly lastWarning = signal(null).asReadonly();

  readonly initialize = vi.fn(async () => { /* noop */ });
  readonly refresh = vi.fn(async () => { /* noop */ });
  readonly refreshAll = vi.fn(async () => { /* noop */ });
  readonly setPollInterval = vi.fn(async () => { /* noop */ });
  readonly readPollIntervals = vi.fn((): Record<ProviderId, number> => ({
    claude: 0, codex: 0, gemini: 0, copilot: 0,
  }));

  setSnapshot(p: ProviderId, snap: ProviderQuotaSnapshot | null): void {
    this.snaps.update((s) => ({ ...s, [p]: snap }));
  }
}

describe('ProviderQuotaSettingsTabComponent', () => {
  let store: FakeStore;
  let fixture: ComponentFixture<ProviderQuotaSettingsTabComponent>;
  let component: ProviderQuotaSettingsTabComponent;

  beforeEach(async () => {
    store = new FakeStore();
    await TestBed.configureTestingModule({
      imports: [ProviderQuotaSettingsTabComponent],
      providers: [{ provide: ProviderQuotaStore, useValue: store }],
    }).compileComponents();

    fixture = TestBed.createComponent(ProviderQuotaSettingsTabComponent);
    component = fixture.componentInstance;
  });

  describe('rendering', () => {
    it('shows one row per provider', () => {
      fixture.detectChanges();
      const rows = fixture.nativeElement.querySelectorAll('tbody tr');
      expect(rows.length).toBe(4);
    });

    it('shows "—" state for providers with no snapshot', () => {
      fixture.detectChanges();
      const text = fixture.nativeElement.textContent ?? '';
      expect(text).toContain('—');
    });

    it('shows plan tier when snapshot is ok', () => {
      store.setSnapshot('claude', {
        provider: 'claude',
        takenAt: Date.now(),
        source: 'cli-result',
        ok: true,
        plan: 'max',
        windows: [],
      });
      fixture.detectChanges();
      const text = fixture.nativeElement.textContent ?? '';
      expect(text.toLowerCase()).toContain('max');
    });

    it('shows error message when snapshot is not ok', () => {
      store.setSnapshot('codex', {
        provider: 'codex',
        takenAt: Date.now(),
        source: 'cli-result',
        ok: false,
        error: 'Codex CLI is not signed in',
        windows: [],
      });
      fixture.detectChanges();
      const text = fixture.nativeElement.textContent ?? '';
      expect(text).toContain('Codex CLI is not signed in');
    });
  });

  describe('lifecycle', () => {
    it('calls store.initialize() on init', () => {
      fixture.detectChanges();
      expect(store.initialize).toHaveBeenCalledTimes(1);
    });

    it('seeds intervals from readPollIntervals on init', () => {
      store.readPollIntervals.mockReturnValue({
        claude: 15 * 60 * 1000, codex: 0, gemini: 0, copilot: 60 * 60 * 1000,
      });
      fixture.detectChanges();
      expect(component.intervals().claude).toBe(15 * 60 * 1000);
      expect(component.intervals().copilot).toBe(60 * 60 * 1000);
    });
  });

  describe('interactions', () => {
    it('changing a select calls store.setPollInterval', () => {
      fixture.detectChanges();
      const select = fixture.nativeElement.querySelector('select') as HTMLSelectElement;
      select.value = String(15 * 60 * 1000);
      select.dispatchEvent(new Event('change'));
      expect(store.setPollInterval).toHaveBeenCalledWith('claude', 15 * 60 * 1000);
    });

    it('updates the local intervals signal optimistically', () => {
      fixture.detectChanges();
      component.onIntervalChange('claude', {
        target: { value: String(5 * 60 * 1000) },
      } as unknown as Event);
      expect(component.intervals().claude).toBe(5 * 60 * 1000);
    });

    it('refresh calls store.refresh for that provider', () => {
      fixture.detectChanges();
      component.refresh('codex');
      expect(store.refresh).toHaveBeenCalledWith('codex');
    });

    it('refreshAll calls store.refreshAll', () => {
      fixture.detectChanges();
      component.refreshAll();
      expect(store.refreshAll).toHaveBeenCalledTimes(1);
    });

    it('ignores invalid interval values', () => {
      fixture.detectChanges();
      component.onIntervalChange('claude', {
        target: { value: 'not-a-number' },
      } as unknown as Event);
      expect(store.setPollInterval).not.toHaveBeenCalled();
    });
  });
});
