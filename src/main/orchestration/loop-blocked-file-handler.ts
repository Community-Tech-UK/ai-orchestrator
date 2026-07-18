import {
  createLoopPendingInput,
  type LoopState,
  type ProgressSignalEvidence,
} from '../../shared/types/loop.types';
import { getBlockOverrideInterventionText } from './loop-coordinator-block-utils';

interface BlockedFileContents {
  message: string;
}

interface LivenessProbeResult {
  alive: boolean;
  detail: string;
}

interface LoopBlockedFileHandlerDependencies {
  readBlockedFile(state: LoopState): Promise<BlockedFileContents | null>;
  isToolchainClassBlock(message: string, evidence: []): boolean;
  runLivenessProbe(workspaceCwd: string, timeoutMs: number): Promise<LivenessProbeResult>;
  moveBlockedFileAside(state: LoopState): Promise<void>;
  setConvergenceNote(loopRunId: string, note: string): void;
  cloneStateForBroadcast(state: LoopState): LoopState;
  emit(eventName: string, payload: unknown): void;
  onOverridden?(loopRunId: string, probeDetail: string): void;
  onPaused?(loopRunId: string, probeDetail: string | undefined): void;
}

/** Handles the legacy BLOCKED.md pause/override handshake at iteration boundaries. */
export class LoopBlockedFileHandler {
  constructor(private readonly dependencies: LoopBlockedFileHandlerDependencies) {}

  async handle(state: LoopState): Promise<'continue' | 'restart'> {
    const blockedFile = await this.dependencies.readBlockedFile(state);
    if (!blockedFile || state.status !== 'running') return 'continue';

    const probeConfig = state.config.blockSanityProbe;
    const probeEnabled = probeConfig?.enabled !== false;
    let failedProbeDetail: string | undefined;
    if (
      probeEnabled &&
      this.dependencies.isToolchainClassBlock(blockedFile.message, [])
    ) {
      const probe = await this.dependencies.runLivenessProbe(
        state.config.workspaceCwd,
        probeConfig?.timeoutMs ?? 5000,
      );
      if (probe.alive) {
        state.pendingInterventions.push(
          createLoopPendingInput(getBlockOverrideInterventionText(), {
            source: 'block-override',
          }),
        );
        this.dependencies.setConvergenceNote(
          state.id,
          'BLOCKED.md overridden by liveness probe',
        );
        await this.dependencies.moveBlockedFileAside(state);
        this.dependencies.emit('loop:activity', {
          loopRunId: state.id,
          seq: state.totalIterations,
          stage: state.currentStage,
          timestamp: Date.now(),
          kind: 'status',
          message: 'BLOCKED.md overridden: liveness probe confirmed toolchain responsive',
          detail: { probe: probe.detail },
        });
        this.dependencies.onOverridden?.(state.id, probe.detail);
        return 'restart';
      }
      failedProbeDetail = probe.detail;
    }

    state.status = 'paused';
    state.pausedForInput = true;
    const signal: ProgressSignalEvidence = {
      id: 'BLOCKED',
      verdict: 'CRITICAL',
      message: failedProbeDetail
        ? `BLOCKED.md present: ${blockedFile.message} (liveness probe failed: ${failedProbeDetail})`
        : `BLOCKED.md present: ${blockedFile.message}`,
      detail: {
        file: 'BLOCKED.md',
        excerpt: blockedFile.message,
        ...(failedProbeDetail ? { probeDetail: failedProbeDetail } : {}),
      },
    };
    this.dependencies.emit('loop:paused-no-progress', { loopRunId: state.id, signal });
    this.dependencies.emit('loop:state-changed', {
      loopRunId: state.id,
      state: this.dependencies.cloneStateForBroadcast(state),
    });
    this.dependencies.onPaused?.(state.id, failedProbeDetail);
    return 'restart';
  }
}
