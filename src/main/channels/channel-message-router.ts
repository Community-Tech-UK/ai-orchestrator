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
import { crossPlatformBasename } from '../../shared/utils/cross-platform-path';
import { getLogger } from '../logging/logger';
import type { ChannelManager, ChannelEvent } from './channel-manager';
import type { ChannelPersistence } from './channel-persistence';
import { RateLimiter } from './rate-limiter';
import type { BaseChannelAdapter, ChannelAutocompleteChoice, ChannelAutocompleteRequest } from './channel-adapter';
import { getRecentDirectoriesManager } from '../core/config/recent-directories-manager';
import { getSettingsManager } from '../core/config/settings-manager';
import type {
  ChannelMessageAction,
  ChannelPlatform,
  InboundChannelMessage,
} from '../../shared/types/channels';
import type { FileAttachment } from '../../shared/types/instance.types';
import { detectBrowserIntent } from './browser-intent';
import {
  getRemoteNodeConfig,
  updateRemoteNodeConfig,
} from '../remote-node/remote-node-config';
import { getWorkerNodeRegistry } from '../remote-node';
import type { ProviderRuntimeEventEnvelope } from '@contracts/types/provider-runtime-events';
import { toOutputMessageFromProviderEnvelope } from '../providers/provider-output-event';
import { ChannelAccessPolicyStore } from './channel-access-policy-store';
import { ChannelRouteStore, type SavedChannelRoutePin } from './channel-route-store';
import { getRLMDatabase } from '../persistence/rlm-database';

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

type ChannelPin = SavedChannelRoutePin;

type ResolvedNamedTarget =
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  | { kind: 'instance'; instance: any }
  | { kind: 'project'; project: ProjectDescriptor };

interface KnownChannelInstance {
  id: string;
  displayName?: string;
  workingDirectory?: string;
  status?: string;
  lastActivity?: number;
}

interface OutputStreamTracker {
  content: string;
  suppressedContent: string;
  flushCount: number;
  suppressionNoticeSent: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  pendingFinalization: boolean;
  outputHandler: (envelope: ProviderRuntimeEventEnvelope) => void;
  stateHandler: (payload: { instanceId: string; status?: string }) => void;
  /**
   * The latest inbound message that should be used as the reply target for
   * outbound stream chunks. Mutated when subsequent user prompts arrive while
   * the instance is still streaming, so live output threads under the most
   * recent user message instead of duplicating across stale trackers.
   */
  currentMsg: InboundChannelMessage;
}

/** Directories that must never be sent out via channel file sharing */
const FORBIDDEN_PATHS = ['.env', 'credentials', 'tokens', 'secrets', '.ssh', 'access.json'];
const MAX_CHANNEL_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const MAX_LIVE_STREAM_FLUSHES = 3;
const NO_PROJECT_KEY = '__no_project__';
const NO_PROJECT_LABEL = '(no project)';
const ACTIVE_SESSION_STATUSES = new Set([
  'initializing',
  'ready',
  'idle',
  'busy',
  'processing',
  'thinking_deeply',
  'waiting_for_input',
  'waiting_for_permission',
  'interrupting',
  'cancelling',
  'interrupt-escalating',
  'cancelled',
  'respawning',
  'waking',
  'degraded',
]);

export class ChannelMessageRouter {
  private rateLimiter = new RateLimiter(RATE_LIMIT_MAX, RATE_LIMIT_WINDOW_MS);
  private unsubscribe: (() => void) | null = null;
  private outputStreams = new Map<string, OutputStreamTracker>();
  /** Maps Discord channelId → pinned instance or project target */
  private channelPins = new Map<string, ChannelPin>();
  /** Maps DM senderId → instanceId (persistent per-user DM instance) */
  private dmPins = new Map<string, string>();
  /** Maps channelId/senderId → pending pick list for interactive selection */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private pendingPicks = new Map<string, any[]>();
  /** Maps channelId/senderId → ordered project list from last /list for numeric selection */
  private pendingProjectPicks = new Map<string, ProjectDescriptor[]>();
  /** Maps channelId/senderId → ordered revivable session list from last /revive or /list <project> */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private pendingRevivePicks = new Map<string, any[]>();
  // We need InstanceManager but import it lazily to avoid circular deps
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _instanceManagerOverride: any = null;
  private resolvedRouteStore: ChannelRouteStore | null | undefined;

  constructor(
    private channelManager: ChannelManager,
    private persistence: ChannelPersistence,
    private routeStore?: ChannelRouteStore | null,
  ) {}

  start(): void {
    this.unsubscribe = this.channelManager.onEvent((event: ChannelEvent) => {
      if (event.type === 'message') {
        this.handleInboundMessage(event.data).catch(err => {
          logger.error('Error handling inbound message', err instanceof Error ? err : new Error(String(err)));
        });
      } else if (event.type === 'autocomplete') {
        this.handleAutocompleteRequest(event.data).catch(err => {
          logger.error('Error handling channel autocomplete', err instanceof Error ? err : new Error(String(err)));
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
    const im = this.getInstanceManager();
    for (const [bufferKey, tracker] of this.outputStreams) {
      if (tracker.timer) {
        clearTimeout(tracker.timer);
      }
      im.removeListener('provider:normalized-event', tracker.outputHandler);
      im.removeListener('instance:state-update', tracker.stateHandler);
      this.outputStreams.delete(bufferKey);
    }
    this.rateLimiter.clear();
    logger.info('Channel message router stopped');
  }

  /**
   * Return the injected InstanceManager, or throw if setInstanceManager()
   * hasn't been called yet. Main process startup wires this up.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private getInstanceManager(): any {
    if (!this._instanceManagerOverride) {
      throw new Error(
        'ChannelMessageRouter: setInstanceManager() must be called before use. ' +
        'See src/main/index.ts for the canonical wiring.'
      );
    }
    return this._instanceManagerOverride;
  }

  /** Inject the InstanceManager. Called from main process startup (and tests). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  setInstanceManager(im: any): void {
    this._instanceManagerOverride = im;
  }

  /** @deprecated Use setInstanceManager. Kept for backward compatibility with existing specs. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  _setInstanceManagerForTesting(im: any): void {
    this._instanceManagerOverride = im;
  }

  private getRouteStore(): ChannelRouteStore | null {
    if (this.routeStore !== undefined) {
      return this.routeStore;
    }
    if (this.resolvedRouteStore !== undefined) {
      return this.resolvedRouteStore;
    }
    try {
      this.resolvedRouteStore = new ChannelRouteStore(getRLMDatabase().getRawDb());
    } catch (err) {
      logger.warn('Channel route store unavailable', { error: String(err) });
      this.resolvedRouteStore = null;
    }
    return this.resolvedRouteStore;
  }

  private getAccessPolicyStore(): ChannelAccessPolicyStore | null {
    try {
      return new ChannelAccessPolicyStore(getRLMDatabase().getRawDb());
    } catch (err) {
      logger.warn('Channel access policy store unavailable', { error: String(err) });
      return null;
    }
  }

  private setChannelPin(platform: ChannelPlatform, chatId: string, pin: ChannelPin): void {
    this.channelPins.set(chatId, pin);
    try {
      this.getRouteStore()?.savePin(platform, 'chat', chatId, pin);
    } catch (err) {
      logger.warn('Failed to persist channel pin', { platform, chatId, error: String(err) });
    }
  }

  private getChannelPin(platform: ChannelPlatform, chatId: string): ChannelPin | undefined {
    const cached = this.channelPins.get(chatId);
    if (cached) {
      return cached;
    }
    try {
      const persisted = this.getRouteStore()?.getPin(platform, 'chat', chatId) ?? null;
      if (persisted) {
        this.channelPins.set(chatId, persisted);
        return persisted;
      }
    } catch (err) {
      logger.warn('Failed to load channel pin', { platform, chatId, error: String(err) });
    }
    return undefined;
  }

  private clearChannelPin(platform: ChannelPlatform, chatId: string): void {
    this.channelPins.delete(chatId);
    try {
      this.getRouteStore()?.removePin(platform, 'chat', chatId);
    } catch (err) {
      logger.warn('Failed to remove channel pin', { platform, chatId, error: String(err) });
    }
  }

  private setDmPin(platform: ChannelPlatform, senderId: string, instanceId: string): void {
    this.dmPins.set(senderId, instanceId);
    try {
      this.getRouteStore()?.savePin(platform, 'dm', senderId, { kind: 'instance', instanceId });
    } catch (err) {
      logger.warn('Failed to persist DM pin', { platform, senderId, error: String(err) });
    }
  }

  private getDmPin(platform: ChannelPlatform, senderId: string): string | undefined {
    const cached = this.dmPins.get(senderId);
    if (cached) {
      return cached;
    }
    try {
      const persisted = this.getRouteStore()?.getPin(platform, 'dm', senderId) ?? null;
      if (persisted?.kind === 'instance') {
        this.dmPins.set(senderId, persisted.instanceId);
        return persisted.instanceId;
      }
    } catch (err) {
      logger.warn('Failed to load DM pin', { platform, senderId, error: String(err) });
    }
    return undefined;
  }

  private clearDmPin(platform: ChannelPlatform, senderId: string): void {
    this.dmPins.delete(senderId);
    try {
      this.getRouteStore()?.removePin(platform, 'dm', senderId);
    } catch (err) {
      logger.warn('Failed to remove DM pin', { platform, senderId, error: String(err) });
    }
  }

  private clearAllPins(platform: ChannelPlatform): void {
    this.channelPins.clear();
    this.dmPins.clear();
    this.pendingPicks.clear();
    this.pendingProjectPicks.clear();
    this.pendingRevivePicks.clear();
    try {
      this.getRouteStore()?.removePlatform(platform);
    } catch (err) {
      logger.warn('Failed to remove channel route pins', { platform, error: String(err) });
    }
  }

  private getPendingKey(msg: Pick<InboundChannelMessage, 'chatId' | 'senderId'>): string {
    return `${msg.chatId}:${msg.senderId}`;
  }

  private clearPendingSelections(pendingKey: string): void {
    this.pendingPicks.delete(pendingKey);
    this.pendingProjectPicks.delete(pendingKey);
    this.pendingRevivePicks.delete(pendingKey);
  }

  private setPendingPickSelection(pendingKey: string, instances: KnownChannelInstance[]): void {
    this.clearPendingSelections(pendingKey);
    this.pendingPicks.set(pendingKey, instances);
  }

  private setPendingProjectSelection(pendingKey: string, projects: ProjectDescriptor[]): void {
    this.clearPendingSelections(pendingKey);
    this.pendingProjectPicks.set(pendingKey, projects);
  }

  private setPendingReviveSelection(pendingKey: string, instances: KnownChannelInstance[]): void {
    this.clearPendingSelections(pendingKey);
    this.pendingRevivePicks.set(pendingKey, instances);
  }

  private normalizePendingNumericSelection(msg: InboundChannelMessage): InboundChannelMessage {
    const trimmed = msg.content.trim();
    if (!/^\d+$/.test(trimmed)) {
      return msg;
    }

    const pendingKey = this.getPendingKey(msg);
    if (this.pendingPicks.has(pendingKey)) {
      return { ...msg, content: `/pick ${trimmed}` };
    }
    if (this.pendingRevivePicks.has(pendingKey)) {
      return { ...msg, content: `/revive ${trimmed}` };
    }

    return msg;
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
  private isActiveSession(instance: any): boolean {
    return ACTIVE_SESSION_STATUSES.has(String(instance.status || ''));
  }

  private sortByLastActivity<T extends { lastActivity?: number }>(instances: T[]): T[] {
    return [...instances].sort((a, b) => (b.lastActivity || 0) - (a.lastActivity || 0));
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private getActiveInstances(project: ProjectDescriptor): any[] {
    return this.sortByLastActivity(
      project.activeInstances.filter(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (instance: any) => this.isActiveSession(instance),
      ),
    );
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private getRevivableInstances(project: ProjectDescriptor): any[] {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const byId = new Map<string, any>();
    for (const entry of project.hibernatedInstances) {
      const id = entry.instanceId || entry.id;
      if (!id || byId.has(id)) {
        continue;
      }
      byId.set(id, {
        id,
        displayName: entry.displayName,
        workingDirectory: entry.workingDirectory || project.workingDirectory || '',
        status: 'hibernated',
        lastActivity: entry.hibernatedAt || entry.lastActivity,
      });
    }
    return this.sortByLastActivity([...byId.values()]);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private getRouteableInstances(project: ProjectDescriptor): any[] {
    return [
      ...this.getActiveInstances(project),
      ...this.getRevivableInstances(project),
    ];
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
        if (instance.status === 'hibernated') {
          descriptor.hibernatedInstances.push({
            instanceId: instance.id,
            displayName: instance.displayName,
            workingDirectory: instance.workingDirectory,
            hibernatedAt: instance.lastActivity || 0,
          });
        } else {
          descriptor.activeInstances.push(instance);
        }
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

  private async handleAutocompleteRequest(request: ChannelAutocompleteRequest): Promise<void> {
    const focusedName = request.focusedName.toLowerCase();
    const focusedValue = request.focusedValue.toLowerCase();
    let choices: ChannelAutocompleteChoice[] = [];

    if (focusedName === 'project') {
      const descriptors = [...(await this.getProjectDescriptors()).values()]
        .sort((a, b) => b.lastActivity - a.lastActivity || a.label.localeCompare(b.label));
      choices = descriptors
        .filter(project => {
          const label = project.label.toLowerCase();
          const workingDirectory = project.workingDirectory?.toLowerCase() || '';
          return !focusedValue || label.includes(focusedValue) || workingDirectory.includes(focusedValue);
        })
        .slice(0, 25)
        .map(project => ({
          name: project.workingDirectory ? `${project.label} - ${project.workingDirectory}` : project.label,
          value: project.label,
        }));
    } else if (focusedName === 'session') {
      const projectName = request.options['project'];
      const project = projectName ? await this.resolveProject(projectName) : null;
      const instances = project
        ? this.getRouteableInstances(project)
        : this.getAllKnownInstances();
      choices = instances
        .filter(instance => {
          const label = String(instance.displayName || instance.id || '').toLowerCase();
          return !focusedValue || label.includes(focusedValue) || String(instance.id || '').toLowerCase().includes(focusedValue);
        })
        .slice(0, 25)
        .map(instance => ({
          name: `${instance.displayName || String(instance.id).slice(0, 8)} - ${instance.status || 'unknown'}`,
          value: instance.displayName || instance.id,
        }));
    }

    await request.respond(choices);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private getAllKnownInstances(): any[] {
    const im = this.getInstanceManager();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const liveInstances: any[] = im.getAllInstances?.() ?? im.getInstances?.() ?? [];
    const liveIds = new Set(liveInstances.map(instance => instance.id));
    const hibernated = [...this.getHibernatedByProject().values()]
      .flat()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .filter((entry: any) => !liveIds.has(entry.instanceId))
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .map((entry: any) => ({
        id: entry.instanceId,
        displayName: entry.displayName,
        workingDirectory: entry.workingDirectory,
        status: 'hibernated',
        lastActivity: entry.hibernatedAt,
      }));
    return this.sortByLastActivity([...liveInstances, ...hibernated]);
  }

  private makeAction(
    id: string,
    label: string,
    style: ChannelMessageAction['style'] = 'secondary',
  ): ChannelMessageAction {
    return { id, label, style };
  }

  private encodeActionArg(value: string): string {
    return encodeURIComponent(value).replace(/%20/g, '+');
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private buildReviveActions(instances: any[]): ChannelMessageAction[] {
    return instances.slice(0, 4).map((instance, index) => {
      const label = instance.displayName || String(instance.id || '').slice(0, 8) || `Session ${index + 1}`;
      return this.makeAction(
        `orch:revive:${this.encodeActionArg(instance.id)}`,
        `Revive ${label}`.slice(0, 80),
        'success',
      );
    });
  }

  private buildSessionActions(instanceId: string): ChannelMessageAction[] {
    const encoded = this.encodeActionArg(instanceId);
    return [
      this.makeAction(`orch:stop:${encoded}`, 'Stop', 'danger'),
      this.makeAction(`orch:continue:${encoded}`, 'Continue', 'primary'),
      this.makeAction('orch:pick', 'Pick', 'secondary'),
    ];
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

      const activeInstances = this.getActiveInstances(project);
      const revivableInstances = this.getRevivableInstances(project);
      const historyEntries = [...project.historyEntries].sort(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (a: any, b: any) => (b.endedAt || b.createdAt || 0) - (a.endedAt || a.createdAt || 0)
      );

      lines.push(`**${project.label}**`);
      if (project.workingDirectory) {
        lines.push(`Path: \`${project.workingDirectory}\``);
      }
      const summaryParts = [
        `${activeInstances.length} active`,
        `${revivableInstances.length} revivable`,
      ];
      if (historyEntries.length > 0) {
        summaryParts.push(`${historyEntries.length} archived`);
      }
      lines.push(`Sessions: ${summaryParts.join(', ')}`);
      lines.push('');

      if (activeInstances.length === 0 && revivableInstances.length === 0 && historyEntries.length === 0) {
        lines.push('No sessions yet for this project.');
      }

      if (activeInstances.length > 0) {
        lines.push('Active sessions:');
      }
      for (const instance of activeInstances) {
        const name = instance.displayName || instance.id?.slice(0, 8) || 'unknown';
        const status = instance.status || 'unknown';
        const age = this.formatAge(instance.lastActivity);
        lines.push(`* ${name} — ${status}, ${age}`);
      }

      if (revivableInstances.length > 0) {
        if (activeInstances.length > 0) {
          lines.push('');
        }
        lines.push('Revivable sessions:');
      }
      for (const instance of revivableInstances) {
        const name = instance.displayName || instance.id?.slice(0, 8) || 'unknown';
        const age = this.formatAge(instance.lastActivity);
        lines.push(`* ${name} — hibernated, ${age}`);
      }

      if (historyEntries.length > 0) {
        lines.push('');
        lines.push(`Archived sessions: ${historyEntries.length} not shown in Discord.`);
      }

      lines.push('');
      lines.push(
        `Use \`/select ${project.label}\` to pin this project, \`/select ${project.label}/<session>\` to pin a session, or \`/new ${project.label} -- <prompt>\` to start a new session.`,
      );
      this.setPendingReviveSelection(this.getPendingKey(msg), revivableInstances);
      await adapter.sendMessage(msg.chatId, lines.join('\n'), {
        replyTo: msg.messageId,
        actions: this.buildReviveActions(revivableInstances),
      });
      return;
    }

    const projects = [...projectDescriptors.values()].sort(
      (a, b) => b.lastActivity - a.lastActivity || a.label.localeCompare(b.label),
    );

    // Store numbered project list for numeric selection
    const pickKey = this.getPendingKey(msg);
    this.setPendingProjectSelection(pickKey, projects);

    lines.push('**Projects**');
    for (let i = 0; i < projects.length; i++) {
      const project = projects[i];
      const activeCount = this.getActiveInstances(project).length;
      const revivableCount = this.getRevivableInstances(project).length;
      const countParts = [`${activeCount} active`];
      if (revivableCount > 0) {
        countParts.push(`${revivableCount} revivable`);
      }
      if (project.historyEntries.length > 0) {
        countParts.push(`${project.historyEntries.length} archived`);
      }
      lines.push(`**${i + 1}.** **${project.label}** : ${countParts.join(', ')}`);
      if (project.workingDirectory) {
        lines.push(`  ${project.workingDirectory}`);
      }
    }

    const pin = this.getChannelPin(msg.platform, msg.chatId);
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

    await adapter.sendMessage(msg.chatId, lines.join('\n'), {
      replyTo: msg.messageId,
      actions: [
        this.makeAction('orch:pick', 'Pick Active', 'primary'),
      ],
    });
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
    const pickKey = this.getPendingKey(msg);

    const target = await this.resolveNamedTarget(projectName, instanceName, true);
    if (!instanceName) {
      const project = await this.resolveProjectByNumberOrName(projectName, pickKey);
      if (project) {
        this.setChannelPin(msg.platform, msg.chatId, {
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
    this.setChannelPin(msg.platform, msg.chatId, { kind: 'instance', instanceId: instance.id });
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
    if (this.getChannelPin(msg.platform, msg.chatId)) {
      this.clearChannelPin(msg.platform, msg.chatId);
      await adapter.sendMessage(msg.chatId, 'Pin cleared. Messages will create new instances.', {
        replyTo: msg.messageId,
      });
    } else {
      await adapter.sendMessage(msg.chatId, 'No pin set on this channel.', {
        replyTo: msg.messageId,
      });
    }
  }

  private async handleWhereAmICommand(
    msg: InboundChannelMessage,
    adapter: BaseChannelAdapter,
  ): Promise<void> {
    const lines = ['**Current Discord target**'];
    const dmPinId = this.isDm(msg) ? this.getDmPin(msg.platform, msg.senderId) : undefined;
    const channelPin = this.getChannelPin(msg.platform, msg.chatId);
    const im = this.getInstanceManager();

    if (dmPinId) {
      const instance = im.getInstance?.(dmPinId);
      lines.push(`DM pin: ${this.formatInstanceLabel(instance, dmPinId)}`);
    } else if (this.isDm(msg)) {
      lines.push('DM pin: none');
    }

    if (channelPin?.kind === 'instance') {
      const instance = im.getInstance?.(channelPin.instanceId);
      lines.push(`Channel pin: ${this.formatInstanceLabel(instance, channelPin.instanceId)}`);
    } else if (channelPin?.kind === 'project') {
      const project = await this.resolveProject(channelPin.workingDirectory || channelPin.label);
      const active = project ? this.getActiveInstances(project).length : 0;
      const revivable = project ? this.getRevivableInstances(project).length : 0;
      lines.push(`Channel pin: project **${channelPin.label}** (${active} active, ${revivable} revivable)`);
      if (channelPin.workingDirectory) {
        lines.push(`Path: \`${channelPin.workingDirectory}\``);
      }
    } else if (!this.isDm(msg)) {
      lines.push('Channel pin: none');
    }

    lines.push('');
    lines.push('Use `/select <project>` to set the default target, `/pick` for active sessions, or `/revive <project>` for hibernated sessions.');
    await adapter.sendMessage(msg.chatId, lines.join('\n'), { replyTo: msg.messageId });
  }

  private async handleStatusCommand(
    msg: InboundChannelMessage,
    adapter: BaseChannelAdapter,
  ): Promise<void> {
    const policy = adapter.getAccessPolicy();
    const health = this.getAdapterHealth(adapter);
    const projects = [...(await this.getProjectDescriptors()).values()];
    const activeCount = projects.reduce((sum, project) => sum + this.getActiveInstances(project).length, 0);
    const revivableCount = projects.reduce((sum, project) => sum + this.getRevivableInstances(project).length, 0);

    const lines = [
      '**Discord bot status**',
      `Connection: ${adapter.status}`,
      health?.botUsername ? `Bot: ${health.botUsername}` : null,
      health?.lastMessageAt ? `Last message: ${this.formatAge(health.lastMessageAt)}` : null,
      health?.lastGatewayEventAt ? `Last gateway event: ${this.formatAge(health.lastGatewayEventAt)}` : null,
      `Reconnect attempts: ${health?.reconnectAttempts ?? 0}${health?.reconnectScheduled ? ' (scheduled)' : ''}`,
      health?.lastError ? `Last error: ${health.lastError}` : null,
      `Access mode: ${policy.mode}`,
      `Paired senders: ${policy.allowedSenders.length}`,
      `Projects: ${projects.length}`,
      `Sessions: ${activeCount} active, ${revivableCount} revivable`,
    ].filter(Boolean) as string[];

    await adapter.sendMessage(msg.chatId, lines.join('\n'), { replyTo: msg.messageId });
  }

  private async handleReviveCommand(
    msg: InboundChannelMessage,
    args: string,
    adapter: BaseChannelAdapter,
  ): Promise<void> {
    const pickKey = this.getPendingKey(msg);
    const trimmed = args.trim();
    const numericPick = parseInt(trimmed, 10);
    if (!Number.isNaN(numericPick) && String(numericPick) === trimmed && this.pendingRevivePicks.has(pickKey)) {
      const candidates = this.pendingRevivePicks.get(pickKey)!;
      if (numericPick < 1 || numericPick > candidates.length) {
        await adapter.sendMessage(msg.chatId, `Pick a number between 1 and ${candidates.length}.`, { replyTo: msg.messageId });
        return;
      }
      this.pendingRevivePicks.delete(pickKey);
      await this.reviveInstance(msg, candidates[numericPick - 1], adapter);
      return;
    }

    const candidates = await this.resolveReviveCandidates(msg, trimmed);
    if (candidates.length === 0) {
      await adapter.sendMessage(
        msg.chatId,
        'No revivable session found. Use `/list` to choose a project, then `/list <project>` to see revivable sessions.',
        { replyTo: msg.messageId },
      );
      return;
    }

    if (candidates.length > 1) {
      this.setPendingReviveSelection(pickKey, candidates);
      const lines = ['**Revivable sessions** (reply with `/revive <number>`):'];
      for (let i = 0; i < candidates.length; i++) {
        const instance = candidates[i];
        lines.push(`**${i + 1}.** ${this.formatInstanceLabel(instance, instance.id)} (${this.formatAge(instance.lastActivity)})`);
      }
      await adapter.sendMessage(msg.chatId, lines.join('\n'), {
        replyTo: msg.messageId,
        actions: this.buildReviveActions(candidates),
      });
      return;
    }

    await this.reviveInstance(msg, candidates[0], adapter);
  }

  private async handleStopCommand(
    msg: InboundChannelMessage,
    args: string,
    adapter: BaseChannelAdapter,
  ): Promise<void> {
    const instanceId = await this.resolveInstanceIdForCommand(msg, args.trim());
    if (!instanceId) {
      await adapter.sendMessage(msg.chatId, 'No session selected. Use `/pick` or `/select <project>/<session>` first.', { replyTo: msg.messageId });
      return;
    }
    const im = this.getInstanceManager();
    const accepted = im.interruptInstance?.(instanceId);
    await adapter.sendMessage(
      msg.chatId,
      accepted === false ? `Could not stop **${instanceId.slice(0, 8)}**.` : `Stop requested for **${instanceId.slice(0, 8)}**.`,
      { replyTo: msg.messageId },
    );
  }

  private async handleContinueCommand(
    msg: InboundChannelMessage,
    args: string,
    adapter: BaseChannelAdapter,
  ): Promise<void> {
    const instanceId = await this.resolveInstanceIdForCommand(msg, args.trim());
    if (!instanceId) {
      await adapter.sendMessage(msg.chatId, 'No session selected. Use `/pick` or `/select <project>/<session>` first.', { replyTo: msg.messageId });
      return;
    }
    await this.routeToInstance(msg, instanceId, 'continue', adapter, []);
    await adapter.sendMessage(msg.chatId, `Sent \`continue\` to **${instanceId.slice(0, 8)}**.`, {
      replyTo: msg.messageId,
      actions: this.buildSessionActions(instanceId),
    });
  }

  private async handlePairCommand(
    msg: InboundChannelMessage,
    adapter: BaseChannelAdapter,
  ): Promise<void> {
    const paired = adapter.getAccessPolicy().allowedSenders.includes(msg.senderId);
    await adapter.sendMessage(
      msg.chatId,
      paired
        ? `You are paired as \`${msg.senderId}\`.`
        : 'You are not paired. Send any message to request a pairing code.',
      { replyTo: msg.messageId },
    );
  }

  private async handleWhoAmICommand(
    msg: InboundChannelMessage,
    adapter: BaseChannelAdapter,
  ): Promise<void> {
    const policy = adapter.getAccessPolicy();
    const paired = policy.allowedSenders.includes(msg.senderId);
    const lines = [
      `Discord id: \`${msg.senderId}\``,
      `Name: ${msg.senderName}`,
      `Pairing: ${paired ? 'paired' : 'not paired'}`,
      `Discord admin: ${msg.senderIsAdmin ? 'yes' : 'no'}`,
      `Access mode: ${policy.mode}`,
    ];
    await adapter.sendMessage(msg.chatId, lines.join('\n'), { replyTo: msg.messageId });
  }

  private async handleAllowCommand(
    msg: InboundChannelMessage,
    args: string,
    adapter: BaseChannelAdapter,
  ): Promise<void> {
    if (!(await this.requireDiscordAdmin(msg, adapter, 'allow users'))) {
      return;
    }
    const senderId = this.parseUserId(args);
    if (!senderId) {
      await adapter.sendMessage(msg.chatId, 'Usage: `/allow <discord-user-id>`', { replyTo: msg.messageId });
      return;
    }
    this.setAllowedSender(msg.platform, adapter, senderId, true);
    await adapter.sendMessage(msg.chatId, `Allowed Discord user \`${senderId}\`.`, { replyTo: msg.messageId });
  }

  private async handleDenyCommand(
    msg: InboundChannelMessage,
    args: string,
    adapter: BaseChannelAdapter,
  ): Promise<void> {
    if (!(await this.requireDiscordAdmin(msg, adapter, 'remove users'))) {
      return;
    }
    const senderId = this.parseUserId(args);
    if (!senderId) {
      await adapter.sendMessage(msg.chatId, 'Usage: `/deny <discord-user-id>`', { replyTo: msg.messageId });
      return;
    }
    this.setAllowedSender(msg.platform, adapter, senderId, false);
    await adapter.sendMessage(msg.chatId, `Removed Discord user \`${senderId}\` from the allowlist.`, { replyTo: msg.messageId });
  }

  private async handleUnpairCommand(
    msg: InboundChannelMessage,
    args: string,
    adapter: BaseChannelAdapter,
  ): Promise<void> {
    const requestedId = this.parseUserId(args) || msg.senderId;
    if (requestedId !== msg.senderId && !(await this.requireDiscordAdmin(msg, adapter, 'unpair another user'))) {
      return;
    }
    this.setAllowedSender(msg.platform, adapter, requestedId, false);
    if (requestedId === msg.senderId) {
      this.clearDmPin(msg.platform, msg.senderId);
    }
    await adapter.sendMessage(msg.chatId, `Unpaired Discord user \`${requestedId}\`.`, { replyTo: msg.messageId });
  }

  private async handleResetDiscordCommand(
    msg: InboundChannelMessage,
    adapter: BaseChannelAdapter,
  ): Promise<void> {
    if (!(await this.requireDiscordAdmin(msg, adapter, 'reset Discord state'))) {
      return;
    }
    adapter.setAccessPolicy({
      ...adapter.getAccessPolicy(),
      mode: 'pairing',
      allowedSenders: [],
      pendingPairings: [],
    });
    try {
      this.getAccessPolicyStore()?.remove(msg.platform);
    } catch (err) {
      logger.warn('Failed to remove Discord access policy', { error: String(err) });
    }
    this.clearAllPins(msg.platform);
    await adapter.sendMessage(
      msg.chatId,
      'Discord routing pins and pairing allowlist were reset. The bot connection remains active.',
      { replyTo: msg.messageId },
    );
  }

  private getAdapterHealth(adapter: BaseChannelAdapter): {
    botUsername?: string;
    lastMessageAt?: number;
    lastGatewayEventAt?: number;
    reconnectAttempts?: number;
    reconnectScheduled?: boolean;
    lastError?: string;
  } | null {
    const maybeHealth = adapter as BaseChannelAdapter & {
      getHealthSnapshot?: () => {
        botUsername?: string;
        lastMessageAt?: number;
        lastGatewayEventAt?: number;
        reconnectAttempts?: number;
        reconnectScheduled?: boolean;
        lastError?: string;
      };
    };
    return maybeHealth.getHealthSnapshot?.() ?? null;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private formatInstanceLabel(instance: any, fallbackId: string): string {
    const name = instance?.displayName || fallbackId.slice(0, 8);
    const status = instance?.status || 'unknown';
    const dir = this.getProjectLabel(instance?.workingDirectory);
    return `**${dir}/${name}** (${status})`;
  }

  private parseUserId(args: string): string | null {
    const trimmed = args.trim();
    if (!trimmed) {
      return null;
    }
    const mention = trimmed.match(/^<@!?(\d+)>$/);
    if (mention) {
      return mention[1];
    }
    const id = trimmed.match(/\d{5,}/);
    return id?.[0] ?? null;
  }

  private async requireDiscordAdmin(
    msg: InboundChannelMessage,
    adapter: BaseChannelAdapter,
    action: string,
  ): Promise<boolean> {
    if (msg.senderIsAdmin) {
      return true;
    }
    await adapter.sendMessage(
      msg.chatId,
      `Discord administrator permission is required to ${action}.`,
      { replyTo: msg.messageId },
    );
    return false;
  }

  private setAllowedSender(
    platform: ChannelPlatform,
    adapter: BaseChannelAdapter,
    senderId: string,
    allow: boolean,
  ): void {
    const policy = adapter.getAccessPolicy();
    const allowed = new Set(policy.allowedSenders);
    if (allow) {
      allowed.add(senderId);
    } else {
      allowed.delete(senderId);
    }
    const nextPolicy = {
      ...policy,
      mode: policy.mode === 'disabled' && allow ? 'allowlist' as const : policy.mode,
      allowedSenders: [...allowed],
      pendingPairings: policy.pendingPairings.filter(pairing => pairing.senderId !== senderId),
    };
    adapter.setAccessPolicy(nextPolicy);
    try {
      this.getAccessPolicyStore()?.save(platform, nextPolicy);
    } catch (err) {
      logger.warn('Failed to persist channel access policy', { platform, error: String(err) });
    }
  }

  private async resolveInstanceIdForCommand(
    msg: InboundChannelMessage,
    reference: string,
  ): Promise<string | null> {
    const trimmed = reference.trim();
    if (trimmed) {
      if (trimmed.includes('/')) {
        const [projectName, ...instanceNameParts] = trimmed.split('/');
        const target = await this.resolveNamedTarget(
          projectName.trim(),
          instanceNameParts.join('/').trim() || undefined,
          true,
        );
        return target?.kind === 'instance' ? target.instance.id : null;
      }

      const lower = trimmed.toLowerCase();
      const matched = this.getAllKnownInstances().find(instance => {
        const id = String(instance.id || '').toLowerCase();
        const label = String(instance.displayName || '').toLowerCase();
        return id === lower || id.startsWith(lower) || label.includes(lower);
      });
      if (matched) {
        return matched.id;
      }
    }

    const dmPinId = this.isDm(msg) ? this.getDmPin(msg.platform, msg.senderId) : undefined;
    if (dmPinId) {
      return dmPinId;
    }

    const channelPin = this.getChannelPin(msg.platform, msg.chatId);
    if (channelPin?.kind === 'instance') {
      return channelPin.instanceId;
    }
    if (channelPin?.kind === 'project') {
      const project = await this.resolveProject(channelPin.workingDirectory || channelPin.label);
      return project ? this.getRouteableInstances(project)[0]?.id ?? null : null;
    }

    return null;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async resolveReviveCandidates(msg: InboundChannelMessage, args: string): Promise<any[]> {
    const trimmed = args.trim();
    if (!trimmed) {
      const channelPin = this.getChannelPin(msg.platform, msg.chatId);
      if (channelPin?.kind === 'project') {
        const project = await this.resolveProject(channelPin.workingDirectory || channelPin.label);
        return project ? this.getRevivableInstances(project) : [];
      }
      return [];
    }

    if (trimmed.includes('/')) {
      const [projectName, ...sessionParts] = trimmed.split('/');
      const project = await this.resolveProject(projectName.trim());
      if (!project) {
        return [];
      }
      const needle = sessionParts.join('/').trim().toLowerCase();
      return this.getRevivableInstances(project).filter(instance => {
        const id = String(instance.id || '').toLowerCase();
        const label = String(instance.displayName || '').toLowerCase();
        return !needle || id === needle || id.startsWith(needle) || label.includes(needle);
      });
    }

    const lower = trimmed.toLowerCase();
    const directMatches = this.getAllKnownInstances().filter(instance => {
      if (instance.status !== 'hibernated') {
        return false;
      }
      const id = String(instance.id || '').toLowerCase();
      const label = String(instance.displayName || '').toLowerCase();
      return id === lower || id.startsWith(lower) || label.includes(lower);
    });
    if (directMatches.length > 0) {
      return directMatches;
    }

    const project = await this.resolveProject(trimmed);
    return project ? this.getRevivableInstances(project) : [];
  }

  private async reviveInstance(
    msg: InboundChannelMessage,
    instance: KnownChannelInstance,
    adapter: BaseChannelAdapter,
  ): Promise<void> {
    const im = this.getInstanceManager();
    const liveInstance = im.getInstance?.(instance.id);
    if (!liveInstance) {
      await adapter.sendMessage(
        msg.chatId,
        `Session **${instance.displayName || instance.id.slice(0, 8)}** is listed as hibernated, but it is not present in the live instance store and cannot be revived from Discord.`,
        { replyTo: msg.messageId },
      );
      return;
    }

    if (liveInstance.status === 'hibernated') {
      await im.wakeInstance(instance.id);
    }

    if (this.isDm(msg)) {
      this.setDmPin(msg.platform, msg.senderId, instance.id);
    } else {
      this.setChannelPin(msg.platform, msg.chatId, { kind: 'instance', instanceId: instance.id });
    }

    await adapter.sendMessage(
      msg.chatId,
      `Revived and selected ${this.formatInstanceLabel(liveInstance, instance.id)}.`,
      {
        replyTo: msg.messageId,
        actions: this.buildSessionActions(instance.id),
      },
    );
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
      '`/pick` — pick from active sessions, then `/pick <number>` to select',
      '`/revive <number|project|project/session>` — wake a hibernated session',
      '`/select <number|project>` — pin this channel to a project',
      '`/select <project>/<instance>` — pin to a specific instance',
      '`/new <number|project> -- <prompt>` — start a new session in a project',
      '`/whereami` — show the current Discord routing target',
      '`/status` — show bot connection and pairing health',
      '`/stop [session]` — interrupt a session',
      '`/continue [session]` — send continue to a session',
      '`/pair`, `/whoami`, `/unpair` — pairing utilities',
      '`/allow <user>`, `/deny <user>`, `/reset-discord` — admin setup tools',
      '`/clear` — remove channel pin',
      '`/switch` — clear your DM instance (start a new conversation)',
      '`/nodes` — list connected worker nodes',
      '`/nodes <name>` — show worker node details',
      '`/run-on <node> <message>` — force a task onto a worker node',
      '`/offload browser [on|off]` — toggle automatic browser-task offloading',
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
    const startsWithPromptSeparator = trimmedArgs.startsWith('--');
    const [rawProjectArgFromSplit, ...rawPromptParts] = startsWithPromptSeparator
      ? ['', trimmedArgs.slice(2)]
      : trimmedArgs.split(/\s+--\s+/);
    const rawProjectArg = rawProjectArgFromSplit;
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
      const pin = this.getChannelPin(msg.platform, msg.chatId);
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
      this.setDmPin(msg.platform, msg.senderId, instanceId);
    } else {
      this.setChannelPin(msg.platform, msg.chatId, { kind: 'instance', instanceId });
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
        this.setDmPin(msg.platform, msg.senderId, chosen.id);
      } else {
        this.setChannelPin(msg.platform, msg.chatId, { kind: 'instance', instanceId: chosen.id });
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

    // Show the pick list — active instances only. Project drill-down handles revivable sessions.
    const im = this.getInstanceManager();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const instances: any[] = im.getAllInstances?.() ?? im.getInstances?.() ?? [];
    const active = instances
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .filter((i: any) => this.isActiveSession(i))
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .sort((a: any, b: any) => (b.lastActivity || 0) - (a.lastActivity || 0))
      .slice(0, 15);

    if (active.length === 0) {
      await adapter.sendMessage(
        msg.chatId,
        'No active sessions. Use `/list` to choose a project, `/list <project>` to view revivable sessions, or send a message to create one.',
        { replyTo: msg.messageId },
      );
      return;
    }

    this.setPendingPickSelection(pickKey, active);

    const lines = ['**Pick an instance** (reply with `/pick <number>`):'];
    for (let i = 0; i < active.length; i++) {
      const inst = active[i];
      const dir = crossPlatformBasename(inst.workingDirectory || '');
      const name = inst.displayName || inst.id.slice(0, 8);
      const status = inst.status || 'unknown';
      const icon = status === 'idle' || status === 'ready' ? '🟢' : status === 'busy' ? '🟡' : '⚪';
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
    if (this.getDmPin(msg.platform, msg.senderId)) {
      this.clearDmPin(msg.platform, msg.senderId);
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
    const effectiveMsg = this.normalizePendingNumericSelection(msg);
    const intent = this.parseIntent(effectiveMsg.content, effectiveMsg.threadId, effectiveMsg.chatId, effectiveMsg.platform);

    // 4. Handle commands (no persistence needed for these)
    if (intent.type === 'command') {
      switch (intent.command) {
        case 'help':
          await this.handleHelpCommand(effectiveMsg, adapter);
          return;
        case 'list':
          await this.handleListCommand(effectiveMsg, intent.commandArgs || '', adapter);
          return;
        case 'select':
          await this.handleSelectCommand(effectiveMsg, intent.commandArgs || '', adapter);
          return;
        case 'whereami':
          await this.handleWhereAmICommand(effectiveMsg, adapter);
          return;
        case 'status':
          await this.handleStatusCommand(effectiveMsg, adapter);
          return;
        case 'revive':
          await this.handleReviveCommand(effectiveMsg, intent.commandArgs || '', adapter);
          return;
        case 'stop':
          await this.handleStopCommand(effectiveMsg, intent.commandArgs || '', adapter);
          return;
        case 'continue':
          await this.handleContinueCommand(effectiveMsg, intent.commandArgs || '', adapter);
          return;
        case 'pair':
          await this.handlePairCommand(effectiveMsg, adapter);
          return;
        case 'whoami':
          await this.handleWhoAmICommand(effectiveMsg, adapter);
          return;
        case 'allow':
          await this.handleAllowCommand(effectiveMsg, intent.commandArgs || '', adapter);
          return;
        case 'deny':
          await this.handleDenyCommand(effectiveMsg, intent.commandArgs || '', adapter);
          return;
        case 'unpair':
          await this.handleUnpairCommand(effectiveMsg, intent.commandArgs || '', adapter);
          return;
        case 'reset-discord':
          await this.handleResetDiscordCommand(effectiveMsg, adapter);
          return;
        case 'new':
          await this.handleNewCommand(effectiveMsg, intent.commandArgs || '', adapter);
          return;
        case 'clear':
          await this.handleClearCommand(effectiveMsg, adapter);
          return;
        case 'pick':
          await this.handlePickCommand(effectiveMsg, intent.commandArgs || '', adapter);
          return;
        case 'switch':
          await this.handleSwitchCommand(effectiveMsg, adapter);
          return;
        case 'nodes':
          await this.handleNodesCommand(effectiveMsg, intent.commandArgs || '', adapter);
          return;
        case 'run-on':
          await this.handleRunOnCommand(effectiveMsg, intent.commandArgs || '', adapter);
          return;
        case 'offload':
          await this.handleOffloadCommand(effectiveMsg, intent.commandArgs || '', adapter);
          return;
        default:
          await adapter.sendMessage(
            effectiveMsg.chatId,
            `Unknown command: \`/${intent.command}\`. Try \`/help\` to see available commands.`,
            { replyTo: effectiveMsg.messageId },
          );
          return;
      }
    }

    this.clearPendingSelections(this.getPendingKey(effectiveMsg));

    // 5. Save inbound message to persistence
    this.persistence.saveMessage({
      id: effectiveMsg.id,
      platform: effectiveMsg.platform,
      chat_id: effectiveMsg.chatId,
      message_id: effectiveMsg.messageId,
      thread_id: effectiveMsg.threadId ?? null,
      sender_id: effectiveMsg.senderId,
      sender_name: effectiveMsg.senderName,
      content: effectiveMsg.content,
      direction: 'inbound',
      instance_id: null,
      reply_to_message_id: effectiveMsg.replyTo ?? null,
      timestamp: effectiveMsg.timestamp,
    });

    // 6. Acknowledge receipt
    try {
      await adapter.addReaction(effectiveMsg.chatId, effectiveMsg.messageId, '👀');
    } catch {
      // Ignore reaction failures
    }

    const inputAttachments = await this.resolveInputAttachments(effectiveMsg, adapter);

    // 7. Route based on intent
    try {
      let instanceId: string;

      switch (intent.type) {
        case 'thread':
          instanceId = intent.instanceId!;
          await this.routeToInstance(effectiveMsg, instanceId, intent.cleanContent, adapter, inputAttachments);
          break;

        case 'explicit':
          instanceId = intent.instanceId!;
          await this.routeToInstance(effectiveMsg, instanceId, intent.cleanContent, adapter, inputAttachments);
          break;

        case 'named': {
          const target = await this.resolveNamedTarget(intent.projectName!, intent.instanceName);
          if (!target) {
            throw new Error(`Could not find project "${intent.projectName}"`);
          }

          if (target.kind === 'instance') {
            instanceId = target.instance.id;
            await this.routeToInstance(effectiveMsg, instanceId, intent.cleanContent, adapter, inputAttachments);
          } else {
            instanceId = await this.routeToProject(effectiveMsg, intent.cleanContent, adapter, target.project, inputAttachments);
          }
          break;
        }

        case 'broadcast':
          await this.routeBroadcast(effectiveMsg, intent.cleanContent, adapter, inputAttachments);
          return; // broadcast handles its own completion

        case 'pinned-instance':
          instanceId = intent.instanceId!;
          await this.routeToInstance(effectiveMsg, instanceId, intent.cleanContent, adapter, inputAttachments);
          break;

        case 'pinned-project':
          instanceId = await this.routeToProject(
            effectiveMsg,
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
            inputAttachments,
          );
          break;

        case 'default':
        default: {
          // Check DM pin before creating a new instance
          const dmPinId = this.getDmPin(effectiveMsg.platform, effectiveMsg.senderId);
          if (dmPinId) {
            const im = this.getInstanceManager();
            const pinned = im.getInstance?.(dmPinId);
            if (pinned) {
              instanceId = dmPinId;
              await this.routeToInstance(effectiveMsg, instanceId, intent.cleanContent, adapter, inputAttachments);
              break;
            }
            // Stale pin — instance gone
            this.clearDmPin(effectiveMsg.platform, effectiveMsg.senderId);
          }
          instanceId = await this.routeDefault(effectiveMsg, intent.cleanContent, adapter, process.cwd(), inputAttachments);
          break;
        }
      }

      // Update instance_id in persistence
      this.persistence.updateInstanceId(effectiveMsg.id, instanceId);

      // React with completion
      try {
        await adapter.addReaction(effectiveMsg.chatId, effectiveMsg.messageId, '✅');
      } catch {
        // Ignore
      }
    } catch (err) {
      logger.error('Error routing message', err instanceof Error ? err : new Error(String(err)));
      try {
        await adapter.addReaction(effectiveMsg.chatId, effectiveMsg.messageId, '❌');
        await adapter.sendMessage(effectiveMsg.chatId, `Error: ${err instanceof Error ? err.message : String(err)}`, {
          replyTo: effectiveMsg.messageId,
        });
      } catch {
        // Ignore send failures
      }
    }
  }

  // ============ Intent parsing ============

  parseIntent(
    content: string,
    threadId?: string,
    chatId?: string,
    platform: ChannelPlatform = 'discord',
  ): ParsedIntent {
    const trimmed = content.trim();

    // Bare "?" or "help" → treat as /help
    if (trimmed === '?' || trimmed.toLowerCase() === 'help') {
      return { type: 'command', command: 'help', commandArgs: '', cleanContent: '' };
    }

    // Commands: /help, /list, /select <args>, /pick, /switch, /clear
    const cmdMatch = trimmed.match(/^\/([\w-]+)(?:\s+([\s\S]*))?$/);
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
      const pin = this.getChannelPin(platform, chatId);
      if (pin?.kind === 'instance') {
        // Verify the pinned instance still exists
        const im = this.getInstanceManager();
        const inst = im.getInstance?.(pin.instanceId);
        if (inst) {
          return { type: 'pinned-instance', instanceId: pin.instanceId, cleanContent: content };
        }
        // Instance gone — clear stale pin
        this.clearChannelPin(platform, chatId);
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

  private async handleOffloadCommand(
    msg: InboundChannelMessage,
    args: string,
    adapter: BaseChannelAdapter,
  ): Promise<void> {
    const [target = '', mode = 'on'] = args.trim().toLowerCase().split(/\s+/);
    if (target !== 'browser') {
      await adapter.sendMessage(
        msg.chatId,
        'Usage: /offload browser [on|off]',
        { replyTo: msg.messageId },
      );
      return;
    }

    if (mode === 'status') {
      const enabled = getRemoteNodeConfig().autoOffloadBrowser;
      await adapter.sendMessage(
        msg.chatId,
        `Browser auto-offloading is currently ${enabled ? 'enabled' : 'disabled'}.`,
        { replyTo: msg.messageId },
      );
      return;
    }

    const enabled = !['off', 'false', 'disable', 'disabled'].includes(mode);
    updateRemoteNodeConfig({ autoOffloadBrowser: enabled });
    getSettingsManager().set('remoteNodesAutoOffloadBrowser', enabled);

    await adapter.sendMessage(
      msg.chatId,
      `Browser auto-offloading ${enabled ? 'enabled' : 'disabled'}.`,
      { replyTo: msg.messageId },
    );
  }

  private async routeDefault(
    msg: InboundChannelMessage,
    content: string,
    adapter: BaseChannelAdapter,
    workingDirectory = process.cwd(),
    attachments: FileAttachment[] = [],
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
      attachments: attachments.length > 0 ? attachments : undefined,
      yoloMode: true,
      ...(needsBrowser ? { nodePlacement: { requiresBrowser: true } } : {}),
    });

    // Stream results back
    if (content || attachments.length > 0) {
      this.streamResults(msg, instance.id, adapter);
    }

    return instance.id;
  }

  private async routeToProject(
    msg: InboundChannelMessage,
    content: string,
    adapter: BaseChannelAdapter,
    project: ProjectDescriptor,
    attachments: FileAttachment[] = [],
  ): Promise<string> {
    const refreshedProject =
      (project.workingDirectory
        ? await this.resolveProject(project.workingDirectory)
        : await this.resolveProject(project.label)) || project;
    const latestInstance = this.getRouteableInstances(refreshedProject)[0];

    if (latestInstance) {
      await this.routeToInstance(msg, latestInstance.id, content, adapter, attachments);
      return latestInstance.id;
    }

    if (!refreshedProject.workingDirectory) {
      throw new Error(
        `Project "${refreshedProject.label}" is missing a working directory, so a new session cannot be started.`,
      );
    }

    return this.routeDefault(msg, content, adapter, refreshedProject.workingDirectory, attachments);
  }

  private async routeToInstance(
    msg: InboundChannelMessage,
    instanceId: string,
    content: string,
    adapter: BaseChannelAdapter,
    attachments: FileAttachment[] = [],
  ): Promise<void> {
    const im = this.getInstanceManager();
    const instance = im.getInstance?.(instanceId);
    if (instance?.status === 'hibernated') {
      await im.wakeInstance(instanceId);
    }

    if (attachments.length > 0) {
      await im.sendInput(instanceId, content, attachments);
    } else {
      await im.sendInput(instanceId, content);
    }

    // Stream results back
    this.streamResults(msg, instanceId, adapter);
  }

  private async routeBroadcast(
    msg: InboundChannelMessage,
    content: string,
    adapter: BaseChannelAdapter,
    attachments: FileAttachment[] = [],
  ): Promise<void> {
    const im = this.getInstanceManager();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const instances: any[] = im.getAllInstances?.() ?? im.getInstances?.() ?? [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const activeInstances = instances.filter((i: any) =>
      this.isActiveSession(i)
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
        if (attachments.length > 0) {
          await im.sendInput(inst.id, content, attachments);
        } else {
          await im.sendInput(inst.id, content);
        }
        this.streamResults(msg, inst.id, adapter);
      } catch (err) {
        logger.warn('Failed to send broadcast to instance', { instanceId: inst.id, error: err });
      }
    }
  }

  private async resolveInputAttachments(
    msg: InboundChannelMessage,
    adapter: BaseChannelAdapter,
  ): Promise<FileAttachment[]> {
    if (msg.attachments.length === 0) {
      return [];
    }

    const accepted: FileAttachment[] = [];
    const rejected: string[] = [];

    for (const attachment of msg.attachments) {
      if (attachment.size > MAX_CHANNEL_ATTACHMENT_BYTES) {
        rejected.push(`${attachment.name} is larger than ${Math.round(MAX_CHANNEL_ATTACHMENT_BYTES / 1024 / 1024)} MB`);
        continue;
      }

      try {
        if (attachment.localPath) {
          this.assertSendable(attachment.localPath);
          const data = fs.readFileSync(attachment.localPath);
          accepted.push({
            name: attachment.name,
            type: attachment.type || 'application/octet-stream',
            size: attachment.size || data.length,
            data: `data:${attachment.type || 'application/octet-stream'};base64,${data.toString('base64')}`,
          });
          continue;
        }

        if (!attachment.url) {
          rejected.push(`${attachment.name} has no downloadable URL`);
          continue;
        }

        const response = await fetch(attachment.url);
        if (!response.ok) {
          rejected.push(`${attachment.name} download failed (${response.status})`);
          continue;
        }
        const arrayBuffer = await response.arrayBuffer();
        if (arrayBuffer.byteLength > MAX_CHANNEL_ATTACHMENT_BYTES) {
          rejected.push(`${attachment.name} downloaded larger than ${Math.round(MAX_CHANNEL_ATTACHMENT_BYTES / 1024 / 1024)} MB`);
          continue;
        }
        const type = attachment.type || response.headers.get('content-type') || 'application/octet-stream';
        accepted.push({
          name: attachment.name,
          type,
          size: arrayBuffer.byteLength,
          data: `data:${type};base64,${Buffer.from(arrayBuffer).toString('base64')}`,
        });
      } catch (err) {
        rejected.push(`${attachment.name} could not be attached: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const summary: string[] = [];
    if (accepted.length > 0) {
      summary.push(`Attached ${accepted.length} file${accepted.length === 1 ? '' : 's'} to the session.`);
    }
    if (rejected.length > 0) {
      summary.push(`Rejected ${rejected.length} file${rejected.length === 1 ? '' : 's'}: ${rejected.join('; ')}`);
    }
    if (summary.length > 0) {
      await adapter.sendMessage(msg.chatId, summary.join('\n'), { replyTo: msg.messageId });
    }

    return accepted;
  }

  // ============ Output streaming ============

  private streamResults(
    msg: InboundChannelMessage,
    instanceId: string,
    adapter: BaseChannelAdapter,
  ): void {
    const im = this.getInstanceManager();
    // Key by (platform, chatId, instanceId) — NOT by msg.id — so repeat user
    // prompts to the same chat+instance reuse the existing stream tracker.
    // Otherwise every new message (including each /continue button click)
    // would spawn a fresh listener on provider:normalized-event, causing every
    // emitted output chunk to be replayed N times into the channel.
    const bufferKey = `${msg.platform}:${msg.chatId}:${instanceId}`;
    const existingTracker = this.outputStreams.get(bufferKey);
    if (existingTracker) {
      // Re-target streaming output at the latest user prompt and clear any
      // pending finalization — fresh input means more output is incoming.
      existingTracker.currentMsg = msg;
      existingTracker.pendingFinalization = false;
      return;
    }

    const tracker: OutputStreamTracker = {
      content: '',
      suppressedContent: '',
      flushCount: 0,
      suppressionNoticeSent: false,
      timer: null,
      pendingFinalization: false,
      outputHandler: () => undefined,
      stateHandler: () => undefined,
      currentMsg: msg,
    };

    const cleanup = (): void => {
      if (tracker.timer) {
        clearTimeout(tracker.timer);
        tracker.timer = null;
      }
      im.removeListener('provider:normalized-event', tracker.outputHandler);
      im.removeListener('instance:state-update', tracker.stateHandler);
      this.outputStreams.delete(bufferKey);
    };

    const flush = (): void => {
      if (tracker.timer) {
        clearTimeout(tracker.timer);
        tracker.timer = null;
      }

      if (!tracker.content && !tracker.suppressedContent) {
        if (tracker.pendingFinalization) {
          cleanup();
        }
        return;
      }

      const bufferedContent = `${tracker.suppressedContent}${tracker.content}`;
      tracker.content = '';
      tracker.suppressedContent = '';
      // Always reply to the most recent user prompt for this chat+instance.
      const ctx = tracker.currentMsg;

      if (!tracker.pendingFinalization && tracker.flushCount >= MAX_LIVE_STREAM_FLUSHES) {
        tracker.suppressedContent += bufferedContent;
        if (!tracker.suppressionNoticeSent) {
          tracker.suppressionNoticeSent = true;
          void adapter.sendMessage(
            ctx.chatId,
            'Output is still streaming. I will hold further live chunks and post the final update when the session settles.',
            {
              replyTo: ctx.messageId,
              actions: this.buildSessionActions(instanceId),
            },
          ).catch((err: unknown) => {
            logger.error('Failed to send stream suppression notice', err instanceof Error ? err : new Error(String(err)));
          });
        }
        return;
      }

      tracker.flushCount += 1;
      const shouldCleanupAfterSend = tracker.pendingFinalization;

      void adapter.sendMessage(ctx.chatId, bufferedContent, {
        replyTo: ctx.messageId,
        actions: this.buildSessionActions(instanceId),
      }).then((sentMessage) => {
        this.persistence.saveMessage({
          id: `out-${ctx.platform}-${sentMessage.messageId}`,
          platform: ctx.platform,
          chat_id: ctx.chatId,
          message_id: sentMessage.messageId,
          thread_id: ctx.threadId ?? null,
          sender_id: 'bot',
          sender_name: 'Orchestrator',
          content: bufferedContent,
          direction: 'outbound',
          instance_id: instanceId,
          reply_to_message_id: ctx.messageId,
          timestamp: sentMessage.timestamp,
        });

        this.channelManager.emitResponseSent({
          channelMessageId: ctx.messageId,
          platform: ctx.platform,
          chatId: ctx.chatId,
          messageId: sentMessage.messageId,
          instanceId,
          content: bufferedContent,
          status: 'complete',
          replyToMessageId: ctx.messageId,
          timestamp: sentMessage.timestamp,
        });
      }).catch((err: unknown) => {
        logger.error('Failed to send output to channel', err instanceof Error ? err : new Error(String(err)));
      }).finally(() => {
        if (shouldCleanupAfterSend) {
          cleanup();
        }
      });
    };

    const scheduleFlush = (): void => {
      if (tracker.timer) {
        clearTimeout(tracker.timer);
      }
      tracker.timer = setTimeout(() => flush(), DEBOUNCE_MS);
    };

    tracker.outputHandler = (envelope: ProviderRuntimeEventEnvelope) => {
      if (envelope.instanceId !== instanceId) return;

      const message = toOutputMessageFromProviderEnvelope(envelope);
      const content = message?.content;
      if (!content) return;

      tracker.content += content;
      scheduleFlush();
    };

    tracker.stateHandler = (payload: { instanceId: string; status?: string }) => {
      if (payload.instanceId !== instanceId) return;

      if (
        payload.status !== 'idle' &&
        payload.status !== 'waiting_for_input' &&
        payload.status !== 'error' &&
        payload.status !== 'failed' &&
        payload.status !== 'terminated'
      ) {
        return;
      }

      tracker.pendingFinalization = true;
      if (!tracker.timer) {
        scheduleFlush();
      }
    };

    this.outputStreams.set(bufferKey, tracker);
    im.on('provider:normalized-event', tracker.outputHandler);
    im.on('instance:state-update', tracker.stateHandler);
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
