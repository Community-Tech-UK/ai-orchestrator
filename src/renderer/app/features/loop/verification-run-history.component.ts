import {
  ChangeDetectionStrategy,
  Component,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';
import type { VerificationRunPayload } from '@contracts/schemas/loop';
import { LoopIpcService } from '../../core/services/ipc/loop-ipc.service';
import { formatTimestamp, humanDuration } from './loop-formatters.util';

export type VerificationRunFreshness = 'fresh' | 'stale' | 'unknown';

/** Whether a durable run was executed against the loop's displayed work state.
 * This is deliberately independent of pass/fail: a failed command can still
 * be current, while a passing command against older files cannot prove today. */
export function verificationRunFreshness(
  run: Pick<VerificationRunPayload, 'workHash'>,
  currentWorkHash: string | null,
): VerificationRunFreshness {
  if (!run.workHash || !currentWorkHash) return 'unknown';
  return run.workHash === currentWorkHash ? 'fresh' : 'stale';
}

export function verificationRunResultLabel(exitCode: number | null): string {
  if (exitCode === 0) return 'passed';
  if (exitCode === null) return 'did not exit';
  return `failed (exit ${exitCode})`;
}

/** Compact, read-only evidence ledger for a loop detail / inspector view. */
@Component({
  selector: 'app-verification-run-history',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (loopRunId()) {
      <details class="verification-runs">
        <summary>
          Verification executions
          @if (loading()) { <span class="vr-subtle">loading…</span> }
          @else if (runs().length > 0) { <span class="vr-subtle">({{ runs().length }})</span> }
        </summary>
        @if (error()) {
          <p class="vr-error">{{ error() }}</p>
        } @else if (!loading() && runs().length === 0) {
          <p class="vr-empty">No coordinator-observed verification executions yet.</p>
        } @else if (runs().length > 0) {
          <div class="vr-list" role="list">
            @for (run of runs(); track run.id) {
              <div class="vr-row" role="listitem">
                <div class="vr-row-head">
                  <span class="vr-result" [attr.data-result]="run.exitCode === 0 ? 'passed' : 'failed'">{{ result(run.exitCode) }}</span>
                  <span class="vr-freshness" [attr.data-freshness]="freshness(run)">{{ freshness(run) }}</span>
                  <span class="vr-age" [title]="timestamp(run.startedAt)">{{ timestamp(run.startedAt) }}</span>
                  <span class="vr-duration">{{ duration(run.durationMs) }}</span>
                </div>
                <code class="vr-command">{{ run.command }}</code>
              </div>
            }
          </div>
        }
      </details>
    }
  `,
  styles: [`
    .verification-runs { margin-top: 10px; font-size: 12px; }
    .verification-runs > summary { cursor: pointer; font-weight: 600; }
    .vr-subtle, .vr-age, .vr-duration { opacity: .65; font-weight: 400; }
    .vr-list { display: grid; gap: 6px; margin-top: 8px; }
    .vr-row { padding: 7px 8px; border: 1px solid rgba(255,255,255,.08); border-radius: 4px; background: rgba(0,0,0,.16); }
    .vr-row-head { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin-bottom: 4px; font-size: 11px; }
    .vr-result, .vr-freshness { padding: 1px 5px; border-radius: 3px; font-weight: 600; font-size: 10px; }
    .vr-result[data-result="passed"] { color: #8edc8e; background: rgba(142,220,142,.12); }
    .vr-result[data-result="failed"] { color: #f78c7c; background: rgba(247,140,124,.12); }
    .vr-freshness[data-freshness="fresh"] { color: #8ecae6; background: rgba(142,202,230,.12); }
    .vr-freshness[data-freshness="stale"] { color: #f7c07a; background: rgba(247,192,122,.12); }
    .vr-freshness[data-freshness="unknown"] { opacity: .65; background: rgba(255,255,255,.08); }
    .vr-command { display: block; overflow-wrap: anywhere; white-space: pre-wrap; font-size: 11px; }
    .vr-empty, .vr-error { margin: 8px 0 0; opacity: .7; }
    .vr-error { color: #f78c7c; opacity: 1; }
  `],
})
export class VerificationRunHistoryComponent {
  loopRunId = input<string | null>(null);
  currentWorkHash = input<string | null>(null);
  /** Changes whenever the inspected loop records another completed iteration. */
  refreshKey = input<number | null>(null);

  private readonly ipc = inject(LoopIpcService);
  protected readonly runs = signal<VerificationRunPayload[]>([]);
  protected readonly loading = signal(false);
  protected readonly error = signal<string | null>(null);
  private requestSequence = 0;

  constructor() {
    effect(() => {
      const loopRunId = this.loopRunId();
      this.refreshKey();
      untracked(() => {
        const request = ++this.requestSequence;
        this.runs.set([]);
        this.error.set(null);
        if (!loopRunId) {
          this.loading.set(false);
          return;
        }
        void this.load(loopRunId, request);
      });
    });
  }

  protected freshness(run: VerificationRunPayload): VerificationRunFreshness {
    return verificationRunFreshness(run, this.currentWorkHash());
  }

  protected result(exitCode: number | null): string {
    return verificationRunResultLabel(exitCode);
  }

  protected timestamp(value: number): string {
    return formatTimestamp(value);
  }

  protected duration(value: number): string {
    return humanDuration(value);
  }

  private async load(loopRunId: string, request: number): Promise<void> {
    this.loading.set(true);
    try {
      const response = await this.ipc.listVerificationRuns({ loopRunId });
      if (request !== this.requestSequence) return;
      if (response.success && response.data) {
        this.runs.set(response.data.runs);
      } else {
        this.error.set(response.error?.message ?? 'Could not load verification history.');
      }
    } catch {
      if (request === this.requestSequence) {
        this.error.set('Could not load verification history.');
      }
    } finally {
      if (request === this.requestSequence) this.loading.set(false);
    }
  }
}
