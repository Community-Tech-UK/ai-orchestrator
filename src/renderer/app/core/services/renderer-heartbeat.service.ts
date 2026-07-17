import { Injectable } from '@angular/core';

/** Beat cadence. Main considers the renderer stalled after ~10s without one. */
export const HEARTBEAT_INTERVAL_MS = 2_000;

/** Window type that may have the Electron preload API. */
interface HeartbeatWindow {
  electronAPI?: {
    infrastructure?: {
      rendererHeartbeat?: (payload: { seq: number; sentAt: number }) => void;
    };
  };
}

/**
 * Sends a periodic heartbeat to the main process from the renderer's MAIN
 * thread — deliberately not a worker: when the UI event loop is blocked the
 * beats stop, and that silence is exactly the freeze signal the main-process
 * monitor turns into diagnostics. App-lifetime singleton started once from
 * the app initializer; no-op outside Electron (tests, plain browser).
 */
@Injectable({ providedIn: 'root' })
export class RendererHeartbeatService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private seq = 0;

  start(): void {
    if (this.timer) return;
    const send = (window as unknown as HeartbeatWindow).electronAPI?.infrastructure?.rendererHeartbeat;
    if (typeof send !== 'function') return;

    const beat = () => send({ seq: this.seq++, sentAt: Date.now() });
    beat();
    this.timer = setInterval(beat, HEARTBEAT_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
