/**
 * Render-count test harness for OnPush Angular components.
 *
 * ## What this measures and its limitations
 *
 * ### Zone.js TestBed mode (this project)
 *
 * `fixture.detectChanges()` calls `ChangeDetectorRef.detectChanges()` on the
 * fixture's root host view, which force-sets the LView's "force check" flag
 * (bit 1024) before walking the tree. This means Angular ALWAYS re-evaluates
 * the component template on every `fixture.detectChanges()` call, regardless
 * of whether the component is dirty. OnPush's skip-if-clean optimisation does
 * NOT fire for the direct component under test in zone.js TestBed mode.
 *
 * This means counting renders as "times detectChanges() was called" is always
 * 1:1. The harness instead tracks signal-driven dirtiness:
 *
 *   - `signalScheduleCount` — number of `fixture.detectChanges()` passes where
 *     the component's reactive template consumer was dirty (had pending signal
 *     changes). In a real app with OnPush, this equals the number of actual
 *     template re-evaluations caused by signals.
 *
 *   - `totalDetectChangesCount` — total `fixture.detectChanges()` calls since
 *     the last `reset()`; always >= `signalScheduleCount`.
 *
 * ### What the tests using this harness actually assert
 *
 * - `signalScheduleCount === 0`: no tracked signal changed between last flush
 *   and this detectChanges call — in a real app the OnPush component would
 *   have been skipped.
 *
 * - `signalScheduleCount === N`: the component's signal graph was dirtied
 *   exactly N times (once per detectChanges call that found pending changes).
 *
 * - `signalScheduleCount === 1` after multiple mutations + one detectChanges:
 *   the signal coalesces multiple writes into one dirty flag, as expected.
 *
 * ## How it works
 *
 * Angular's signal reactivity tracks template reads via a per-view
 * `REACTIVE_TEMPLATE_CONSUMER` node stored at index 24 in the component's
 * LView. When any signal the template reads changes, `consumer.dirty` is set
 * to `true`. `refreshView` resets it to `false` after each re-evaluation.
 *
 * The component's own LView is accessed via:
 *
 * ```
 * fixture.debugElement.injector.get(ChangeDetectorRef)._lView
 * ```
 *
 * This gives the component's view (type=1), not the fixture's root host view
 * (type=0). Both access patterns mirror what Angular's own testing framework
 * and internal tools do with `_lView`.
 *
 * Constants verified against Angular 21.2.13 source:
 *   - `REACTIVE_TEMPLATE_CONSUMER = 24`
 *     (node_modules/@angular/core/fesm2022/_effect-chunk2.mjs, line 1503)
 *
 * ## Usage
 *
 * ```typescript
 * let counter: RenderCounter;
 *
 * beforeEach(() => {
 *   TestBed.configureTestingModule({ imports: [MyComponent], providers: [...] });
 *   fixture = TestBed.createComponent(MyComponent);
 *   counter = attachRenderCounter(fixture);
 *   fixture.detectChanges(); // initial render
 *   counter.reset();         // don't count setup
 * });
 *
 * it('no signal change → signalScheduleCount stays 0', () => {
 *   fixture.detectChanges();
 *   expect(counter.signalScheduleCount).toBe(0);
 * });
 *
 * it('one signal change → exactly one scheduled render', () => {
 *   someSignal.set('new');
 *   fixture.detectChanges();
 *   expect(counter.signalScheduleCount).toBe(1);
 * });
 *
 * it('three mutations, one flush → still one scheduled render', () => {
 *   s.set('a'); s.set('b'); s.set('c');
 *   fixture.detectChanges();
 *   expect(counter.signalScheduleCount).toBe(1);
 * });
 * ```
 */

import { ChangeDetectorRef } from '@angular/core';
import { ComponentFixture } from '@angular/core/testing';

// ---------------------------------------------------------------------------
// Angular LView internal constant (stable since Angular 17, verified v21.2.13)
// ---------------------------------------------------------------------------

/**
 * Index of the REACTIVE_TEMPLATE_CONSUMER in the component's LView.
 *
 * Source: @angular/core/fesm2022/_effect-chunk2.mjs — `const REACTIVE_TEMPLATE_CONSUMER = 24`
 *
 * This is the per-view reactive node created the first time a signal is read
 * during a template execution. Its `dirty` flag is set to `true` when any
 * tracked signal changes, and reset to `false` by `refreshView` after each
 * template re-evaluation.
 */
const REACTIVE_TEMPLATE_CONSUMER_IDX = 24;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface RenderCounter {
  /**
   * Number of `fixture.detectChanges()` calls where the reactive template
   * consumer was dirty (at least one signal the template reads had changed
   * since the previous flush).
   *
   * In a real app with OnPush (outside TestBed zone.js mode), this equals the
   * number of actual template re-evaluations caused by signals.
   */
  readonly signalScheduleCount: number;

  /**
   * Total number of `fixture.detectChanges()` calls since the last `reset()`.
   * Always >= `signalScheduleCount`.
   */
  readonly totalDetectChangesCount: number;

  /**
   * Set both counters back to zero. Call after the initial
   * `fixture.detectChanges()` so the setup render is not counted.
   */
  reset(): void;

  /**
   * Unwrap the `fixture.detectChanges` override. Usually not needed — the
   * project's global `test-setup.ts` resets TestBed after every test.
   */
  restore(): void;
}

// ---------------------------------------------------------------------------
// LView helpers
// ---------------------------------------------------------------------------

/**
 * Get the component's own LView from the fixture. This uses the component's
 * ChangeDetectorRef, which holds a reference to the component's LView (not
 * the fixture's root host LView). Verified in Angular 21 via debug inspection:
 * `fixture.debugElement.injector.get(ChangeDetectorRef)._lView` has
 * `tView.type === 1` (component view) and `lView[24]` is the reactive consumer.
 */
function getComponentLView<T>(fixture: ComponentFixture<T>): unknown[] {
  const cdr = fixture.debugElement.injector.get(ChangeDetectorRef) as unknown as {
    _lView?: unknown[];
    _cdRefInjectingView?: unknown[];
  };
  // In Angular 21 zone.js mode: the element injector's CDR has _lView pointing
  // directly to the component's own view (tView.type=1), which contains the
  // reactive template consumer at index 24. This is different from the fixture's
  // root host view (type=0) which wraps the component.
  const lView = cdr._lView;
  if (!lView) {
    throw new Error(
      'attachRenderCounter: cannot access component LView from ChangeDetectorRef. ' +
      'Ensure TestBed.createComponent() was called before attachRenderCounter().',
    );
  }
  return lView;
}

/**
 * Returns the reactive template consumer for the LView, or null if the
 * template has never been executed with signal tracking (first render not
 * yet completed, or no signals in the template).
 */
function getConsumer(lView: unknown[]): { dirty: boolean } | null {
  const c = lView[REACTIVE_TEMPLATE_CONSUMER_IDX];
  if (c == null || typeof c !== 'object') return null;
  return c as { dirty: boolean };
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Attach a render counter to a component fixture.
 *
 * Call after `TestBed.createComponent()`, then call `fixture.detectChanges()`
 * for the initial render, then call `counter.reset()`.
 *
 * @param fixture  The `ComponentFixture` returned by `TestBed.createComponent`.
 * @returns        A `RenderCounter` tracking signal-driven CD events.
 */
export function attachRenderCounter<T>(fixture: ComponentFixture<T>): RenderCounter {
  const lView = getComponentLView(fixture);

  let signalScheduleCount = 0;
  let totalDetectChangesCount = 0;

  const originalDetectChanges = fixture.detectChanges.bind(fixture);

  fixture.detectChanges = (checkNoChanges?: boolean) => {
    // Snapshot consumer dirty state BEFORE the flush resets it.
    const consumer = getConsumer(lView);
    const wasDirty = consumer?.dirty === true;

    originalDetectChanges(checkNoChanges);

    totalDetectChangesCount++;
    if (wasDirty) {
      signalScheduleCount++;
    }
  };

  return {
    get signalScheduleCount(): number { return signalScheduleCount; },
    get totalDetectChangesCount(): number { return totalDetectChangesCount; },
    reset(): void {
      signalScheduleCount = 0;
      totalDetectChangesCount = 0;
    },
    restore(): void {
      fixture.detectChanges = originalDetectChanges;
    },
  };
}
