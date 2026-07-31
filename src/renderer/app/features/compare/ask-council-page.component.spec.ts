/**
 * Spec: AskCouncilPageComponent — logic-level tests.
 *
 * The component delegates all run/synthesis state to AskCouncilStore, so it
 * is stubbed here with plain signals; these tests only exercise the
 * component's own page-local logic (prompt/provider selection, synthesis
 * method choice, and that it calls the store correctly).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { signal, ɵresolveComponentResources as resolveComponentResources } from '@angular/core';
import { AskCouncilPageComponent } from './ask-council-page.component';
import { AskCouncilStore } from './ask-council.store';
import type { CouncilMember, CouncilRun, CouncilSynthesisResult } from '../../core/services/ipc/compare-ipc.service';

// AskCouncilPageComponent uses templateUrl/styleUrl; these tests are logic-only
// (no DOM assertions), so resolve those external resources to empty strings —
// same JIT-test pattern as cost-page.component.spec.ts.
await resolveComponentResources((url) => {
  if (url.endsWith('.html') || url.endsWith('.scss')) {
    return Promise.resolve('');
  }
  return Promise.reject(new Error(`Unexpected resource: ${url}`));
});

function makeMember(overrides: Partial<CouncilMember> = {}): CouncilMember {
  return { provider: 'claude', status: 'succeeded', answer: 'hi', ...overrides };
}

function makeMockStore() {
  return {
    availableProviders: signal<string[]>([]),
    loadingProviders: signal(false),
    starting: signal(false),
    synthesizing: signal(false),
    errorMessage: signal<string | null>(null),
    members: signal<CouncilMember[]>([]),
    isRunning: signal(false),
    canSynthesize: signal(false),
    canCancel: signal(false),
    synthesis: signal<CouncilSynthesisResult | null>(null),
    succeededMembers: signal<CouncilMember[]>([]),
    failedMembers: signal<CouncilMember[]>([]),
    run: signal<CouncilRun | null>(null),
    initialize: vi.fn().mockResolvedValue(undefined),
    start: vi.fn().mockResolvedValue(undefined),
    cancel: vi.fn().mockResolvedValue(undefined),
    synthesize: vi.fn().mockResolvedValue(undefined),
    clearRun: vi.fn(),
  };
}

describe('AskCouncilPageComponent', () => {
  let component: AskCouncilPageComponent;
  let mockStore: ReturnType<typeof makeMockStore>;

  beforeEach(async () => {
    mockStore = makeMockStore();

    await TestBed.configureTestingModule({
      imports: [AskCouncilPageComponent],
      providers: [{ provide: AskCouncilStore, useValue: mockStore }],
    }).compileComponents();

    const fixture = TestBed.createComponent(AskCouncilPageComponent);
    component = fixture.componentInstance;
  });

  // ── initial state ──────────────────────────────────────────────────────────

  describe('initial state', () => {
    it('starts with an empty prompt and no selected providers', () => {
      expect(component.prompt()).toBe('');
      expect(component.selectedProviders()).toEqual([]);
    });

    it('canStart is false when prompt is empty', () => {
      expect(component.canStart()).toBe(false);
    });
  });

  // ── ngOnInit ────────────────────────────────────────────────────────────────

  describe('ngOnInit', () => {
    it('initializes the store', async () => {
      await component.ngOnInit();
      expect(mockStore.initialize).toHaveBeenCalledOnce();
    });

    it('pre-selects all available providers when none are selected yet', async () => {
      mockStore.availableProviders.set(['claude', 'gemini']);
      await component.ngOnInit();
      expect(component.selectedProviders()).toEqual(['claude', 'gemini']);
    });

    it('does not clobber an existing selection', async () => {
      mockStore.availableProviders.set(['claude', 'gemini']);
      component.selectedProviders.set(['gemini']);
      await component.ngOnInit();
      expect(component.selectedProviders()).toEqual(['gemini']);
    });
  });

  // ── provider selection ─────────────────────────────────────────────────────

  describe('provider selection', () => {
    beforeEach(async () => {
      mockStore.availableProviders.set(['claude', 'gemini']);
      await component.ngOnInit();
    });

    it('isSelected reflects current selection', () => {
      expect(component.isSelected('claude')).toBe(true);
    });

    it('toggleProvider deselects a selected provider', () => {
      component.toggleProvider('claude');
      expect(component.isSelected('claude')).toBe(false);
    });

    it('toggleProvider selects an unselected provider', () => {
      component.clearSelection();
      component.toggleProvider('gemini');
      expect(component.isSelected('gemini')).toBe(true);
    });

    it('selectAll re-selects every available provider', () => {
      component.clearSelection();
      component.selectAll();
      expect(component.selectedProviders()).toEqual(['claude', 'gemini']);
    });

    it('clearSelection empties the selection', () => {
      component.clearSelection();
      expect(component.selectedProviders()).toEqual([]);
    });
  });

  // ── canStart / runHint ─────────────────────────────────────────────────────

  describe('canStart / runHint', () => {
    beforeEach(async () => {
      mockStore.availableProviders.set(['claude']);
      await component.ngOnInit();
    });

    it('is false while the store reports a run in progress', () => {
      component.prompt.set('hello');
      mockStore.isRunning.set(true);
      expect(component.canStart()).toBe(false);
    });

    it('is true with a non-blank prompt and at least one selected provider', () => {
      component.prompt.set('hello');
      expect(component.canStart()).toBe(true);
    });

    it('runHint prompts for a prompt when blank', () => {
      expect(component.runHint()).toMatch(/enter a prompt/i);
    });
  });

  // ── run / cancel / clear ───────────────────────────────────────────────────

  describe('runCouncil()', () => {
    it('starts the store with the trimmed prompt and selected providers', async () => {
      mockStore.availableProviders.set(['claude', 'gemini']);
      await component.ngOnInit();
      component.prompt.set('  hello  ');

      await component.runCouncil();

      expect(mockStore.start).toHaveBeenCalledWith('hello', ['claude', 'gemini']);
    });

    it('does nothing when canStart is false', async () => {
      component.prompt.set('');
      await component.runCouncil();
      expect(mockStore.start).not.toHaveBeenCalled();
    });
  });

  it('cancel() delegates to the store', async () => {
    await component.cancel();
    expect(mockStore.cancel).toHaveBeenCalledOnce();
  });

  it('clearRun() delegates to the store', () => {
    component.clearRun();
    expect(mockStore.clearRun).toHaveBeenCalledOnce();
  });

  // ── synthesis method selection ─────────────────────────────────────────────

  describe('synthesize()', () => {
    it('routes the consensus method', async () => {
      component.setSynthesisChoice('consensus');
      await component.synthesize();
      expect(mockStore.synthesize).toHaveBeenCalledWith('consensus');
    });

    it('routes the debate method', async () => {
      component.setSynthesisChoice('debate');
      await component.synthesize();
      expect(mockStore.synthesize).toHaveBeenCalledWith('debate');
    });

    it('routes a chosen provider, defaulting to the first succeeded member', async () => {
      mockStore.succeededMembers.set([makeMember({ provider: 'gemini' }), makeMember({ provider: 'codex' })]);
      component.setSynthesisChoice('provider');

      await component.synthesize();

      expect(mockStore.synthesize).toHaveBeenCalledWith({ providerId: 'gemini' });
    });

    it('routes an explicitly-picked provider once one is set', async () => {
      mockStore.succeededMembers.set([makeMember({ provider: 'gemini' }), makeMember({ provider: 'codex' })]);
      component.setSynthesisChoice('provider');
      component.setSynthesisProviderId('codex');

      await component.synthesize();

      expect(mockStore.synthesize).toHaveBeenCalledWith({ providerId: 'codex' });
    });

    it('does nothing for the provider method when no member has succeeded', async () => {
      component.setSynthesisChoice('provider');
      await component.synthesize();
      expect(mockStore.synthesize).not.toHaveBeenCalled();
    });
  });

  // ── helpers ────────────────────────────────────────────────────────────────

  describe('formatMs()', () => {
    it('formats sub-second durations as ms', () => {
      expect(component.formatMs(450)).toBe('450ms');
    });

    it('formats durations >= 1000ms as seconds with one decimal', () => {
      expect(component.formatMs(1500)).toBe('1.5s');
    });
  });

  describe('statusLabel()', () => {
    it('labels every member status', () => {
      expect(component.statusLabel('queued')).toBe('Queued');
      expect(component.statusLabel('running')).toBe('Running…');
      expect(component.statusLabel('succeeded')).toBe('Done');
      expect(component.statusLabel('failed')).toBe('Failed');
      expect(component.statusLabel('cancelled')).toBe('Cancelled');
    });
  });
});
