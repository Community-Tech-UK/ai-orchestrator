/**
 * Measured live on 2026-08-01 against a running dev app: with
 * `document.visibilityState === 'hidden'`, `requestAnimationFrame` **never
 * fires at all** — not late, not throttled, never.
 *
 * The transcript's scroll-restore paths raise `isRestoringRef` synchronously
 * and lower it only inside the frame callback, and `OutputScrollService`'s
 * listener short-circuits on that guard. So a restore begun while hidden left
 * the guard stuck `true` and killed scroll tracking for that session with no
 * error — reachable by opening an instance and switching to another app before
 * the frame lands.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { runRestoreFrame, RESTORE_FRAME_FALLBACK_MS } from './restore-frame';

const realRaf = globalThis.requestAnimationFrame;

afterEach(() => {
  globalThis.requestAnimationFrame = realRaf;
  vi.useRealTimers();
});

describe('runRestoreFrame', () => {
  it('runs the step on the frame when one arrives', () => {
    vi.useFakeTimers();
    const step = vi.fn();
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    }) as typeof requestAnimationFrame;

    runRestoreFrame(step);

    expect(step).toHaveBeenCalledOnce();
  });

  /** The whole point: a hidden window never delivers a frame. */
  it('still runs the step when the frame NEVER arrives', () => {
    vi.useFakeTimers();
    const step = vi.fn();
    globalThis.requestAnimationFrame = (() => 1) as unknown as typeof requestAnimationFrame;

    runRestoreFrame(step);
    expect(step).not.toHaveBeenCalled();

    vi.advanceTimersByTime(RESTORE_FRAME_FALLBACK_MS);
    expect(step).toHaveBeenCalledOnce();
  });

  it('runs exactly once when a late frame arrives after the fallback', () => {
    vi.useFakeTimers();
    const step = vi.fn();
    // Boxed: TS does not credit a reassignment made inside the mock closure to
    // the outer binding, and would narrow a bare `let` back to `null` here.
    const frame: { cb: FrameRequestCallback | null } = { cb: null };
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      frame.cb = cb;
      return 1;
    }) as typeof requestAnimationFrame;

    runRestoreFrame(step);
    vi.advanceTimersByTime(RESTORE_FRAME_FALLBACK_MS);
    expect(step).toHaveBeenCalledOnce();

    // The window becomes visible and the parked frame finally fires.
    frame.cb?.(0);
    expect(step).toHaveBeenCalledOnce();
  });

  it('does not fire the fallback when the frame already ran', () => {
    vi.useFakeTimers();
    const step = vi.fn();
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    }) as typeof requestAnimationFrame;

    runRestoreFrame(step);
    vi.advanceTimersByTime(RESTORE_FRAME_FALLBACK_MS * 4);

    expect(step).toHaveBeenCalledOnce();
  });
});
