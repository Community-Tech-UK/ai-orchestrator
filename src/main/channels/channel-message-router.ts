/**
 * Channel Message Router
 *
 * Routes inbound channel messages to instances and streams results back.
 * Pipeline: access gate → rate limit → parse intent → route → stream results
 */

import * as path from 'path';
import { getLogger } from '../logging/logger';
import type { ChannelManager, ChannelEvent } from './channel-manager';
import type { ChannelPersistence } from './channel-persistence';
import { RateLimiter } from './rate-limiter';
import type { BaseChannelAdapter } from './channel-adapter';
import type { InboundChannelMessage } from '../../shared/types/channels';

const logger = getLogger('ChannelMessageRouter');

const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_WINDOW_MS = 60_000;
const DEBOUNCE_MS = 2000;

interface ParsedIntent {
  type: 'default' | 'thread' | 'explicit' | 'broadcast';
  instanceId?: string;
  cleanContent: string;
}

/** Directories that must never be sent out via channel file sharing */
const FORBIDDEN_PATHS = ['.env', 'credentials', 'tokens', 'secrets', '.ssh', 'access.json'];

export class ChannelMessageRouter {
  private rateLimiter = new RateLimiter(RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS);
  private unsubscribe: (() => void) | null = null;
  private outputBuffers = new Map<string, { content: string; timer: ReturnType<typeof setTimeout> }>();
  // We need InstanceManager but import it lazily to avoid circular deps
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private instanceManager: any = null;

  constructor(
    private channelManager: ChannelManager,
    private persistence: ChannelPersistence,
  ) {}

  start(): void {
    this.unsubscribe = this.channelManager.onEvent((event: ChannelEvent) => {
      if (event.type === 'message') {
        this.handleInboundMessage(event.data).catch(err => {
          logger.error('Error handling inbound message', err instanceof Error ? err : new Error(String(err)));
        });
      }
    });
    logger.info('Channel message router started');
  }

  stop(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    // Clear any pending debounce timers
    for (const [, buf] of this.outputBuffers) {
      clearTimeout(buf.timer);
    }
    this.outputBuffers.clear();
    this.rateLimiter.clear();
    logger.info('Channel message router stopped');
  }

  /**
   * Lazy-load InstanceManager to avoid circular deps at import time.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private getInstanceManager(): any {
    if (!this.instanceManager) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { InstanceManager } = require('../instance/instance-manager');
      this.instanceManager = InstanceManager.getInstance?.() ?? new InstanceManager();
    }
    return this.instanceManager;
  }

  /** Inject instance manager for testing */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  _setInstanceManagerForTesting(im: any): void {
    this.instanceManager = im;
  }

  async handleInboundMessage(msg: InboundChannelMessage): Promise<void> {
    // 1. Access gate — adapter already handles this, but double-check
    const adapter = this.channelManager.getAdapter(msg.platform);
    if (!adapter) {
      logger.warn('No adapter for platform', { platform: msg.platform });
      return;
    }

    // 2. Rate limit
    if (!this.rateLimiter.check(msg.senderId)) {
      logger.warn('Rate limited sender', { senderId: msg.senderId, platform: msg.platform });
      try {
        await adapter.addReaction(msg.chatId, msg.messageId, '⏳');
      } catch {
        // Ignore reaction failures
      }
      return;
    }

    // 3. Parse intent
    const intent = this.parseIntent(msg.content, msg.threadId);

    // 4. Save inbound message to persistence
    this.persistence.saveMessage({
      id: msg.id,
      platform: msg.platform,
      chat_id: msg.chatId,
      message_id: msg.messageId,
      thread_id: msg.threadId ?? null,
      sender_id: msg.senderId,
      sender_name: msg.senderName,
      content: msg.content,
      direction: 'inbound',
      instance_id: null,
      reply_to_message_id: msg.replyTo ?? null,
      timestamp: msg.timestamp,
    });

    // 5. Acknowledge receipt
    try {
      await adapter.addReaction(msg.chatId, msg.messageId, '👀');
    } catch {
      // Ignore reaction failures
    }

    // 6. Route based on intent
    try {
      let instanceId: string;

      switch (intent.type) {
        case 'thread':
          instanceId = intent.instanceId!;
          await this.routeToInstance(msg, instanceId, intent.cleanContent, adapter);
          break;

        case 'explicit':
          instanceId = intent.instanceId!;
          await this.routeToInstance(msg, instanceId, intent.cleanContent, adapter);
          break;

        case 'broadcast':
          await this.routeBroadcast(msg, intent.cleanContent, adapter);
          return; // broadcast handles its own completion

        case 'default':
        default:
          instanceId = await this.routeDefault(msg, intent.cleanContent, adapter);
          break;
      }

      // Update instance_id in persistence
      this.persistence.updateInstanceId(msg.id, instanceId);

      // React with completion
      try {
        await adapter.addReaction(msg.chatId, msg.messageId, '✅');
      } catch {
        // Ignore
      }
    } catch (err) {
      logger.error('Error routing message', err instanceof Error ? err : new Error(String(err)));
      try {
        await adapter.addReaction(msg.chatId, msg.messageId, '❌');
        await adapter.sendMessage(msg.chatId, `Error: ${err instanceof Error ? err.message : String(err)}`, {
          replyTo: msg.messageId,
        });
      } catch {
        // Ignore send failures
      }
    }
  }

  parseIntent(content: string, threadId?: string): ParsedIntent {
    // Check for @instance-<id> pattern
    const explicitMatch = content.match(/^@instance-(\S+)\s+([\s\S]+)$/);
    if (explicitMatch) {
      return { type: 'explicit', instanceId: explicitMatch[1], cleanContent: explicitMatch[2].trim() };
    }

    // Check for @all pattern
    const broadcastMatch = content.match(/^@all\s+([\s\S]+)$/);
    if (broadcastMatch) {
      return { type: 'broadcast', cleanContent: broadcastMatch[1].trim() };
    }

    // Check for thread continuity
    if (threadId) {
      const instanceId = this.persistence.resolveInstanceByThread(threadId);
      if (instanceId) {
        return { type: 'thread', instanceId, cleanContent: content };
      }
    }

    // Default: create new instance
    return { type: 'default', cleanContent: content };
  }

  private async routeDefault(
    msg: InboundChannelMessage,
    content: string,
    adapter: BaseChannelAdapter,
  ): Promise<string> {
    const im = this.getInstanceManager();
    const instance = await im.createInstance({
      displayName: `${msg.platform}:${msg.senderName}`,
      workingDirectory: process.cwd(),
      initialPrompt: content,
      yoloMode: true,
    });

    // Stream results back
    this.streamResults(msg, instance.id, adapter);

    return instance.id;
  }

  private async routeToInstance(
    msg: InboundChannelMessage,
    instanceId: string,
    content: string,
    adapter: BaseChannelAdapter,
  ): Promise<void> {
    const im = this.getInstanceManager();
    await im.sendInput(instanceId, content);

    // Stream results back
    this.streamResults(msg, instanceId, adapter);
  }

  private async routeBroadcast(
    msg: InboundChannelMessage,
    content: string,
    adapter: BaseChannelAdapter,
  ): Promise<void> {
    const im = this.getInstanceManager();
    // Get all instances — InstanceManager has getInstances() or similar
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const instances: any[] = im.getInstances?.() ?? [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const activeInstances = instances.filter((i: any) =>
      i.status === 'idle' || i.status === 'busy'
    );

    if (activeInstances.length === 0) {
      await adapter.sendMessage(msg.chatId, 'No active instances to broadcast to.', {
        replyTo: msg.messageId,
      });
      return;
    }

    await adapter.sendMessage(
      msg.chatId,
      `Broadcasting to ${activeInstances.length} instances...`,
      { replyTo: msg.messageId },
    );

    for (const inst of activeInstances) {
      try {
        await im.sendInput(inst.id, content);
        this.streamResults(msg, inst.id, adapter);
      } catch (err) {
        logger.warn('Failed to send broadcast to instance', { instanceId: inst.id, error: err });
      }
    }
  }

  private streamResults(
    msg: InboundChannelMessage,
    instanceId: string,
    adapter: BaseChannelAdapter,
  ): void {
    const im = this.getInstanceManager();
    const bufferKey = `${msg.id}:${instanceId}`;

    const handler = (payload: { instanceId: string; message: { type: string; content: string } }) => {
      if (payload.instanceId !== instanceId) return;

      const content = payload.message?.content;
      if (!content) return;

      // Debounce: accumulate output and send after DEBOUNCE_MS of silence
      const existing = this.outputBuffers.get(bufferKey);
      if (existing) {
        clearTimeout(existing.timer);
        existing.content += content;
      } else {
        this.outputBuffers.set(bufferKey, { content, timer: null as unknown as ReturnType<typeof setTimeout> });
      }

      const buffer = this.outputBuffers.get(bufferKey)!;
      buffer.timer = setTimeout(() => {
        this.outputBuffers.delete(bufferKey);
        im.removeListener('instance:output', handler);

        // Send accumulated output
        adapter.sendMessage(msg.chatId, buffer.content, {
          replyTo: msg.messageId,
        }).catch((err: unknown) => {
          logger.error('Failed to send output to channel', err instanceof Error ? err : new Error(String(err)));
        });

        // Save outbound message
        this.persistence.saveMessage({
          id: `out-${msg.id}-${instanceId}`,
          platform: msg.platform,
          chat_id: msg.chatId,
          message_id: '',
          thread_id: msg.threadId ?? null,
          sender_id: 'bot',
          sender_name: 'Orchestrator',
          content: buffer.content,
          direction: 'outbound',
          instance_id: instanceId,
          reply_to_message_id: msg.messageId,
          timestamp: Date.now(),
        });
      }, DEBOUNCE_MS);
    };

    im.on('instance:output', handler);
  }

  /**
   * Security guard: prevents sending sensitive files via channel.
   * Blocks files from config/state directories.
   */
  assertSendable(filePath: string): void {
    const normalized = path.normalize(filePath).toLowerCase();
    for (const forbidden of FORBIDDEN_PATHS) {
      if (normalized.includes(forbidden)) {
        throw new Error(`Cannot send file from restricted path: ${filePath}`);
      }
    }
  }
}
