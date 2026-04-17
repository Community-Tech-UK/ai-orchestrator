/**
 * Orchestrator Plugin Manager
 *
 * Loads JS plugins from well-known directories and dispatches events to them.
 * The goal is a stable event surface (similar to how modern coding agents expose hooks),
 * without depending on any external repo runtime code.
 *
 * Plugin locations:
 * - `~/.orchestrator/plugins/**.js`
 * - `<cwd>/.orchestrator/plugins/**.js`
 *
 * Plugin module contract (CommonJS recommended):
 * - `module.exports = async (ctx) => ({ hooks... })` OR `module.exports = { hooks... }`
 *
 * Hooks are plain functions keyed by event name:
 * - `instance.created`
 * - `instance.removed`
 * - `instance.output`
 * - `verification.started`
 * - `verification.completed`
 * - `verification.error`
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { app } from 'electron';
import type { InstanceManager } from '../instance/instance-manager';
import { getMultiVerifyCoordinator } from '../orchestration/multi-verify-coordinator';
import { getConsensusCoordinator } from '../orchestration/consensus-coordinator';
import { getDebateCoordinator } from '../orchestration/debate-coordinator';
import { getSettingsManager } from '../core/config/settings-manager';
import { getLogger } from '../logging/logger';
import { getSessionContinuityManager } from '../session/session-continuity';
import type { OutputMessage } from '../../shared/types/instance.types';
import type {
  PluginHookEvent,
  PluginHookPayloads,
  PluginRecord,
  TypedOrchestratorHooks,
} from '../../shared/types/plugin.types';
import type { PluginManifest } from '@sdk/plugins';
import { PluginManifestSchema } from '@contracts/schemas/plugin';

const logger = getLogger('PluginManager');

/**
 * Reject paths containing '..' segments to prevent directory escape.
 */
function isPathSafe(filePath: string, baseDir: string): boolean {
  const resolved = path.resolve(filePath);
  const resolvedBase = path.resolve(baseDir);
  return resolved.startsWith(resolvedBase + path.sep) || resolved === resolvedBase;
}

function isRecord(value: unknown): value is PluginRecord {
  return typeof value === 'object' && value !== null;
}

function isOutputMessage(value: unknown): value is OutputMessage {
  if (!isRecord(value)) {
    return false;
  }

  const type = value['type'];
  return (
    typeof value['id'] === 'string' &&
    typeof value['timestamp'] === 'number' &&
    typeof value['content'] === 'string' &&
    (type === 'assistant' ||
      type === 'user' ||
      type === 'system' ||
      type === 'tool_use' ||
      type === 'tool_result' ||
      type === 'error')
  );
}

function isStringRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function toInstanceCreatedPayload(payload: unknown): PluginHookPayloads['instance.created'] | null {
  if (!isRecord(payload)) return null;
  const rawId = payload['id'];
  const rawWorkingDirectory = payload['workingDirectory'];
  if (typeof rawId !== 'string' || typeof rawWorkingDirectory !== 'string') {
    return null;
  }

  const provider = typeof payload['provider'] === 'string' ? payload['provider'] : undefined;
  return {
    ...payload,
    id: rawId,
    instanceId: rawId,
    workingDirectory: rawWorkingDirectory,
    ...(provider ? { provider } : {}),
  };
}

function toInstanceOutputPayload(payload: unknown): PluginHookPayloads['instance.output'] | null {
  if (!isRecord(payload)) return null;
  if (typeof payload['instanceId'] !== 'string' || !isOutputMessage(payload['message'])) {
    return null;
  }

  return {
    instanceId: payload['instanceId'],
    message: payload['message'],
  };
}

function toInstanceStateChangedPayload(
  payload: unknown,
): PluginHookPayloads['instance.stateChanged'] | null {
  if (!isRecord(payload)) return null;
  if (
    typeof payload['instanceId'] !== 'string'
    || typeof payload['status'] !== 'string'
    || typeof payload['previousStatus'] !== 'string'
  ) {
    return null;
  }

  return {
    instanceId: payload['instanceId'],
    previousState: payload['previousStatus'],
    newState: payload['status'],
    timestamp: typeof payload['timestamp'] === 'number' ? payload['timestamp'] : Date.now(),
  };
}

function toPermissionAskPayload(
  payload: unknown,
): PluginHookPayloads['permission.ask'] | null {
  if (!isRecord(payload) || typeof payload['instanceId'] !== 'string') {
    return null;
  }

  const metadata = isRecord(payload['metadata']) ? payload['metadata'] : {};
  const type = typeof metadata['type'] === 'string' ? metadata['type'] : '';
  if (type !== 'deferred_permission' && type !== 'permission_denial') {
    return null;
  }

  const toolName =
    typeof metadata['tool_name'] === 'string'
      ? metadata['tool_name']
      : typeof metadata['action'] === 'string'
        ? metadata['action']
        : 'unknown';
  const toolInput = isRecord(metadata['tool_input']) ? metadata['tool_input'] : {};
  const command =
    typeof toolInput['command'] === 'string'
      ? toolInput['command']
      : typeof metadata['path'] === 'string'
        ? metadata['path']
        : undefined;

  return {
    instanceId: payload['instanceId'],
    toolName,
    ...(command ? { command } : {}),
  };
}

function toSessionResumedPayload(payload: unknown): PluginHookPayloads['session.resumed'] | null {
  if (!isRecord(payload) || !isRecord(payload['state'])) {
    return null;
  }

  const state = payload['state'];
  if (typeof state['instanceId'] !== 'string' || typeof state['sessionId'] !== 'string') {
    return null;
  }

  return {
    instanceId: state['instanceId'],
    sessionId: state['sessionId'],
  };
}

function toSessionCompactingPayload(
  payload: unknown,
): PluginHookPayloads['session.compacting'] | null {
  if (!isRecord(payload)) {
    return null;
  }
  if (
    typeof payload['instanceId'] !== 'string'
    || typeof payload['messageCount'] !== 'number'
    || typeof payload['tokenCount'] !== 'number'
  ) {
    return null;
  }

  return {
    instanceId: payload['instanceId'],
    messageCount: payload['messageCount'],
    tokenCount: payload['tokenCount'],
  };
}

function toVerificationStartedPayload(
  payload: unknown,
): PluginHookPayloads['verification.started'] | null {
  if (!isRecord(payload)) return null;
  if (typeof payload['id'] !== 'string' || typeof payload['instanceId'] !== 'string') {
    return null;
  }

  return {
    ...payload,
    id: payload['id'],
    verificationId: payload['id'],
    instanceId: payload['instanceId'],
  };
}

function toVerificationCompletedPayload(
  payload: unknown,
): PluginHookPayloads['verification.completed'] | null {
  if (!isRecord(payload) || typeof payload['id'] !== 'string') {
    return null;
  }

  const request = isRecord(payload['request']) ? payload['request'] : null;
  const instanceId =
    typeof payload['instanceId'] === 'string'
      ? payload['instanceId']
      : typeof request?.['instanceId'] === 'string'
        ? request['instanceId']
        : '';

  return {
    ...payload,
    id: payload['id'],
    verificationId: payload['id'],
    instanceId,
  };
}

function toVerificationErrorPayload(
  payload: unknown,
): PluginHookPayloads['verification.error'] | null {
  if (!isRecord(payload) || !isRecord(payload['request'])) {
    return null;
  }

  const request = payload['request'];
  const verificationId = typeof request['id'] === 'string' ? request['id'] : '';
  const instanceId = typeof request['instanceId'] === 'string' ? request['instanceId'] : '';

  return {
    request,
    error: payload['error'],
    verificationId,
    instanceId,
  };
}

/**
 * Validate a plugin manifest using the contracts-backed Zod schema.
 * Replaces hand-rolled field checks with {@link PluginManifestSchema}.
 */
export function validateManifest(
  manifest: unknown,
): { valid: true; manifest: PluginManifest } | { valid: false; errors: string[] } {
  const result = PluginManifestSchema.safeParse(manifest);
  if (result.success) {
    // ValidatedPluginManifest is structurally assignable to PluginManifest
    return { valid: true, manifest: result.data as unknown as PluginManifest };
  }

  const errors = result.error.issues.map(
    (issue) => {
      const path = issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
      return `${path}${issue.message}`;
    },
  );
  return { valid: false, errors };
}

export interface OrchestratorPluginContext {
  instanceManager: InstanceManager;
  appPath: string;
  homeDir: string | null;
}

export type OrchestratorHooks = TypedOrchestratorHooks;
export type OrchestratorPluginModule =
  | OrchestratorHooks
  | ((ctx: OrchestratorPluginContext) => OrchestratorHooks | Promise<OrchestratorHooks>);

interface LoadedPlugin {
  filePath: string;
  hooks: TypedOrchestratorHooks;
  manifest?: PluginManifest;
}

interface CacheEntry {
  loadedAt: number;
  plugins: LoadedPlugin[];
  errors: { filePath: string; error: string }[];
}

const CACHE_TTL_MS = 10_000;

export class OrchestratorPluginManager {
  private static instance: OrchestratorPluginManager | null = null;

  private cacheByWorkingDir = new Map<string, CacheEntry>();
  private configLoadedByWorkingDir = new Set<string>();
  private activeToolExecutions = new Map<string, {
    toolName: string;
    args: Record<string, unknown>;
    startedAt: number;
  }>();
  private initialized = false;

  static getInstance(): OrchestratorPluginManager {
    if (!OrchestratorPluginManager.instance) {
      OrchestratorPluginManager.instance = new OrchestratorPluginManager();
    }
    return OrchestratorPluginManager.instance;
  }

  static _resetForTesting(): void {
    OrchestratorPluginManager.instance = null;
  }

  static _injectPluginForTesting(
    instance: OrchestratorPluginManager,
    workingDirectory: string,
    hooks: TypedOrchestratorHooks,
  ): void {
    const entry = instance.cacheByWorkingDir.get(workingDirectory) ?? {
      loadedAt: Date.now(),
      plugins: [],
      errors: [],
    };
    entry.plugins.push({ filePath: 'test-plugin.js', hooks });
    instance.cacheByWorkingDir.set(workingDirectory, entry);
  }

  private getHomeDir(): string | null {
    try {
      return app.getPath('home');
    } catch {
      return process.env['HOME'] || process.env['USERPROFILE'] || null;
    }
  }

  private getPluginDirs(workingDirectory: string): string[] {
    const dirs: string[] = [];
    const home = this.getHomeDir();
    if (home) dirs.push(path.join(home, '.orchestrator', 'plugins'));
    dirs.push(path.join(workingDirectory, '.orchestrator', 'plugins'));
    return dirs;
  }

  private buildContext(instanceManager: InstanceManager): OrchestratorPluginContext {
    return {
      instanceManager,
      appPath: app.getAppPath(),
      homeDir: this.getHomeDir(),
    };
  }

  private async walkJsFiles(dir: string): Promise<string[]> {
    const out: string[] = [];
    const stack: string[] = [dir];
    while (stack.length > 0) {
      const current = stack.pop()!;
      let entries: import('fs').Dirent[];
      try {
        entries = await fs.readdir(current, { withFileTypes: true });
      } catch (e) {
        logger.debug('Failed to read plugin directory during walk', { dir: current, error: String(e) });
        continue;
      }
      for (const entry of entries) {
        const full = path.join(current, entry.name);
        if (!isPathSafe(full, dir)) {
          logger.warn('Blocked path traversal attempt in plugin directory', { path: full, baseDir: dir });
          continue;
        }
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules' || entry.name === '.git') continue;
          stack.push(full);
          continue;
        }
        if (entry.isFile() && entry.name.toLowerCase().endsWith('.js')) out.push(full);
      }
    }
    return out;
  }

  private async loadModule(filePath: string): Promise<OrchestratorPluginModule> {
    const moduleUrl = `${pathToFileURL(filePath).href}?t=${Date.now()}`;
    const mod = await import(moduleUrl);
    return (mod && (mod.default || mod)) as OrchestratorPluginModule;
  }

  private async loadPluginsForWorkingDirectory(
    workingDirectory: string,
    ctx: OrchestratorPluginContext,
  ): Promise<{ plugins: LoadedPlugin[]; errors: { filePath: string; error: string }[] }> {
    const plugins: LoadedPlugin[] = [];
    const errors: { filePath: string; error: string }[] = [];
    const dirs = this.getPluginDirs(workingDirectory);
    for (const dir of dirs) {
      const files = await this.walkJsFiles(dir);
      for (const filePath of files) {
        try {
          const mod = await this.loadModule(filePath);
          const hooks: OrchestratorHooks =
            typeof mod === 'function' ? await mod(ctx) : (mod || {});
          let manifest: PluginManifest | undefined;
          const manifestPath = path.join(path.dirname(filePath), 'plugin.json');
          try {
            const manifestRaw = await fs.readFile(manifestPath, 'utf-8');
            const parsed: unknown = JSON.parse(manifestRaw);
            const result = validateManifest(parsed);
            if (result.valid) {
              manifest = result.manifest;
            } else {
              logger.warn(`Invalid plugin manifest at ${manifestPath}: ${result.errors.join(', ')}`);
              errors.push({ filePath: manifestPath, error: `Invalid manifest: ${result.errors.join(', ')}` });
            }
          } catch {
            // No manifest or unreadable — that's fine, it's optional
          }
          plugins.push({ filePath, hooks, manifest });
        } catch (e) {
          errors.push({ filePath, error: e instanceof Error ? e.message : String(e) });
        }
      }
    }
    return { plugins, errors };
  }

  private async getPlugins(workingDirectory: string, ctx: OrchestratorPluginContext): Promise<LoadedPlugin[]> {
    const cached = this.cacheByWorkingDir.get(workingDirectory);
    const now = Date.now();
    if (cached && now - cached.loadedAt < CACHE_TTL_MS) return cached.plugins;

    const { plugins, errors } = await this.loadPluginsForWorkingDirectory(workingDirectory, ctx);
    this.cacheByWorkingDir.set(workingDirectory, { loadedAt: now, plugins, errors });
    return plugins;
  }

  async listPlugins(workingDirectory: string, instanceManager: InstanceManager): Promise<{
    plugins: { filePath: string; hookKeys: string[]; manifest?: PluginManifest }[];
    scanDirs: string[];
    errors: { filePath: string; error: string }[];
  }> {
    const ctx = this.buildContext(instanceManager);
    const plugins = await this.getPlugins(workingDirectory, ctx);
    const errors = this.cacheByWorkingDir.get(workingDirectory)?.errors || [];
    const list = plugins
      .map((p) => ({ filePath: p.filePath, hookKeys: Object.keys(p.hooks || {}).sort(), manifest: p.manifest }))
      .sort((a, b) => a.filePath.localeCompare(b.filePath));
    return { plugins: list, scanDirs: this.getPluginDirs(workingDirectory), errors: errors.slice() };
  }

  clearCache(workingDirectory?: string): void {
    if (!workingDirectory) {
      this.cacheByWorkingDir.clear();
      this.configLoadedByWorkingDir.clear();
      return;
    }
    this.cacheByWorkingDir.delete(workingDirectory);
    this.configLoadedByWorkingDir.delete(workingDirectory);
  }

  private static readonly HOOK_TIMEOUT_MS = 5_000;

  private async invokeHook<K extends PluginHookEvent>(
    plugin: LoadedPlugin,
    event: K,
    payload: PluginHookPayloads[K],
  ): Promise<void> {
    const hook = plugin.hooks[event];
    if (!hook) return;

    try {
      const result = hook(payload);
      if (result instanceof Promise) {
        let timeoutId: ReturnType<typeof setTimeout>;
        const timeoutPromise = new Promise<never>((_, reject) => {
          timeoutId = setTimeout(
            () => reject(new Error(`Plugin hook timeout: ${plugin.filePath}:${String(event)}`)),
            OrchestratorPluginManager.HOOK_TIMEOUT_MS,
          );
        });
        try {
          await Promise.race([result, timeoutPromise]);
        } finally {
          clearTimeout(timeoutId!);
        }
      }
    } catch (err) {
      logger.warn(`Plugin hook error [${plugin.filePath}:${String(event)}]: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async emitConfigLoadedIfNeeded(
    workingDirectory: string,
    plugins: LoadedPlugin[],
  ): Promise<void> {
    if (this.configLoadedByWorkingDir.has(workingDirectory)) {
      return;
    }

    this.configLoadedByWorkingDir.add(workingDirectory);
    const config = getSettingsManager().getAll() as unknown as Record<string, unknown>;
    for (const plugin of plugins) {
      await this.invokeHook(plugin, 'config.loaded', { config });
    }
  }

  /**
   * Public method for core subsystems to emit plugin hook events.
   * Unlike the private `emitToPlugins`, this doesn't require a working directory
   * or context — it broadcasts to ALL cached plugin instances.
   *
   * Each hook call is wrapped with try/catch and a timeout to prevent
   * misbehaving plugins from crashing or blocking the host.
   */
  async emitHook<K extends PluginHookEvent>(
    event: K,
    payload: PluginHookPayloads[K],
  ): Promise<void> {
    // Broadcast to all cached working directories
    for (const [, entry] of this.cacheByWorkingDir) {
      for (const plugin of entry.plugins) {
        await this.invokeHook(plugin, event, payload);
      }
    }
  }

  private async emitToPlugins<K extends PluginHookEvent>(
    workingDirectory: string,
    ctx: OrchestratorPluginContext,
    event: K,
    payload: PluginHookPayloads[K],
  ): Promise<void> {
    const plugins = await this.getPlugins(workingDirectory, ctx);
    await this.emitConfigLoadedIfNeeded(workingDirectory, plugins);
    for (const plugin of plugins) {
      await this.invokeHook(plugin, event, payload);
    }
  }

  private getToolExecutionKey(instanceId: string, toolUseId: string): string {
    return `${instanceId}:${toolUseId}`;
  }

  private rememberToolExecution(instanceId: string, message: OutputMessage): void {
    if (message.type !== 'tool_use' || !isStringRecord(message.metadata)) {
      return;
    }

    const toolUseId = typeof message.metadata['id'] === 'string' ? message.metadata['id'] : null;
    const toolName = typeof message.metadata['name'] === 'string' ? message.metadata['name'] : null;
    const input = isStringRecord(message.metadata['input']) ? message.metadata['input'] : {};
    if (!toolUseId || !toolName) {
      return;
    }

    this.activeToolExecutions.set(this.getToolExecutionKey(instanceId, toolUseId), {
      toolName,
      args: input,
      startedAt: message.timestamp,
    });
  }

  private consumeToolExecution(
    instanceId: string,
    message: OutputMessage,
  ): { toolName: string; args: Record<string, unknown>; durationMs: number } | null {
    if (message.type !== 'tool_result' || !isStringRecord(message.metadata)) {
      return null;
    }

    const toolUseId =
      typeof message.metadata['tool_use_id'] === 'string' ? message.metadata['tool_use_id'] : null;
    if (!toolUseId) {
      return null;
    }

    const key = this.getToolExecutionKey(instanceId, toolUseId);
    const execution = this.activeToolExecutions.get(key);
    if (!execution) {
      return null;
    }

    this.activeToolExecutions.delete(key);
    return {
      toolName: execution.toolName,
      args: execution.args,
      durationMs: Math.max(0, message.timestamp - execution.startedAt),
    };
  }

  initialize(instanceManager: InstanceManager): void {
    if (this.initialized) return;
    this.initialized = true;

    const ctx = this.buildContext(instanceManager);

    instanceManager.on('instance:created', (payload: unknown) => {
      const pluginPayload = toInstanceCreatedPayload(payload);
      if (!pluginPayload) return;
      const wd = pluginPayload.workingDirectory || process.cwd();
      void this.emitToPlugins(wd, ctx, 'instance.created', pluginPayload);

      const sessionId = typeof pluginPayload['sessionId'] === 'string'
        ? pluginPayload['sessionId']
        : typeof pluginPayload['historyThreadId'] === 'string'
          ? pluginPayload['historyThreadId']
          : undefined;
      if (sessionId) {
        void this.emitToPlugins(wd, ctx, 'session.created', {
          instanceId: pluginPayload.instanceId,
          sessionId,
        });
      }
    });

    instanceManager.on('instance:removed', (instanceId: string) => {
      void this.emitToPlugins(process.cwd(), ctx, 'instance.removed', { instanceId });
    });

    instanceManager.on('instance:output', (payload: unknown) => {
      const pluginPayload = toInstanceOutputPayload(payload);
      if (!pluginPayload) return;
      const instance = instanceManager.getInstance(pluginPayload.instanceId);
      const wd = instance?.workingDirectory || process.cwd();
      void this.emitToPlugins(wd, ctx, 'instance.output', pluginPayload);

      if (pluginPayload.message.type === 'tool_use') {
        this.rememberToolExecution(pluginPayload.instanceId, pluginPayload.message);
        if (isStringRecord(pluginPayload.message.metadata)) {
          const toolName = typeof pluginPayload.message.metadata['name'] === 'string'
            ? pluginPayload.message.metadata['name']
            : null;
          const args = isStringRecord(pluginPayload.message.metadata['input'])
            ? pluginPayload.message.metadata['input']
            : {};
          if (toolName) {
            void this.emitToPlugins(wd, ctx, 'tool.execute.before', {
              instanceId: pluginPayload.instanceId,
              toolName,
              args,
            });
          }
        }
        return;
      }

      if (pluginPayload.message.type === 'tool_result') {
        const execution = this.consumeToolExecution(pluginPayload.instanceId, pluginPayload.message);
        if (execution) {
          void this.emitToPlugins(wd, ctx, 'tool.execute.after', {
            instanceId: pluginPayload.instanceId,
            toolName: execution.toolName,
            args: execution.args,
            result: pluginPayload.message.content,
            durationMs: execution.durationMs,
          });
        }
      }
    });

    instanceManager.on('instance:state-update', (payload: unknown) => {
      const pluginPayload = toInstanceStateChangedPayload(payload);
      if (!pluginPayload) return;
      const instance = instanceManager.getInstance(pluginPayload.instanceId);
      const wd = instance?.workingDirectory || process.cwd();
      void this.emitToPlugins(wd, ctx, 'instance.stateChanged', pluginPayload);
    });

    instanceManager.on('instance:input-required', (payload: unknown) => {
      const pluginPayload = toPermissionAskPayload(payload);
      if (!pluginPayload) return;
      const instance = instanceManager.getInstance(pluginPayload.instanceId);
      const wd = instance?.workingDirectory || process.cwd();
      void this.emitToPlugins(wd, ctx, 'permission.ask', pluginPayload);
    });

    const verify = getMultiVerifyCoordinator();
    verify.on('verification:started', (payload: unknown) => {
      const pluginPayload = toVerificationStartedPayload(payload);
      if (!pluginPayload) return;
      const instance = instanceManager.getInstance(pluginPayload.instanceId);
      const wd = instance?.workingDirectory || process.cwd();
      void this.emitToPlugins(wd, ctx, 'verification.started', pluginPayload);
    });
    verify.on('verification:completed', (payload: unknown) => {
      const pluginPayload = toVerificationCompletedPayload(payload);
      if (!pluginPayload) return;
      const instance = pluginPayload.instanceId
        ? instanceManager.getInstance(pluginPayload.instanceId)
        : undefined;
      const wd = instance?.workingDirectory || process.cwd();
      void this.emitToPlugins(wd, ctx, 'verification.completed', pluginPayload);
    });
    verify.on('verification:error', (payload: unknown) => {
      const pluginPayload = toVerificationErrorPayload(payload);
      if (!pluginPayload) return;
      const instance = pluginPayload.instanceId
        ? instanceManager.getInstance(pluginPayload.instanceId)
        : undefined;
      const wd = instance?.workingDirectory || process.cwd();
      void this.emitToPlugins(wd, ctx, 'verification.error', pluginPayload);
    });

    const sessionContinuity = getSessionContinuityManager();
    sessionContinuity.on('session:resumed', (payload: unknown) => {
      const pluginPayload = toSessionResumedPayload(payload);
      if (!pluginPayload) return;
      const instance = instanceManager.getInstance(pluginPayload.instanceId);
      const wd = instance?.workingDirectory || process.cwd();
      void this.emitToPlugins(wd, ctx, 'session.resumed', pluginPayload);
    });
    sessionContinuity.on('session:compacting', (payload: unknown) => {
      const pluginPayload = toSessionCompactingPayload(payload);
      if (!pluginPayload) return;
      const instance = instanceManager.getInstance(pluginPayload.instanceId);
      const wd = instance?.workingDirectory || process.cwd();
      void this.emitToPlugins(wd, ctx, 'session.compacting', pluginPayload);
    });

    const debate = getDebateCoordinator();
    debate.on('debate:round-complete', (payload: unknown) => {
      if (!isRecord(payload) || !isRecord(payload['round'])) {
        return;
      }

      const round = payload['round'];
      const instanceId = typeof payload['instanceId'] === 'string' ? payload['instanceId'] : undefined;
      const wd = instanceId
        ? instanceManager.getInstance(instanceId)?.workingDirectory || process.cwd()
        : process.cwd();
      const debateId = typeof payload['debateId'] === 'string' ? payload['debateId'] : null;
      const totalRounds = typeof payload['totalRounds'] === 'number' ? payload['totalRounds'] : 0;
      const roundNumber = typeof round['roundNumber'] === 'number' ? round['roundNumber'] : 0;
      const contributions = Array.isArray(round['contributions']) ? round['contributions'] : [];
      if (!debateId) {
        return;
      }

      for (const contribution of contributions) {
        if (!isRecord(contribution)) {
          continue;
        }
        const participantId = typeof contribution['agentId'] === 'string'
          ? contribution['agentId']
          : 'unknown';
        const response = typeof contribution['content'] === 'string'
          ? contribution['content']
          : '';
        void this.emitToPlugins(wd, ctx, 'orchestration.debate.round', {
          debateId,
          round: roundNumber,
          totalRounds,
          participantId,
          response,
        });
      }
    });

    const consensus = getConsensusCoordinator();
    consensus.on('consensus:vote', (payload: unknown) => {
      if (!isRecord(payload)) {
        return;
      }
      if (
        typeof payload['queryId'] !== 'string'
        || typeof payload['workingDirectory'] !== 'string'
        || typeof payload['provider'] !== 'string'
        || typeof payload['content'] !== 'string'
        || typeof payload['confidence'] !== 'number'
      ) {
        return;
      }

      void this.emitToPlugins(payload['workingDirectory'], ctx, 'orchestration.consensus.vote', {
        consensusId: payload['queryId'],
        voterId: payload['provider'],
        vote: payload['content'],
        confidence: payload['confidence'],
      });
    });
  }
}

let pluginManager: OrchestratorPluginManager | null = null;
export function getOrchestratorPluginManager(): OrchestratorPluginManager {
  if (!pluginManager) pluginManager = OrchestratorPluginManager.getInstance();
  return pluginManager;
}

export function _resetOrchestratorPluginManagerForTesting(): void {
  pluginManager = null;
  OrchestratorPluginManager._resetForTesting();
}
