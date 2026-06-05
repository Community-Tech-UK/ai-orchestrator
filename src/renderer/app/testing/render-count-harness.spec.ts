/**
 * Example render-count tests using the render-count harness.
 *
 * These tests demonstrate two things:
 *
 *   1. The harness API — how to attach it, reset it, and assert on counts.
 *   2. Render-count assertions on two existing OnPush components, showing that
 *      signal changes correctly dirty the view and that multiple mutations
 *      before a single detectChanges() coalesce into one scheduled render.
 *
 * ## Zone.js caveat (important)
 *
 * In Angular TestBed zone.js mode, `fixture.detectChanges()` always runs the
 * template (the CDR's detectChanges() force-sets the LView's 1024 "force check"
 * flag). The harness therefore tracks *signal-driven dirtiness* via the
 * REACTIVE_TEMPLATE_CONSUMER, not raw call counts.
 *
 * What `signalScheduleCount` tells you:
 *   - > 0 → at least one signal the template reads changed since the last flush.
 *   - === 0 → no tracked signal changed; in a real app the OnPush component
 *     would have been skipped. This is the meaningful assertion for
 *     "unrelated state does not cause extra renders."
 *
 * Components exercised:
 *   - CliUpdatePillComponent  (src/renderer/app/features/title-bar/)
 *   - ProviderQuotaChipComponent (src/renderer/app/shared/components/provider-quota-chip/)
 *
 * Both are standalone, OnPush, and inject their stores via inject().
 */

import { signal, computed } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CliUpdatePillComponent } from '../features/title-bar/cli-update-pill.component';
import { CliUpdatePillStore } from '../core/state/cli-update-pill.store';
import type { CliUpdatePillState } from '../../../shared/types/diagnostics.types';

import { ProviderQuotaChipComponent } from '../shared/components/provider-quota-chip/provider-quota-chip.component';
import { ProviderQuotaStore } from '../core/state/provider-quota.store';
import type { ProviderId, ProviderQuotaWindow } from '../../../shared/types/provider-quota.types';

import { attachRenderCounter, type RenderCounter } from './render-count-harness';

// ============================================================================
// Shared helpers
// ============================================================================

function makeUpdateEntry(cli: string, displayName: string) {
  return {
    cli,
    displayName,
    currentVersion: '1.0.0',
    latestVersion: '1.1.0',
    updateAvailable: true,
    updatePlan: { cli, displayName, supported: true, displayCommand: `${cli} update` },
  };
}

function makeWindow(used: number, limit: number, resetsAt: number | null = null): ProviderQuotaWindow {
  return {
    kind: 'rolling-window',
    id: `${used}-${limit}`,
    label: 'test window',
    unit: 'messages',
    used,
    limit,
    remaining: Math.max(0, limit - used),
    resetsAt,
  };
}

// ============================================================================
// CliUpdatePillComponent render-count tests
// ============================================================================

describe('CliUpdatePillComponent — render counts (OnPush + signals)', () => {
  let fixture: ComponentFixture<CliUpdatePillComponent>;
  let counter: RenderCounter;
  let state: ReturnType<typeof signal<CliUpdatePillState>>;

  beforeEach(() => {
    state = signal<CliUpdatePillState>({
      generatedAt: 1,
      count: 1,
      entries: [makeUpdateEntry('claude', 'Claude Code')],
    });
    const storeStub = {
      state: state.asReadonly(),
      init: vi.fn(),
    };

    TestBed.configureTestingModule({
      imports: [CliUpdatePillComponent],
      providers: [
        { provide: CliUpdatePillStore, useValue: storeStub },
        { provide: Router, useValue: { navigate: vi.fn() } },
      ],
    });

    fixture = TestBed.createComponent(CliUpdatePillComponent);
    counter = attachRenderCounter(fixture);
    fixture.detectChanges(); // initial render
    counter.reset();         // don't count setup
  });

  // ── Core harness behaviour ─────────────────────────────────────────────

  it('counters start at 0 after reset', () => {
    expect(counter.signalScheduleCount).toBe(0);
    expect(counter.totalDetectChangesCount).toBe(0);
  });

  // ── No signal change → no scheduled render ────────────────────────────

  it('detectChanges() with no signal change does not increment signalScheduleCount', () => {
    // The store signal was NOT updated — the reactive consumer is clean.
    // In a real app with OnPush this component would be skipped.
    fixture.detectChanges();
    expect(counter.signalScheduleCount).toBe(0);
    expect(counter.totalDetectChangesCount).toBe(1);
  });

  // ── Signal change → one scheduled render ──────────────────────────────

  it('state signal change marks the view dirty once', () => {
    state.set({
      generatedAt: 2,
      count: 2,
      entries: [
        makeUpdateEntry('claude', 'Claude Code'),
        makeUpdateEntry('codex', 'OpenAI Codex'),
      ],
    });
    fixture.detectChanges();

    expect(counter.signalScheduleCount).toBe(1);
  });

  // ── Multiple mutations coalesce into one dirty notification ───────────

  it('three rapid state mutations before one detectChanges() are seen as one dirty flush', () => {
    // Angular's signal system coalesces multiple changes to the same
    // signal between CD passes into a single consumer.dirty = true.
    state.set({ generatedAt: 2, count: 1, entries: [makeUpdateEntry('claude', 'Claude Code')] });
    state.set({ generatedAt: 3, count: 2, entries: [makeUpdateEntry('claude', 'Claude Code'), makeUpdateEntry('codex', 'Codex')] });
    state.set({ generatedAt: 4, count: 0, entries: [] });

    // One flush — consumer was dirty (was set at least once) → one scheduled render.
    fixture.detectChanges();
    expect(counter.signalScheduleCount).toBe(1);
  });

  // ── Two separate flushes each with a signal change ─────────────────────

  it('separate flushes each with a change yield signalScheduleCount = 2', () => {
    state.set({ generatedAt: 2, count: 0, entries: [] });
    fixture.detectChanges();

    state.set({ generatedAt: 3, count: 1, entries: [makeUpdateEntry('claude', 'Claude Code')] });
    fixture.detectChanges();

    expect(counter.signalScheduleCount).toBe(2);
    expect(counter.totalDetectChangesCount).toBe(2);
  });

  // ── After resolving a dirty pass, the next clean pass is clean ─────────

  it('signalScheduleCount does not grow on second detectChanges() after change already flushed', () => {
    state.set({ generatedAt: 2, count: 0, entries: [] });
    fixture.detectChanges();   // dirty flush → signalScheduleCount = 1
    counter.reset();

    // No further signal change — this pass is clean.
    fixture.detectChanges();
    expect(counter.signalScheduleCount).toBe(0);
  });
});

// ============================================================================
// ProviderQuotaChipComponent render-count tests
// ============================================================================

class FakeProviderQuotaStore {
  readonly initialize = vi.fn(async () => undefined);
  private worstSig = signal<{ provider: ProviderId; window: ProviderQuotaWindow } | null>(null);
  private snapsSig = signal<Record<ProviderId, null>>({
    claude: null, codex: null, gemini: null, copilot: null, cursor: null,
  });

  readonly mostConstrainedWindow = computed(() => this.worstSig());
  readonly snapshots = computed(() => this.snapsSig());

  setWorst(v: { provider: ProviderId; window: ProviderQuotaWindow } | null): void {
    this.worstSig.set(v);
  }
}

describe('ProviderQuotaChipComponent — render counts (OnPush + computed signals)', () => {
  let fixture: ComponentFixture<ProviderQuotaChipComponent>;
  let counter: RenderCounter;
  let store: FakeProviderQuotaStore;

  beforeEach(async () => {
    store = new FakeProviderQuotaStore();

    await TestBed.configureTestingModule({
      imports: [ProviderQuotaChipComponent],
      providers: [{ provide: ProviderQuotaStore, useValue: store }],
    }).compileComponents();

    fixture = TestBed.createComponent(ProviderQuotaChipComponent);
    counter = attachRenderCounter(fixture);
    fixture.detectChanges(); // initial render
    counter.reset();
  });

  it('counters start at 0 after reset', () => {
    expect(counter.signalScheduleCount).toBe(0);
    expect(counter.totalDetectChangesCount).toBe(0);
  });

  it('detectChanges() with no signal change does not dirty the view', () => {
    fixture.detectChanges();
    expect(counter.signalScheduleCount).toBe(0);
  });

  it('changing the worst-window signal dirties the view once', () => {
    store.setWorst({ provider: 'claude', window: makeWindow(50, 100) });
    fixture.detectChanges();

    expect(counter.signalScheduleCount).toBe(1);
  });

  it('second detectChanges() after a flushed change is clean', () => {
    store.setWorst({ provider: 'claude', window: makeWindow(50, 100) });
    fixture.detectChanges();
    counter.reset();

    fixture.detectChanges();
    expect(counter.signalScheduleCount).toBe(0);
  });

  it('two mutations to worst-window before one flush coalesce into one dirty mark', () => {
    // Both mutations go to the same signal, so the consumer is dirty once.
    store.setWorst({ provider: 'claude', window: makeWindow(50, 100) });
    store.setWorst({ provider: 'claude', window: makeWindow(75, 100) });

    fixture.detectChanges();

    expect(counter.signalScheduleCount).toBe(1);
  });
});
