/**
 * InstanceTerminationCoordinator
 *
 * Owns instance teardown and cleanup policy so InstanceLifecycleManager can
 * stay focused on orchestration rather than disposal details.
 */

import { RemoteCliAdapter } from '../../cli/adapters/remote-cli-adapter';
import type { CliAdapter } from '../../cli/adapters/adapter-factory';
import { getLogger } from '../../logging/logger';
import type { ConversationEndStatus } from '../../../shared/types/history.types';
import type { Instance, InstanceStatus, InstanceWaitReason } from '../../../shared/types/instance.types';
import { emitPluginHook } from '../../plugins/hook-emitter';
import { normalizeProjectMemoryKey } from '../../memory/project-memory-key';
import { deleteTurnSupervisor } from '../../session/session-turn-supervisor';
import { deleteCircuitBreaker } from './respawn-circuit-breaker';
import { mergeSessionBranchToMain } from './session-branch-merge';

const logger = getLogger('InstanceTermination');

/**
 * Upper bound on a graceful terminate. Mirrors BaseCliAdapter.terminate(), which
 * sends SIGTERM and escalates to SIGKILL after 5s. Used only to compute the
 * `terminating` waitReason deadline surfaced to the renderer.
 */
const TERMINATE_GRACE_MS = 5_000;

export interface TranscriptImportOptions {
  wing: string;
  sourceFile: string;
}

export interface TerminateInstanceOptions {
  skipTranscriptMining?: boolean;
}

export interface InstanceTerminationDeps {
  getAdapter: (instanceId: string) => CliAdapter | undefined;
  getInstance: (instanceId: string) => Instance | undefined;
  deleteAdapter: (instanceId: string) => boolean | void;
  deleteInstance: (instanceId: string) => boolean | void;
  stopStuckTracking?: (instanceId: string) => void;
  deleteDiffTracker?: (instanceId: string) => void;
  deleteStateMachine?: (instanceId: string) => void;
  forceReleaseSessionMutex: (instanceId: string) => void;
  removeActivityDetector: (instanceId: string) => void;
  clearRecoveryHistory: (instanceId: string) => void;
  transitionState: (instance: Instance, status: InstanceStatus) => void;
  /**
   * Surface (or clear, with `null`) why the instance is currently waiting so a
   * long terminate is never a silent spinner (plan §4.G / E1). Optional so
   * lightweight constructions (and existing tests) need not provide it.
   */
  setWaitReason?: (instanceId: string, waitReason: InstanceWaitReason | null) => void;
  terminateChild: (instanceId: string, graceful: boolean) => Promise<void>;
  unregisterSupervisor: (instanceId: string) => void;
  unregisterOrchestration: (instanceId: string) => void;
  clearFirstMessageTracking: (instanceId: string) => void;
  endRlmSession: (instanceId: string) => void;
  deleteOutputStorage: (instanceId: string) => Promise<void>;
  drainContextEvidence?: (instanceId: string) => Promise<void>;
  archiveInstance: (instance: Instance, status: ConversationEndStatus) => Promise<void>;
  importTranscript: (transcript: string, options: TranscriptImportOptions) => void;
  emitRemoved: (instanceId: string) => void;
}

export class InstanceTerminationCoordinator {
  constructor(private readonly deps: InstanceTerminationDeps) {}

  async terminateInstance(
    instanceId: string,
    graceful = true,
    options: TerminateInstanceOptions = {},
  ): Promise<void> {
    const adapter = this.deps.getAdapter(instanceId);
    const instance = this.deps.getInstance(instanceId);

    // Capture clean-completion BEFORE teardown mutates status: a regular (root)
    // session that finished its turn sits at 'idle'; one killed mid-task does not.
    const finishedCleanlyOnEntry = !!instance && !instance.parentId && instance.status === 'idle';

    this.deps.forceReleaseSessionMutex(instanceId);
    this.deps.stopStuckTracking?.(instanceId);
    this.deps.deleteDiffTracker?.(instanceId);
    this.deps.deleteStateMachine?.(instanceId);
    this.deps.removeActivityDetector(instanceId);
    this.deps.clearRecoveryHistory(instanceId);

    if (adapter) {
      // §4.G/E1: a graceful terminate can sit in a SIGTERM→SIGKILL wait for up
      // to TERMINATE_GRACE_MS. Surface that wait so the user sees a reason, then
      // clear it (the instance still exists until deleteInstance() below).
      this.deps.setWaitReason?.(instanceId, {
        kind: 'terminating',
        force: !graceful,
        startedAt: Date.now(),
        deadlineAt: graceful ? Date.now() + TERMINATE_GRACE_MS : undefined,
      });
      try {
        await this.terminateAdapter(instanceId, adapter, graceful);
      } finally {
        this.deps.setWaitReason?.(instanceId, null);
      }
      this.deps.deleteAdapter(instanceId);
    }

    if (!instance) {
      return;
    }

    await this.deps.drainContextEvidence?.(instanceId);
    await this.archiveRootConversation(instanceId, instance);
    await this.maybeMergeSessionBranch(instanceId, instance, graceful, finishedCleanlyOnEntry);
    // Bulk app shutdown has already archived the transcript above; skip only
    // the secondary RLM mining work on that latency-sensitive path.
    if (!options.skipTranscriptMining) {
      this.mineTranscript(instanceId, instance, 'terminate');
    }
    this.markTerminated(instance);
    instance.processId = null;

    await this.applyChildPolicy(instance, graceful);

    instance.childrenIds = [];
    this.deps.unregisterSupervisor(instanceId);
    this.deps.unregisterOrchestration(instanceId);
    this.deps.clearFirstMessageTracking(instanceId);
    this.deps.endRlmSession(instanceId);
    this.deleteOutputStorage(instanceId);
    this.deps.emitRemoved(instanceId);
    this.deps.deleteInstance(instanceId);
    deleteTurnSupervisor(instanceId);
    deleteCircuitBreaker(instanceId);
  }

  mineTranscript(instanceId: string, instance: Instance, source: 'terminate' | 'hibernate'): void {
    if (instance.parentId || instance.outputBuffer.length < 4) {
      return;
    }

    try {
      const transcript = instance.outputBuffer
        .filter((message) => message.type === 'user' || message.type === 'assistant')
        .map((message) => (message.type === 'user' ? `> ${message.content}` : message.content))
        .join('\n\n');

      if (transcript.length <= 100) {
        return;
      }

      this.deps.importTranscript(transcript, {
        wing: normalizeProjectMemoryKey(instance.workingDirectory) || instance.workingDirectory || 'default',
        sourceFile: `session://${instanceId}/${source}`,
      });

      logger.info(
        source === 'hibernate'
          ? 'Mined transcript before hibernation'
          : 'Mined transcript into verbatim storage',
        {
          instanceId,
          messageCount: instance.outputBuffer.length,
        },
      );
    } catch (error) {
      logger.warn(
        source === 'hibernate'
          ? 'Failed to mine transcript before hibernation'
          : 'Failed to mine transcript',
        {
          instanceId,
          error: error instanceof Error ? error.message : String(error),
        },
      );
    }
  }

  private async terminateAdapter(
    instanceId: string,
    adapter: CliAdapter,
    graceful: boolean,
  ): Promise<void> {
    try {
      await adapter.terminate(graceful);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (adapter instanceof RemoteCliAdapter) {
        logger.warn('Remote adapter terminate failed, proceeding with cleanup', {
          instanceId,
          error: errorMessage,
        });
      } else {
        logger.error('Local adapter terminate failed, proceeding with cleanup', error instanceof Error ? error : undefined, {
          instanceId,
        });
      }
    }

    if (adapter instanceof RemoteCliAdapter) {
      adapter.forceCleanup();
    }
  }

  private async archiveRootConversation(instanceId: string, instance: Instance): Promise<void> {
    if (instance.parentId || instance.outputBuffer.length === 0) {
      return;
    }

    try {
      const status = instance.status === 'error' ? 'error' : 'completed';
      await this.deps.archiveInstance(instance, status);
      emitPluginHook('session.archived', {
        instanceId,
        historyThreadId: instance.historyThreadId,
        providerSessionId: instance.providerSessionId,
        messageCount: instance.outputBuffer.length,
        timestamp: Date.now(),
      });
    } catch (error) {
      logger.error('Failed to archive instance to history', error instanceof Error ? error : undefined, {
        instanceId,
      });
    }
  }

  /**
   * On a clean, user-ended root session (agent finished its turn -> 'idle'), merge the
   * working branch back into base and delete it. Off by default; opt in with
   * AIO_AUTO_MERGE_SESSION=1. Fail-safe: any error is logged and teardown continues.
   */
  private async maybeMergeSessionBranch(
    instanceId: string,
    instance: Instance,
    graceful: boolean,
    finishedCleanly: boolean,
  ): Promise<void> {
    if (
      process.env['AIO_AUTO_MERGE_SESSION'] !== '1' ||
      !graceful ||
      !finishedCleanly ||
      !instance.workingDirectory
    ) {
      return;
    }
    try {
      const result = await mergeSessionBranchToMain(instance.workingDirectory);
      if (result.merged) {
        logger.info('Auto-merged session branch into base on clean completion', {
          instanceId,
          branch: result.branch,
          base: result.base,
        });
      } else if (result.reason === 'conflict') {
        logger.warn('Session branch left intact: merge conflict with base', {
          instanceId,
          branch: result.branch,
          base: result.base,
        });
      } else {
        logger.info('Session branch merge-back skipped', { instanceId, reason: result.reason });
      }
    } catch (error) {
      logger.warn('Session branch merge-back failed; continuing teardown', {
        instanceId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private markTerminated(instance: Instance): void {
    if (instance.status !== 'terminated' && instance.status !== 'failed') {
      this.deps.transitionState(instance, 'terminated');
    }
  }

  private async applyChildPolicy(instance: Instance, graceful: boolean): Promise<void> {
    if (instance.parentId) {
      const parent = this.deps.getInstance(instance.parentId);
      if (parent) {
        parent.childrenIds = parent.childrenIds.filter((id) => id !== instance.id);
      }
    }

    const childrenToTerminate: string[] = [];

    switch (instance.terminationPolicy) {
      case 'terminate-children':
        childrenToTerminate.push(...instance.childrenIds);
        break;
      case 'orphan-children':
        for (const childId of instance.childrenIds) {
          const child = this.deps.getInstance(childId);
          if (child) {
            child.parentId = null;
            logger.info('Orphaned child instance', { childId, parentId: instance.id });
          }
        }
        break;
      case 'reparent-to-root':
        for (const childId of instance.childrenIds) {
          const child = this.deps.getInstance(childId);
          if (child) {
            child.parentId = null;
            child.depth = 0;
            logger.info('Reparented child instance to root', {
              childId,
              formerParentId: instance.id,
            });
          }
        }
        break;
    }

    for (const childId of childrenToTerminate) {
      await this.deps.terminateChild(childId, graceful);
    }
  }

  private deleteOutputStorage(instanceId: string): void {
    this.deps.deleteOutputStorage(instanceId).catch((error) => {
      logger.error('Failed to clean up storage', error instanceof Error ? error : undefined, {
        instanceId,
      });
    });
  }
}
