/**
 * Discord Adapter - discord.js implementation of ChannelAdapter
 */

import * as crypto from 'crypto';
import { getLogger } from '../../logging/logger';
import { BaseChannelAdapter } from '../channel-adapter';
import type {
  ChannelPlatform,
  ChannelConfig,
  SendOptions,
  SentMessage,
  InboundChannelMessage,
} from '../../../shared/types/channels';

const logger = getLogger('DiscordAdapter');

const DISCORD_MAX_LENGTH = 2000;

// Discord.js types (resolved at runtime via dynamic import — no static types available)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DiscordClient = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DiscordMessage = any;

export class DiscordAdapter extends BaseChannelAdapter {
  readonly platform: ChannelPlatform = 'discord';
  private client: DiscordClient | null = null;
  private botUserId: string | null = null;

  async connect(config: ChannelConfig): Promise<void> {
    if (!config.token) {
      throw new Error('Discord bot token is required');
    }

    this.setStatus('connecting');
    logger.info('Connecting to Discord...');

    try {
      // Lazy import discord.js
      const { Client, GatewayIntentBits, Partials } = await import('discord.js');

      this.client = new Client({
        intents: [
          GatewayIntentBits.Guilds,
          GatewayIntentBits.GuildMessages,
          GatewayIntentBits.DirectMessages,
          GatewayIntentBits.MessageContent,
        ],
        partials: [Partials.Channel],
      });

      this.client.on('messageCreate', (message: DiscordMessage) =>
        this.handleMessage(message).catch((err: unknown) => {
          logger.error('Error handling Discord message', err instanceof Error ? err : new Error(String(err)));
        })
      );

      this.client.on('error', (err: Error) => {
        logger.error('Discord client error', err);
        this.emitError(err.message, true);
      });

      await this.client.login(config.token);
      this.botUserId = this.client.user?.id ?? null;
      const botUsername = this.client.user?.tag ?? undefined;
      logger.info('Connected to Discord', { botUsername });
      this.setStatus('connected', { botUsername });

      // Apply config allowlists
      if (config.allowedSenders.length > 0) {
        this.accessPolicy.allowedSenders = [...config.allowedSenders];
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('Failed to connect to Discord', err instanceof Error ? err : new Error(message));
      this.setStatus('error');
      this.emitError(`Failed to connect: ${message}`, true);
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      logger.info('Disconnecting from Discord');
      this.client.destroy();
      this.client = null;
      this.botUserId = null;
      this.setStatus('disconnected');
    }
  }

  async sendMessage(chatId: string, content: string, options?: SendOptions): Promise<SentMessage> {
    if (!this.client) throw new Error('Discord client not connected');

    const channel = await this.client.channels.fetch(chatId);
    if (!channel?.isTextBased()) throw new Error(`Channel ${chatId} is not a text channel`);

    const chunks = this.chunkMessage(content, options?.splitAt ?? DISCORD_MAX_LENGTH);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let lastMessage: any;

    for (const chunk of chunks) {
      if (options?.replyTo && chunk === chunks[0]) {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const replyTarget = await (channel as any).messages.fetch(options.replyTo);
          lastMessage = await replyTarget.reply(chunk);
        } catch {
          // If we can't reply, just send normally
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          lastMessage = await (channel as any).send(chunk);
        }
      } else {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        lastMessage = await (channel as any).send(chunk);
      }
    }

    return {
      messageId: lastMessage.id,
      chatId,
      timestamp: lastMessage.createdTimestamp ?? Date.now(),
    };
  }

  async sendFile(chatId: string, filePath: string, caption?: string): Promise<SentMessage> {
    if (!this.client) throw new Error('Discord client not connected');

    const channel = await this.client.channels.fetch(chatId);
    if (!channel?.isTextBased()) throw new Error(`Channel ${chatId} is not a text channel`);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const message = await (channel as any).send({
      content: caption ?? '',
      files: [filePath],
    });

    return {
      messageId: message.id,
      chatId,
      timestamp: message.createdTimestamp ?? Date.now(),
    };
  }

  async editMessage(chatId: string, messageId: string, content: string): Promise<void> {
    if (!this.client) throw new Error('Discord client not connected');

    const channel = await this.client.channels.fetch(chatId);
    if (!channel?.isTextBased()) throw new Error(`Channel ${chatId} is not a text channel`);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const message = await (channel as any).messages.fetch(messageId);
    await message.edit(content);
  }

  async addReaction(chatId: string, messageId: string, emoji: string): Promise<void> {
    if (!this.client) throw new Error('Discord client not connected');

    const channel = await this.client.channels.fetch(chatId);
    if (!channel?.isTextBased()) throw new Error(`Channel ${chatId} is not a text channel`);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const message = await (channel as any).messages.fetch(messageId);
    await message.react(emoji);
  }

  private async handleMessage(message: DiscordMessage): Promise<void> {
    // Ignore bot's own messages
    if (message.author?.id === this.botUserId) return;
    // Ignore other bots
    if (message.author?.bot) return;

    const isGroup = message.guild !== null;
    const isDM = !isGroup;

    // In groups, require @mention of the bot
    if (isGroup && this.botUserId) {
      if (!message.mentions?.has(this.botUserId)) return;
    }

    const senderId = message.author?.id;
    const senderName = message.author?.username ?? message.author?.tag ?? 'Unknown';

    // Access gate
    if (!this.isSenderAllowed(senderId)) {
      // Try pairing flow
      const pending = this.handlePairingRequest(senderId, senderName);
      if (pending) {
        try {
          await message.reply(
            `👋 You're not yet paired with this bot. Your pairing code is: **${pending.code}**\nEnter this code in the Orchestrator UI to pair your account. Code expires in 5 minutes.`
          );
        } catch (err) {
          logger.warn('Failed to send pairing code', { senderId, error: String(err) });
        }
      }
      return;
    }

    // Typing indicator
    try {
      await message.channel?.sendTyping?.();
    } catch {
      // Ignore typing failures
    }

    // Build inbound message
    const inbound: InboundChannelMessage = {
      id: crypto.randomUUID(),
      platform: 'discord',
      chatId: message.channelId ?? message.channel?.id ?? '',
      messageId: message.id,
      threadId: message.thread?.id ?? (message.reference?.messageId ? `discord-ref-${message.reference.messageId}` : undefined),
      senderId,
      senderName,
      content: this.cleanContent(message),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      attachments: (message.attachments?.values ? Array.from(message.attachments.values()) : []).map((a: any) => ({
        name: a.name ?? 'attachment',
        type: a.contentType ?? 'application/octet-stream',
        size: a.size ?? 0,
        url: a.url,
      })),
      isGroup,
      isDM,
      replyTo: message.reference?.messageId,
      timestamp: message.createdTimestamp ?? Date.now(),
    };

    this.emit('message', inbound);
  }

  /**
   * Clean the message content by removing bot mention prefix
   */
  private cleanContent(message: DiscordMessage): string {
    let content: string = message.content ?? '';
    if (this.botUserId) {
      // Remove <@botId> or <@!botId> mention prefix
      content = content.replace(new RegExp(`<@!?${this.botUserId}>\\s*`), '').trim();
    }
    return content;
  }
}
