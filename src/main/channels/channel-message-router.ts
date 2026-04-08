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

import * as fs from 'fs';
import * as path from 'path';
import { getLogger } from '../logging/logger';
import type { ChannelManager, ChannelEvent } from './channel-manager';
import type { ChannelPersistence } from './channel-persistence';
import { RateLimiter } from './rate-limiter';
import type { BaseChannelAdapter } from './channel-adapter';
import { getRecentDirectoriesManager } from '../core/config/recent-directories-manager';
import type { InboundChannelMessage } from '../../shared/types/channels';
import { detectBrowserIntent } from './browser-intent';
import { getRemoteNodeConfig } from '../remote-node/remote-node-config';
import { getWorkerNodeRegistry } from '../remote-node';

const logger = getLogger('ChannelMessageRouter');

const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_WINDOW_MS = 60_000;
const DEBOUNCE_MS = 2000;

interface ParsedIntent {
  type:
    | 'command'
    | 'thread'
    | 'explicit'
    | 'named'
    | 'broadcast'
    | 'pinned-instance'
    | 'pinned-project'
    | 'default';
  instanceId?: string;
  projectName?: string;
  instanceName?: string;
  workingDirectory?: string;
  cleanContent: string;
  command?: string;
  commandArgs?: string;
}

interface ProjectDescriptor {
  key: string;
  label: string;
  workingDirectory: string | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  activeInstances: any[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  hibernatedInstances: any[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  historyEntries: any[];
  lastActivity: number;
}

type ChannelPin =
  | { kind: 'instance'; instanceId: string }
  | { kind: 'project'; projectKey: string; label: string; workingDirectory: string | null };

type ResolvedNamedTarget =
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  | { kind: 'instance'; instance: any }
  | { kind: 'project'; project: ProjectDescriptor };

/** Directories that must never be sent out via channel file sharing */
const FORBIDDEN_PATHS = ['.env', 'credentials', 'tokens', 'secrets', '.ssh', 'access.json'];
const NO_PROJECT_KEY = '__no_project__';
const NO_PROJECT_LABEL = '(no project)';

export class ChannelMessageRouter {
  private rateLimiter = new RateLimiter(RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS);
  private unsubscribe: (() => void) | null = null;
  private outputBuffers = new Map<string, { content: string; timer: ReturnType<typeof setTimeout> }>();
  /** Maps Discord channelId → pinned instance or project target */
  private channelPins = new Map<string, ChannelPin>();
  /** Maps DM senderId → instanceId (persistent per-user DM instance) */
  private dmPins = new Map<string, string>();
  /** Maps channelId/senderId → pending pick list for interactive selection */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private pendingPicks = new Map<string, any[]>();
  /** Maps channelId/senderId → ordered project list from last /list for numeric selection */
  private pendingProjectPicks = new Map<string, ProjectDescriptor[]>();
  // We need InstanceManager but import it lazily to avoid circular deps
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _instanceManagerOverride: any = null;

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
    if (this._instanceManagerOverride) {
      return this._instanceManagerOverride;
    }
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getInstanceManager } = require('../instance/instance-manager');
    return getInstanceManager();
  }

  /** Inject instance manager for testing */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  _setInstanceManagerForTesting(im: any): void {
    this._instanceManagerOverride = im;
  }

  // ============ Instance helpers ============

  /**
   * Get all instances grouped by project (derived from workingDirectory basename).
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private getProjectMap(): Map<string, any[]> {
    const im = this.getInstanceManager();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const instances: any[] = im.getAllInstances?.() ?? im.getInstances?.() ?? [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const map = new Map<string, any[]>();

    for (const inst of instances) {
      const dir = (inst.workingDirectory || '').trim();
      const key = this.getProjectKey(dir);
      if (!map.has(key)) {
        map.set(key, []);
      }
      map.get(key)!.push(inst);
    }
    return map;
  }

  /**
   * Normalize a working directory into a stable project key.
   */
  private getProjectKey(workingDirectory: string | null | undefined): string {
    const normalized = (workingDirectory ?? '').trim();
    return normalized ? normalized.toLowerCase() : NO_PROJECT_KEY;
  }

  private getProjectLabel(workingDirectory: string | null | undefined, fallbackLabel?: string): string {
    const normalized = (workingDirectory ?? '').trim();
    if (fallbackLabel?.trim()) {
      return fallbackLabel.trim();
    }
    if (!normalized) {
      return NO_PROJECT_LABEL;
    }
    return path.basename(normalized) || normalized;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private getRouteableInstances(project: ProjectDescriptor): any[] {
    const active = project.activeInstances.filter(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (instance: any) =>
        instance.status === 'idle' ||
        instance.status === 'busy' ||
        instance.status === 'waiting_for_input'
    );

    const hibernated = project.hibernatedInstances.map(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (entry: any) => ({
        id: entry.instanceId,
        displayName: entry.displayName,
        workingDirectory: entry.workingDirectory || project.workingDirectory || '',
        status: 'hibernated',
        lastActivity: entry.hibernatedAt,
      })
    );

    return [...active, ...hibernated].sort(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (a: any, b: any) => (b.lastActivity || 0) - (a.lastActivity || 0)
    );
  }

  private async getProjectDescriptors(): Promise<Map<string, ProjectDescriptor>> {
    const descriptors = new Map<string, ProjectDescriptor>();

    const ensureDescriptor = (
      workingDirectory: string | null | undefined,
      fallbackLabel?: string,
    ): ProjectDescriptor => {
      const normalized = (workingDirectory ?? '').trim() || null;
      const key = this.getProjectKey(normalized);
      const existing = descriptors.get(key);
      if (existing) {
        if (!existing.workingDirectory && normalized) {
          existing.workingDirectory = normalized;
        }
        if (existing.label === NO_PROJECT_LABEL && fallbackLabel?.trim()) {
          existing.label = fallbackLabel.trim();
        }
        return existing;
      }

      const descriptor: ProjectDescriptor = {
        key,
        label: this.getProjectLabel(normalized, fallbackLabel),
        workingDirectory: normalized,
        activeInstances: [],
        hibernatedInstances: [],
        historyEntries: [],
        lastActivity: 0,
      };
      descriptors.set(key, descriptor);
      return descriptor;
    };

    try {
      const recentDirectories = await getRecentDirectoriesManager().getDirectories({
        sortBy: 'lastAccessed',
      });
      for (const entry of recentDirectories) {
        const descriptor = ensureDescriptor(entry.path, entry.displayName);
        descriptor.lastActivity = Math.max(descriptor.lastActivity, entry.lastAccessed || 0);
      }
    } catch {
      // Ignore recent-directory failures; live/history state still builds a project list.
    }

    for (const instances of this.getProjectMap().values()) {
      for (const instance of instances) {
        const descriptor = ensureDescriptor(instance.workingDirectory);
        descriptor.activeInstances.push(instance);
        descriptor.lastActivity = Math.max(descriptor.lastActivity, instance.lastActivity || 0);
      }
    }

    for (const instances of this.getHibernatedByProject().values()) {
      for (const instance of instances) {
        const descriptor = ensureDescriptor(instance.workingDirectory);
        descriptor.hibernatedInstances.push(instance);
        descriptor.lastActivity = Math.max(descriptor.lastActivity, instance.hibernatedAt || 0);
      }
    }

    for (const { dir, entries } of this.getHistoryByProject().values()) {
      const descriptor = ensureDescriptor(dir);
      descriptor.historyEntries.push(...entries);
      for (const entry of entries) {
        descriptor.lastActivity = Math.max(
          descriptor.lastActivity,
          entry.endedAt || entry.createdAt || 0,
        );
      }
    }

    return descriptors;
  }

  private async resolveProject(projectName: string): Promise<ProjectDescriptor | null> {
    const normalizedQuery = projectName.trim();
    if (!normalizedQuery) {
      return null;
    }

    const descriptors = await this.getProjectDescriptors();
    const queryLower = normalizedQuery.toLowerCase();

    const byKey = descriptors.get(this.getProjectKey(normalizedQuery));
    if (byKey) {
      return byKey;
    }

    const exactLabelMatch = [...descriptors.values()].find(
      descriptor => descriptor.label.toLowerCase() === queryLower,
    );
    if (exactLabelMatch) {
      return exactLabelMatch;
    }

    const prefixMatch = [...descriptors.values()].find(descriptor => {
      const workingDirectory = descriptor.workingDirectory?.toLowerCase() || '';
      return descriptor.label.toLowerCase().startsWith(queryLower) || workingDirectory.startsWith(queryLower);
    });
    if (prefixMatch) {
      return prefixMatch;
    }

    if (fs.existsSync(normalizedQuery)) {
      const resolvedPath = path.resolve(normalizedQuery);
      if (fs.statSync(resolvedPath).isDirectory()) {
        return {
          key: this.getProjectKey(resolvedPath),
          label: this.getProjectLabel(resolvedPath),
          workingDirectory: resolvedPath,
          activeInstances: [],
          hibernatedInstances: [],
          historyEntries: [],
          lastActivity: Date.now(),
        };
      }
    }

    return null;
  }

  /**
   * Resolve a project by number (from last /list) or name.
   * If the input is a number like "3", look up from the stored pendingProjectPicks.
   * Otherwise fall through to normal resolveProject.
   */
  private async resolveProjectByNumberOrName(
    input: string,
    pickKey: string,
  ): Promise<ProjectDescriptor | null> {
    const num = parseInt(input, 10);
    if (!isNaN(num) && String(num) === input.trim() && this.pendingProjectPicks.has(pickKey)) {
      const projects = this.pendingProjectPicks.get(pickKey)!;
      if (num >= 1 && num <= projects.length) {
        return projects[num - 1];
      }
    }
    return this.resolveProject(input);
  }

  private async resolveNamedTarget(
    projectName: string,
    instanceName?: string,
    strictInstanceName = false,
  ): Promise<ResolvedNamedTarget | null> {
    const project = await this.resolveProject(projectName);
    if (!project) {
      return null;
    }

    const routeableInstances = this.getRouteableInstances(project);

    if (instanceName) {
      const needle = instanceName.toLowerCase();
      const matchedInstance = routeableInstances.find(instance => {
        const displayName = (instance.displayName || '').toLowerCase();
        return displayName.includes(needle) || String(instance.id || '').toLowerCase() === needle;
      });
      if (matchedInstance) {
        return { kind: 'instance', instance: matchedInstance };
      }
      return strictInstanceName ? null : project.workingDirectory ? { kind: 'project', project } : null;
    }

    if (routeableInstances.length > 0) {
      return { kind: 'instance', instance: routeableInstances[0] };
    }

    return project.workingDirectory ? { kind: 'project', project } : null;
  }

  // ============ Command handlers ============

  /**
   * Get hibernated instances grouped by project.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private getHibernatedByProject(): Map<string, any[]> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { getHibernationManager } = require('../process/hibernation-manager');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const hibernated: any[] = getHibernationManager().getHibernatedInstances?.() ?? [];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const map = new Map<string, any[]>();
      for (const h of hibernated) {
        const dir = (h.workingDirectory || '').trim();
        const key = this.getProjectKey(dir);
        if (!map.has(key)) map.set(key, []);
        map.get(key)!.push(h);
      }
      return map;
    } catch {
      return new Map();
    }
  }

  /**
   * Get conversation history entries grouped by project.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private getHistoryByProject(): Map<string, { dir: string; entries: any[] }> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { getHistoryManager } = require('../history/history-manager');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const entries: any[] = getHistoryManager().getEntries?.() ?? [];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const map = new Map<string, { dir: string; entries: any[] }>();
      for (const e of entries) {
        const dir = (e.workingDirectory || '').trim();
        const key = this.getProjectKey(dir);
        if (!map.has(key)) map.set(key, { dir, entries: [] });
        map.get(key)!.entries.push(e);
      }
      return map;
    } catch {
      return new Map();
    }
  }

  private async handleListCommand(
    msg: InboundChannelMessage,
    args: string,
    adapter: BaseChannelAdapter,
  ): Promise<void> {
    const projectDescriptors = await this.getProjectDescriptors();
    if (projectDescriptors.size === 0) {
      await adapter.sendMessage(msg.chatId, 'No projects or sessions found.', { replyTo: msg.messageId });
      return;
    }

    const lines: string[] = [];
    const requestedProject = args.trim();

    if (requestedProject) {
      const pickKey = `${msg.chatId}:${msg.senderId}`;
      const project = await this.resolveProjectByNumberOrName(requestedProject, pickKey);
      if (!project) {
        await adapter.sendMessage(
          msg.chatId,
          `Could not find project "${requestedProject}". Use \`/list\` to see available projects.`,
          { replyTo: msg.messageId },
        );
        return;
      }

      const routeableInstances = this.getRouteableInstances(project);
      const historyEntries = [...project.historyEntries].sort(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (a: any, b: any) => (b.endedAt || b.createdAt || 0) - (a.endedAt || a.createdAt || 0)
      );
      const totalSessions = routeableInstances.length + historyEntries.length;

      lines.push(`**${project.label}**`);
      if (project.workingDirectory) {
        lines.push(`Path: \`${project.workingDirectory}\``);
      }
      lines.push(`Sessions: ${totalSessions} total`);
      lines.push('');

      if (routeableInstances.length === 0 && historyEntries.length === 0) {
        lines.push('No sessions yet for this project.');
      }

      for (const instance of routeableInstances) {
        const name = instance.displayName || instance.id?.slice(0, 8) || 'unknown';
        const status = instance.status || 'unknown';
        const age = this.formatAge(instance.lastActivity);
        lines.push(`* ${name} — ${status}, ${age}`);
      }

      const shownHistory = historyEntries.slice(0, 5);
      for (const entry of shownHistory) {
        const preview = entry.firstUserMessage || entry.displayName || entry.id?.slice(0, 8) || 'Session';
        const truncated = preview.length > 70 ? `${preview.slice(0, 67)}...` : preview;
        const age = this.formatAge(entry.endedAt || entry.createdAt);
        lines.push(`- ${truncated} — archived, ${age}`);
      }

      if (historyEntries.length > shownHistory.length) {
        lines.push(`… +${historyEntries.length - shownHistory.length} more archived sessions`);
      }

      lines.push('');
      lines.push(
        `Use \`/select ${project.label}\` to pin this project or \`/new ${project.label} -- <prompt>\` to start a new session.`,
      );
      await adapter.sendMessage(msg.chatId, lines.join('\n'), { replyTo: msg.messageId });
      return;
    }

    const projects = [...projectDescriptors.values()].sort(
      (a, b) => b.lastActivity - a.lastActivity || a.label.localeCompare(b.label),
    );

    // Store numbered project list for numeric selection
    const pickKey = `${msg.chatId}:${msg.senderId}`;
    this.pendingProjectPicks.set(pickKey, projects);

    lines.push('**Projects**');
    for (let i = 0; i < projects.length; i++) {
      const project = projects[i];
      const routeableCount = this.getRouteableInstances(project).length;
      const totalSessions = routeableCount + project.historyEntries.length;
      const activeSuffix = routeableCount > 0 ? ` (${routeableCount} active)` : '';
      lines.push(`**${i + 1}.** **${project.label}** : ${totalSessions}${activeSuffix}`);
      if (project.workingDirectory) {
        lines.push(`  ${project.workingDirectory}`);
      }
    }

    const pin = this.channelPins.get(msg.chatId);
    if (pin?.kind === 'instance') {
      const im = this.getInstanceManager();
      const pinned = im.getInstance?.(pin.instanceId);
      const label = pinned?.displayName || pin.instanceId.slice(0, 8);
      lines.push('');
      lines.push(`Pinned to session: **${label}**`);
    } else if (pin?.kind === 'project') {
      lines.push('');
      lines.push(`Pinned to project: **${pin.label}**`);
    }

    lines.push('');
    lines.push(
      'Use `/list <number>` or `/list <project>` to drill into sessions, `/select <number>` to pin a project, or `/new <number> -- <prompt>` to start a session.',
    );

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
    const pickKey = `${msg.chatId}:${msg.senderId}`;

    const target = await this.resolveNamedTarget(projectName, instanceName, true);
    if (!instanceName) {
      const project = await this.resolveProjectByNumberOrName(projectName, pickKey);
      if (project) {
        this.channelPins.set(msg.chatId, {
          kind: 'project',
          projectKey: project.key,
          label: project.label,
          workingDirectory: project.workingDirectory,
        });
        await adapter.sendMessage(
          msg.chatId,
          `Pinned this channel to project **${project.label}**. New messages will use the latest session there or start a new one.\nUse \`/clear\` to unpin.`,
          { replyTo: msg.messageId },
        );
        return;
      }
      await adapter.sendMessage(
        msg.chatId,
        `Could not find project "${projectName}". Use \`/list\` to see available projects.`,
        { replyTo: msg.messageId },
      );
      return;
    }

    if (!target || target.kind !== 'instance') {
      await adapter.sendMessage(
        msg.chatId,
        `Could not find instance "${instanceName}" in project "${projectName}". Use \`/list ${projectName}\` to see available sessions.`,
        { replyTo: msg.messageId },
      );
      return;
    }

    const instance = target.instance;
    this.channelPins.set(msg.chatId, { kind: 'instance', instanceId: instance.id });
    const label = instance.displayName || instance.id.slice(0, 8);
    const dir = this.getProjectLabel(instance.workingDirectory);
    await adapter.sendMessage(
      msg.chatId,
      `Pinned this channel to session **${dir}/${label}**. All messages here will route to that session.\nUse \`/clear\` to unpin.`,
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
      '`/list` — show numbered projects',
      '`/list <number|project>` — show sessions in a project',
      '`/pick` — interactive numbered picker, then `/pick <number>` to select',
      '`/select <number|project>` — pin this channel to a project',
      '`/select <project>/<instance>` — pin to a specific instance',
      '`/new <number|project> -- <prompt>` — start a new session in a project',
      '`/clear` — remove channel pin',
      '`/switch` — clear your DM instance (start a new conversation)',
      '',
      '**Routing:**',
      '`@<project> <message>` — send to the latest session in a project, or start a new one there',
      '`@<project>/<name> <message>` — send to a specific instance by name',
      '`@all <message>` — broadcast to every active instance',
      '',
      '**Automatic routing:**',
      'Thread replies continue the same instance.',
      'In DMs, your instance is remembered until you `/switch`.',
      'Pinned channels route all messages to the pinned project or instance.',
    ];
    await adapter.sendMessage(msg.chatId, lines.join('\n'), { replyTo: msg.messageId });
  }

  private async handleNewCommand(
    msg: InboundChannelMessage,
    args: string,
    adapter: BaseChannelAdapter,
  ): Promise<void> {
    const trimmedArgs = args.trim();
    const [rawProjectArg, ...rawPromptParts] = trimmedArgs.split(/\s+--\s+/);
    const prompt = rawPromptParts.join(' -- ').trim();

    const pickKey = `${msg.chatId}:${msg.senderId}`;
    let project: ProjectDescriptor | null = null;
    if (rawProjectArg?.trim()) {
      project = await this.resolveProjectByNumberOrName(rawProjectArg.trim(), pickKey);
      if (!project) {
        await adapter.sendMessage(
          msg.chatId,
          `Could not find project "${rawProjectArg.trim()}". Use \`/list\` to see available projects or pass an existing directory path.`,
          { replyTo: msg.messageId },
        );
        return;
      }
    } else {
      const pin = this.channelPins.get(msg.chatId);
      if (pin?.kind === 'project') {
        project = await this.resolveProject(pin.workingDirectory || pin.label);
      } else if (pin?.kind === 'instance') {
        const im = this.getInstanceManager();
        const instance = im.getInstance?.(pin.instanceId);
        if (instance) {
          project = await this.resolveProject(instance.workingDirectory || '');
        }
      }
    }

    const workingDirectory = project?.workingDirectory || process.cwd();
    const instanceId = await this.routeDefault(msg, prompt, adapter, workingDirectory);

    if (msg.isDM) {
      this.dmPins.set(msg.senderId, instanceId);
    } else {
      this.channelPins.set(msg.chatId, { kind: 'instance', instanceId });
    }

    const im = this.getInstanceManager();
    const instance = im.getInstance?.(instanceId);
    const label = instance?.displayName || instanceId.slice(0, 8);
    const projectLabel = project?.label || this.getProjectLabel(workingDirectory);
    const confirmation = prompt
      ? `Started a new session in **${projectLabel}** and sent your prompt to **${label}**.`
      : `Started a new session in **${projectLabel}**. ${msg.isDM ? 'Your DM' : 'This channel'} is now pinned to **${label}**.`;

    await adapter.sendMessage(msg.chatId, confirmation, { replyTo: msg.messageId });
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
        this.channelPins.set(msg.chatId, { kind: 'instance', instanceId: chosen.id });
      }

      const dir = this.getProjectLabel(chosen.workingDirectory);
      const label = chosen.displayName || chosen.id.slice(0, 8);
      await adapter.sendMessage(
        msg.chatId,
        `Selected **${dir}/${label}**. ${isDm ? 'Your DM messages' : 'Messages in this channel'} will now go to this instance.`,
        { replyTo: msg.messageId },
      );
      return;
    }

    // Show the pick list — active + hibernated instances
    const im = this.getInstanceManager();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const instances: any[] = im.getAllInstances?.() ?? im.getInstances?.() ?? [];
    const active = instances
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .filter((i: any) => i.status === 'idle' || i.status === 'busy' || i.status === 'waiting_for_input')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .sort((a: any, b: any) => (b.lastActivity || 0) - (a.lastActivity || 0));

    // Also include hibernated instances
    const activeIds = new Set(active.map((i: { id: string }) => i.id));
    const hibernatedList = this.getHibernatedByProject();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const hibernated: any[] = [];
    for (const group of hibernatedList.values()) {
      for (const h of group) {
        if (!activeIds.has(h.instanceId)) {
          // Normalize to match active instance shape for the pick list
          hibernated.push({
            id: h.instanceId,
            displayName: h.displayName,
            workingDirectory: h.workingDirectory || '',
            status: 'hibernated',
            lastActivity: h.hibernatedAt,
          });
        }
      }
    }

    const combined = [...active, ...hibernated]
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .sort((a: any, b: any) => (b.lastActivity || 0) - (a.lastActivity || 0))
      .slice(0, 15);

    if (combined.length === 0) {
      await adapter.sendMessage(msg.chatId, 'No instances available. Send a message to create one.', { replyTo: msg.messageId });
      return;
    }

    this.pendingPicks.set(pickKey, combined);

    const lines = ['**Pick an instance** (reply with `/pick <number>`):'];
    for (let i = 0; i < combined.length; i++) {
      const inst = combined[i];
      const dir = path.basename(inst.workingDirectory || '');
      const name = inst.displayName || inst.id.slice(0, 8);
      const status = inst.status || 'unknown';
      const icon = status === 'idle' ? '🟢' : status === 'busy' ? '🟡' : status === 'hibernated' ? '💤' : '⚪';
      const age = this.formatAge(inst.lastActivity);
      lines.push(`**${i + 1}.** ${icon} ${dir}/**${name}**  —  ${status}  (${age})`);
    }
    if (hibernated.length > 0) {
      lines.push('');
      lines.push('💤 Hibernated instances will be woken when you send a message.');
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
    return msg.isDM;
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
          await this.handleListCommand(msg, intent.commandArgs || '', adapter);
          return;
        case 'select':
          await this.handleSelectCommand(msg, intent.commandArgs || '', adapter);
          return;
        case 'new':
          await this.handleNewCommand(msg, intent.commandArgs || '', adapter);
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
        case 'nodes':
          await this.handleNodesCommand(msg, intent.commandArgs || '', adapter);
          return;
        case 'run-on':
          await this.handleRunOnCommand(msg, intent.commandArgs || '', adapter);
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

        case 'explicit':
          instanceId = intent.instanceId!;
          await this.routeToInstance(msg, instanceId, intent.cleanContent, adapter);
          break;

        case 'named': {
          const target = await this.resolveNamedTarget(intent.projectName!, intent.instanceName);
          if (!target) {
            throw new Error(`Could not find project "${intent.projectName}"`);
          }

          if (target.kind === 'instance') {
            instanceId = target.instance.id;
            await this.routeToInstance(msg, instanceId, intent.cleanContent, adapter);
          } else {
            instanceId = await this.routeToProject(msg, intent.cleanContent, adapter, target.project);
          }
          break;
        }

        case 'broadcast':
          await this.routeBroadcast(msg, intent.cleanContent, adapter);
          return; // broadcast handles its own completion

        case 'pinned-instance':
          instanceId = intent.instanceId!;
          await this.routeToInstance(msg, instanceId, intent.cleanContent, adapter);
          break;

        case 'pinned-project':
          instanceId = await this.routeToProject(
            msg,
            intent.cleanContent,
            adapter,
            {
              key: this.getProjectKey(intent.workingDirectory),
              label: intent.projectName || this.getProjectLabel(intent.workingDirectory),
              workingDirectory: intent.workingDirectory || null,
              activeInstances: [],
              hibernatedInstances: [],
              historyEntries: [],
              lastActivity: 0,
            },
          );
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

    const explicitMatch = trimmed.match(/^@instance-([\w-]+)\s+([\s\S]+)$/);
    if (explicitMatch) {
      return {
        type: 'explicit',
        instanceId: explicitMatch[1],
        cleanContent: explicitMatch[2].trim(),
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

      return {
        type: 'named',
        projectName,
        instanceName,
        cleanContent: namedMatch[3].trim(),
      };
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
      const pin = this.channelPins.get(chatId);
      if (pin?.kind === 'instance') {
        // Verify the pinned instance still exists
        const im = this.getInstanceManager();
        const inst = im.getInstance?.(pin.instanceId);
        if (inst) {
          return { type: 'pinned-instance', instanceId: pin.instanceId, cleanContent: content };
        }
        // Instance gone — clear stale pin
        this.channelPins.delete(chatId);
      } else if (pin?.kind === 'project') {
        return {
          type: 'pinned-project',
          projectName: pin.label,
          workingDirectory: pin.workingDirectory || undefined,
          cleanContent: content,
        };
      }
    }

    // Default: create new instance
    return { type: 'default', cleanContent: content };
  }

  // ============ Routing ============

  private async handleNodesCommand(
    msg: InboundChannelMessage,
    args: string,
    adapter: BaseChannelAdapter,
  ): Promise<void> {
    const registry = getWorkerNodeRegistry();
    const nodes = registry.getAllNodes();

    if (args.trim()) {
      // /nodes <name> - show details for a specific node
      const node = nodes.find((n) => n.name === args.trim() || n.id === args.trim());
      if (!node) {
        await adapter.sendMessage(msg.chatId, `Node "${args.trim()}" not found.`, { replyTo: msg.messageId });
        return;
      }
      const detail = [
        `**${node.name}** (${node.id})`,
        `Status: ${node.status}`,
        `Platform: ${node.capabilities.platform} / ${node.capabilities.arch}`,
        `CPU: ${node.capabilities.cpuCores} cores`,
        `Memory: ${node.capabilities.availableMemoryMB}/${node.capabilities.totalMemoryMB} MB`,
        node.capabilities.gpuName ? `GPU: ${node.capabilities.gpuName} (${node.capabilities.gpuMemoryMB} MB)` : null,
        `CLIs: ${node.capabilities.supportedClis.join(', ') || 'none'}`,
        `Browser: ${node.capabilities.hasBrowserRuntime ? 'yes' : 'no'}`,
        `Active instances: ${node.activeInstances}`,
        node.latencyMs !== undefined ? `Latency: ${node.latencyMs}ms` : null,
      ].filter(Boolean).join('\n');
      await adapter.sendMessage(msg.chatId, detail, { replyTo: msg.messageId });
      return;
    }

    // /nodes - list all
    if (nodes.length === 0) {
      await adapter.sendMessage(msg.chatId, 'No worker nodes connected.', { replyTo: msg.messageId });
      return;
    }

    const lines = nodes.map(
      (n) => `- **${n.name}** - ${n.status} | ${n.activeInstances} instances | ${n.capabilities.platform}`,
    );
    await adapter.sendMessage(msg.chatId, `**Worker Nodes (${nodes.length}):**\n${lines.join('\n')}`, { replyTo: msg.messageId });
  }

  private async handleRunOnCommand(
    msg: InboundChannelMessage,
    args: string,
    adapter: BaseChannelAdapter,
  ): Promise<void> {
    // /run-on <node> <message>
    const spaceIdx = args.indexOf(' ');
    if (spaceIdx === -1 || !args.trim()) {
      await adapter.sendMessage(msg.chatId, 'Usage: /run-on <node-name> <message>', { replyTo: msg.messageId });
      return;
    }

    const nodeName = args.slice(0, spaceIdx).trim();
    const content = args.slice(spaceIdx + 1).trim();

    const registry = getWorkerNodeRegistry();
    const node = registry.getAllNodes().find((n) => n.name === nodeName || n.id === nodeName);
    if (!node) {
      await adapter.sendMessage(msg.chatId, `Node "${nodeName}" not found.`, { replyTo: msg.messageId });
      return;
    }

    const im = this.getInstanceManager();
    const allowedDirs = node.capabilities?.workingDirectories ?? [];
    const workingDirectory = allowedDirs[0] || process.cwd();
    const instance = await im.createInstance({
      displayName: `${msg.platform}:${msg.senderName}`,
      workingDirectory,
      initialPrompt: content,
      yoloMode: true,
      forceNodeId: node.id,
    });

    this.streamResults(msg, instance.id, adapter);
    await adapter.sendMessage(msg.chatId, `Running on **${node.name}**...`, { replyTo: msg.messageId });
  }

  private async routeDefault(
    msg: InboundChannelMessage,
    content: string,
    adapter: BaseChannelAdapter,
    workingDirectory = process.cwd(),
  ): Promise<string> {
    const im = this.getInstanceManager();
    try {
      getRecentDirectoriesManager().addDirectory(workingDirectory);
    } catch {
      // Ignore missing or inaccessible directories; instance creation will surface real failures.
    }
    // Detect browser intent for auto-offloading
    const remoteConfig = getRemoteNodeConfig();
    const needsBrowser = remoteConfig.autoOffloadBrowser && detectBrowserIntent(content);

    const instance = await im.createInstance({
      displayName: `${msg.platform}:${msg.senderName}`,
      workingDirectory,
      initialPrompt: content || undefined,
      yoloMode: true,
      ...(needsBrowser ? { nodePlacement: { requiresBrowser: true } } : {}),
    });

    // Stream results back
    if (content) {
      this.streamResults(msg, instance.id, adapter);
    }

    return instance.id;
  }

  private async routeToProject(
    msg: InboundChannelMessage,
    content: string,
    adapter: BaseChannelAdapter,
    project: ProjectDescriptor,
  ): Promise<string> {
    const refreshedProject =
      (project.workingDirectory
        ? await this.resolveProject(project.workingDirectory)
        : await this.resolveProject(project.label)) || project;
    const latestInstance = this.getRouteableInstances(refreshedProject)[0];

    if (latestInstance) {
      await this.routeToInstance(msg, latestInstance.id, content, adapter);
      return latestInstance.id;
    }

    if (!refreshedProject.workingDirectory) {
      throw new Error(
        `Project "${refreshedProject.label}" is missing a working directory, so a new session cannot be started.`,
      );
    }

    return this.routeDefault(msg, content, adapter, refreshedProject.workingDirectory);
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
    const instances: any[] = im.getAllInstances?.() ?? im.getInstances?.() ?? [];
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

        void adapter.sendMessage(msg.chatId, buffer.content, {
          replyTo: msg.messageId,
        }).then((sentMessage) => {
          this.persistence.saveMessage({
            id: `out-${msg.platform}-${sentMessage.messageId}`,
            platform: msg.platform,
            chat_id: msg.chatId,
            message_id: sentMessage.messageId,
            thread_id: msg.threadId ?? null,
            sender_id: 'bot',
            sender_name: 'Orchestrator',
            content: buffer.content,
            direction: 'outbound',
            instance_id: instanceId,
            reply_to_message_id: msg.messageId,
            timestamp: sentMessage.timestamp,
          });

          this.channelManager.emitResponseSent({
            channelMessageId: msg.messageId,
            platform: msg.platform,
            chatId: msg.chatId,
            messageId: sentMessage.messageId,
            instanceId,
            content: buffer.content,
            status: 'complete',
            replyToMessageId: msg.messageId,
            timestamp: sentMessage.timestamp,
          });
        }).catch((err: unknown) => {
          logger.error('Failed to send output to channel', err instanceof Error ? err : new Error(String(err)));
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
