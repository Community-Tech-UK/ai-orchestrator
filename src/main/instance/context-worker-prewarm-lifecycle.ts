import { getLogger } from '../logging/logger';

const logger = getLogger('ContextWorkerPrewarmLifecycle');

/**
 * Tracks app readiness independently from the current context-worker generation.
 * Each generation can claim the post-ready prewarm start exactly once.
 */
export class ContextWorkerPrewarmLifecycle {
  private appReady = false;
  private generation = 0;
  private readyGeneration = -1;
  private startedGeneration = -1;

  constructor(private readonly onStart: () => Promise<boolean> | undefined) {}

  beginWorker(): void {
    this.generation++;
    this.readyGeneration = -1;
  }

  signalAppReady(): boolean {
    const firstSignal = !this.appReady;
    this.appReady = true;
    this.startIfReady();
    return firstSignal;
  }

  markWorkerReady(): void {
    this.readyGeneration = this.generation;
    this.startIfReady();
  }

  private startIfReady(): void {
    if (
      !this.appReady
      || this.readyGeneration !== this.generation
      || this.startedGeneration === this.generation
    ) return;
    this.startedGeneration = this.generation;
    void this.onStart()?.catch((error: unknown) => {
      logger.warn('Post-ready RLM prewarm could not be started', {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }
}
