/**
 * State holder for one "Where your usage went" card.
 *
 * Provided by the card itself, so every card has its own view and its own polling.
 * The first read of a big transcript folder can take a while on the main side, so
 * the controller shows what is happening (reading N of M files) and keeps asking
 * until there is a report. A later refresh keeps the old report on screen and says
 * it is updating.
 *
 * Several requests can be in flight at once (a poll and a press of Refresh, say), and
 * answers can arrive in any order. Only the newest answer for the session on screen is
 * ever shown, and nothing arriving after the card has gone changes anything.
 */

import { DestroyRef, Injectable, inject, signal } from '@angular/core';
import { UsageInsightIpcService } from '../../core/services/ipc/usage-insight-ipc.service';
import { RendererPollSchedulerService } from '../../core/services/renderer-poll-scheduler.service';
import type {
  UsageInsightReport,
  UsageInsightResponse,
  UsageInsightUnsupportedReason,
  UsageScanProgress,
} from '../../../../shared/usage-insight/usage-insight.types';
import { presentUsageFailure, type UsageFailure } from './usage-insight-failure';

export type UsageInsightView =
  | { phase: 'loading' }
  | { phase: 'scanning'; progress: UsageScanProgress }
  | { phase: 'ready'; report: UsageInsightReport; refreshing: boolean; refreshFailure?: UsageFailure }
  | { phase: 'unsupported'; reason: UsageInsightUnsupportedReason }
  | { phase: 'error'; failure: UsageFailure };

const POLL_MS = 1500;
const NO_ANSWER = 'No answer from Harness.';

@Injectable()
export class UsageInsightController {
  private readonly ipc = inject(UsageInsightIpcService);
  private readonly poller = inject(RendererPollSchedulerService);

  private readonly state = signal<UsageInsightView>({ phase: 'loading' });
  readonly view = this.state.asReadonly();

  private instanceId: string | null = null;
  /** Bumped whenever the scope changes, so a slow answer for the old scope is ignored. */
  private generation = 0;
  /** Number of the latest request sent, and of the newest answer shown. */
  private issued = 0;
  private shown = 0;
  /** Requests sent and not yet answered. */
  private waiting = 0;
  private destroyed = false;
  private stopPolling: (() => void) | null = null;

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      this.destroyed = true;
      this.generation += 1;
      this.stopPolling?.();
      this.stopPolling = null;
    });
  }

  /** Show the report for one session, or for every session when `instanceId` is null. */
  async open(instanceId: string | null): Promise<void> {
    if (this.destroyed) return;
    this.instanceId = instanceId;
    this.generation += 1;
    this.setPolling(false);
    this.state.set({ phase: 'loading' });
    await this.fetch(false);
  }

  /** Ask the main process to read the transcripts again. */
  async refresh(): Promise<void> {
    if (this.destroyed) return;
    // With a report on screen it stays up while the new read runs.
    if (this.state().phase !== 'ready') this.state.set({ phase: 'loading' });
    await this.fetch(true);
  }

  private async fetch(refresh: boolean): Promise<void> {
    const generation = this.generation;
    const sequence = ++this.issued;
    let outcome: { response: UsageInsightResponse } | { failure: UsageFailure };
    this.waiting += 1;
    try {
      const result = await this.ipc.get({
        ...(this.instanceId ? { instanceId: this.instanceId } : {}),
        ...(refresh ? { refresh: true } : {}),
      });
      outcome = result.success && result.data
        ? { response: result.data }
        : { failure: presentUsageFailure(result.error ?? NO_ANSWER) };
    } catch (error) {
      outcome = { failure: presentUsageFailure(error) };
    } finally {
      this.waiting -= 1;
    }
    // Only the newest answer for the session on screen may change anything.
    if (this.destroyed || generation !== this.generation || sequence < this.shown) return;
    this.shown = sequence;

    const current = this.state();
    if ('failure' in outcome) {
      // A report already on screen stays; the failure is shown beside it.
      this.state.set(current.phase === 'ready'
        ? { ...current, refreshing: false, refreshFailure: outcome.failure }
        : { phase: 'error', failure: outcome.failure });
      this.setPolling(false);
      return;
    }

    const next = outcome.response;
    switch (next.status) {
      case 'ready':
        this.state.set({
          phase: 'ready',
          report: next.report,
          refreshing: next.refreshing,
          ...(next.refreshError ? { refreshFailure: presentUsageFailure(next.refreshError) } : {}),
        });
        break;
      case 'scanning':
        this.state.set({ phase: 'scanning', progress: next.progress });
        break;
      case 'unsupported':
        this.state.set({ phase: 'unsupported', reason: next.reason });
        break;
      case 'error':
        this.state.set({ phase: 'error', failure: presentUsageFailure(next.message) });
        break;
    }
    this.setPolling(next.status === 'scanning' || (next.status === 'ready' && next.refreshing));
  }

  private setPolling(on: boolean): void {
    if (on && !this.stopPolling && !this.destroyed) {
      // A poll waits its turn: it is skipped while an earlier request is still unanswered.
      this.stopPolling = this.poller.register(() => (this.waiting > 0 ? undefined : this.fetch(false)), POLL_MS);
    } else if (!on && this.stopPolling) {
      this.stopPolling();
      this.stopPolling = null;
    }
  }
}
