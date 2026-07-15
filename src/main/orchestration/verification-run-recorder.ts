import { getLogger } from '../logging/logger';
import {
  truncateToolOutput,
  type TruncationResult,
} from '../util/tool-output-truncation';
import {
  VerificationRunStore,
  type VerificationRun,
  type VerificationRunScope,
} from './verification-run-store';

const logger = getLogger('VerificationRunRecorder');

export interface RecordVerificationExecution {
  scope: VerificationRunScope;
  loopRunId?: string;
  instanceId?: string;
  command: string;
  cwd: string;
  exitCode: number | null;
  durationMs: number;
  workHash?: string;
  output: string;
  startedAt?: number;
}

export interface VerificationRunRecorderDependencies {
  store?: Pick<VerificationRunStore, 'record'>;
  externalizeOutput?: (output: string) => TruncationResult;
  now?: () => number;
}

/**
 * Fail-soft execution recorder. Command execution remains authoritative: a
 * disk or database fault only loses ledger telemetry, never changes a verify
 * result or completion decision.
 */
export class VerificationRunRecorder {
  private static instance: VerificationRunRecorder | null = null;
  private readonly store: Pick<VerificationRunStore, 'record'>;
  private readonly externalizeOutput: (output: string) => TruncationResult;
  private readonly now: () => number;

  constructor(deps: VerificationRunRecorderDependencies = {}) {
    this.store = deps.store ?? VerificationRunStore.getInstance();
    this.externalizeOutput = deps.externalizeOutput ?? ((output) => truncateToolOutput(output));
    this.now = deps.now ?? Date.now;
  }

  static getInstance(): VerificationRunRecorder {
    if (!VerificationRunRecorder.instance) {
      VerificationRunRecorder.instance = new VerificationRunRecorder();
    }
    return VerificationRunRecorder.instance;
  }

  static _resetForTesting(): void {
    VerificationRunRecorder.instance = null;
  }

  record(input: RecordVerificationExecution): VerificationRun | null {
    let outputRef: string | undefined;
    try {
      const externalized = this.externalizeOutput(input.output);
      if (externalized.truncated) outputRef = externalized.outputPath;
    } catch (err) {
      logger.warn('Verification output externalization failed; recording execution without output reference', {
        scope: input.scope,
        loopRunId: input.loopRunId,
        instanceId: input.instanceId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    try {
      return this.store.record({
        scope: input.scope,
        ...(input.loopRunId === undefined ? {} : { loopRunId: input.loopRunId }),
        ...(input.instanceId === undefined ? {} : { instanceId: input.instanceId }),
        command: input.command,
        cwd: input.cwd,
        exitCode: input.exitCode,
        durationMs: input.durationMs,
        ...(input.workHash === undefined ? {} : { workHash: input.workHash }),
        ...(outputRef === undefined ? {} : { outputRef }),
        startedAt: input.startedAt ?? this.now(),
      });
    } catch (err) {
      logger.warn('Verification run recording failed (fail-soft)', {
        scope: input.scope,
        loopRunId: input.loopRunId,
        instanceId: input.instanceId,
        command: input.command,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }
}
