import { randomBytes } from 'crypto';
import { BaseChannelAdapter } from '../channel-adapter';
import { getLogger } from '../../logging/logger';
import type {
  ChannelPlatform,
  ChannelConnectionStatus,
  ChannelConfig,
  ChannelSendOptions,
  ChannelSentMessage,
  InboundChannelMessage,
  AccessPolicy,
  PairedSender,
  PendingPairing,
} from '../../../shared/types/channels';

const logger = getLogger('DiscordAdapter');

const DISCORD_MAX_LENGTH = 2000;
const DEFAULT_CODE_EXPIRY_MS = 60 * 60 * 1000; // 1 hour
const DEFAULT_MAX_PENDING = 10;

export class DiscordAdapter extends BaseChannelAdapter {
  readonly platform: ChannelPlatform = 'discord';
  status: ChannelConnectionStatus = 'disconnected';

  private client: import('discord.js').Client | null = null;
  private botId: string | null = null;
  private accessPolicy: AccessPolicy = {
    mode: 'pairing',
    allowedSenders: [],
    pendingPairings: [],
    maxPending: DEFAULT_MAX_PENDING,
    codeExpiryMs: DEFAULT_CODE_EXPIRY_MS,
  };

  async connect(config: ChannelConfig): Promise<void> {
    if (!config.token) {
      throw new Error('Discord adapter requires a bot token');
    }

    this.status = 'connecting';
    this.emit('status', 'connecting');

    // Use dynamic import so vi.mock('discord.js') intercepts it in tests.
    // In production (CJS build), Electron's Node supports top-level dynamic import.
    const { Client, GatewayIntentBits, Partials } = await import('discord.js');

    const client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.MessageContent,
      ],
      partials: [Partials.Channel, Partials.Message],
    });

    client.on('messageCreate', (msg: import('discord.js').Message) => {
      this.handleIncomingMessage(msg);
    });

    client.on('error', (err: Error) => {
      logger.error('Discord client error', err, {});
      this.emit('error', err);
    });

    await client.login(config.token);

    this.client = client;
    this.botId = client.user?.id ?? null;

    if (config.allowedSenders?.length) {
      this.accessPolicy = {
        ...this.accessPolicy,
        allowedSenders: [...config.allowedSenders],
      };
    }

    this.status = 'connected';
    this.emit('status', 'connected');
    logger.info('Discord connected', { botTag: client.user?.tag });
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      this.client.destroy();
      this.client = null;
    }
    this.botId = null;
    this.status = 'disconnected';
    this.emit('status', 'disconnected');
    logger.info('Discord disconnected', {});
  }

  async sendMessage(chatId: string, content: string, _options?: ChannelSendOptions): Promise<ChannelSentMessage> {
    if (!this.client) {
      throw new Error('Discord adapter is not connected');
    }

    const channel = await this.client.channels.fetch(chatId);
    if (!channel || !channel.isTextBased()) {
      throw new Error(`Channel ${chatId} is not a text channel`);
    }

    const chunks = this.chunkMessage(content);
    let lastMessageId = '';

    // Cast via unknown to avoid PartialGroupDMChannel incompatibility; guarded by isTextBased()
    const sendable = channel as unknown as { send(content: string): Promise<{ id: string }> };
    for (const chunk of chunks) {
      const sent = await sendable.send(chunk);
      lastMessageId = sent.id;
    }

    return {
      messageId: lastMessageId,
      chatId,
      timestamp: Date.now(),
    };
  }

  async sendFile(chatId: string, filePath: string, caption?: string): Promise<ChannelSentMessage> {
    if (!this.client) {
      throw new Error('Discord adapter is not connected');
    }

    const channel = await this.client.channels.fetch(chatId);
    if (!channel || !channel.isTextBased()) {
      throw new Error(`Channel ${chatId} is not a text channel`);
    }

    // Cast via unknown to avoid PartialGroupDMChannel incompatibility; guarded by isTextBased()
    const sendable = channel as unknown as { send(options: { content?: string; files: string[] }): Promise<{ id: string }> };
    const sent = await sendable.send({
      content: caption,
      files: [filePath],
    });

    return {
      messageId: sent.id,
      chatId,
      timestamp: Date.now(),
    };
  }

  async editMessage(chatId: string, messageId: string, content: string): Promise<void> {
    if (!this.client) {
      throw new Error('Discord adapter is not connected');
    }

    const channel = await this.client.channels.fetch(chatId);
    if (!channel || !channel.isTextBased()) {
      throw new Error(`Channel ${chatId} is not a text channel`);
    }

    const msg = await (channel as import('discord.js').TextChannel).messages.fetch(messageId);
    await msg.edit(content);
  }

  async addReaction(chatId: string, messageId: string, emoji: string): Promise<void> {
    if (!this.client) {
      throw new Error('Discord adapter is not connected');
    }

    const channel = await this.client.channels.fetch(chatId);
    if (!channel || !channel.isTextBased()) {
      throw new Error(`Channel ${chatId} is not a text channel`);
    }

    const msg = await (channel as import('discord.js').TextChannel).messages.fetch(messageId);
    await msg.react(emoji);
  }

  getAccessPolicy(): AccessPolicy {
    return { ...this.accessPolicy };
  }

  setAccessPolicy(policy: AccessPolicy): void {
    this.accessPolicy = { ...policy };
  }

  async pairSender(code: string): Promise<PairedSender> {
    const now = Date.now();
    const idx = this.accessPolicy.pendingPairings.findIndex(p => p.code === code);

    if (idx === -1) {
      throw new Error('Invalid pairing code');
    }

    const pending = this.accessPolicy.pendingPairings[idx];

    if (pending.expiresAt < now) {
      this.accessPolicy.pendingPairings.splice(idx, 1);
      throw new Error('Pairing code has expired');
    }

    // Move sender from pending to allowed
    this.accessPolicy.pendingPairings.splice(idx, 1);
    if (!this.accessPolicy.allowedSenders.includes(pending.senderId)) {
      this.accessPolicy.allowedSenders.push(pending.senderId);
    }

    const pairedSender: PairedSender = {
      senderId: pending.senderId,
      senderName: pending.senderName,
      platform: 'discord',
      pairedAt: now,
    };

    logger.info('Sender paired', { senderId: pending.senderId, senderName: pending.senderName });
    return pairedSender;
  }

  // --- Private helpers ---

  private handleIncomingMessage(msg: import('discord.js').Message): void {
    // Ignore bot's own messages
    if (this.botId && msg.author.id === this.botId) {
      return;
    }

    const senderId = msg.author.id;
    const policy = this.accessPolicy;

    // Pairing mode: unknown sender DMs → generate code
    if (policy.mode === 'pairing' && !policy.allowedSenders.includes(senderId)) {
      if (msg.channel.isDMBased()) {
        this.handlePairingRequest(msg);
      }
      return;
    }

    // Allowlist mode: reject unknown senders
    if (policy.mode === 'allowlist' && !policy.allowedSenders.includes(senderId)) {
      logger.warn('Message from unauthorized sender ignored', { senderId });
      return;
    }

    // Disabled: allow all
    const inbound = this.buildInboundMessage(msg);
    this.emit('message', inbound);
  }

  private handlePairingRequest(msg: import('discord.js').Message): void {
    const policy = this.accessPolicy;

    // Clean up expired pending pairings
    const now = Date.now();
    this.accessPolicy.pendingPairings = policy.pendingPairings.filter(p => p.expiresAt > now);

    if (this.accessPolicy.pendingPairings.length >= policy.maxPending) {
      logger.warn('Max pending pairings reached, ignoring pairing request', { senderId: msg.author.id });
      return;
    }

    const code = randomBytes(3).toString('hex');
    const pending: PendingPairing = {
      code,
      senderId: msg.author.id,
      senderName: msg.author.tag ?? msg.author.username,
      expiresAt: now + policy.codeExpiryMs,
    };

    this.accessPolicy.pendingPairings.push(pending);
    logger.info('Pairing code generated', { senderId: msg.author.id, code });

    // Reply with pairing code (fire-and-forget)
    // Cast via unknown — isDMBased() guarantees a real DM channel with send()
    const dmChannel = msg.channel as unknown as { send(content: string): Promise<unknown> };
    dmChannel.send(`Your pairing code is: \`${code}\``).catch((err: Error) => {
      logger.error('Failed to send pairing code', err, { senderId: msg.author.id });
    });
  }

  private buildInboundMessage(msg: import('discord.js').Message): InboundChannelMessage {
    // Strip bot mention from content
    let content = msg.content;
    if (this.botId) {
      content = content.replace(new RegExp(`<@!?${this.botId}>`, 'g'), '').trim();
    }

    // Thread support: if message is in a thread, use parent channel id as chatId
    let chatId = msg.channelId;
    let threadId: string | undefined;

    const channel = msg.channel;
    if (channel.isThread()) {
      threadId = channel.id;
      chatId = channel.parentId ?? chatId;
    }

    const isDM = channel.isDMBased();
    const isGroup = !isDM;

    const attachments = [...msg.attachments.values()].map(a => ({
      name: a.name ?? 'attachment',
      type: a.contentType ?? 'application/octet-stream',
      size: a.size,
      url: a.url,
    }));

    return {
      id: msg.id,
      platform: 'discord',
      chatId,
      messageId: msg.id,
      threadId,
      senderId: msg.author.id,
      senderName: msg.author.tag ?? msg.author.username,
      content,
      attachments,
      isGroup,
      isDM,
      replyTo: msg.reference?.messageId,
      timestamp: msg.createdTimestamp,
    };
  }

  private chunkMessage(content: string, chunkSize = DISCORD_MAX_LENGTH): string[] {
    if (content.length <= chunkSize) {
      return [content];
    }

    const chunks: string[] = [];
    let offset = 0;
    while (offset < content.length) {
      chunks.push(content.slice(offset, offset + chunkSize));
      offset += chunkSize;
    }
    return chunks;
  }
}
