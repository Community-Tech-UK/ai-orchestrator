/**
 * Orchestration Activity Bridge
 *
 * Listens to orchestration, debate, and verification events in the main process
 * and forwards human-readable activity strings to the renderer via IPC.
 *
 * This replaces the generic "Processing..." indicator with meaningful messages like
 * "Spawning child: code-reviewer" or "Debate round 2/4 · Critiquing".
 */

import type { WindowManager } from '../window-manager';
import type { OrchestrationHandler } from './orchestration-handler';
import type { DebateCoordinator } from './debate-coordinator';
import type { MultiVerifyCoordinator } from './multi-verify-coordinator';
import type { OrchestrationActivityPayload } from '../../shared/types/ipc.types';
import type { SpawnChildCommand, TerminateChildCommand } from './orchestration-protocol';
import type { TaskExecution, TaskProgress, TaskError } from '../../shared/types/task.types';
import type {
  VerificationProgress,
  VerificationResult,
  VerificationVerdictReadyPayload,
} from '../../shared/types/verification.types';
import type { DebateSessionRound } from '../../shared/types/debate.types';
import { getLogger } from '../logging/logger';
import { deriveVerdict } from './verification-verdict-deriver';

const logger = getLogger('OrchestrationActivityBridge');

interface EventSource {
  on(event: string, handler: (...args: unknown[]) => void): void;
  removeListener(event: string, handler: (...args: unknown[]) => void): void;
}

interface BoundListener {
  emitter: EventSource;
  event: string;
  handler: (...args: unknown[]) => void;
}

export class OrchestrationActivityBridge {
  private static instance: OrchestrationActivityBridge;

  static getInstance(): OrchestrationActivityBridge {
    if (!this.instance) {
      this.instance = new OrchestrationActivityBridge();
    }
    return this.instance;
  }

  static _resetForTesting(): void {
    if (this.instance) {
      this.instance.cleanup();
      (this.instance as unknown) = undefined;
    }
  }

  private windowManager: WindowManager | null = null;
  private boundListeners: BoundListener[] = [];
  private debateInstanceMap = new Map<string, string>();
  private verificationInstanceMap = new Map<string, string>();
  private derivedVerdictIds = new Set<string>();

  // eslint-disable-next-line @typescript-eslint/no-empty-function -- singleton pattern
  private constructor() {}

  /**
   * Wire up to the orchestration event emitters and forward activity to renderer.
   */
  initialize(
    windowManager: WindowManager,
    orchestration: OrchestrationHandler,
    debate: DebateCoordinator,
    verification: MultiVerifyCoordinator
  ): void {
    this.windowManager = windowManager;
    this.wireOrchestration(orchestration);
    this.wireDebate(debate);
    this.wireVerification(verification);
    logger.info('Initialized — forwarding orchestration activity to renderer');
  }

  /**
   * Register a debate-to-instance mapping so debate events can be attributed.
   * Call from the IPC handler that starts a debate.
   */
  registerDebate(debateId: string, instanceId: string): void {
    this.debateInstanceMap.set(debateId, instanceId);
  }

  cleanup(): void {
    for (const { emitter, event, handler } of this.boundListeners) {
      emitter.removeListener(event, handler);
    }
    this.boundListeners = [];
    this.debateInstanceMap.clear();
    this.verificationInstanceMap.clear();
    this.derivedVerdictIds.clear();
    this.windowManager = null;
  }

  // ============================================
  // Private helpers
  // ============================================

  private send(payload: OrchestrationActivityPayload): void {
    this.windowManager?.sendToRenderer('orchestration:activity', payload);
  }

  private listen(
    emitter: EventSource,
    event: string,
    handler: (...args: unknown[]) => void
  ): void {
    emitter.on(event, handler);
    this.boundListeners.push({ emitter, event, handler });
  }

  // ============================================
  // Orchestration Handler events
  // ============================================

  private wireOrchestration(orchestration: OrchestrationHandler): void {
    this.listen(orchestration, 'spawn-child', (...args: unknown[]) => {
      const parentId = args[0] as string;
      const command = args[1] as SpawnChildCommand;
      const label = command.name || 'child';
      this.send({
        instanceId: parentId,
        activity: `Spawning child: ${label}`,
        category: 'orchestration',
      });
    });

    this.listen(orchestration, 'terminate-child', (...args: unknown[]) => {
      const parentId = args[0] as string;
      const command = args[1] as TerminateChildCommand;
      this.send({
        instanceId: parentId,
        activity: `Terminating child: ${command.childId.slice(0, 8)}`,
        category: 'orchestration',
      });
    });

    this.listen(orchestration, 'task-complete', (...args: unknown[]) => {
      const parentId = args[0] as string;
      const task = args[2] as TaskExecution;
      const label = task.task?.slice(0, 40) || 'task';
      this.send({
        instanceId: parentId,
        activity: `Child completed: ${label}`,
        category: 'task',
      });
    });

    this.listen(orchestration, 'task-progress', (...args: unknown[]) => {
      const parentId = args[0] as string;
      const progress = args[2] as TaskProgress;
      const step = progress.currentStep || 'working';
      this.send({
        instanceId: parentId,
        activity: `Child: ${step} (${progress.percentage}%)`,
        category: 'task',
        progress: { current: progress.percentage, total: 100 },
      });
    });

    this.listen(orchestration, 'task-error', (...args: unknown[]) => {
      const parentId = args[0] as string;
      const error = args[2] as TaskError;
      const msg = error.message?.slice(0, 40) || 'unknown error';
      this.send({
        instanceId: parentId,
        activity: `Child error: ${msg}`,
        category: 'task',
      });
    });
  }

  // ============================================
  // Debate Coordinator events
  // ============================================

  private wireDebate(debate: DebateCoordinator): void {
    this.listen(debate, 'debate:started', (...args: unknown[]) => {
      const data = args[0] as { debateId: string; query: string };
      const instanceId = this.debateInstanceMap.get(data.debateId);
      if (!instanceId) return;
      this.send({
        instanceId,
        activity: 'Debate started',
        category: 'debate',
      });
    });

    this.listen(debate, 'debate:round-complete', (...args: unknown[]) => {
      const data = args[0] as { debateId: string; round: DebateSessionRound };
      const instanceId = this.debateInstanceMap.get(data.debateId);
      if (!instanceId) return;

      const roundNum = data.round.roundNumber;
      const typeLabel = data.round.type.charAt(0).toUpperCase() + data.round.type.slice(1);
      this.send({
        instanceId,
        activity: `Debate round ${roundNum} · ${typeLabel}`,
        category: 'debate',
        progress: { current: roundNum, total: roundNum },
      });
    });

    this.listen(debate, 'debate:completed', (...args: unknown[]) => {
      const data = args[0] as { id: string };
      const instanceId = this.debateInstanceMap.get(data.id);
      if (!instanceId) return;
      this.send({
        instanceId,
        activity: 'Debate completed',
        category: 'debate',
      });
      this.debateInstanceMap.delete(data.id);
    });

    this.listen(debate, 'debate:error', (...args: unknown[]) => {
      const data = args[0] as { debateId: string; error: string };
      const instanceId = this.debateInstanceMap.get(data.debateId);
      if (!instanceId) return;
      this.send({
        instanceId,
        activity: 'Debate error',
        category: 'debate',
      });
      this.debateInstanceMap.delete(data.debateId);
    });
  }

  // ============================================
  // Multi-Verify Coordinator events
  // ============================================

  private wireVerification(verification: MultiVerifyCoordinator): void {
    this.listen(verification, 'verification:started', (...args: unknown[]) => {
      const request = args[0] as { id: string; instanceId: string };
      this.verificationInstanceMap.set(request.id, request.instanceId);
      this.send({
        instanceId: request.instanceId,
        activity: 'Verification started',
        category: 'verification',
      });
    });

    this.listen(verification, 'verification:agents-launching', (...args: unknown[]) => {
      const data = args[0] as { requestId: string; agentCount: number };
      const instanceId = this.verificationInstanceMap.get(data.requestId);
      if (!instanceId) return;
      this.send({
        instanceId,
        activity: `Verification: launching ${data.agentCount} agents`,
        category: 'verification',
        progress: { current: 0, total: data.agentCount },
      });
    });

    this.listen(verification, 'verification:progress', (...args: unknown[]) => {
      const data = args[0] as { requestId: string; progress: VerificationProgress };
      const instanceId = this.verificationInstanceMap.get(data.requestId);
      if (!instanceId) return;

      const { completedAgents, totalAgents, phase } = data.progress;
      const activity = phase === 'complete'
        ? 'Verification complete'
        : `Verification: ${completedAgents}/${totalAgents} agents`;
      this.send({
        instanceId,
        activity,
        category: 'verification',
        progress: { current: completedAgents, total: totalAgents },
      });
    });

    this.listen(verification, 'verification:completed', (...args: unknown[]) => {
      const data = args[0] as VerificationResult;
      const instanceId = this.verificationInstanceMap.get(data.id) ?? data.request.instanceId;
      if (!instanceId) return;
      this.send({
        instanceId,
        activity: 'Verification complete',
        category: 'verification',
      });
      this.emitVerdictReady(data, instanceId);
      this.verificationInstanceMap.delete(data.id);
    });

    this.listen(verification, 'verification:error', (...args: unknown[]) => {
      const data = args[0] as { request: { id: string; instanceId: string } };
      this.send({
        instanceId: data.request.instanceId,
        activity: 'Verification error',
        category: 'verification',
      });
      this.verificationInstanceMap.delete(data.request.id);
    });

    this.listen(verification, 'verification:cancelled', (...args: unknown[]) => {
      const data = args[0] as { verificationId: string };
      const instanceId = this.verificationInstanceMap.get(data.verificationId);
      if (!instanceId) return;
      this.send({
        instanceId,
        activity: 'Verification cancelled',
        category: 'verification',
      });
      this.verificationInstanceMap.delete(data.verificationId);
    });
  }

  private emitVerdictReady(result: VerificationResult, instanceId: string): void {
    if (this.derivedVerdictIds.has(result.id)) {
      return;
    }
    try {
      const { verdict, diagnostic } = deriveVerdict(result);
      const payload: VerificationVerdictReadyPayload = {
        resultId: result.id,
        instanceId,
        verdict,
        diagnostic: diagnostic.reason === 'normal' ? undefined : diagnostic,
      };
      this.windowManager?.sendToRenderer('verification:verdict-ready', payload);
      this.derivedVerdictIds.add(result.id);
      logger.info('Derived verification verdict', {
        resultId: result.id,
        status: verdict.status,
        diagnostic: diagnostic.reason,
      });
    } catch (error) {
      logger.warn('Failed to derive verification verdict', {
        resultId: result.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

export function getOrchestrationActivityBridge(): OrchestrationActivityBridge {
  return OrchestrationActivityBridge.getInstance();
}
