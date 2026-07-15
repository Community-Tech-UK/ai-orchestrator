import type { LoopIteration, LoopState } from '../../shared/types/loop.types';
import { getLogger } from '../logging/logger';
import { getRLMDatabase } from '../persistence/rlm-database';
import type { LoopCompletionDetector, VerifyOutcome } from './loop-completion-detector';
import { VerificationRunRecorder } from './verification-run-recorder';
import { VerificationRunStore, type VerificationRun } from './verification-run-store';

const logger = getLogger('LoopVerificationRunLedger');

type VerificationRunRecorderPort = Pick<VerificationRunRecorder, 'record'>;
type VerificationRunReaderPort = Pick<VerificationRunStore, 'listForLoop'>;

interface VerificationExecution {
  command: string;
  exitCode: number | null;
  durationMs: number;
  output: string;
  startedAt: number;
}

/**
 * Adds a fail-soft, durable execution trail around the loop's existing verify
 * runner. It owns no completion decisions; the caller still interprets every
 * verify outcome exactly as before.
 */
export class LoopVerificationRunLedger {
  private recorder: VerificationRunRecorderPort | null = null;
  private recorderResolved = false;
  private runReader: VerificationRunReaderPort | null = null;
  private runReaderResolved = false;

  setRecorder(recorder: VerificationRunRecorderPort | null): void {
    this.recorder = recorder;
    this.recorderResolved = true;
  }

  /** Override the durable run reader for completion resolution tests. */
  setRunReader(reader: VerificationRunReaderPort | null): void {
    this.runReader = reader;
    this.runReaderResolved = true;
  }

  resetForTesting(): void {
    this.recorder = null;
    this.recorderResolved = false;
    this.runReader = null;
    this.runReaderResolved = false;
  }

  /**
   * Reads execution evidence for one loop. `undefined` means the durable
   * store is unavailable, distinct from an available empty ledger.
   */
  listForLoop(loopRunId: string): readonly VerificationRun[] | undefined {
    const reader = this.resolveRunReader();
    if (!reader) return undefined;
    try {
      return reader.listForLoop(loopRunId);
    } catch (err) {
      logger.warn('Verification run ledger read failed (fail-open)', {
        loopRunId,
        error: err instanceof Error ? err.message : String(err),
      });
      return undefined;
    }
  }

  async run(
    state: LoopState,
    iteration: LoopIteration | undefined,
    kind: 'verify' | 'quick-verify',
    detector: Pick<LoopCompletionDetector, 'runQuickVerify' | 'runVerify'>,
  ): Promise<VerifyOutcome> {
    const startedAt = Date.now();
    const outcome = kind === 'quick-verify'
      ? await detector.runQuickVerify(state.config)
      : await detector.runVerify(state.config);
    const command = kind === 'quick-verify'
      ? state.config.completion.quickVerifyCommand?.trim()
      : state.config.completion.verifyCommand.trim();
    if (command && outcome.status !== 'skipped') {
      this.record(state, iteration, {
        command,
        exitCode: outcome.status === 'passed' ? 0 : outcome.exitCode,
        durationMs: outcome.durationMs,
        output: outcome.output,
        startedAt,
      });
    }
    return outcome;
  }

  record(state: LoopState, iteration: LoopIteration | undefined, execution: VerificationExecution): void {
    const recorder = this.resolveRecorder();
    if (!recorder) return;
    try {
      recorder.record({
        scope: 'loop',
        loopRunId: state.id,
        command: execution.command,
        cwd: state.config.executionCwd?.trim() || state.config.workspaceCwd,
        exitCode: execution.exitCode,
        durationMs: execution.durationMs,
        ...(iteration ? { workHash: iteration.workHash } : {}),
        output: execution.output,
        startedAt: execution.startedAt,
      });
    } catch (err) {
      logger.warn('Verification run recorder failed (fail-soft)', {
        loopRunId: state.id,
        command: execution.command,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private resolveRecorder(): VerificationRunRecorderPort | null {
    if (this.recorder) return this.recorder;
    if (this.recorderResolved) return null;
    this.recorderResolved = true;
    try {
      const rlm = getRLMDatabase();
      if (!rlm.isInitialized()) return null;
      this.recorder = VerificationRunRecorder.getInstance();
      return this.recorder;
    } catch (err) {
      logger.warn('Verification run recorder unavailable (ledger disabled)', {
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  private resolveRunReader(): VerificationRunReaderPort | null {
    if (this.runReader) return this.runReader;
    if (this.runReaderResolved) return null;
    this.runReaderResolved = true;
    try {
      const rlm = getRLMDatabase();
      if (!rlm.isInitialized()) return null;
      this.runReader = VerificationRunStore.getInstance();
      return this.runReader;
    } catch (err) {
      logger.warn('Verification run reader unavailable (ledger read disabled)', {
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }
}
