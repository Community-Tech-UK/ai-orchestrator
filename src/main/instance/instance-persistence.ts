/**
 * Instance Persistence Manager - Session export, import, and storage
 */

import { getOutputStorageManager } from '../memory';
import { getLogger } from '../logging/logger';
import { buildReplayContinuityMessage } from '../session/replay-continuity';
import type {
  Instance,
  InstanceCreateConfig,
  ExportedSession,
  ForkConfig,
  OutputMessage
} from '../../shared/types/instance.types';

/**
 * Dependencies required by the persistence manager
 */
export interface PersistenceDependencies {
  getInstance: (id: string) => Instance | undefined;
  createInstance: (config: InstanceCreateConfig) => Promise<Instance>;
}

const logger = getLogger('InstancePersistence');

export class InstancePersistenceManager {
  private outputStorage = getOutputStorageManager();
  private deps: PersistenceDependencies;

  constructor(deps: PersistenceDependencies) {
    this.deps = deps;
  }

  // ============================================
  // Historical Output Loading
  // ============================================

  /**
   * Load historical output from disk for an instance
   */
  async loadHistoricalOutput(
    instanceId: string,
    limit?: number
  ): Promise<OutputMessage[]> {
    return this.outputStorage.loadMessages(instanceId, { limit });
  }

  /**
   * Get storage stats for an instance
   */
  getInstanceStorageStats(instanceId: string) {
    return this.outputStorage.getInstanceStats(instanceId);
  }

  /**
   * Delete storage for an instance
   */
  async deleteInstanceStorage(instanceId: string): Promise<void> {
    await this.outputStorage.deleteInstance(instanceId);
  }

  // ============================================
  // Fork Instance
  // ============================================

  /**
   * Fork an instance at a specific message point
   */
  async forkInstance(config: ForkConfig): Promise<Instance> {
    const sourceInstance = this.deps.getInstance(config.instanceId);
    if (!sourceInstance) {
      throw new Error(`Instance ${config.instanceId} not found`);
    }

    const forkSourceMessages = await this.buildForkSourceMessages(config.instanceId, sourceInstance.outputBuffer);

    const { forkIndex, sourceMessage } = this.resolveForkPoint(config, forkSourceMessages);

    // Copy messages up to the fork point
    const forkedMessages = forkSourceMessages.slice(0, forkIndex);

    // Create new instance with forked messages.
    // initialPrompt (when set by edit-and-resend) is sent inside background
    // init right after the CLI spawns, bypassing the renderer's status-gated
    // queue. The queue would otherwise race the 'idle' transition.
    //
    // When supersedeSource is true (the edit-and-resend flow), inherit the
    // source's historyThreadId. The fork is the same logical conversation
    // thread, just with an edited message. Sharing the threadId means:
    //   1. The rail's history-side filter (which drops history entries whose
    //      threadId matches a live instance) hides the source's pre-archive
    //      history entry as soon as the fork is live — no duplicate row.
    //   2. history-manager.archiveInstance() dedupes on threadId, so when the
    //      fork later archives it replaces (not appends to) any prior entry
    //      for this thread on disk.
    // Non-supersede forks (explicit divergent branches) keep getting a fresh
    // threadId so both branches remain independently visible.
    const initialContextBlock = this.buildInitialContextBlockForFork(
      forkedMessages,
      config,
    );
    const forkedInstance = await this.deps.createInstance({
      workingDirectory: sourceInstance.workingDirectory,
      displayName:
        config.displayName || `Fork of ${sourceInstance.displayName}`,
      historyThreadId: config.supersedeSource === true
        ? sourceInstance.historyThreadId
        : undefined,
      yoloMode: config.preserveRuntimeSettings === false ? undefined : sourceInstance.yoloMode,
      agentId: config.preserveRuntimeSettings === false ? undefined : sourceInstance.agentId,
      modelOverride: config.preserveRuntimeSettings === false ? undefined : sourceInstance.currentModel,
      reasoningEffort: config.preserveRuntimeSettings === false ? undefined : sourceInstance.reasoningEffort,
      provider: config.preserveRuntimeSettings === false ? undefined : sourceInstance.provider,
      forceNodeId: config.preserveRuntimeSettings === false || sourceInstance.executionLocation?.type !== 'remote'
        ? undefined
        : sourceInstance.executionLocation.nodeId,
      metadata: config.preserveRuntimeSettings === false || !sourceInstance.metadata
        ? undefined
        : { ...sourceInstance.metadata },
      initialOutputBuffer: forkedMessages,
      initialPrompt: config.initialPrompt,
      initialContextBlock,
      attachments: config.attachments ?? sourceMessage?.attachments,
    });

    logger.info('Instance forked', {
      sourceId: sourceInstance.id,
      forkIndex,
      forkedId: forkedInstance.id,
      sourceMessageId: config.sourceMessageId,
      forkAfterMessageId: config.forkAfterMessageId,
      atMessageId: config.atMessageId,
      preservedRuntimeSettings: config.preserveRuntimeSettings !== false,
    });

    return forkedInstance;
  }

  private resolveForkPoint(
    config: ForkConfig,
    messages: OutputMessage[],
  ): { forkIndex: number; sourceMessage?: OutputMessage } {
    const sourceMessageId = config.sourceMessageId ?? config.atMessageId;
    const sourceMessage = sourceMessageId
      ? messages.find((message) => message.id === sourceMessageId)
      : undefined;

    if (config.forkAfterMessageId) {
      const index = messages.findIndex((message) => message.id === config.forkAfterMessageId);
      if (index >= 0) {
        return {
          forkIndex: Math.min(index + 1, messages.length),
          sourceMessage,
        };
      }
    }

    if (sourceMessageId) {
      const index = messages.findIndex((message) => message.id === sourceMessageId);
      if (index >= 0) {
        return {
          forkIndex: Math.max(0, index),
          sourceMessage: messages[index],
        };
      }
    }

    if (config.atMessageIndex !== undefined) {
      const forkIndex = Math.min(config.atMessageIndex, messages.length);
      return {
        forkIndex,
        sourceMessage: messages[forkIndex],
      };
    }

    return { forkIndex: messages.length };
  }

  private buildInitialContextBlockForFork(
    forkedMessages: OutputMessage[],
    config: ForkConfig,
  ): string | undefined {
    const hasInitialPayload =
      (typeof config.initialPrompt === 'string' && config.initialPrompt.length > 0)
      || Boolean(config.attachments?.length);
    if (!hasInitialPayload || forkedMessages.length === 0) {
      return undefined;
    }

    const reason = config.supersedeSource === true
      ? 'edit-and-resend-fork'
      : 'session-fork';
    const continuity = buildReplayContinuityMessage(forkedMessages, { reason });
    if (!continuity) {
      return undefined;
    }

    return [
      continuity,
      '',
      'The next user message is the fork prompt. Use the transcript above as prior context, then answer the next user message directly.',
    ].join('\n');
  }

  private async buildForkSourceMessages(
    instanceId: string,
    liveMessages: OutputMessage[],
  ): Promise<OutputMessage[]> {
    const historicalMessages = await this.outputStorage.loadMessages(instanceId);
    if (historicalMessages.length === 0) {
      return liveMessages;
    }

    const merged = [...historicalMessages, ...liveMessages];
    const seenIds = new Set<string>();
    const deduped: OutputMessage[] = [];

    for (const message of merged) {
      if (seenIds.has(message.id)) {
        continue;
      }

      seenIds.add(message.id);
      deduped.push(message);
    }

    return deduped;
  }

  // ============================================
  // Session Export
  // ============================================

  /**
   * Export an instance to JSON format
   */
  exportSession(instanceId: string): ExportedSession {
    const instance = this.deps.getInstance(instanceId);
    if (!instance) {
      throw new Error(`Instance ${instanceId} not found`);
    }

    return {
      version: '1.0',
      exportedAt: Date.now(),
      metadata: {
        displayName: instance.displayName,
        createdAt: instance.createdAt,
        workingDirectory: instance.workingDirectory,
        agentId: instance.agentId,
        agentMode: instance.agentMode,
        totalMessages: instance.outputBuffer.length,
        contextUsage: instance.contextUsage
      },
      messages: instance.outputBuffer
    };
  }

  /**
   * Export an instance to Markdown format
   */
  exportSessionMarkdown(instanceId: string): string {
    const session = this.exportSession(instanceId);
    const lines: string[] = [];

    lines.push(`# ${session.metadata.displayName}`);
    lines.push('');
    lines.push(
      `**Created:** ${new Date(session.metadata.createdAt).toLocaleString()}`
    );
    lines.push(`**Working Directory:** ${session.metadata.workingDirectory}`);
    lines.push(
      `**Agent:** ${session.metadata.agentId} (${session.metadata.agentMode})`
    );
    lines.push(`**Messages:** ${session.metadata.totalMessages}`);
    lines.push('');
    lines.push('---');
    lines.push('');

    for (const msg of session.messages) {
      const time = new Date(msg.timestamp).toLocaleTimeString();
      const rolePrefix =
        msg.type === 'user'
          ? '**User**'
          : msg.type === 'assistant'
            ? '**Assistant**'
            : msg.type === 'system'
              ? '_System_'
              : msg.type === 'tool_use'
                ? '`Tool`'
                : msg.type === 'tool_result'
                  ? '`Result`'
                  : '**Error**';

      lines.push(`### ${rolePrefix} (${time})`);
      lines.push('');

      if (msg.type === 'tool_use' && msg.metadata) {
        lines.push(`Using tool: \`${msg.metadata['name'] || 'unknown'}\``);
      } else if (msg.type === 'tool_result') {
        lines.push('```');
        lines.push(
          msg.content.slice(0, 500) + (msg.content.length > 500 ? '...' : '')
        );
        lines.push('```');
      } else {
        lines.push(msg.content);
      }

      lines.push('');
    }

    return lines.join('\n');
  }

  // ============================================
  // Session Import
  // ============================================

  /**
   * Import a session from exported JSON
   */
  async importSession(
    session: ExportedSession,
    workingDirectory?: string
  ): Promise<Instance> {
    const instance = await this.deps.createInstance({
      workingDirectory: workingDirectory || session.metadata.workingDirectory,
      displayName: `Imported: ${session.metadata.displayName}`,
      agentId: session.metadata.agentId,
      initialOutputBuffer: session.messages
    });

    logger.info('Session imported', { messageCount: session.messages.length, instanceId: instance.id });

    return instance;
  }
}
