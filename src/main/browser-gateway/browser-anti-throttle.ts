import type { BrowserCdpSession } from './browser-download-watcher';

/**
 * Minimal page surface needed to open a CDP session. Mirrors the puppeteer
 * `Page` shape without depending on it so this module stays test-friendly.
 */
export interface AntiThrottlePage {
  createCDPSession?: () => Promise<BrowserCdpSession>;
  target?: () => { createCDPSession?: () => Promise<BrowserCdpSession> };
}

export interface BrowserAntiThrottleOptions {
  /** Defaults to enabled; disable in tests that do not exercise it. */
  enabled?: boolean;
  /** Interval (ms) between lifecycle heartbeats. Floored at 1s. */
  heartbeatMs?: number;
  /** Override CDP session creation (defaults to the page's own factory). */
  createSession?: (page: AntiThrottlePage) => Promise<BrowserCdpSession>;
  /**
   * Run a renderer-level liveness probe on each heartbeat to detect a "wedged"
   * target — one where browser-process calls still succeed but the renderer has
   * stalled, so element/canvas operations silently time out. Default true.
   */
  probeRenderer?: boolean;
  /** Timeout (ms) for the renderer liveness probe. Floored at 500ms. Default 5000. */
  probeTimeoutMs?: number;
  /** Consecutive failed probes before a target is flagged wedged. Floored at 1. Default 2. */
  wedgedThreshold?: number;
  /** Called once when a target transitions into the wedged state. */
  onWedged?: (targetId: string) => void;
  /** Called once when a previously wedged target becomes responsive again. */
  onRecovered?: (targetId: string) => void;
}

interface AntiThrottleKeepAlive {
  session: BrowserCdpSession;
  timer: ReturnType<typeof setInterval>;
  /** Consecutive renderer-probe failures. Reset to 0 on any success. */
  failures: number;
  /** True once `failures` crossed the threshold; cleared on recovery. */
  wedged: boolean;
  /** Guards against overlapping heartbeat ticks if one runs long. */
  ticking: boolean;
}

async function defaultCreateSession(page: AntiThrottlePage): Promise<BrowserCdpSession> {
  const session = page.createCDPSession
    ? await page.createCDPSession()
    : await page.target?.().createCDPSession?.();
  if (!session) {
    throw new Error('Browser page does not expose a CDP session.');
  }
  return session;
}

/**
 * Keeps CDP-driven pages reporting as visible/focused and out of the
 * frozen/discarded lifecycle states even when their tab is backgrounded.
 *
 * When a page's tab is not the foreground tab, Chrome pauses timers/rAF and can
 * freeze or discard the renderer. That silently times out subsequent
 * canvas/element CDP calls mid-automation — and a blind retry of a
 * non-idempotent op then duplicates work. Focus emulation keeps
 * `document.visibilityState === 'visible'`; a periodic lifecycle heartbeat keeps
 * Memory Saver from freezing/discarding the tab.
 *
 * Each heartbeat also runs a renderer-level liveness probe. The lifecycle/focus
 * commands are handled by the browser process and keep succeeding even when the
 * renderer has wedged, so a probe that hits the renderer (Runtime.evaluate) is
 * what actually detects "page pings fine but element ops time out". After
 * `wedgedThreshold` consecutive probe timeouts the target is flagged via
 * `onWedged` so a caller can surface it / reload the target instead of letting
 * non-idempotent operations time out and get blindly retried.
 */
export class BrowserAntiThrottle {
  private readonly enabled: boolean;
  private readonly heartbeatMs: number;
  private readonly createSession: (page: AntiThrottlePage) => Promise<BrowserCdpSession>;
  private readonly probeRenderer: boolean;
  private readonly probeTimeoutMs: number;
  private readonly wedgedThreshold: number;
  private readonly onWedged?: (targetId: string) => void;
  private readonly onRecovered?: (targetId: string) => void;
  private readonly keepAlive = new Map<string, AntiThrottleKeepAlive>();

  constructor(options: BrowserAntiThrottleOptions = {}) {
    this.enabled = options.enabled ?? true;
    this.heartbeatMs = Math.max(1_000, options.heartbeatMs ?? 25_000);
    this.createSession = options.createSession ?? defaultCreateSession;
    this.probeRenderer = options.probeRenderer ?? true;
    this.probeTimeoutMs = Math.max(500, options.probeTimeoutMs ?? 5_000);
    this.wedgedThreshold = Math.max(1, options.wedgedThreshold ?? 2);
    this.onWedged = options.onWedged;
    this.onRecovered = options.onRecovered;
  }

  /** Attach focus emulation + lifecycle heartbeat to a freshly indexed page. */
  async register(targetId: string, page: AntiThrottlePage): Promise<void> {
    if (!this.enabled || this.keepAlive.has(targetId)) {
      return;
    }
    if (typeof page.createCDPSession !== 'function' && typeof page.target !== 'function') {
      // Lightweight/test page without a CDP session — nothing to keep alive.
      return;
    }

    let session: BrowserCdpSession;
    try {
      session = await this.createSession(page);
    } catch {
      // Best-effort: a page that cannot open a CDP session simply forgoes the
      // anti-throttle protection rather than failing the open/index flow.
      return;
    }

    await this.safeSend(session, 'Emulation.setFocusEmulationEnabled', { enabled: true });
    await this.safeSend(session, 'Page.enable');
    await this.markActive(session);

    const timer = setInterval(() => {
      void this.tick(targetId);
    }, this.heartbeatMs);
    if (typeof timer.unref === 'function') {
      timer.unref();
    }
    this.keepAlive.set(targetId, {
      session,
      timer,
      failures: 0,
      wedged: false,
      ticking: false,
    });
  }

  /** True if the target is currently flagged as wedged (renderer unresponsive). */
  isWedged(targetId: string): boolean {
    return this.keepAlive.get(targetId)?.wedged ?? false;
  }

  /** Target ids whose renderer is currently wedged. */
  wedgedTargets(): string[] {
    return Array.from(this.keepAlive.entries())
      .filter(([, entry]) => entry.wedged)
      .map(([targetId]) => targetId);
  }

  private async tick(targetId: string): Promise<void> {
    const entry = this.keepAlive.get(targetId);
    if (!entry || entry.ticking) {
      return;
    }
    entry.ticking = true;
    try {
      // Re-assert focus emulation each tick in case the renderer reset it, then
      // refresh the active lifecycle. setWebLifecycleState is a browser-process
      // command, so a failure here means the CDP session itself is gone (tab
      // closed / navigated cross-process) — stop the heartbeat to avoid leaking
      // a dead timer.
      await this.safeSend(entry.session, 'Emulation.setFocusEmulationEnabled', {
        enabled: true,
      });
      const alive = await this.markActive(entry.session);
      if (!alive) {
        await this.stop(targetId);
        return;
      }
      if (this.probeRenderer) {
        await this.runProbe(targetId, entry);
      }
    } finally {
      entry.ticking = false;
    }
  }

  private async runProbe(targetId: string, entry: AntiThrottleKeepAlive): Promise<void> {
    const responsive = await this.probe(entry.session);
    if (responsive) {
      entry.failures = 0;
      if (entry.wedged) {
        entry.wedged = false;
        this.onRecovered?.(targetId);
      }
      return;
    }
    entry.failures += 1;
    if (!entry.wedged && entry.failures >= this.wedgedThreshold) {
      entry.wedged = true;
      this.onWedged?.(targetId);
    }
  }

  private async probe(session: BrowserCdpSession): Promise<boolean> {
    try {
      await this.withTimeout(
        session.send('Runtime.evaluate', { expression: '1', returnByValue: true }),
        this.probeTimeoutMs,
      );
      return true;
    } catch {
      return false;
    }
  }

  private withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('anti_throttle_probe_timeout'));
      }, ms);
      if (typeof timer.unref === 'function') {
        timer.unref();
      }
      promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error: unknown) => {
          clearTimeout(timer);
          reject(error instanceof Error ? error : new Error(String(error)));
        },
      );
    });
  }

  /** Stop the heartbeat for a single target and detach its session. */
  async stop(targetId: string): Promise<void> {
    const entry = this.keepAlive.get(targetId);
    if (!entry) {
      return;
    }
    this.keepAlive.delete(targetId);
    clearInterval(entry.timer);
    await this.detach(entry.session);
  }

  /** Stop heartbeats for every target whose id belongs to the given profile. */
  async stopForProfile(profileId: string): Promise<void> {
    for (const targetId of Array.from(this.keepAlive.keys())) {
      if (targetId.startsWith(`${profileId}:`)) {
        await this.stop(targetId);
      }
    }
  }

  private async markActive(session: BrowserCdpSession): Promise<boolean> {
    return this.safeSend(session, 'Page.setWebLifecycleState', { state: 'active' });
  }

  private async safeSend(
    session: BrowserCdpSession,
    method: string,
    params?: Record<string, unknown>,
  ): Promise<boolean> {
    try {
      await session.send(method, params);
      return true;
    } catch {
      return false;
    }
  }

  private async detach(session: BrowserCdpSession): Promise<void> {
    const detachable = session as BrowserCdpSession & { detach?: () => Promise<void> };
    if (typeof detachable.detach === 'function') {
      await detachable.detach().catch(() => undefined);
    }
  }
}
