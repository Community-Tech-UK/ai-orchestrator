import type { LoopIteration, LoopState } from '../../shared/types/loop.types';
import { getLogger } from '../logging/logger';
import { getRLMDatabase } from '../persistence/rlm-database';
import type { LoopCompletionDetector, VerifyOutcome } from './loop-completion-detector';
import { loopExecutionCwd } from './loop-cwd';
import { VerificationRunRecorder } from './verification-run-recorder';
import { VerificationRunStore, type VerificationRun } from './verification-run-store';
import {
  computeVerifyTreeHash,
  LoopVerifyReplayCache,
  renderReplayNotice,
  type VerifyReplayKey,
} from './loop-verify-replay';

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
  /** L2 — identical-tree red replay. In-process and bounded; see the module. */
  private readonly replayCache = new LoopVerifyReplayCache();
  private computeTreeHash: (cwd: string) => string | null = (cwd) => computeVerifyTreeHash(cwd);

  setRecorder(recorder: VerificationRunRecorderPort | null): void {
    this.recorder = recorder;
    this.recorderResolved = true;
  }

  /** Override the durable run reader for completion resolution tests. */
  setRunReader(reader: VerificationRunReaderPort | null): void {
    this.runReader = reader;
    this.runReaderResolved = true;
  }

  /** Override the tree-hash probe (L2) so replay behaviour is unit-testable. */
  setTreeHasher(hasher: (cwd: string) => string | null): void {
    this.computeTreeHash = hasher;
  }

  /** Drop replayable verify results for one loop (or all of them). */
  clearReplayCache(loopRunId?: string): void {
    this.replayCache.clear(loopRunId);
  }

  resetForTesting(): void {
    this.recorder = null;
    this.recorderResolved = false;
    this.runReader = null;
    this.runReaderResolved = false;
    this.replayCache.clear();
    this.computeTreeHash = (cwd) => computeVerifyTreeHash(cwd);
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

  /**
   * L2 — the replay port handed to `runLoopVerify`. It is consulted ONCE per
   * completion attempt (before any run) and written ONCE (after the cycle
   * settles), so the anti-flake second pass still executes for real.
   *
   * `null` means the tree hash could not be computed, which disables replay
   * for this attempt: fail open, never assume the previous answer.
   */
  replayPortFor(state: LoopState, kind: 'verify' | 'quick-verify'): {
    lookup: () => VerifyOutcome | null;
    record: (outcome: VerifyOutcome) => void;
  } | undefined {
    const command = kind === 'quick-verify'
      ? state.config.completion.quickVerifyCommand?.trim()
      : state.config.completion.verifyCommand?.trim();
    if (!command) return undefined;
    const key = this.replayKeyFor(state, kind, command);
    if (!key) return undefined;
    return {
      lookup: () => {
        const hit = this.replayCache.lookup(state.id, key);
        if (!hit) return null;
        logger.info('Loop verify replayed from an identical working tree (L2)', {
          loopRunId: state.id,
          kind,
          command,
        });
        return {
          status: 'failed',
          output: `${renderReplayNotice(hit)}${hit.output}`,
          durationMs: 0,
          exitCode: hit.exitCode,
          failureKind: 'command',
        };
      },
      record: (outcome) => {
        // Only a real command failure replays: infra / timeout / environment
        // reds can heal without a tree change, and a PASS is what unlocks
        // completion so it must never come from a cache.
        if (outcome.status !== 'failed' || outcome.failureKind !== 'command') return;
        this.replayCache.record(state.id, key, {
          treeHash: key.treeHash,
          command: key.command,
          exitCode: outcome.exitCode,
          output: outcome.output,
          durationMs: outcome.durationMs,
          failureKind: 'command',
          recordedAt: Date.now(),
        });
      },
    };
  }

  /**
   * Build the replay key for this run, or `null` when the tree hash cannot be
   * computed (non-git workspace, unreadable file, git failure) — fail open.
   */
  private replayKeyFor(
    state: LoopState,
    kind: 'verify' | 'quick-verify',
    command: string,
  ): VerifyReplayKey | null {
    const cwd = loopExecutionCwd(state.config);
    let treeHash: string | null = null;
    try {
      treeHash = this.computeTreeHash(cwd);
    } catch (err) {
      logger.warn('Verify tree hash failed (replay disabled for this run)', {
        loopRunId: state.id,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
    return treeHash ? { kind, command, cwd, treeHash } : null;
  }

  record(state: LoopState, iteration: LoopIteration | undefined, execution: VerificationExecution): void {
    const recorder = this.resolveRecorder();
    if (!recorder) return;
    try {
      recorder.record({
        scope: 'loop',
        loopRunId: state.id,
        command: execution.command,
        cwd: loopExecutionCwd(state.config),
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
