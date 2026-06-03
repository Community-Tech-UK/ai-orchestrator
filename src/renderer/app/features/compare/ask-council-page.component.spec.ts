/**
 * Spec: AskCouncilPageComponent — logic-level tests.
 *
 * Tests are written without Angular TestBed so they run fast in vitest.
 * We instantiate the component class directly, stub the two dependencies
 * (Router and CompareIpcService), and exercise signals/methods.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { AskCouncilPageComponent } from './ask-council-page.component';
import type { CompareResult } from './ask-council-page.component';
import { CompareIpcService } from '../../core/services/ipc/compare-ipc.service';
import { Router } from '@angular/router';

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeCompareResult(overrides: Partial<CompareResult> = {}): CompareResult {
  return {
    prompt: 'test prompt',
    results: [
      { provider: 'claude', ok: true, model: 'claude-3', answer: 'Hello from Claude', durationMs: 500 },
      { provider: 'gemini', ok: true, model: 'gemini-pro', answer: 'Hello from Gemini', durationMs: 800 },
    ],
    ...overrides,
  };
}

function makePartialFailureResult(): CompareResult {
  return {
    prompt: 'test prompt',
    results: [
      { provider: 'claude', ok: true, model: 'claude-3', answer: 'Hello from Claude', durationMs: 400 },
      { provider: 'gemini', ok: false, error: 'Provider is not available', durationMs: 50 },
    ],
  };
}

// ─── setup ────────────────────────────────────────────────────────────────────

describe('AskCouncilPageComponent', () => {
  let component: AskCouncilPageComponent;

  let mockCompareIpc: {
    compareListProviders: ReturnType<typeof vi.fn>;
    compareRun: ReturnType<typeof vi.fn>;
  };
  let mockRouter: { navigate: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    mockCompareIpc = {
      compareListProviders: vi.fn().mockResolvedValue({ success: true, data: ['claude', 'gemini'] }),
      compareRun: vi.fn().mockResolvedValue({ success: true, data: makeCompareResult() }),
    };
    mockRouter = { navigate: vi.fn() };

    await TestBed.configureTestingModule({
      imports: [AskCouncilPageComponent],
      providers: [
        { provide: CompareIpcService, useValue: mockCompareIpc },
        { provide: Router, useValue: mockRouter },
      ],
    }).compileComponents();

    const fixture = TestBed.createComponent(AskCouncilPageComponent);
    component = fixture.componentInstance;
  });

  // ── initial state ──────────────────────────────────────────────────────────

  describe('initial state', () => {
    it('starts with empty prompt', () => {
      expect(component.prompt()).toBe('');
    });

    it('starts with no results', () => {
      expect(component.results()).toBeNull();
    });

    it('starts not running', () => {
      expect(component.running()).toBe(false);
    });

    it('canRun is false when prompt is empty', () => {
      expect(component.canRun()).toBe(false);
    });
  });

  // ── provider loading ───────────────────────────────────────────────────────

  describe('ngOnInit / loadProviders', () => {
    it('loads available providers from IPC and pre-selects all', async () => {
      await component.ngOnInit();

      expect(component.availableProviders()).toEqual(['claude', 'gemini']);
      expect(component.selectedProviders()).toEqual(['claude', 'gemini']);
    });

    it('handles IPC error gracefully (no crash, empty list)', async () => {
      mockCompareIpc.compareListProviders.mockResolvedValue({ success: false, error: { message: 'fail' } });

      await component.ngOnInit();

      expect(component.availableProviders()).toEqual([]);
      expect(component.selectedProviders()).toEqual([]);
    });
  });

  // ── provider selection ─────────────────────────────────────────────────────

  describe('provider selection', () => {
    beforeEach(async () => {
      await component.ngOnInit();
    });

    it('isSelected returns true for a selected provider', () => {
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

    it('selectAll re-selects all available providers', () => {
      component.clearSelection();
      component.selectAll();
      expect(component.selectedProviders()).toEqual(['claude', 'gemini']);
    });

    it('clearSelection empties selection', () => {
      component.clearSelection();
      expect(component.selectedProviders()).toEqual([]);
    });
  });

  // ── canRun / runHint derived signals ──────────────────────────────────────

  describe('canRun', () => {
    beforeEach(async () => {
      await component.ngOnInit();
    });

    it('is false when prompt is blank (whitespace-only)', () => {
      component.prompt.set('   ');
      expect(component.canRun()).toBe(false);
    });

    it('is false when no providers are selected', () => {
      component.prompt.set('Hello');
      component.clearSelection();
      expect(component.canRun()).toBe(false);
    });

    it('is true when prompt is non-blank and at least one provider is selected', () => {
      component.prompt.set('Hello');
      expect(component.canRun()).toBe(true);
    });
  });

  // ── run: success (all providers OK) ───────────────────────────────────────

  describe('run() — all providers succeed', () => {
    beforeEach(async () => {
      await component.ngOnInit();
      component.prompt.set('What is 2+2?');
    });

    it('populates results on success', async () => {
      await component.run();

      const res = component.results();
      expect(res).not.toBeNull();
      expect(res!.results).toHaveLength(2);
    });

    it('sets running=false after run completes', async () => {
      await component.run();
      expect(component.running()).toBe(false);
    });

    it('successCount equals number of OK cells', async () => {
      await component.run();
      expect(component.successCount()).toBe(2);
    });

    it('maxDurationMs returns the slowest provider duration', async () => {
      await component.run();
      expect(component.maxDurationMs()).toBe(800);
    });

    it('calls compareRun with trimmed prompt and selected providers', async () => {
      component.prompt.set('  trimmed prompt  ');
      await component.run();

      expect(mockCompareIpc.compareRun).toHaveBeenCalledWith({
        prompt: 'trimmed prompt',
        providers: ['claude', 'gemini'],
      });
    });
  });

  // ── run: partial failure ───────────────────────────────────────────────────

  describe('run() — partial failure (one provider fails)', () => {
    beforeEach(async () => {
      await component.ngOnInit();
      component.prompt.set('Hello');
      mockCompareIpc.compareRun.mockResolvedValue({
        success: true,
        data: makePartialFailureResult(),
      });
    });

    it('still populates results', async () => {
      await component.run();
      expect(component.results()).not.toBeNull();
      expect(component.results()!.results).toHaveLength(2);
    });

    it('successCount reflects only OK cells', async () => {
      await component.run();
      expect(component.successCount()).toBe(1);
    });

    it('failed card carries an error string', async () => {
      await component.run();
      const geminiCell = component.results()!.results.find((c) => c.provider === 'gemini')!;
      expect(geminiCell.ok).toBe(false);
      expect(geminiCell.error).toBe('Provider is not available');
    });
  });

  // ── run: IPC-level failure ─────────────────────────────────────────────────

  describe('run() — IPC-level error', () => {
    beforeEach(async () => {
      await component.ngOnInit();
      component.prompt.set('Hello');
      mockCompareIpc.compareRun.mockResolvedValue({
        success: false,
        error: { message: 'Main process crashed' },
      });
    });

    it('sets errorMessage and leaves results null', async () => {
      await component.run();
      expect(component.errorMessage()).toBe('Main process crashed');
      expect(component.results()).toBeNull();
    });

    it('clears running flag after failure', async () => {
      await component.run();
      expect(component.running()).toBe(false);
    });
  });

  // ── clearResults ───────────────────────────────────────────────────────────

  describe('clearResults()', () => {
    it('resets results and errorMessage', async () => {
      await component.ngOnInit();
      component.prompt.set('Hi');
      await component.run();

      component.clearResults();

      expect(component.results()).toBeNull();
      expect(component.errorMessage()).toBeNull();
    });
  });

  // ── formatMs helper ────────────────────────────────────────────────────────

  describe('formatMs()', () => {
    it('formats sub-second durations as ms', () => {
      expect(component.formatMs(450)).toBe('450ms');
    });

    it('formats durations >= 1000 as seconds with one decimal', () => {
      expect(component.formatMs(1500)).toBe('1.5s');
    });

    it('handles zero', () => {
      expect(component.formatMs(0)).toBe('0ms');
    });
  });

  // ── navigation ─────────────────────────────────────────────────────────────

  describe('goBack()', () => {
    it('navigates to root', () => {
      component.goBack();
      expect(mockRouter.navigate).toHaveBeenCalledWith(['/']);
    });
  });
});
