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
import type { Instance, InstanceStatus } from '../../../shared/types/instance.types';
import { emitPluginHook } from '../../plugins/hook-emitter';
import { normalizeProjectMemoryKey } from '../../memory/project-memory-key';

const logger = getLogger('InstanceTermination');

export interface TranscriptImportOptions {
  wing: string;
  sourceFile: string;
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
  terminateChild: (instanceId: string, graceful: boolean) => Promise<void>;
  unregisterSupervisor: (instanceId: string) => void;
  unregisterOrchestration: (instanceId: string) => void;
  clearFirstMessageTracking: (instanceId: string) => void;
  endRlmSession: (instanceId: string) => void;
  deleteOutputStorage: (instanceId: string) => Promise<void>;
  archiveInstance: (instance: Instance, status: ConversationEndStatus) => Promise<void>;
  importTranscript: (transcript: string, options: TranscriptImportOptions) => void;
  emitRemoved: (instanceId: string) => void;
}

export class InstanceTerminationCoordinator {
  constructor(private readonly deps: InstanceTerminationDeps) {}

  async terminateInstance(instanceId: string, graceful = true): Promise<void> {
    const adapter = this.deps.getAdapter(instanceId);
    const instance = this.deps.getInstance(instanceId);

    this.deps.forceReleaseSessionMutex(instanceId);
    this.deps.stopStuckTracking?.(instanceId);
    this.deps.deleteDiffTracker?.(instanceId);
    this.deps.deleteStateMachine?.(instanceId);
    this.deps.removeActivityDetector(instanceId);
    this.deps.clearRecoveryHistory(instanceId);

    if (adapter) {
      await this.terminateAdapter(instanceId, adapter, graceful);
      this.deps.deleteAdapter(instanceId);
    }

    if (!instance) {
      return;
    }

    await this.archiveRootConversation(instanceId, instance);
    this.mineTranscript(instanceId, instance, 'terminate');
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
