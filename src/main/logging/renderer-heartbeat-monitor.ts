/**
 * RendererHeartbeatMonitor
 *
 * Freeze detection for renderer processes. The renderer sends a heartbeat from
 * its main thread every couple of seconds; when beats stop while the
 * webContents is still alive, the UI event loop is blocked — the failure mode
 * Electron's `unresponsive` event misses when the user isn't interacting
 * (the "7-hour silent freeze" class of incident). Log-only by design: it
 * writes a stall entry when beats stop and a recovery entry (with the outage
 * duration) when they resume, giving every freeze a diagnosis trail.
 */

import { webContents } from 'electron';
import { getLogger } from './logger';

const logger = getLogger('RendererHeartbeat');

/** A renderer that misses beats for this long is considered stalled. */
export const HEARTBEAT_STALL_THRESHOLD_MS = 10_000;
/** How often the watchdog scans tracked renderers for stalls. */
export const HEARTBEAT_WATCHDOG_INTERVAL_MS = 5_000;

interface HeartbeatEntry {
  lastBeatAt: number;
  lastSeq: number;
  /** Set while a stall episode is open so each freeze logs exactly once. */
  stalledSince: number | null;
}

export class RendererHeartbeatMonitor {
  private readonly entries = new Map<number, HeartbeatEntry>();
  private watchdog: ReturnType<typeof setInterval> | null = null;

  /** Record a heartbeat from a renderer webContents. */
  beat(senderId: number, payload: { seq: number; sentAt: number }): void {
    const now = Date.now();
    const entry = this.entries.get(senderId);
    if (!entry) {
      this.entries.set(senderId, { lastBeatAt: now, lastSeq: payload.seq, stalledSince: null });
      this.ensureWatchdog();
      logger.debug('Renderer heartbeat tracking started', { senderId, seq: payload.seq });
      return;
    }

    if (entry.stalledSince !== null) {
      logger.warn('Renderer heartbeat recovered', {
        senderId,
        stalledMs: now - entry.lastBeatAt,
        missedBeats: Math.max(0, payload.seq - entry.lastSeq - 1),
      });
      entry.stalledSince = null;
    }
    entry.lastBeatAt = now;
    entry.lastSeq = payload.seq;
  }

  /** Stop tracking a renderer (its webContents was destroyed). */
  forget(senderId: number): void {
    this.entries.delete(senderId);
    this.stopWatchdogIfIdle();
  }

  /** Whether a tracked renderer is currently inside a stall episode. */
  isStalled(senderId: number): boolean {
    const entry = this.entries.get(senderId);
    return !!entry && entry.stalledSince !== null;
  }

  /** Whether the renderer is currently tracked at all. */
  isTracking(senderId: number): boolean {
    return this.entries.has(senderId);
  }

  private ensureWatchdog(): void {
    if (this.watchdog) return;
    this.watchdog = setInterval(() => this.scan(), HEARTBEAT_WATCHDOG_INTERVAL_MS);
    this.watchdog.unref?.();
  }

  private scan(): void {
    const now = Date.now();
    for (const [senderId, entry] of this.entries) {
      const contents = webContents.fromId(senderId);
      if (!contents || contents.isDestroyed()) {
        // Renderer went away entirely — not a freeze; render-process-gone /
        // window teardown own that story.
        this.entries.delete(senderId);
        continue;
      }
      const gapMs = now - entry.lastBeatAt;
      if (gapMs >= HEARTBEAT_STALL_THRESHOLD_MS && entry.stalledSince === null) {
        entry.stalledSince = now;
        logger.error('Renderer heartbeat stalled — UI event loop likely blocked', undefined, {
          senderId,
          gapMs,
          lastSeq: entry.lastSeq,
        });
      }
    }
    this.stopWatchdogIfIdle();
  }

  private stopWatchdogIfIdle(): void {
    if (this.entries.size === 0 && this.watchdog) {
      clearInterval(this.watchdog);
      this.watchdog = null;
    }
  }

  _resetForTesting(): void {
    if (this.watchdog) {
      clearInterval(this.watchdog);
      this.watchdog = null;
    }
    this.entries.clear();
  }
}

let singleton: RendererHeartbeatMonitor | null = null;

export function getRendererHeartbeatMonitor(): RendererHeartbeatMonitor {
  if (!singleton) singleton = new RendererHeartbeatMonitor();
  return singleton;
}

export function _resetRendererHeartbeatMonitorForTesting(): void {
  singleton?._resetForTesting();
  singleton = null;
}
