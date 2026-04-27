/**
 * Tests for OutputScrollService.
 *
 * These cover the `isRestoring` guard added to fix the cross-session scroll
 * bug where browser auto-clamp scroll events fired during an instance switch
 * would overwrite scrollPositions[currentInstanceId] before the rAF restore
 * could read it. With the guard raised, the listener must short-circuit so
 * the saved position survives the switch transition.
 */

import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { OutputScrollService, type ScrollState } from './output-scroll.service';
import { PerfInstrumentationService } from '../../core/services/perf-instrumentation.service';

describe('OutputScrollService', () => {
  let service: OutputScrollService;
  let perfStub: { recordScrollFrame: Mock };

  beforeEach(() => {
    perfStub = {
      recordScrollFrame: vi.fn(),
    };

    TestBed.configureTestingModule({
      providers: [
        OutputScrollService,
        { provide: PerfInstrumentationService, useValue: perfStub },
      ],
    });

    service = TestBed.inject(OutputScrollService);
  });

  afterEach(() => {
    TestBed.resetTestingModule();
    vi.restoreAllMocks();
  });

  function makeState(overrides: Partial<ScrollState> = {}): ScrollState {
    return {
      showScrollToTop: signal(false),
      showScrollToBottom: signal(false),
      scrollPositions: new Map<string, number>(),
      userScrolledUp: { value: false },
      isRestoring: { value: false },
      ...overrides,
    };
  }

  /**
   * jsdom doesn't run layout, so scrollTop/scrollHeight/clientHeight default
   * to 0. We shadow them with own properties so the listener can read whatever
   * values the test wants. `writable: true` lets us mutate scrollTop later.
   */
  function makeViewport(scrollTop: number, scrollHeight = 8000, clientHeight = 600): HTMLDivElement {
    const el = document.createElement('div');
    Object.defineProperty(el, 'scrollTop', { value: scrollTop, writable: true, configurable: true });
    Object.defineProperty(el, 'scrollHeight', { value: scrollHeight, configurable: true });
    Object.defineProperty(el, 'clientHeight', { value: clientHeight, configurable: true });
    return el;
  }

  describe('setupScrollListener — isRestoring guard', () => {
    it('records scroll position normally when isRestoring is false', () => {
      const state = makeState();
      const el = makeViewport(1234);

      service.setupScrollListener(
        el,
        state,
        () => 'instance-A',
        () => [],
        () => false,
        () => false,
        () => { /* noop */ },
      );
      el.dispatchEvent(new Event('scroll'));

      expect(state.scrollPositions.get('instance-A')).toBe(1234);
    });

    it('skips ALL listener side-effects when isRestoring.value is true', () => {
      const state = makeState({ isRestoring: { value: true } });
      // Pre-seed with the "real" saved position the listener must NOT overwrite.
      state.scrollPositions.set('instance-A', 500);
      const el = makeViewport(7777);

      service.setupScrollListener(
        el,
        state,
        () => 'instance-A',
        () => [],
        () => false,
        () => true,           // hasOlderMessages — would normally trigger load-more
        vi.fn(),              // loadOlderMessages — must NOT be called (tested separately below)
      );
      el.dispatchEvent(new Event('scroll'));

      // Saved position untouched.
      expect(state.scrollPositions.get('instance-A')).toBe(500);
      // Button visibility / userScrolledUp untouched.
      expect(state.userScrolledUp.value).toBe(false);
      expect(state.showScrollToTop()).toBe(false);
      expect(state.showScrollToBottom()).toBe(false);
      // Perf hook not invoked either — this is what tells us we returned
      // before *any* of the listener body ran, not partway through.
      expect(perfStub.recordScrollFrame).not.toHaveBeenCalled();
    });

    it('does not trigger load-more while restoring, even when scrolled near the top', () => {
      const state = makeState({ isRestoring: { value: true } });
      const el = makeViewport(50); // distanceFromTop=50, would normally trigger load-more
      const loadOlderMessages = vi.fn();

      service.setupScrollListener(
        el,
        state,
        () => 'instance-A',
        () => [],
        () => false,    // not currently loading
        () => true,     // has older messages
        loadOlderMessages,
      );
      el.dispatchEvent(new Event('scroll'));

      expect(loadOlderMessages).not.toHaveBeenCalled();
    });

    it('resumes recording once isRestoring is cleared', () => {
      const guard = { value: true };
      const state = makeState({ isRestoring: guard });
      state.scrollPositions.set('instance-A', 500);
      const el = makeViewport(2000);

      service.setupScrollListener(
        el,
        state,
        () => 'instance-A',
        () => [],
        () => false,
        () => false,
        () => { /* noop */ },
      );

      // First event arrives during restore — short-circuits.
      el.dispatchEvent(new Event('scroll'));
      expect(state.scrollPositions.get('instance-A')).toBe(500);

      // Restore completes.
      guard.value = false;

      // User scrolls. Now the listener must update the saved position.
      Object.defineProperty(el, 'scrollTop', { value: 3500, writable: true, configurable: true });
      el.dispatchEvent(new Event('scroll'));
      expect(state.scrollPositions.get('instance-A')).toBe(3500);
    });

    it('regression: switching B→A does not let an auto-clamp event corrupt scrollPositions[A]', () => {
      // Scenario from the original bug:
      //   * User was on B at scrollTop=5000.
      //   * User clicks A. Angular re-renders A's (shorter) content; the
      //     browser auto-clamps scrollTop to A's max and queues a scroll
      //     event for the same frame, BEFORE rAF.
      //   * The scroll listener fires with instanceIdFn() === 'A' (signal is
      //     already updated). Without the guard it would write
      //     scrollPositions['A'] = (clamped leftover from B), and the rAF
      //     restore would then read that corrupted value.
      //
      // With isRestoring=true (which the parent sets in the switch effect
      // before scheduling the rAF), the listener short-circuits and A's
      // saved position survives intact for the rAF to read.
      const state = makeState({ isRestoring: { value: true } });
      state.scrollPositions.set('A', 800); // A's real previously-saved scroll

      const autoClampedScrollTop = 2000;   // post-clamp leftover from B
      const el = makeViewport(autoClampedScrollTop, /* scrollHeight */ 2600, /* clientHeight */ 600);

      service.setupScrollListener(
        el,
        state,
        () => 'A',          // signal already reads A
        () => [],
        () => false,
        () => false,
        () => { /* noop */ },
      );
      el.dispatchEvent(new Event('scroll'));

      // The saved position is what the rAF restore will read.
      expect(state.scrollPositions.get('A')).toBe(800);
    });
  });
});
