import type { Page } from 'puppeteer-core';
import { getLogger } from '../logging/logger';

const logger = getLogger('PuppeteerBrowserDriver');

// A wedged renderer (browser-process pings succeed, element ops time out) is only
// recoverable by reloading the target — the canvas/DOM serialization is stuck, so
// retrying element ops just breeds the timeout-driven duplication the anti-throttle
// guards against. Reload is bounded so a still-dead renderer does not hang recovery.
const WEDGE_RECOVERY_RELOAD_TIMEOUT_MS = 30_000;

type ReloadablePage = Page & { reload?: (options?: unknown) => Promise<unknown> };

export interface BrowserWedgeRecoveryDeps {
  /**
   * Reload a wedged target automatically. When false, the wedge is only logged
   * so a human can reload it manually.
   */
  autoRecover: boolean;
  /** Resolve the live Page for a target id (undefined if it is gone). */
  getPage: (targetId: string) => Page | undefined;
}

/**
 * Reloads CDP targets whose renderer has wedged. Fires once per wedge episode
 * (BrowserAntiThrottle only flags a target as wedged on the transition); a
 * per-target guard additionally prevents overlapping reloads if recovery is slow.
 */
export class BrowserWedgeRecovery {
  private readonly recovering = new Set<string>();

  constructor(private readonly deps: BrowserWedgeRecoveryDeps) {}

  /** Log that a previously wedged target became responsive again. */
  recovered(targetId: string): void {
    logger.info(`Browser target ${targetId} recovered and is responsive again.`);
  }

  async recover(targetId: string): Promise<void> {
    logger.warn(
      `Browser target ${targetId} appears wedged: lifecycle pings still succeed but renderer `
      + 'probes are timing out. Element/canvas operations will likely time out.',
    );
    if (!this.deps.autoRecover) {
      logger.warn(
        `Auto-recovery disabled; reload target ${targetId} manually to restore the renderer.`,
      );
      return;
    }
    if (this.recovering.has(targetId)) {
      return;
    }
    const page = this.deps.getPage(targetId) as ReloadablePage | undefined;
    if (!page || typeof page.reload !== 'function') {
      return;
    }
    this.recovering.add(targetId);
    try {
      logger.warn(`Auto-recovering wedged browser target ${targetId} by reloading it.`);
      await page.reload({
        waitUntil: 'domcontentloaded',
        timeout: WEDGE_RECOVERY_RELOAD_TIMEOUT_MS,
      });
      logger.info(`Reloaded wedged browser target ${targetId} to recover the renderer/canvas.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`Failed to reload wedged browser target ${targetId}: ${message}`);
    } finally {
      this.recovering.delete(targetId);
    }
  }
}
