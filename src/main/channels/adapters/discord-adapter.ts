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
  PairedSender,
  ChannelMessageAction,
} from '../../../shared/types/channels';

const logger = getLogger('DiscordAdapter');

const DISCORD_MAX_LENGTH = 2000;

// Discord.js types (resolved at runtime via dynamic import — no static types available)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DiscordClient = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DiscordMessage = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DiscordInteraction = any;

interface DeferredInteraction {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  interaction: any;
  used: boolean;
}

export interface DiscordHealthSnapshot {
  status: string;
  botUserId: string | null;
  botUsername?: string;
  connectedAt?: number;
  lastGatewayEventAt?: number;
  lastMessageAt?: number;
  reconnectAttempts: number;
  reconnectScheduled: boolean;
  lastError?: string;
}

const DISCORD_OPTION_STRING = 3;
const DISCORD_OPTION_USER = 6;
const BUTTON_PREFIX = 'orch';
const MAX_ACTIONS_PER_MESSAGE = 5;
const RECONNECT_BASE_DELAY_MS = 1_000;
const RECONNECT_MAX_DELAY_MS = 30_000;

const DISCORD_COMMANDS = [
  { name: 'help', description: 'Show bot commands' },
  {
    name: 'list',
    description: 'Show projects or drill into one project',
    options: [
      { name: 'project', description: 'Project name or path', type: DISCORD_OPTION_STRING, required: false, autocomplete: true },
    ],
  },
  { name: 'pick', description: 'Pick from active sessions' },
  {
    name: 'select',
    description: 'Pin this Discord channel or DM to a project/session',
    options: [
      { name: 'project', description: 'Project name or path', type: DISCORD_OPTION_STRING, required: true, autocomplete: true },
      { name: 'session', description: 'Session display name or id', type: DISCORD_OPTION_STRING, required: false, autocomplete: true },
    ],
  },
  {
    name: 'new',
    description: 'Start a new session',
    options: [
      { name: 'prompt', description: 'Initial prompt', type: DISCORD_OPTION_STRING, required: false },
      { name: 'project', description: 'Project name or path', type: DISCORD_OPTION_STRING, required: false, autocomplete: true },
    ],
  },
  {
    name: 'revive',
    description: 'Revive a hibernated session',
    options: [
      { name: 'project', description: 'Project name or path', type: DISCORD_OPTION_STRING, required: false, autocomplete: true },
      { name: 'session', description: 'Session display name or id', type: DISCORD_OPTION_STRING, required: false, autocomplete: true },
    ],
  },
  { name: 'whereami', description: 'Show current routing target for this Discord context' },
  { name: 'status', description: 'Show bot connection, pairing, and routing health' },
  { name: 'clear', description: 'Clear this channel project/session pin' },
  { name: 'switch', description: 'Clear your DM session pin' },
  {
    name: 'stop',
    description: 'Interrupt a session',
    options: [
      { name: 'session', description: 'Session id or display name', type: DISCORD_OPTION_STRING, required: false, autocomplete: true },
    ],
  },
  {
    name: 'continue',
    description: 'Send continue to a session',
    options: [
      { name: 'session', description: 'Session id or display name', type: DISCORD_OPTION_STRING, required: false, autocomplete: true },
    ],
  },
  { name: 'pair', description: 'Get pairing status or request a pairing code' },
  {
    name: 'unpair',
    description: 'Unpair yourself, or an explicit user id if you are an admin',
    options: [
      { name: 'user', description: 'Discord user to unpair', type: DISCORD_OPTION_USER, required: false },
      { name: 'user_id', description: 'Discord user id to unpair', type: DISCORD_OPTION_STRING, required: false },
    ],
  },
  { name: 'whoami', description: 'Show your Discord id and pairing status' },
  {
    name: 'allow',
    description: 'Admin: allow a Discord user',
    options: [
      { name: 'user', description: 'Discord user to allow', type: DISCORD_OPTION_USER, required: false },
      { name: 'user_id', description: 'Discord user id to allow', type: DISCORD_OPTION_STRING, required: false },
    ],
  },
  {
    name: 'deny',
    description: 'Admin: remove a Discord user from the allowlist',
    options: [
      { name: 'user', description: 'Discord user to remove', type: DISCORD_OPTION_USER, required: false },
      { name: 'user_id', description: 'Discord user id to remove', type: DISCORD_OPTION_STRING, required: false },
    ],
  },
  { name: 'reset-discord', description: 'Admin: reset local Discord routing and pairing state' },
  { name: 'nodes', description: 'List worker nodes' },
  {
    name: 'run-on',
    description: 'Run a prompt on a specific worker node',
    options: [
      { name: 'node', description: 'Worker node name or id', type: DISCORD_OPTION_STRING, required: true },
      { name: 'prompt', description: 'Prompt to run', type: DISCORD_OPTION_STRING, required: true },
    ],
  },
  {
    name: 'offload',
    description: 'Configure automatic offloading',
    options: [
      { name: 'target', description: 'Offload target', type: DISCORD_OPTION_STRING, required: true, choices: [{ name: 'browser', value: 'browser' }] },
      { name: 'mode', description: 'Mode', type: DISCORD_OPTION_STRING, required: false, choices: [
        { name: 'on', value: 'on' },
        { name: 'off', value: 'off' },
        { name: 'status', value: 'status' },
      ] },
    ],
  },
];

export class DiscordAdapter extends BaseChannelAdapter {
  readonly platform: ChannelPlatform = 'discord';
  private client: DiscordClient | null = null;
  private botUserId: string | null = null;
  private botUsername: string | undefined;
  private lastConfig: ChannelConfig | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private manualDisconnect = false;
  private connectedAt: number | undefined;
  private lastGatewayEventAt: number | undefined;
  private lastMessageAt: number | undefined;
  private lastError: string | undefined;
  private deferredInteractions = new Map<string, DeferredInteraction>();

  async connect(config: ChannelConfig): Promise<void> {
    if (!config.token) {
      throw new Error('Discord bot token is required');
    }

    this.lastConfig = {
      ...config,
      allowedSenders: [...config.allowedSenders],
      allowedChats: [...config.allowedChats],
    };
    this.manualDisconnect = false;
    this.clearReconnectTimer();
    this.setStatus('connecting');
    logger.info('Connecting to Discord...');

    try {
      await this.destroyClient(false);

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

      this.client.on('interactionCreate', (interaction: DiscordInteraction) =>
        this.handleInteraction(interaction).catch((err: unknown) => {
          logger.error('Error handling Discord interaction', err instanceof Error ? err : new Error(String(err)));
        })
      );

      this.client.on('ready', () => {
        this.lastGatewayEventAt = Date.now();
      });

      this.client.on('shardResume', () => {
        this.lastGatewayEventAt = Date.now();
        this.lastError = undefined;
      });

      this.client.on('shardDisconnect', (event: { code?: number; reason?: string } | undefined) => {
        const reason = event?.reason || `Gateway disconnected${event?.code ? ` (${event.code})` : ''}`;
        this.scheduleReconnect(reason);
      });

      this.client.on('shardError', (err: Error) => {
        this.lastError = err.message;
        this.emitError(err.message, true);
      });

      this.client.on('invalidated', () => {
        this.scheduleReconnect('Discord session invalidated');
      });

      this.client.on('error', (err: Error) => {
        logger.error('Discord client error', err);
        this.lastError = err.message;
        this.emitError(err.message, true);
      });

      await this.client.login(config.token);
      this.botUserId = this.client.user?.id ?? null;
      this.botUsername = this.client.user?.tag ?? undefined;
      this.connectedAt = Date.now();
      this.lastGatewayEventAt = this.connectedAt;
      this.lastError = undefined;
      this.reconnectAttempts = 0;
      logger.info('Connected to Discord', { botUsername: this.botUsername });
      await this.registerSlashCommands();
      this.setStatus('connected', { botUsername: this.botUsername });

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
    this.manualDisconnect = true;
    this.clearReconnectTimer();
    await this.destroyClient(true);
  }

  getHealthSnapshot(): DiscordHealthSnapshot {
    return {
      status: this.status,
      botUserId: this.botUserId,
      botUsername: this.botUsername,
      connectedAt: this.connectedAt,
      lastGatewayEventAt: this.lastGatewayEventAt,
      lastMessageAt: this.lastMessageAt,
      reconnectAttempts: this.reconnectAttempts,
      reconnectScheduled: this.reconnectTimer !== null,
      lastError: this.lastError,
    };
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private async destroyClient(emitStatus: boolean): Promise<void> {
    if (!this.client) {
      if (emitStatus) {
        this.setStatus('disconnected');
      }
      return;
    }

    logger.info('Disconnecting from Discord');
    this.client.destroy();
    this.client = null;
    this.botUserId = null;
    this.botUsername = undefined;
    this.connectedAt = undefined;
    this.deferredInteractions.clear();
    if (emitStatus) {
      this.setStatus('disconnected');
    }
  }

  private scheduleReconnect(reason: string): void {
    this.lastError = reason;
    if (this.manualDisconnect || !this.lastConfig?.token) {
      this.emitError(reason, true);
      return;
    }

    if (this.reconnectTimer) {
      return;
    }

    this.reconnectAttempts += 1;
    const delay = Math.min(
      RECONNECT_MAX_DELAY_MS,
      RECONNECT_BASE_DELAY_MS * 2 ** Math.max(0, this.reconnectAttempts - 1),
    );
    this.setStatus('error');
    this.emitError(`${reason}; reconnecting in ${Math.round(delay / 1000)}s`, true);
    logger.warn('Scheduling Discord reconnect', { reason, delay, attempt: this.reconnectAttempts });

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.manualDisconnect || !this.lastConfig) {
        return;
      }
      this.connect(this.lastConfig).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        this.scheduleReconnect(message);
      });
    }, delay);
  }

  private async registerSlashCommands(): Promise<void> {
    try {
      await this.client?.application?.commands?.set?.(DISCORD_COMMANDS);
      logger.info('Discord slash commands registered', { count: DISCORD_COMMANDS.length });
    } catch (err) {
      logger.warn('Failed to register Discord slash commands', { error: String(err) });
    }
  }

  override async pairSender(code: string): Promise<PairedSender> {
    const result = await super.pairSender(code);

    // Send confirmation DM to the newly paired user
    if (this.client) {
      try {
        const user = await this.client.users.fetch(result.senderId);
        if (user) {
          await user.send(
            `✅ **Paired successfully!** You're now connected to the Orchestrator.\n\nTry these commands:\n• \`/help\` — see all available commands\n• \`/list\` — list running instances\n• \`@projectname message\` — send to a specific project`
          );
        }
      } catch (err) {
        logger.warn('Failed to send pairing confirmation DM', { senderId: result.senderId, error: String(err) });
      }
    }

    return result;
  }

  async sendMessage(chatId: string, content: string, options?: SendOptions): Promise<SentMessage> {
    if (!this.client) throw new Error('Discord client not connected');

    const interactionReply = await this.trySendInteractionReply(content, options);
    if (interactionReply) {
      return interactionReply;
    }

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
          lastMessage = await replyTarget.reply(this.buildSendPayload(chunk, options.actions));
        } catch {
          // If we can't reply, just send normally
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          lastMessage = await (channel as any).send(this.buildSendPayload(chunk, options.actions));
        }
      } else {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        lastMessage = await (channel as any).send(this.buildSendPayload(chunk, chunk === chunks[0] ? options?.actions : undefined));
      }
    }

    return {
      messageId: lastMessage.id,
      chatId,
      timestamp: lastMessage.createdTimestamp ?? Date.now(),
    };
  }

  private async trySendInteractionReply(
    content: string,
    options?: SendOptions,
  ): Promise<SentMessage | null> {
    const replyTo = options?.replyTo;
    if (!replyTo) {
      return null;
    }

    const deferred = this.deferredInteractions.get(replyTo);
    if (!deferred || deferred.used) {
      return null;
    }

    deferred.used = true;
    const chunks = this.chunkMessage(content, options.splitAt ?? DISCORD_MAX_LENGTH);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let lastMessage: any;

    for (let i = 0; i < chunks.length; i++) {
      const payload = this.buildSendPayload(chunks[i], i === 0 ? options.actions : undefined);
      if (i === 0) {
        if (deferred.interaction.deferred || deferred.interaction.replied) {
          lastMessage = await deferred.interaction.editReply(payload);
        } else {
          lastMessage = await deferred.interaction.reply(payload);
        }
      } else {
        lastMessage = await deferred.interaction.followUp(payload);
      }
    }

    return {
      messageId: lastMessage?.id ?? replyTo,
      chatId: lastMessage?.channelId ?? deferred.interaction.channelId ?? '',
      timestamp: lastMessage?.createdTimestamp ?? Date.now(),
    };
  }

  private buildSendPayload(content: string, actions?: ChannelMessageAction[]): string | Record<string, unknown> {
    const usableActions = actions?.slice(0, MAX_ACTIONS_PER_MESSAGE).filter(action => action.id && action.label) ?? [];
    if (usableActions.length === 0) {
      return content;
    }

    return {
      content,
      components: [
        {
          type: 1,
          components: usableActions.map(action => ({
            type: 2,
            custom_id: action.id.slice(0, 100),
            label: action.label.slice(0, 80),
            style: this.toDiscordButtonStyle(action.style),
          })),
        },
      ],
    };
  }

  private toDiscordButtonStyle(style: ChannelMessageAction['style']): number {
    switch (style) {
      case 'primary':
        return 1;
      case 'success':
        return 3;
      case 'danger':
        return 4;
      case 'secondary':
      default:
        return 2;
    }
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
    this.lastGatewayEventAt = Date.now();
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
    const cleanContent = this.cleanContent(message);
    this.lastMessageAt = Date.now();

    // Access gate
    if (!this.isSenderAllowed(senderId)) {
      if (this.isWhoAmICommand(cleanContent)) {
        await this.replyToUnknownWhoAmI(message, senderId);
        return;
      }
      // Try pairing flow
      await this.replyWithPairingCode(message, senderId, senderName);
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
      guildId: message.guild?.id,
      threadId: message.thread?.id ?? (message.reference?.messageId ? `discord-ref-${message.reference.messageId}` : undefined),
      senderId,
      senderName,
      senderIsAdmin: this.isMessageAdmin(message),
      content: cleanContent,
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

  private async handleInteraction(interaction: DiscordInteraction): Promise<void> {
    this.lastGatewayEventAt = Date.now();

    if (interaction.isAutocomplete?.()) {
      await this.handleAutocompleteInteraction(interaction);
      return;
    }

    if (!interaction.isChatInputCommand?.() && !interaction.isButton?.()) {
      return;
    }

    const senderId = interaction.user?.id ?? '';
    const senderName = interaction.user?.username ?? interaction.user?.tag ?? 'Unknown';
    const commandName = interaction.isChatInputCommand?.()
      ? String(interaction.commandName || '')
      : this.buttonCommandName(interaction.customId || '');

    if (!this.isSenderAllowed(senderId)) {
      if (commandName === 'whoami') {
        await this.replyInteraction(
          interaction,
          `Discord id: \`${senderId || 'unknown'}\`\nPairing: not paired. Use \`/pair\` to request a pairing code.`,
        );
        return;
      }
      await this.replyInteractionWithPairingCode(interaction, senderId, senderName);
      return;
    }

    const content = interaction.isButton?.()
      ? this.buttonToContent(interaction.customId || '')
      : this.commandToContent(interaction);
    if (!content) {
      await this.replyInteraction(interaction, 'Unsupported Discord interaction.');
      return;
    }

    try {
      if (!interaction.deferred && !interaction.replied) {
        await interaction.deferReply?.({ ephemeral: false });
      }
      this.deferredInteractions.set(interaction.id, { interaction, used: false });
    } catch (err) {
      logger.warn('Failed to defer Discord interaction', { error: String(err) });
    }

    const inbound: InboundChannelMessage = {
      id: crypto.randomUUID(),
      platform: 'discord',
      chatId: interaction.channelId ?? interaction.channel?.id ?? '',
      messageId: interaction.id,
      guildId: interaction.guildId ?? interaction.guild?.id,
      senderId,
      senderName,
      senderIsAdmin: this.isInteractionAdmin(interaction),
      content,
      attachments: [],
      isGroup: Boolean(interaction.guildId ?? interaction.guild),
      isDM: !interaction.guildId && !interaction.guild,
      timestamp: Date.now(),
    };

    this.lastMessageAt = inbound.timestamp;
    this.emit('message', inbound);
  }

  private async handleAutocompleteInteraction(interaction: DiscordInteraction): Promise<void> {
    const focused = interaction.options?.getFocused?.(true) ?? {};
    const options = this.extractInteractionOptions(interaction);

    this.emit('autocomplete', {
      platform: 'discord',
      chatId: interaction.channelId ?? interaction.channel?.id ?? '',
      senderId: interaction.user?.id ?? '',
      senderName: interaction.user?.username ?? interaction.user?.tag ?? 'Unknown',
      commandName: String(interaction.commandName || ''),
      focusedName: String(focused.name || ''),
      focusedValue: String(focused.value || ''),
      options,
      respond: async (choices: { name: string; value: string }[]) => {
        await interaction.respond(
          choices.slice(0, 25).map((choice: { name: string; value: string }) => ({
            name: choice.name.slice(0, 100),
            value: choice.value.slice(0, 100),
          })),
        );
      },
    });
  }

  private commandToContent(interaction: DiscordInteraction): string {
    const command = String(interaction.commandName || '').toLowerCase();
    const getString = (name: string): string => interaction.options?.getString?.(name) ?? '';
    const getUserId = (): string => (
      interaction.options?.getUser?.('user')?.id
      ?? interaction.options?.getString?.('user_id')
      ?? ''
    );

    switch (command) {
      case 'help':
      case 'pick':
      case 'whereami':
      case 'status':
      case 'clear':
      case 'switch':
      case 'pair':
      case 'whoami':
      case 'reset-discord':
      case 'nodes':
        return `/${command}`;
      case 'list':
        return this.withArg('/list', getString('project'));
      case 'select': {
        const project = getString('project');
        const session = getString('session');
        return session ? `/select ${project}/${session}` : `/select ${project}`;
      }
      case 'new': {
        const project = getString('project');
        const prompt = getString('prompt');
        return project ? `/new ${project} -- ${prompt}` : `/new -- ${prompt}`;
      }
      case 'revive': {
        const project = getString('project');
        const session = getString('session');
        if (project && session) return `/revive ${project}/${session}`;
        return this.withArg('/revive', project || session);
      }
      case 'stop':
        return this.withArg('/stop', getString('session'));
      case 'continue':
        return this.withArg('/continue', getString('session'));
      case 'unpair':
        return this.withArg('/unpair', getUserId());
      case 'allow':
        return this.withArg('/allow', getUserId());
      case 'deny':
        return this.withArg('/deny', getUserId());
      case 'run-on':
        return `/run-on ${getString('node')} ${getString('prompt')}`.trim();
      case 'offload':
        return `/offload ${getString('target')} ${getString('mode')}`.trim();
      default:
        return `/${command}`;
    }
  }

  private withArg(command: string, arg: string): string {
    const trimmed = arg.trim();
    return trimmed ? `${command} ${trimmed}` : command;
  }

  private buttonCommandName(customId: string): string {
    return customId.split(':')[1] || '';
  }

  private buttonToContent(customId: string): string {
    const [prefix, action, rawArg = ''] = customId.split(':');
    if (prefix !== BUTTON_PREFIX) {
      return '';
    }
    const arg = decodeURIComponent(rawArg);
    switch (action) {
      case 'pick':
        return '/pick';
      case 'revive':
        return this.withArg('/revive', arg);
      case 'new':
        return arg ? `/new ${arg} --` : '/new';
      case 'stop':
        return this.withArg('/stop', arg);
      case 'continue':
        return this.withArg('/continue', arg);
      default:
        return '';
    }
  }

  private extractInteractionOptions(interaction: DiscordInteraction): Record<string, string> {
    const options: Record<string, string> = {};
    const data = interaction.options?.data ?? [];
    for (const option of data) {
      if (typeof option.name === 'string') {
        options[option.name] = String(option.value ?? option.user?.id ?? '');
      }
    }
    return options;
  }

  private async replyWithPairingCode(
    message: DiscordMessage,
    senderId: string,
    senderName: string,
  ): Promise<void> {
    const pending = this.handlePairingRequest(senderId, senderName);
    if (!pending) {
      return;
    }
    try {
      await message.reply(this.pairingCodeMessage(pending.code));
    } catch (err) {
      logger.warn('Failed to send pairing code', { senderId, error: String(err) });
    }
  }

  private async replyInteractionWithPairingCode(
    interaction: DiscordInteraction,
    senderId: string,
    senderName: string,
  ): Promise<void> {
    const pending = this.handlePairingRequest(senderId, senderName);
    if (!pending) {
      await this.replyInteraction(interaction, 'Pairing is not currently available. Ask an administrator to allow your Discord user id.');
      return;
    }
    await this.replyInteraction(interaction, this.pairingCodeMessage(pending.code));
  }

  private pairingCodeMessage(code: string): string {
    return `You're not yet paired with this bot. Your pairing code is: **${code}**\nEnter this code in the Orchestrator UI to pair your account. Code expires in 1 hour.`;
  }

  private async replyToUnknownWhoAmI(message: DiscordMessage, senderId: string): Promise<void> {
    try {
      await message.reply(
        `Discord id: \`${senderId || 'unknown'}\`\nPairing: not paired. Send any message or use \`/pair\` to request a pairing code.`,
      );
    } catch (err) {
      logger.warn('Failed to send whoami response', { senderId, error: String(err) });
    }
  }

  private async replyInteraction(interaction: DiscordInteraction, content: string): Promise<void> {
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ content });
      return;
    }
    await interaction.reply({ content, ephemeral: false });
  }

  private isWhoAmICommand(content: string): boolean {
    const normalized = content.trim().toLowerCase();
    return normalized === '/whoami' || normalized === 'whoami';
  }

  private isMessageAdmin(message: DiscordMessage): boolean {
    return Boolean(
      message.member?.permissions?.has?.('Administrator')
      || message.memberPermissions?.has?.('Administrator')
    );
  }

  private isInteractionAdmin(interaction: DiscordInteraction): boolean {
    return Boolean(
      interaction.memberPermissions?.has?.('Administrator')
      || interaction.member?.permissions?.has?.('Administrator')
    );
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
