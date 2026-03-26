/**
 * Channel Message Router
 *
 * Routes inbound channel messages to instances and streams results back.
 * Pipeline: access gate → rate limit → parse intent → route → stream results
 *
 * Commands:
 *   /list                     — show all projects and their instances
 *   /select <project>         — pin this Discord channel to a project (future messages go there)
 *   /select <project>/<name>  — pin to a specific instance
 *   /clear                    — clear the channel pin
 *
 * Routing (in priority order):
 *   1. Thread reply            — continues the instance that owns the thread
 *   2. @<project>/<name> msg   — route to a specific instance by project/display-name
 *   3. @<project> msg          — route to the most recent idle instance in that project
 *   4. @all msg                — broadcast to every active instance
 *   5. Channel pin             — if /select was used, route there
 *   6. Default                 — create a new instance
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
  type: 'command' | 'thread' | 'named' | 'broadcast' | 'pinned' | 'default';
  instanceId?: string;
  cleanContent: string;
  command?: string;
  commandArgs?: string;
}

/** Directories that must never be sent out via channel file sharing */
const FORBIDDEN_PATHS = ['.env', 'credentials', 'tokens', 'secrets', '.ssh', 'access.json'];

export class ChannelMessageRouter {
  private rateLimiter = new RateLimiter(RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS);
  private unsubscribe: (() => void) | null = null;
  private outputBuffers = new Map<string, { content: string; timer: ReturnType<typeof setTimeout> }>();
  /** Maps Discord channelId → pinned instanceId */
  private channelPins = new Map<string, string>();
  /** Maps DM senderId → instanceId (persistent per-user DM instance) */
  private dmPins = new Map<string, string>();
  /** Maps channelId/senderId → pending pick list for interactive selection */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private pendingPicks = new Map<string, any[]>();
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

  // ============ Instance helpers ============

  /**
   * Get all instances grouped by project (derived from workingDirectory basename).
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private getProjectMap(): Map<string, any[]> {
    const im = this.getInstanceManager();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const instances: any[] = im.getAllInstances?.() ?? [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const map = new Map<string, any[]>();

    for (const inst of instances) {
      const dir = (inst.workingDirectory || '').trim();
      const project = dir ? path.basename(dir) : '(no project)';
      const key = project.toLowerCase();
      if (!map.has(key)) {
        map.set(key, []);
      }
      map.get(key)!.push(inst);
    }
    return map;
  }

  /**
   * Resolve an instance by project name and optional display name.
   * - "claude-orchestrator" → most recent idle instance in that project
   * - "claude-orchestrator/fix nav" → specific instance by display name
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private resolveByName(projectName: string, instanceName?: string): any | null {
    const projectMap = this.getProjectMap();
    const key = projectName.toLowerCase();

    // Try exact match first, then prefix match
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let candidates: any[] | undefined = projectMap.get(key);
    if (!candidates) {
      // Prefix match
      for (const [k, v] of projectMap) {
        if (k.startsWith(key)) {
          candidates = v;
          break;
        }
      }
    }
    if (!candidates || candidates.length === 0) return null;

    if (instanceName) {
      // Match by display name (case-insensitive, partial match)
      const needle = instanceName.toLowerCase();
      return candidates.find(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (i: any) => (i.displayName || '').toLowerCase().includes(needle)
      ) ?? null;
    }

    // No instance name — pick the most recently active idle/busy instance
    const active = candidates
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .filter((i: any) => i.status === 'idle' || i.status === 'busy')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .sort((a: any, b: any) => (b.lastActivity || 0) - (a.lastActivity || 0));
    return active[0] ?? candidates[0] ?? null;
  }

  // ============ Command handlers ============

  private async handleListCommand(
    msg: InboundChannelMessage,
    adapter: BaseChannelAdapter,
  ): Promise<void> {
    const projectMap = this.getProjectMap();

    if (projectMap.size === 0) {
      await adapter.sendMessage(msg.chatId, 'No active instances.', { replyTo: msg.messageId });
      return;
    }

    const lines: string[] = [];
    // Sort projects alphabetically
    const sortedKeys = [...projectMap.keys()].sort();

    for (const key of sortedKeys) {
      const instances = projectMap.get(key)!;
      const dir = (instances[0]?.workingDirectory || '').trim();
      const projectLabel = dir ? path.basename(dir) : '(no project)';
      lines.push(`**${projectLabel}**  (${instances.length} instance${instances.length === 1 ? '' : 's'})`);

      // Sort by last activity descending
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sorted = [...instances].sort((a: any, b: any) => (b.lastActivity || 0) - (a.lastActivity || 0));
      for (const inst of sorted) {
        const status = inst.status || 'unknown';
        const icon = status === 'idle' ? '🟢' : status === 'busy' ? '🟡' : '⚫';
        const name = inst.displayName || inst.id.slice(0, 8);
        const age = this.formatAge(inst.lastActivity);
        lines.push(`  ${icon} ${name}  —  ${status}  (${age})`);
      }
      lines.push('');
    }

    const pinInfo = this.channelPins.get(msg.chatId);
    if (pinInfo) {
      const im = this.getInstanceManager();
      const pinned = im.getInstance?.(pinInfo);
      const label = pinned?.displayName || pinInfo.slice(0, 8);
      lines.push(`📌 This channel is pinned to: **${label}**`);
    }

    lines.push('');
    lines.push('**Commands:**');
    lines.push('`/pick` — interactive numbered list, reply with `/pick <number>`');
    lines.push('`/select <project>` or `/select <project>/<name>` — pin this channel');
    lines.push('`/switch` — clear your DM instance (start fresh)');
    lines.push('`/clear` — remove channel pin');
    lines.push('');
    lines.push('**Routing:**');
    lines.push('`@<project> <message>` — send to most recent instance in project');
    lines.push('`@<project>/<name> <message>` — send to specific instance');
    lines.push('In DMs, your instance is remembered between messages.');

    await adapter.sendMessage(msg.chatId, lines.join('\n'), { replyTo: msg.messageId });
  }

  private async handleSelectCommand(
    msg: InboundChannelMessage,
    args: string,
    adapter: BaseChannelAdapter,
  ): Promise<void> {
    if (!args.trim()) {
      await adapter.sendMessage(
        msg.chatId,
        'Usage: `/select <project>` or `/select <project>/<instance>`\nUse `/list` to see available projects.',
        { replyTo: msg.messageId },
      );
      return;
    }

    const parts = args.trim().split('/');
    const projectName = parts[0].trim();
    const instanceName = parts.length > 1 ? parts.slice(1).join('/').trim() : undefined;

    const instance = this.resolveByName(projectName, instanceName);
    if (!instance) {
      await adapter.sendMessage(
        msg.chatId,
        `Could not find ${instanceName ? `instance "${instanceName}" in` : 'any instance for'} project "${projectName}". Use \`/list\` to see what's available.`,
        { replyTo: msg.messageId },
      );
      return;
    }

    this.channelPins.set(msg.chatId, instance.id);
    const label = instance.displayName || instance.id.slice(0, 8);
    const dir = path.basename(instance.workingDirectory || '');
    await adapter.sendMessage(
      msg.chatId,
      `📌 Pinned this channel to **${dir}/${label}**. All messages here will route to that instance.\nUse \`/clear\` to unpin.`,
      { replyTo: msg.messageId },
    );
  }

  private async handleClearCommand(
    msg: InboundChannelMessage,
    adapter: BaseChannelAdapter,
  ): Promise<void> {
    if (this.channelPins.has(msg.chatId)) {
      this.channelPins.delete(msg.chatId);
      await adapter.sendMessage(msg.chatId, 'Pin cleared. Messages will create new instances.', {
        replyTo: msg.messageId,
      });
    } else {
      await adapter.sendMessage(msg.chatId, 'No pin set on this channel.', {
        replyTo: msg.messageId,
      });
    }
  }

  private async handleHelpCommand(
    msg: InboundChannelMessage,
    adapter: BaseChannelAdapter,
  ): Promise<void> {
    const lines = [
      '**AI Orchestrator Bot**',
      '',
      '**Commands:**',
      '`/help` — show this message',
      '`/list` — show all projects and instances with status',
      '`/pick` — interactive numbered picker, then `/pick <number>` to select',
      '`/select <project>` — pin this channel to a project',
      '`/select <project>/<instance>` — pin to a specific instance',
      '`/clear` — remove channel pin',
      '`/switch` — clear your DM instance (start a new conversation)',
      '',
      '**Routing:**',
      '`@<project> <message>` — send to the most recent instance in a project',
      '`@<project>/<name> <message>` — send to a specific instance by name',
      '`@all <message>` — broadcast to every active instance',
      '',
      '**Automatic routing:**',
      'Thread replies continue the same instance.',
      'In DMs, your instance is remembered until you `/switch`.',
      'Pinned channels route all messages to the pinned instance.',
    ];
    await adapter.sendMessage(msg.chatId, lines.join('\n'), { replyTo: msg.messageId });
  }

  private async handlePickCommand(
    msg: InboundChannelMessage,
    args: string,
    adapter: BaseChannelAdapter,
  ): Promise<void> {
    const pickKey = `${msg.chatId}:${msg.senderId}`;

    // If they sent a number and we have a pending pick list, select it
    const num = parseInt(args, 10);
    if (!isNaN(num) && this.pendingPicks.has(pickKey)) {
      const candidates = this.pendingPicks.get(pickKey)!;
      if (num < 1 || num > candidates.length) {
        await adapter.sendMessage(
          msg.chatId,
          `Pick a number between 1 and ${candidates.length}.`,
          { replyTo: msg.messageId },
        );
        return;
      }
      const chosen = candidates[num - 1];
      this.pendingPicks.delete(pickKey);

      // If this is a DM, pin to this user's DM. Otherwise pin to channel.
      const isDm = this.isDm(msg);
      if (isDm) {
        this.dmPins.set(msg.senderId, chosen.id);
      } else {
        this.channelPins.set(msg.chatId, chosen.id);
      }

      const dir = path.basename(chosen.workingDirectory || '');
      const label = chosen.displayName || chosen.id.slice(0, 8);
      await adapter.sendMessage(
        msg.chatId,
        `Selected **${dir}/${label}**. ${isDm ? 'Your DM messages' : 'Messages in this channel'} will now go to this instance.`,
        { replyTo: msg.messageId },
      );
      return;
    }

    // Show the pick list
    const im = this.getInstanceManager();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const instances: any[] = im.getAllInstances?.() ?? [];
    const active = instances
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .filter((i: any) => i.status === 'idle' || i.status === 'busy' || i.status === 'waiting')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .sort((a: any, b: any) => (b.lastActivity || 0) - (a.lastActivity || 0))
      .slice(0, 10);

    if (active.length === 0) {
      await adapter.sendMessage(msg.chatId, 'No active instances.', { replyTo: msg.messageId });
      return;
    }

    this.pendingPicks.set(pickKey, active);

    const lines = ['**Pick an instance** (reply with `/pick <number>`):'];
    for (let i = 0; i < active.length; i++) {
      const inst = active[i];
      const dir = path.basename(inst.workingDirectory || '');
      const name = inst.displayName || inst.id.slice(0, 8);
      const status = inst.status || 'unknown';
      const icon = status === 'idle' ? '🟢' : status === 'busy' ? '🟡' : '⚪';
      const age = this.formatAge(inst.lastActivity);
      lines.push(`**${i + 1}.** ${icon} ${dir}/**${name}**  —  ${status}  (${age})`);
    }
    await adapter.sendMessage(msg.chatId, lines.join('\n'), { replyTo: msg.messageId });
  }

  private async handleSwitchCommand(
    msg: InboundChannelMessage,
    adapter: BaseChannelAdapter,
  ): Promise<void> {
    // Clear DM pin so next message creates a fresh instance
    if (this.dmPins.has(msg.senderId)) {
      this.dmPins.delete(msg.senderId);
      await adapter.sendMessage(
        msg.chatId,
        'Cleared your DM instance. Your next message will start a new conversation.\nUse `/pick` to select an existing instance.',
        { replyTo: msg.messageId },
      );
    } else {
      await adapter.sendMessage(
        msg.chatId,
        'No DM instance pinned. Use `/pick` to select one.',
        { replyTo: msg.messageId },
      );
    }
  }

  /**
   * Check if a message is from a DM (no guild/server context).
   * Discord DMs have chatId matching the user's DM channel.
   * We treat any chatId that starts with the senderId as a DM.
   * For robustness, we check if the chatId contains no guild separator.
   */
  private isDm(msg: InboundChannelMessage): boolean {
    // Discord DM channel IDs are distinct from guild channel IDs,
    // but we don't have guild info here. Use a heuristic:
    // DMs typically have threadId === undefined and a 1:1 chat pattern.
    // The discord adapter sets chatId to the channel ID regardless.
    // For safety, treat messages with no threadId in non-pinned channels as potential DMs.
    // The actual DM detection is done by the adapter (it allows messages without @mention in DMs).
    // We'll store DM pins by senderId which works regardless.
    return !msg.threadId && !this.channelPins.has(msg.chatId);
  }

  // ============ Main handler ============

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
    const intent = this.parseIntent(msg.content, msg.threadId, msg.chatId);

    // 4. Handle commands (no persistence needed for these)
    if (intent.type === 'command') {
      switch (intent.command) {
        case 'help':
          await this.handleHelpCommand(msg, adapter);
          return;
        case 'list':
          await this.handleListCommand(msg, adapter);
          return;
        case 'select':
          await this.handleSelectCommand(msg, intent.commandArgs || '', adapter);
          return;
        case 'clear':
          await this.handleClearCommand(msg, adapter);
          return;
        case 'pick':
          await this.handlePickCommand(msg, intent.commandArgs || '', adapter);
          return;
        case 'switch':
          await this.handleSwitchCommand(msg, adapter);
          return;
        default:
          await adapter.sendMessage(
            msg.chatId,
            `Unknown command: \`/${intent.command}\`. Try \`/help\` to see available commands.`,
            { replyTo: msg.messageId },
          );
          return;
      }
    }

    // 5. Save inbound message to persistence
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

    // 6. Acknowledge receipt
    try {
      await adapter.addReaction(msg.chatId, msg.messageId, '👀');
    } catch {
      // Ignore reaction failures
    }

    // 7. Route based on intent
    try {
      let instanceId: string;

      switch (intent.type) {
        case 'thread':
          instanceId = intent.instanceId!;
          await this.routeToInstance(msg, instanceId, intent.cleanContent, adapter);
          break;

        case 'named':
          instanceId = intent.instanceId!;
          await this.routeToInstance(msg, instanceId, intent.cleanContent, adapter);
          break;

        case 'broadcast':
          await this.routeBroadcast(msg, intent.cleanContent, adapter);
          return; // broadcast handles its own completion

        case 'pinned':
          instanceId = intent.instanceId!;
          await this.routeToInstance(msg, instanceId, intent.cleanContent, adapter);
          break;

        case 'default':
        default: {
          // Check DM pin before creating a new instance
          const dmPinId = this.dmPins.get(msg.senderId);
          if (dmPinId) {
            const im = this.getInstanceManager();
            const pinned = im.getInstance?.(dmPinId);
            if (pinned) {
              instanceId = dmPinId;
              await this.routeToInstance(msg, instanceId, intent.cleanContent, adapter);
              break;
            }
            // Stale pin — instance gone
            this.dmPins.delete(msg.senderId);
          }
          instanceId = await this.routeDefault(msg, intent.cleanContent, adapter);
          break;
        }
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

  // ============ Intent parsing ============

  parseIntent(content: string, threadId?: string, chatId?: string): ParsedIntent {
    const trimmed = content.trim();

    // Bare "?" or "help" → treat as /help
    if (trimmed === '?' || trimmed.toLowerCase() === 'help') {
      return { type: 'command', command: 'help', commandArgs: '', cleanContent: '' };
    }

    // Commands: /help, /list, /select <args>, /pick, /switch, /clear
    const cmdMatch = trimmed.match(/^\/(\w+)(?:\s+([\s\S]*))?$/);
    if (cmdMatch) {
      return {
        type: 'command',
        command: cmdMatch[1].toLowerCase(),
        commandArgs: cmdMatch[2]?.trim() || '',
        cleanContent: '',
      };
    }

    // Named routing: @project/instance message  or  @project message
    const namedMatch = trimmed.match(/^@([\w.-]+)(?:\/([\w. -]+))?\s+([\s\S]+)$/);
    if (namedMatch) {
      const projectName = namedMatch[1];
      const instanceName = namedMatch[2] || undefined;

      // Special case: @all
      if (projectName.toLowerCase() === 'all') {
        return { type: 'broadcast', cleanContent: namedMatch[3].trim() };
      }

      const instance = this.resolveByName(projectName, instanceName);
      if (instance) {
        return { type: 'named', instanceId: instance.id, cleanContent: namedMatch[3].trim() };
      }
      // Fall through to other resolution if name not found
    }

    // Thread continuity
    if (threadId) {
      const instanceId = this.persistence.resolveInstanceByThread(threadId);
      if (instanceId) {
        return { type: 'thread', instanceId, cleanContent: content };
      }
    }

    // Channel pin
    if (chatId) {
      const pinnedId = this.channelPins.get(chatId);
      if (pinnedId) {
        // Verify the pinned instance still exists
        const im = this.getInstanceManager();
        const inst = im.getInstance?.(pinnedId);
        if (inst) {
          return { type: 'pinned', instanceId: pinnedId, cleanContent: content };
        }
        // Instance gone — clear stale pin
        this.channelPins.delete(chatId);
      }
    }

    // Default: create new instance
    return { type: 'default', cleanContent: content };
  }

  // ============ Routing ============

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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const instances: any[] = im.getAllInstances?.() ?? [];
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

  // ============ Output streaming ============

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

  // ============ Utilities ============

  private formatAge(timestamp: number): string {
    if (!timestamp) return 'unknown';
    const delta = Date.now() - timestamp;
    if (delta < 60_000) return 'just now';
    if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
    if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`;
    return `${Math.floor(delta / 86_400_000)}d ago`;
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
