import { getLogger } from '../logging/logger';

const logger = getLogger('EvidenceMaintenance');
export const EVIDENCE_MAINTENANCE_START_DELAY_MS = 5_000;

/** A runtime generation owns one delayed sweep, including its cancellation. */
export class EvidenceMaintenanceScheduler {
  private readonly controller = new AbortController();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private run: Promise<void> | null = null;
  private started = false;

  constructor(private readonly maintain: (signal: AbortSignal) => Promise<void>) {}

  start(): void {
    if (this.started || this.controller.signal.aborted) return;
    this.started = true;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.controller.signal.aborted) return;
      const startedAt = performance.now();
      logger.info('Evidence maintenance started');
      this.run = this.maintain(this.controller.signal).then(() => {
        this.controller.signal.throwIfAborted();
        logger.info('Evidence maintenance finished', { durationMs: performance.now() - startedAt });
      }).catch(() => {
        logger.warn('Evidence maintenance stopped', {
          failureCode: this.controller.signal.aborted ? 'cancelled' : 'maintenance-failed',
          durationMs: performance.now() - startedAt,
        });
      });
    }, EVIDENCE_MAINTENANCE_START_DELAY_MS);
    this.timer.unref?.();
  }

  abort(): void {
    this.controller.abort();
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  async stop(): Promise<void> {
    this.abort();
    // Await the actual work. A timeout does not cancel a SQLite or filesystem call.
    await this.run;
  }
}
