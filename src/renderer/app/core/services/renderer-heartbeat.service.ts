import { Injectable } from '@angular/core';

/** Beat cadence. Main considers the renderer stalled after ~10s without one. */
export const HEARTBEAT_INTERVAL_MS = 2_000;

/**
 * Window type that may have the Electron preload API. The preload spreads every
 * domain onto one flat `electronAPI` object (see `preload.ts`), so the heartbeat
 * sender sits at the top level — not under an `infrastructure` namespace.
 */
interface HeartbeatWindow {
  electronAPI?: {
    rendererHeartbeat?: (payload: HeartbeatPayload) => void;
  };
}

interface HeartbeatPayload {
  seq: number;
  sentAt: number;
  visibility: 'visible' | 'hidden';
}

/**
 * Sends a periodic heartbeat to the main process from the renderer's MAIN
 * thread — deliberately not a worker: when the UI event loop is blocked the
 * beats stop, and that silence is exactly the freeze signal the main-process
 * monitor turns into diagnostics. App-lifetime singleton started once from
 * the app initializer; no-op outside Electron (tests, plain browser).
 *
 * Each beat carries the document's visibility, and a visibility change beats
 * at once: Chromium throttles a hidden window's timers to about one tick a
 * minute, and the monitor needs to know that before the gap looks like a
 * freeze (LT-022).
 */
@Injectable({ providedIn: 'root' })
export class RendererHeartbeatService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private visibilityListener: (() => void) | null = null;
  private seq = 0;

  start(): void {
    if (this.timer) return;
    const send = (window as unknown as HeartbeatWindow).electronAPI?.rendererHeartbeat;
    if (typeof send !== 'function') return;

    const beat = () => send({
      seq: this.seq++,
      sentAt: Date.now(),
      visibility: document.visibilityState === 'hidden' ? 'hidden' : 'visible',
    });
    beat();
    this.timer = setInterval(beat, HEARTBEAT_INTERVAL_MS);
    this.visibilityListener = beat;
    document.addEventListener('visibilitychange', beat);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.visibilityListener) {
      document.removeEventListener('visibilitychange', this.visibilityListener);
      this.visibilityListener = null;
    }
  }
}
