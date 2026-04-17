/**
 * Instance Persistence Manager - Session export, import, and storage
 */

import { getOutputStorageManager } from '../memory';
import { getLogger } from '../logging/logger';
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

    // Determine the message index to fork at
    const forkIndex =
      config.atMessageIndex !== undefined
        ? Math.min(config.atMessageIndex, forkSourceMessages.length)
        : forkSourceMessages.length;

    // Copy messages up to the fork point
    const forkedMessages = forkSourceMessages.slice(0, forkIndex);

    // Create new instance with forked messages.
    // initialPrompt (when set by edit-and-resend) is sent inside background
    // init right after the CLI spawns, bypassing the renderer's status-gated
    // queue. The queue would otherwise race the 'idle' transition.
    const forkedInstance = await this.deps.createInstance({
      workingDirectory: sourceInstance.workingDirectory,
      displayName:
        config.displayName || `Fork of ${sourceInstance.displayName}`,
      yoloMode: sourceInstance.yoloMode,
      agentId: sourceInstance.agentId,
      initialOutputBuffer: forkedMessages,
      initialPrompt: config.initialPrompt
    });

    logger.info('Instance forked', { sourceId: sourceInstance.id, forkIndex, forkedId: forkedInstance.id });

    return forkedInstance;
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
