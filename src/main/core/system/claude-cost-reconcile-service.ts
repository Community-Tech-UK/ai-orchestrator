/**
 * Runs the Claude cost check once a day and keeps the latest result for the Costs page.
 *
 * Schedule: a check shortly after start-up when none ran in the last day (so a laptop
 * that sleeps through midnight still gets one), then every 24 hours; a failed check
 * is retried after an hour. All dependencies are injected so the schedule, storage and
 * failure paths are tested without a database, Electron or real transcripts.
 */

import { join } from 'path';
import type { ClaudeCostReconcileReport, ClaudeCostReconcileSnapshot } from '../../../shared/types/claude-cost-reconcile.types';
import { getLogger } from '../../logging/logger';
import { reconcileClaudeCosts, type StoredClaudeSession } from './claude-cost-reconcile';
import { ClaudeCostReconcileStore, type ClaudeCostReconcileState, RECONCILE_HISTORY_LIMIT } from './claude-cost-reconcile-store';
import { indexClaudeTranscripts, readSettledCostState, type ClaudeCostStateRead } from './claude-cost-state-reader';

const logger = getLogger('ClaudeCostReconcile');

export const RECONCILE_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const RECONCILE_RETRY_MS = 60 * 60 * 1000;
export const RECONCILE_STARTUP_DELAY_MS = 2 * 60 * 1000;
/** Long enough that a session which ended late yesterday is still examined today. */
export const RECONCILE_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;
export const RECONCILE_STATE_FILE = 'claude-cost-reconcile.json';

export interface ClaudeCostReconcileServiceDeps {
  statePath: string;
  loadSessions(windowStart: number): StoredClaudeSession[];
  bookingLiveAt(): number | null;
  transcriptRoots(): string[];
  now?(): number;
  indexTranscripts?(roots: string[]): Promise<Map<string, string>>;
  readState?(file: string): Promise<ClaudeCostStateRead>;
  yieldTurn?(): Promise<void>;
}

export function reconcileStatePath(userDataPath: string): string {
  return join(userDataPath, RECONCILE_STATE_FILE);
}

export class ClaudeCostReconcileService {
  private static instance: ClaudeCostReconcileService | null = null;

  static getInstance(): ClaudeCostReconcileService {
    if (!ClaudeCostReconcileService.instance) ClaudeCostReconcileService.instance = new ClaudeCostReconcileService();
    return ClaudeCostReconcileService.instance;
  }

  static _resetForTesting(): void {
    ClaudeCostReconcileService.instance?.stop();
    ClaudeCostReconcileService.instance = null;
  }

  private deps: ClaudeCostReconcileServiceDeps | null = null;
  private store: ClaudeCostReconcileStore | null = null;
  private state: ClaudeCostReconcileState = { latest: null, history: [], lastAttemptAt: null, lastError: null };
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: Promise<ClaudeCostReconcileReport | null> | null = null;
  private started = false;
  /** Bumped by stop, configure and shutdown: a check started under an older value must not write anything. */
  private generation = 0;

  configure(deps: ClaudeCostReconcileServiceDeps): void {
    this.stop();
    this.deps = deps;
    this.store = new ClaudeCostReconcileStore(deps.statePath);
    this.state = this.store.load();
  }

  /** Schedule the daily check. Harmless before `configure`. */
  start(): void {
    if (!this.deps) {
      logger.warn('Claude cost check not started: not configured');
      return;
    }
    this.started = true;
    const now = this.now();
    const interval = this.state.lastError ? RECONCILE_RETRY_MS : RECONCILE_INTERVAL_MS;
    const due = this.state.lastAttemptAt === null ? now : this.state.lastAttemptAt + interval;
    // Clamped so a saved time in the future (a clock change) can neither overflow the timer nor postpone the check for long.
    this.schedule(Math.min(RECONCILE_INTERVAL_MS, Math.max(RECONCILE_STARTUP_DELAY_MS, due - now)));
  }

  /** Cancel the schedule and discard any check still running; it can neither save nor report. */
  stop(): void {
    this.started = false;
    this.generation++;
    this.inFlight = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** App shutdown: as stop, and the service stays unusable until it is configured again. */
  shutdown(): void {
    this.stop();
    this.deps = null;
    this.store = null;
  }

  getSnapshot(): ClaudeCostReconcileSnapshot {
    return { latest: this.state.latest, history: this.state.history, running: this.inFlight !== null, lastError: this.state.lastError };
  }

  /** Run a check now. Callers that arrive while one is running share its result. Never rejects. */
  runNow(): Promise<ClaudeCostReconcileReport | null> {
    if (!this.deps || !this.store) return Promise.resolve(null);
    if (this.inFlight) return this.inFlight;
    const run = this.execute(this.deps, this.store, this.generation).finally(() => {
      // Only the check that is still current may clear the marker; a discarded one must not touch its successor's.
      if (this.inFlight === run) this.inFlight = null;
    });
    this.inFlight = run;
    return run;
  }

  private now(): number {
    return this.deps?.now?.() ?? Date.now();
  }

  private schedule(delayMs: number): void {
    if (this.timer) clearTimeout(this.timer);
    const generation = this.generation;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.runNow().then(() => {
        if (this.started && generation === this.generation) this.schedule(this.state.lastError ? RECONCILE_RETRY_MS : RECONCILE_INTERVAL_MS);
      });
    }, delayMs);
    this.timer.unref?.();
  }

  private async execute(deps: ClaudeCostReconcileServiceDeps, store: ClaudeCostReconcileStore, generation: number): Promise<ClaudeCostReconcileReport | null> {
    const checkedAt = this.now();
    this.state = { ...this.state, lastAttemptAt: checkedAt };
    try {
      const windowStart = checkedAt - RECONCILE_WINDOW_MS;
      const sessions = deps.loadSessions(windowStart);
      const index = await (deps.indexTranscripts ?? indexClaudeTranscripts)(deps.transcriptRoots());
      const read = deps.readState ?? readSettledCostState;
      const report = await reconcileClaudeCosts(
        { sessions, bookingLiveAt: deps.bookingLiveAt(), now: checkedAt, windowStart },
        {
          readState: async id => { const file = index.get(id); return file ? read(file) : 'no-transcript'; },
          yieldTurn: deps.yieldTurn ?? (() => new Promise<void>(resolve => setImmediate(resolve))),
        },
      );
      if (generation !== this.generation) return null;
      this.state = {
        latest: report,
        history: [{ checkedAt, status: report.status, total: report.total }, ...this.state.history].slice(0, RECONCILE_HISTORY_LIMIT),
        lastAttemptAt: checkedAt,
        lastError: null,
      };
      store.save(this.state);
      logger.info('Claude cost check finished', { status: report.status, compared: report.coverage.compared, driftPct: report.total.driftPct });
      return report;
    } catch (error) {
      if (generation !== this.generation) return null;
      this.state = { ...this.state, lastError: String(error instanceof Error ? error.message : error).slice(0, 200) };
      store.save(this.state);
      logger.warn('Claude cost check failed', { error: this.state.lastError });
      return null;
    }
  }
}

export function getClaudeCostReconcileService(): ClaudeCostReconcileService {
  return ClaudeCostReconcileService.getInstance();
}
