import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import type { CliType } from '../main/cli/cli-detection';
import type { CliResponse, InterruptResult } from '../main/cli/adapters/base-cli-adapter';
import type { FileAttachment } from '../shared/types/instance.types';
import { observeAdapterRuntimeEvents } from '../main/providers/adapter-runtime-event-bridge';
import { toOutputMessageFromProviderOutputEvent } from '../main/providers/provider-output-event';
import type { WorkerBrowserManager } from './worker-browser-manager';
import type { WorkerAndroidManager, WorkerAndroidAttach } from './android/worker-android-manager';
import type { NodePlacementPrefs } from '../shared/types/worker-node.types';

const ACTIVITY_WATCHDOG_INTERVAL_MS = 5_000;
type MobileMcpSpawnAttach = Omit<WorkerAndroidAttach, 'mobileMcpVersion'> & { version?: string };

export interface SpawnParams {
  instanceId: string;
  cliType: CliType;
  workingDirectory: string;
  systemPrompt?: string;
  model?: string;
  yoloMode?: boolean;
  allowedTools?: string[];
  disallowedTools?: string[];
  resume?: boolean;
  forkSession?: boolean;
  mcpConfig?: string[];
  nodePlacement?: NodePlacementPrefs;
}

type WorkerManagedAdapter = EventEmitter & {
  spawn: () => Promise<number | void>;
  sendInput: (message: string, attachments?: FileAttachment[]) => Promise<void>;
  terminate: (graceful?: boolean) => Promise<void>;
  interrupt: () => InterruptResult | Promise<void>;
};

interface DeferredCompletion {
  promise: Promise<void>;
  resolve: () => void;
}

export interface ManagedInstance {
  instanceId: string;
  cliType: CliType;
  workingDirectory: string;
  spawnParams: SpawnParams;
  adapter: WorkerManagedAdapter;
  runtimeObserverCleanup: () => void;
  createdAt: number;
  watchdogTimer: ReturnType<typeof setInterval> | null;
  /** Last known adapter status — used to suppress stale watchdog/stream:idle events */
  lastStatus: string;
}

/**
 * Manages CLI adapter instances on the worker machine.
 * Enforces working directory sandboxing and capacity limits.
 */
export class LocalInstanceManager extends EventEmitter {
  private readonly instances = new Map<string, ManagedInstance>();
  private readonly pendingSpawns = new Set<string>();
  private readonly cancelledSpawns = new Set<string>();
  private readonly pendingSpawnAdapters = new Map<string, WorkerManagedAdapter>();
  private readonly pendingSpawnCompletions = new Map<string, Promise<void>>();
  private readonly hibernatedInstances = new Map<string, SpawnParams>();
  /** Last resume proof relayed to the coordinator, per instance (P2.9 dedup). */
  private readonly relayedResumeProof = new Map<string, string>();
  private readonly allowedDirs: string[];
  private readonly maxInstances: number;
  private readonly browserManager: WorkerBrowserManager | null;
  private readonly androidManager: WorkerAndroidManager | null;
  private terminateAllInProgress = false;

  constructor(
    allowedDirs: string[],
    maxInstances = 10,
    browserManager: WorkerBrowserManager | null = null,
    androidManager: WorkerAndroidManager | null = null,
  ) {
    super();
    this.allowedDirs = allowedDirs.map((d) => path.resolve(d));
    this.maxInstances = maxInstances;
    this.browserManager = browserManager;
    this.androidManager = androidManager;
  }

  /**
   * When browser automation is enabled on this node, ensure the managed Chrome
   * is up and return a `chromeDevtoolsMcp` attach option for the spawn. Degrades
   * gracefully: any failure logs and returns null so the instance still spawns,
   * just without browser tools (better than failing the whole spawn).
   */
  private async resolveChromeDevtoolsMcp(): Promise<{ browserUrl: string } | null> {
    if (!this.browserManager?.isEnabled()) {
      return null;
    }
    try {
      const browserUrl = await this.browserManager.ensureRunning();
      return { browserUrl };
    } catch (err) {
      console.warn(
        '[LocalInstanceManager] browser automation enabled but Chrome failed to start; spawning without browser tools',
        err instanceof Error ? err.message : String(err),
      );
      return null;
    }
  }

  private async resolveMobileMcp(params: SpawnParams): Promise<MobileMcpSpawnAttach | null> {
    if (!params.nodePlacement?.requiresAndroid || !this.androidManager?.isEnabled()) {
      return null;
    }
    try {
      const kind = params.nodePlacement.androidDeviceKind ?? 'any';
      const attach = await this.androidManager.resolveAttachForInstance(params.instanceId, {
        kind,
      });
      return {
        serial: attach.serial,
        kind: attach.kind,
        sdkPath: attach.sdkPath,
        maestro: attach.maestro,
        ...(attach.mobileMcpVersion ? { version: attach.mobileMcpVersion } : {}),
      };
    } catch (err) {
      console.warn(
        '[LocalInstanceManager] Android automation requested but no device lease could be acquired; spawning without Android tools',
        err instanceof Error ? err.message : String(err),
      );
      return null;
    }
  }

  private releaseAndroidLease(instanceId: string): void {
    this.androidManager?.releaseLeaseForInstance(instanceId);
  }

  private appendAndroidLeasePrompt(systemPrompt: string | undefined, attach: MobileMcpSpawnAttach | null): string | undefined {
    if (!attach) {
      return systemPrompt;
    }
    const leasePrompt = [
      '[Android device lease]',
      `You are leased Android device \`${attach.serial}\` (${attach.kind}).`,
      'Pass this exact serial as the `device` parameter to every mobile-mcp tool call.',
      'Do not touch other Android serials on this worker.',
    ].join('\n');
    return [systemPrompt?.trim(), leasePrompt].filter(Boolean).join('\n\n---\n\n');
  }

  private resolveAxeRunnerPath(): string | null {
    const argvEntry = process.argv[1] ? path.dirname(process.argv[1]) : process.cwd();
    const candidates = [
      path.resolve(argvEntry, 'worker-tools', 'axe-audit.mjs'),
      path.resolve(argvEntry, '..', 'worker-tools', 'axe-audit.mjs'),
      path.resolve(process.cwd(), 'dist', 'worker-tools', 'axe-audit.mjs'),
      path.resolve(__dirname, '..', 'worker-tools', 'axe-audit.mjs'),
      path.resolve(process.cwd(), 'scripts', 'worker-tools', 'axe-audit.mjs'),
    ];
    return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
  }

  getInstanceCount(): number {
    return this.instances.size;
  }

  getAllInstanceIds(): string[] {
    return [...this.instances.keys()];
  }

  getInstance(instanceId: string): ManagedInstance | undefined {
    return this.instances.get(instanceId);
  }

  private startWatchdog(instanceId: string): void {
    const inst = this.instances.get(instanceId);
    if (!inst) return;
    this.resetWatchdog(instanceId);
  }

  private resetWatchdog(instanceId: string): void {
    const inst = this.instances.get(instanceId);
    if (!inst) return;

    if (inst.watchdogTimer) {
      clearInterval(inst.watchdogTimer);
    }

    inst.watchdogTimer = setInterval(() => {
      if (this.instances.has(instanceId)) {
        this.emit('instance:stateChange', instanceId, 'processing');
      }
    }, ACTIVITY_WATCHDOG_INTERVAL_MS);

    if (inst.watchdogTimer.unref) {
      inst.watchdogTimer.unref();
    }
  }

  private clearWatchdog(instanceId: string): void {
    const inst = this.instances.get(instanceId);
    if (!inst?.watchdogTimer) return;
    clearInterval(inst.watchdogTimer);
    inst.watchdogTimer = null;
  }

  async spawn(params: SpawnParams): Promise<void> {
    // Enforce working directory sandboxing
    const resolved = path.resolve(params.workingDirectory);
    const isAllowed = this.allowedDirs.some((allowed) =>
      isPathInsideAllowedDirectory(resolved, allowed)
    );
    if (!isAllowed) {
      throw new Error(
        `Working directory "${params.workingDirectory}" is not in allowed working directories: ${this.allowedDirs.join(', ')}`,
      );
    }

    this.assertSpawnNotShuttingDown(params.instanceId);

    if (this.instances.has(params.instanceId) || this.pendingSpawns.has(params.instanceId)) {
      throw new Error(`Instance already exists: ${params.instanceId}`);
    }

    // Enforce capacity limit, including async spawns that have not finished starting yet.
    if (this.instances.size + this.pendingSpawns.size >= this.maxInstances) {
      throw new Error(`Worker at capacity (${this.maxInstances} instances)`);
    }
    this.pendingSpawns.add(params.instanceId);
    const pendingCompletion = createDeferredCompletion();
    this.pendingSpawnCompletions.set(params.instanceId, pendingCompletion.promise);

    let mobileMcp: MobileMcpSpawnAttach | null = null;
    let runtimeObserverCleanup: () => void = () => undefined;
    try {
      // Resolve browser automation before building the adapter so the
      // chrome-devtools MCP server is baked into the spawn config. Lazy: this
      // launches the managed Chrome on the first browser-enabled spawn, then
      // reuses it for subsequent spawns.
      const chromeDevtoolsMcp = await this.resolveChromeDevtoolsMcp();
      mobileMcp = await this.resolveMobileMcp(params);
      this.assertSpawnNotShuttingDown(params.instanceId);
      const env: Record<string, string> = {};
      if (mobileMcp) {
        env['ANDROID_SERIAL'] = mobileMcp.serial;
      }
      if (chromeDevtoolsMcp) {
        env['AIO_BROWSER_URL'] = chromeDevtoolsMcp.browserUrl;
        const axeRunnerPath = this.resolveAxeRunnerPath();
        if (axeRunnerPath) {
          env['AIO_AXE_RUNNER'] = axeRunnerPath;
        }
      }

      // Dynamic import to avoid pulling in Electron at module load time.
      // In the bundled worker agent, the adapter factory is tree-shaken to
      // only include the CLI adapters that are used.
      const { createCliAdapter } = await import('../main/cli/adapters/adapter-factory');
      this.assertSpawnNotShuttingDown(params.instanceId);
      const adapter: WorkerManagedAdapter = createCliAdapter(params.cliType, {
        sessionId: params.instanceId,
        workingDirectory: params.workingDirectory,
        systemPrompt: this.appendAndroidLeasePrompt(params.systemPrompt, mobileMcp),
        model: params.model,
        yoloMode: params.yoloMode ?? true,
        allowedTools: params.allowedTools,
        disallowedTools: params.disallowedTools,
        resume: params.resume,
        forkSession: params.forkSession,
        mcpConfig: params.mcpConfig,
        env: Object.keys(env).length > 0 ? env : undefined,
        nodePlacement: params.nodePlacement,
        ...(chromeDevtoolsMcp ? { chromeDevtoolsMcp } : {}),
        ...(mobileMcp ? { mobileMcp } : {}),
      });
      this.pendingSpawnAdapters.set(params.instanceId, adapter);

      runtimeObserverCleanup = observeAdapterRuntimeEvents(adapter, ({ event, eventId, rawPayload, timestamp }) => {
        switch (event.kind) {
          case 'output': {
            const inst = this.instances.get(params.instanceId);
            // Only reset watchdog if instance is busy — output can arrive after
            // the idle event due to buffering, and resetting the watchdog would
            // restart the 5s processing timer that overrides idle.
            if (inst && inst.lastStatus !== 'idle' && inst.lastStatus !== 'ready' && inst.lastStatus !== 'waiting_for_input') {
              this.resetWatchdog(params.instanceId);
            }
            this.emit(
              'instance:output',
              params.instanceId,
              toOutputMessageFromProviderOutputEvent(event, { eventId, timestamp }),
            );
            // P2.9: relay the worker adapter's resume proof to the coordinator so
            // the remote adapter can confirm the resumed session id (closes the
            // remote half of B1 — otherwise remote resume "succeeds" on any output).
            this.relayResumeProof(params.instanceId, adapter);
            break;
          }
          case 'exit':
            runtimeObserverCleanup();
            this.clearWatchdog(params.instanceId);
            this.instances.delete(params.instanceId);
            this.relayedResumeProof.delete(params.instanceId);
            this.releaseAndroidLease(params.instanceId);
            this.emit('instance:exit', params.instanceId, { code: event.code, signal: event.signal });
            break;
          case 'status': {
            const inst = this.instances.get(params.instanceId);
            if (inst) {
              inst.lastStatus = event.status;
            }
            if (event.status === 'idle' || event.status === 'ready' || event.status === 'waiting_for_input') {
              this.clearWatchdog(params.instanceId);
            } else {
              this.resetWatchdog(params.instanceId);
            }
            this.emit('instance:stateChange', params.instanceId, event.status);
            break;
          }
          case 'context':
            this.emit('instance:context', params.instanceId, {
              used: event.used,
              total: event.total,
              percentage: event.percentage,
            });
            break;
          case 'complete':
            this.relayResumeProof(params.instanceId, adapter);
            this.emit('instance:complete', params.instanceId, rawPayload as CliResponse);
            break;
          default:
            break;
        }
      });

      adapter.on('heartbeat', () => {
        const inst = this.instances.get(params.instanceId);
        if (!inst || inst.lastStatus === 'idle' || inst.lastStatus === 'ready' || inst.lastStatus === 'waiting_for_input') {
          return;
        }
        this.resetWatchdog(params.instanceId);
        this.emit('instance:heartbeat', params.instanceId);
      });
      adapter.on('exit', () => {
        this.releaseAndroidLease(params.instanceId);
      });

      adapter.on('input_required', (permission: unknown) => {
        this.emit('instance:permissionRequest', params.instanceId, permission);
      });
      adapter.on('stream:idle', () => {
        const inst = this.instances.get(params.instanceId);
        // Only emit thinking_deeply if the instance is actually busy.
        // After a response completes, the stream goes quiet but that's normal
        // idle behavior, not deep thinking.
        if (inst && inst.lastStatus !== 'idle' && inst.lastStatus !== 'ready' && inst.lastStatus !== 'waiting_for_input') {
          this.clearWatchdog(params.instanceId);
          this.emit('instance:stateChange', params.instanceId, 'thinking_deeply');
        }
      });

      // Spawn the process
      await adapter.spawn();
      if (this.terminateAllInProgress || this.cancelledSpawns.has(params.instanceId)) {
        runtimeObserverCleanup();
        await adapter.terminate().catch((error: unknown) => {
          console.warn(
            '[LocalInstanceManager] failed to terminate instance after startup was cancelled',
            error instanceof Error ? error.message : String(error),
          );
        });
        runtimeObserverCleanup = () => undefined;
        throw new Error(
          this.terminateAllInProgress
            ? `Instance spawn cancelled during shutdown: ${params.instanceId}`
            : `Instance spawn cancelled: ${params.instanceId}`,
        );
      }

      this.instances.set(params.instanceId, {
        instanceId: params.instanceId,
        cliType: params.cliType,
        workingDirectory: params.workingDirectory,
        spawnParams: { ...params },
        adapter,
        runtimeObserverCleanup,
        createdAt: Date.now(),
        watchdogTimer: null,
        lastStatus: 'busy',
      });

      this.startWatchdog(params.instanceId);
    } catch (error) {
      runtimeObserverCleanup();
      this.releaseAndroidLease(params.instanceId);
      throw error;
    } finally {
      this.pendingSpawns.delete(params.instanceId);
      this.cancelledSpawns.delete(params.instanceId);
      this.pendingSpawnAdapters.delete(params.instanceId);
      this.pendingSpawnCompletions.delete(params.instanceId);
      pendingCompletion.resolve();
    }
  }

  private assertSpawnNotShuttingDown(instanceId: string): void {
    if (this.terminateAllInProgress) {
      throw new Error(`Instance spawn cancelled during shutdown: ${instanceId}`);
    }
    if (this.cancelledSpawns.has(instanceId)) {
      throw new Error(`Instance spawn cancelled: ${instanceId}`);
    }
  }

  async sendInput(instanceId: string, message: string, attachments?: FileAttachment[]): Promise<void> {
    const inst = this.instances.get(instanceId);
    if (!inst) throw new Error(`Instance not found: ${instanceId}`);
    await inst.adapter.sendInput(message, attachments);
  }

  async terminate(instanceId: string): Promise<void> {
    if (this.pendingSpawns.has(instanceId)) {
      this.cancelledSpawns.add(instanceId);
      const adapter = this.pendingSpawnAdapters.get(instanceId);
      if (adapter) {
        await adapter.terminate().catch((error: unknown) => {
          console.warn(
            '[LocalInstanceManager] failed to terminate pending instance',
            error instanceof Error ? error.message : String(error),
          );
        });
      }
      await this.pendingSpawnCompletions.get(instanceId);
      return;
    }
    const inst = this.instances.get(instanceId);
    if (!inst) return;
    this.clearWatchdog(instanceId);
    inst.runtimeObserverCleanup();
    await inst.adapter.terminate();
    this.instances.delete(instanceId);
    this.relayedResumeProof.delete(instanceId);
    this.releaseAndroidLease(instanceId);
  }

  /**
   * P2.9: Forward the worker adapter's resume proof to the coordinator as a
   * `resume_proof` state-change (whose `info` carries the proof). Deduped so we
   * only emit when the proof changes — the proof transitions pending → confirmed
   * once. The coordinator's RemoteCliAdapter consumes it via getResumeAttemptResult().
   */
  private relayResumeProof(instanceId: string, adapter: WorkerManagedAdapter): void {
    const proof = (adapter as { getResumeAttemptResult?: () => unknown }).getResumeAttemptResult?.();
    if (!proof || typeof proof !== 'object') return;
    const source = (proof as { source?: unknown }).source;
    if (source === undefined || source === 'none') return;
    const signature = JSON.stringify(proof);
    if (this.relayedResumeProof.get(instanceId) === signature) return;
    this.relayedResumeProof.set(instanceId, signature);
    this.emit('instance:stateChange', instanceId, 'resume_proof', proof);
  }

  async interrupt(instanceId: string): Promise<void> {
    const inst = this.instances.get(instanceId);
    if (!inst) throw new Error(`Instance not found: ${instanceId}`);
    await inst.adapter.interrupt();
  }

  async hibernate(instanceId: string): Promise<void> {
    const inst = this.instances.get(instanceId);
    if (!inst) throw new Error(`Instance not found: ${instanceId}`);
    this.hibernatedInstances.set(instanceId, {
      ...inst.spawnParams,
      resume: true,
    });
    await this.terminate(instanceId);
  }

  async wake(instanceId: string): Promise<void> {
    if (this.instances.has(instanceId)) {
      return;
    }
    const spawnParams = this.hibernatedInstances.get(instanceId);
    if (!spawnParams) {
      throw new Error(`Hibernated instance not found: ${instanceId}`);
    }
    await this.spawn({
      ...spawnParams,
      resume: true,
    });
    this.hibernatedInstances.delete(instanceId);
  }

  async terminateAll(): Promise<void> {
    this.terminateAllInProgress = true;
    const ids = [...this.instances.keys()];
    const pendingCompletions = [...this.pendingSpawnCompletions.entries()];
    for (const id of ids) {
      this.clearWatchdog(id);
    }
    this.hibernatedInstances.clear();
    try {
      await Promise.allSettled([
        ...ids.map((id) => this.terminate(id)),
        ...pendingCompletions.map(async ([id, completion]) => {
          await completion;
          await this.terminate(id);
        }),
      ]);
    } finally {
      this.terminateAllInProgress = false;
    }
  }
}

function createDeferredCompletion(): DeferredCompletion {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function isPathInsideAllowedDirectory(resolvedPath: string, allowedDir: string): boolean {
  const [candidate, allowed] = process.platform === 'win32'
    ? [resolvedPath.toLowerCase(), allowedDir.toLowerCase()]
    : [resolvedPath, allowedDir];
  return candidate === allowed || candidate.startsWith(allowed + path.sep);
}
