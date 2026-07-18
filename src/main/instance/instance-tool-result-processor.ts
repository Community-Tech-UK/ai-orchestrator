import type { CliToolCall } from '../cli/adapters/base-cli-adapter';
import type { Instance, OutputMessage } from '../../shared/types/instance.types';
import type { RuntimeToolResultEvidenceCaptureInput } from '../context-evidence/context-evidence-coordinator';
import { getHookManager, type HookManager } from '../hooks/hook-manager';
import { emitPluginHook } from '../plugins/hook-emitter';
import { getFileEditBus } from './file-edit-bus';
import { getLogger } from '../logging/logger';
import type { SessionDiffTracker } from './session-diff-tracker';
import { ToolOutputParser } from './tool-output-parser';
import { dispatchInstanceLifecycleHook } from './instance-lifecycle-hooks';
import {
  buildParsedToolResultEvidenceIngress,
  buildRawToolResultEvidenceIngress,
} from './instance-provider-event-ingress';

const logger = getLogger('InstanceToolResultProcessor');

export interface InstanceToolResultProcessorDependencies {
  captureContextEvidenceToolResult?: (
    input: RuntimeToolResultEvidenceCaptureInput,
  ) => Promise<unknown>;
  createSnapshot?: (
    instanceId: string,
    name: string,
    description: string | undefined,
    trigger: 'checkpoint' | 'auto',
  ) => void;
  getDiffTracker?: (instanceId: string) => SessionDiffTracker | undefined;
  hookManager?: HookManager;
}

/** Tool-result deduplication, evidence capture, checkpoints, and file/tool hooks. */
export class InstanceToolResultProcessor {
  private readonly seenToolResultIds = new Map<string, Set<string>>();
  private readonly autonomousToolCounts = new Map<string, number>();
  private readonly softCheckpointCounts = new Map<string, number>();
  private readonly toolOutputParser = new ToolOutputParser();
  private readonly hookManager: HookManager;

  constructor(private readonly deps: InstanceToolResultProcessorDependencies) {
    this.hookManager = deps.hookManager ?? getHookManager();
  }

  acceptForBuffer(instance: Instance, message: OutputMessage): boolean {
    if (message.type !== 'tool_result') return true;
    const toolUseId = message.metadata?.['tool_use_id'];
    if (typeof toolUseId === 'string') {
      let seen = this.seenToolResultIds.get(instance.id);
      if (!seen) {
        seen = new Set<string>();
        this.seenToolResultIds.set(instance.id, seen);
      }
      if (seen.has(toolUseId)) {
        logger.debug('Skipped duplicate tool_result', { instanceId: instance.id, toolUseId });
        return false;
      }
      seen.add(toolUseId);
    }

    this.recordAutonomousToolResult(instance, message);
    return true;
  }

  captureParsedEvidence(instance: Instance, message: OutputMessage): void {
    const ingress = buildParsedToolResultEvidenceIngress(instance, message);
    if (!ingress) return;
    void this.captureEvidence(ingress, instance.id);
  }

  captureRawEvidence(instance: Instance, toolCall: CliToolCall): void {
    const ingress = buildRawToolResultEvidenceIngress(instance, toolCall);
    if (!ingress) return;
    void this.captureEvidence(ingress, instance.id);
  }

  async processToolLifecycle(
    instanceId: string,
    instance: Instance,
    message: OutputMessage,
  ): Promise<void> {
    if (message.type !== 'tool_use' && message.type !== 'tool_result') return;

    if (message.type === 'tool_use' && message.metadata) {
      const metadata = message.metadata as Record<string, unknown>;
      const toolName = typeof metadata['name'] === 'string' ? metadata['name'] : 'unknown';
      try {
        await this.hookManager.triggerLifecycleHooks('PreToolUse', {
          instanceId,
          sessionId: instance.providerSessionId || instance.sessionId,
          toolName,
          toolInput: metadata,
          workingDirectory: instance.workingDirectory,
        });
      } catch (error) {
        logger.error('PreToolUse hook error', error instanceof Error ? error : undefined, { instanceId });
      }
    }

    this.processFilePaths(instanceId, instance, message);

    if (message.type === 'tool_result' && message.metadata) {
      const metadata = message.metadata as Record<string, unknown>;
      try {
        await this.hookManager.triggerLifecycleHooks('PostToolUse', {
          instanceId,
          sessionId: instance.providerSessionId || instance.sessionId,
          content: message.content,
          toolOutput: message.content,
          workingDirectory: instance.workingDirectory,
        });
        if (metadata['is_error'] === true) {
          logger.warn('Tool execution reported an error', { instanceId });
        }
      } catch (error) {
        logger.error('PostToolUse hook error', error instanceof Error ? error : undefined, { instanceId });
      }
    }
  }

  resetAutonomousCount(instanceId: string): void {
    this.autonomousToolCounts.set(instanceId, 0);
  }

  cleanup(instanceId: string): void {
    this.seenToolResultIds.delete(instanceId);
    this.autonomousToolCounts.delete(instanceId);
    this.softCheckpointCounts.delete(instanceId);
  }

  cleanupDedup(instanceId: string): void {
    this.seenToolResultIds.delete(instanceId);
  }

  private async captureEvidence(
    ingress: RuntimeToolResultEvidenceCaptureInput,
    instanceId: string,
  ): Promise<void> {
    try {
      await this.deps.captureContextEvidenceToolResult?.(ingress);
    } catch (error) {
      logger.error('Tool-result evidence ingress failed', error instanceof Error ? error : undefined, {
        instanceId,
        captureKey: ingress.captureKey,
      });
    }
  }

  private recordAutonomousToolResult(instance: Instance, message: OutputMessage): void {
    if (!this.deps.createSnapshot) return;
    const count = (this.autonomousToolCounts.get(instance.id) ?? 0) + 1;
    this.autonomousToolCounts.set(instance.id, count);
    if (count <= 5) return;

    const softCount = this.softCheckpointCounts.get(instance.id) ?? 0;
    if (softCount >= 10) return;
    const toolName = typeof message.metadata?.['name'] === 'string'
      ? message.metadata['name']
      : 'unknown';
    try {
      this.deps.createSnapshot(
        instance.id,
        `Auto: after ${toolName} (autonomous run, tool #${count})`,
        undefined,
        'auto',
      );
      this.softCheckpointCounts.set(instance.id, softCount + 1);
    } catch (error) {
      logger.debug('Failed to create soft checkpoint', {
        instanceId: instance.id,
        error: String(error),
      });
    }
    this.autonomousToolCounts.set(instance.id, 0);
  }

  private processFilePaths(
    instanceId: string,
    instance: Instance,
    message: OutputMessage,
  ): void {
    const filePaths = this.toolOutputParser.extractFilePaths(
      message,
      instance.workingDirectory,
      instance.provider,
    );
    if (filePaths.length === 0) return;

    const tracker = this.deps.getDiffTracker?.(instanceId);
    if (tracker) {
      for (const filePath of filePaths) {
        try {
          tracker.captureBaseline(filePath);
        } catch (error) {
          logger.debug('Baseline capture failed', {
            instanceId,
            filePath,
            error: String(error),
          });
        }
      }
    }
    if (message.type !== 'tool_use') return;

    const metadata = message.metadata as Record<string, unknown> | undefined;
    const toolName = typeof metadata?.['name'] === 'string' ? metadata['name'] : 'unknown';
    for (const filePath of filePaths) {
      emitPluginHook('file.edited', {
        instanceId,
        filePath,
        toolName,
        provider: instance.provider,
        timestamp: Date.now(),
      });
      getFileEditBus().emitEdited({
        instanceId,
        filePath,
        toolName,
        provider: instance.provider,
      });
      dispatchInstanceLifecycleHook('FileChanged', instance, {
        toolName,
        filePath,
        changedPath: filePath,
        changedRelativePath: filePath.startsWith(instance.workingDirectory)
          ? filePath.slice(instance.workingDirectory.length).replace(/^[/\\]/, '')
          : filePath,
        changeType: 'change',
      }, logger, this.hookManager);
    }
  }
}
