import { getLogger } from '../logging/logger';
import { getInstanceManager } from '../instance/instance-manager';
import { detectSecretsInContent, isSecretFile } from '../security/secret-detector';
import type { ChannelPersistence } from './channel-persistence';
import type { RateLimiter } from './rate-limiter';
import type { BaseChannelAdapter } from './channel-adapter';
import type { InboundChannelMessage, AccessPolicy } from '../../shared/types/channels';

const logger = getLogger('ChannelMessageRouter');

export class ChannelMessageRouter {
  constructor(private deps: {
    persistence: ChannelPersistence;
    rateLimiter: RateLimiter;
  }) {}

  async handleMessage(msg: InboundChannelMessage, adapter: BaseChannelAdapter): Promise<void> {
    // 1. Access gate — check sender against adapter's access policy
    const policy = adapter.getAccessPolicy();
    if (!this.isAuthorized(msg.senderId, policy)) {
      logger.warn('Unauthorized sender blocked', { senderId: msg.senderId, platform: msg.platform });
      return;
    }

    // 2. Rate limit
    if (!this.deps.rateLimiter.tryAcquire(msg.senderId)) {
      logger.warn('Rate limited', { senderId: msg.senderId });
      return;
    }

    // 3. Add "processing" reaction
    try {
      await adapter.addReaction(msg.chatId, msg.messageId, '\u23F3');
    } catch { /* best effort */ }

    // 4. Persist inbound message
    this.deps.persistence.insertMessage(msg, 'inbound');

    // 5. Parse intent and route
    try {
      const instanceId = await this.resolveTarget(msg);

      // Success reaction
      try {
        await adapter.addReaction(msg.chatId, msg.messageId, '\u2705');
      } catch { /* best effort */ }

      logger.info('Message routed', { messageId: msg.messageId, instanceId });
    } catch (error) {
      logger.error('Failed to route message', error instanceof Error ? error : undefined, { messageId: msg.messageId });
      try {
        await adapter.addReaction(msg.chatId, msg.messageId, '\u274C');
      } catch { /* best effort */ }
    }
  }

  private isAuthorized(senderId: string, policy: AccessPolicy): boolean {
    if (policy.mode === 'disabled') return true;
    return policy.allowedSenders.includes(senderId);
  }

  private async resolveTarget(msg: InboundChannelMessage): Promise<string> {
    const instanceManager = getInstanceManager();
    const content = msg.content.trim();

    // Check for @all broadcast
    if (content.startsWith('@all ')) {
      const instances = instanceManager.getAllInstances();
      const broadcastContent = content.replace(/^@all\s+/, '');
      for (const inst of instances) {
        await instanceManager.sendInput(inst.id, broadcastContent);
      }
      if (instances.length > 0) {
        return instances[0].id;
      }
    }

    // Check for @DisplayName or @id targeting a specific instance
    if (content.startsWith('@')) {
      const spaceIdx = content.indexOf(' ');
      if (spaceIdx !== -1) {
        const targetName = content.slice(1, spaceIdx);
        const instances = instanceManager.getAllInstances();
        const target = instances.find(
          i => i.displayName === targetName || i.id === targetName,
        );
        if (target) {
          const targetContent = content.slice(spaceIdx + 1);
          await instanceManager.sendInput(target.id, targetContent);
          return target.id;
        }
      }
    }

    // Check for thread mapping to existing instance
    if (msg.threadId) {
      const existingInstanceId = this.deps.persistence.getInstanceForThread(msg.threadId);
      if (existingInstanceId) {
        await instanceManager.sendInput(existingInstanceId, content);
        return existingInstanceId;
      }
    }

    // Default: create new instance
    const instance = await instanceManager.createInstance({
      agentId: 'claude',
      displayName: `Discord-${msg.senderName}`,
      workingDirectory: process.cwd(),
    });
    await instanceManager.sendInput(instance.id, content);
    return instance.id;
  }

  /** Check if outbound content is safe to send to a channel */
  assertSendable(content: string): void {
    const secrets = detectSecretsInContent(content);
    if (secrets.length > 0) {
      throw new Error(`Content contains ${secrets.length} detected secret(s) — blocked from sending to channel`);
    }

    const filePathPattern = /(?:^|\s)(\/[^\s]+|~\/[^\s]+|[A-Za-z]:\\[^\s]+)/g;
    let match: RegExpExecArray | null;
    while ((match = filePathPattern.exec(content)) !== null) {
      const filePath = match[1];
      if (isSecretFile(filePath)) {
        throw new Error(`Content references sensitive file path "${filePath}" — blocked from sending to channel`);
      }
    }
  }
}
