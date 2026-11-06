import { EventEmitter } from 'events';
import { getLogger } from '../main/logging/logger';
import * as fs from 'fs';
import * as path from 'path';
import type { CliType } from '../main/cli/cli-detection';
import type { CliResponse, InterruptResult } from '../main/cli/adapters/base-cli-adapter';
import type { StatelessExecClassifiable } from '../main/cli/adapters/stateless-exec-adapter';
import type { UnifiedSpawnOptions } from '../main/cli/adapters/adapter-factory.types';
import type { FileAttachment } from '../shared/types/instance.types';
import { observeAdapterRuntimeEvents } from '../main/providers/adapter-runtime-event-bridge';
import { toOutputMessageFromProviderOutputEvent } from '../main/providers/provider-output-event';
import type { WorkerBrowserManager } from './worker-browser-manager';
import type { WorkerAndroidManager, WorkerAndroidAttach } from './android/worker-android-manager';
import type { NodePlacementPrefs } from '../shared/types/worker-node.types';
import type { ResolvedAccountRoute } from '../shared/types/provider-account.types';
import { materializeWorkerAccountRoute, type WorkerAccountRouteParams } from './worker-account-route';
import { wireWorkerInteraction } from './worker-instance-interaction';
import { InstanceSendRawParamsSchema, remoteContextDetails } from '../main/remote-node/instance-interaction-schemas';
import { resolveNativeOpenCodeCommandInput } from '../main/commands/provider-native-commands';
import { observeWorkerInstanceTelemetry } from './worker-instance-telemetry';
import type { RemoteClaudeSpawnPolicy } from '../main/remote-node/claude-spawn-policy-schema';
import { resolveWorkerRtkSpawn } from './worker-rtk-spawn';
import { endsOnlyTheTurn, isSettledStatus, onExecTurnInterrupted } from './worker-exec-turn';
import { WorkerInstanceModelChange } from './worker-instance-model-change';
import { assertWorkerCopilotBinding, validateWorkerSpawnDirectories } from './worker-instance-spawn-validation';
import { sampleStallProcessFacts, type StallProcessFacts } from '../main/instance/stall-process-facts';
import { observeWorkerStderrActivity } from './worker-stderr-activity';
import { workerSpawnMetadata, type RemoteSpawnMetadata } from '../main/remote-node/remote-spawn-metadata';
import { buildQueuePushGuardEnv } from '../main/plan-queue/plan-queue-push-guard';

const logger = getLogger('LocalInstanceManager');
const ACTIVITY_WATCHDOG_INTERVAL_MS = 5_000;
type MobileMcpSpawnAttach = Omit<WorkerAndroidAttach, 'mobileMcpVersion'> & { version?: string };

export interface SpawnParams extends RemoteSpawnMetadata {
  instanceId: string;
  sessionId?: string;
  interactionId?: string;
  cliType: CliType;
  workingDirectory: string;
  /** Controller understands pending/settled usage frames for this instance. */
  usageSettlementProtocol?: 1;
  systemPrompt?: string;
  model?: string;
  reasoningEffort?: UnifiedSpawnOptions['reasoningEffort'];
  yoloMode?: boolean;
  allowedTools?: string[];
  disallowedTools?: string[];
  resume?: boolean;
  forkSession?: boolean;
  transcriptKnown?: boolean;
  additionalDirectories?: string[];
  mcpConfig?: string[];
  nodePlacement?: NodePlacementPrefs;
  /**
   * GitHub Copilot account routing metadata from the controller (spec §13).
   *
   * Safe metadata only: a profile ID, the identity the controller expects, and
   * the normalized host. This worker derives its OWN profile home under its own
   * AIO state directory and verifies its OWN local binding — credentials and
   * controller paths never travel.
   */
  copilotAccountRoute?: {
    profileId: string;
    expectedLogin?: string | null;
    host?: string;
    source?: string;
  };
  /** Claude Code / Codex account pool routing (D10). Safe metadata only, like `copilotAccountRoute`. */
  accountRoute?: WorkerAccountRouteParams;
  /** Claude policies the controller resolved; applied by this worker's own Claude adapter. */
  claudeSpawnPolicy?: RemoteClaudeSpawnPolicy;
  sessionKind?: UnifiedSpawnOptions['sessionKind'];
  rtk?: { enabled: boolean };
}

type WorkerManagedAdapter = EventEmitter & Partial<StatelessExecClassifiable> & {
  spawn: () => Promise<number | void>;
  sendInput: (message: string, attachments?: FileAttachment[]) => Promise<void>;
  terminate: (graceful?: boolean) => Promise<void>;
  interrupt: () => InterruptResult | Promise<void>;
  sendRaw?: (response: string, permissionKey?: string) => Promise<void>;
  getAvailableCommands?: () => unknown;
  getSessionId?: () => string | null;
  hasActiveTurn?: () => boolean;
  hasActiveToolCalls?: () => boolean;
  getPid?: () => number | null;
};

type PendingSpawnFailure = { error: unknown } | undefined;

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
  private readonly modelChanges = new WorkerInstanceModelChange({
    getInstance: id => this.instances.get(id),
    validateReplacement: async params => {
      validateWorkerSpawnDirectories(params, this.allowedDirs);
      this.assertSpawnNotShuttingDown(params.instanceId);
      if (params.cliType === 'copilot' && params.copilotAccountRoute) await assertWorkerCopilotBinding(params.copilotAccountRoute);
      if (params.accountRoute) await materializeWorkerAccountRoute(params.cliType, params.accountRoute);
    },
    terminate: id => this.terminateInstance(id),
    spawn: params => this.spawn(params),
  });
  private readonly instances = new Map<string, ManagedInstance>();
  private readonly pendingSpawns = new Set<string>();
  private readonly cancelledSpawns = new Set<string>();
  private readonly pendingSpawnAdapters = new Map<string, WorkerManagedAdapter>();
  private readonly pendingSpawnCompletions = new Map<string, Promise<PendingSpawnFailure>>();
  private readonly hibernatedInstances = new Map<string, SpawnParams>();
  /** Last resume proof relayed to the coordinator, per instance (P2.9 dedup). */
  private readonly relayedResumeProof = new Map<string, string>();
  private readonly interactions = new Map<string, ReturnType<typeof wireWorkerInteraction>>();
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

  /** Resolve only this worker's own adapter PID, never a coordinator-supplied PID. */
  async sampleStallProcessFacts(instanceId: string, silenceMs: number): Promise<StallProcessFacts | null> {
    const instance = this.instances.get(instanceId);
    if (!instance) throw new Error(`Instance not found: ${instanceId}`);
    const pid = instance.adapter.getPid?.() ?? null;
    const facts = await sampleStallProcessFacts(pid, { silenceMs });
    return this.instances.get(instanceId) === instance && instance.adapter.getPid?.() === pid ? facts : null;
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
        this.interactions.get(instanceId)?.lease();
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

  changeModel(previousInstanceId: string, replacement: SpawnParams): Promise<void> {
    return this.modelChanges.change(previousInstanceId, replacement);
  }

  async spawn(params: SpawnParams): Promise<void> {
    validateWorkerSpawnDirectories(params, this.allowedDirs);

    this.assertSpawnNotShuttingDown(params.instanceId);

    if (params.claudeSpawnPolicy && params.cliType !== 'claude') throw new Error('A Claude spawn policy was sent for a non-Claude provider.');

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
    let pendingInstance: ManagedInstance | undefined;
    let pendingFailure: PendingSpawnFailure;
    try {
      // Resolve browser automation before building the adapter so the
      // chrome-devtools MCP server is baked into the spawn config. Lazy: this
      // launches the managed Chrome on the first browser-enabled spawn, then
      // reuses it for subsequent spawns.
      const chromeDevtoolsMcp = await this.resolveChromeDevtoolsMcp();
      mobileMcp = await this.resolveMobileMcp(params);
      this.assertSpawnNotShuttingDown(params.instanceId);
      const rtkSpawn = resolveWorkerRtkSpawn(params.rtk);
      const env: Record<string, string> = { ...rtkSpawn.env };
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
      if (params.queuePushGuard) Object.assign(env, await buildQueuePushGuardEnv(params.workingDirectory, env)); // This node's repository decides which remotes to block.

      // Dynamic import to avoid pulling in Electron at module load time.
      // In the bundled worker agent, the adapter factory is tree-shaken to
      // only include the CLI adapters that are used.
      const { createCliAdapter } = await import('../main/cli/adapters/adapter-factory');
      this.assertSpawnNotShuttingDown(params.instanceId);
      // Node-local Copilot binding. The controller cannot read this machine's
      // Copilot state, so the account it resolved is only a REQUEST until this
      // worker confirms the profile is signed in here as the expected
      // identity. Failing closed here is what stops a worker silently running
      // the request under whatever account its Copilot home happens to hold.
      if (params.cliType === 'copilot' && params.copilotAccountRoute) {
        await assertWorkerCopilotBinding(params.copilotAccountRoute);
      }
      // Same rule for Claude/Codex account pools: verify this node's sign-in for
      // the profile, then run under a route re-materialised for this node.
      const accountRoute: ResolvedAccountRoute | null = params.accountRoute
        ? await materializeWorkerAccountRoute(params.cliType, params.accountRoute)
        : null;
      this.assertSpawnNotShuttingDown(params.instanceId);
      const adapter: WorkerManagedAdapter = createCliAdapter(params.cliType, {
        ...rtkSpawn,
        sessionId: params.sessionId ?? params.instanceId,
        ...workerSpawnMetadata(params, () => this.pendingSpawnAdapters.get(params.instanceId) === adapter || this.instances.get(params.instanceId)?.adapter === adapter,
          telemetry => this.emit('instance:telemetry', params.instanceId, telemetry)),
        workingDirectory: params.workingDirectory,
        systemPrompt: this.appendAndroidLeasePrompt(params.systemPrompt, mobileMcp),
        model: params.model,
        reasoningEffort: params.reasoningEffort,
        yoloMode: params.yoloMode ?? true,
        allowedTools: params.allowedTools,
        disallowedTools: params.disallowedTools,
        resume: params.resume,
        forkSession: params.forkSession,
        transcriptKnown: params.transcriptKnown,
        additionalDirectories: params.additionalDirectories,
        mcpConfig: params.mcpConfig,
        env: Object.keys(env).length > 0 ? env : undefined,
        nodePlacement: params.nodePlacement,
        ...(params.copilotAccountRoute
          ? {
              copilotAccountRoute: {
                profileId: params.copilotAccountRoute.profileId,
                source: 'persisted' as const,
                executionNodeId: 'worker',
                expectedLogin: params.copilotAccountRoute.expectedLogin ?? null,
                ...(params.copilotAccountRoute.host
                  ? { host: params.copilotAccountRoute.host }
                  : {}),
              },
            }
          : {}),
        ...(accountRoute ? { accountRoute } : {}),
        ...params.claudeSpawnPolicy, // createClaudeAdapter turns these into argv/env here as on the controller.
        // An omitted coordinator cap must not turn into a worker-local default.
        bashOutputMaxChars: params.claudeSpawnPolicy?.bashOutputMaxChars ?? 0,
        ...(chromeDevtoolsMcp ? { chromeDevtoolsMcp } : {}),
        ...(mobileMcp ? { mobileMcp } : {}),
      });
      this.pendingSpawnAdapters.set(params.instanceId, adapter);
      const interaction = wireWorkerInteraction(adapter,
        () => this.pendingSpawnAdapters.get(params.instanceId) === adapter || this.instances.get(params.instanceId)?.adapter === adapter,
        payload => this.emit('instance:permissionRequest', params.instanceId, payload),
        (state, info) => this.emit('instance:stateChange', params.instanceId, state, info), params.interactionId);
      this.interactions.set(params.instanceId, interaction);

      const stopTelemetry = observeWorkerInstanceTelemetry(adapter, telemetry => this.emit('instance:telemetry', params.instanceId, telemetry));
      const stopStderr = observeWorkerStderrActivity(adapter, () => {
        this.emit('instance:stateChange', params.instanceId, 'stderr_activity', { interactionId: params.interactionId });
      });
      runtimeObserverCleanup = () => { stopTelemetry(); stopStderr(); };
      const stopRuntime = observeAdapterRuntimeEvents(adapter, ({ event, eventId, rawPayload, timestamp }) => {
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
            if (endsOnlyTheTurn(adapter)) break; // One process per turn: the session continues.
            this.interactions.get(params.instanceId)?.cleanup(); this.interactions.delete(params.instanceId);
            runtimeObserverCleanup();
            this.clearWatchdog(params.instanceId);
            this.instances.delete(params.instanceId);
            this.relayedResumeProof.delete(params.instanceId);
            this.releaseAndroidLease(params.instanceId);
            if (!this.modelChanges.isChanging(params.instanceId)) {
              this.emit('instance:exit', params.instanceId, { code: event.code, signal: event.signal });
            }
            break;
          case 'status': {
            // As the coordinator does locally: a failed exec turn's `error` ends that turn only
            // (its error already went out as output), so the session settles instead of staying busy.
            const status = event.status === 'error' && endsOnlyTheTurn(adapter) ? 'idle' : event.status;
            const inst = this.instances.get(params.instanceId);
            if (inst) {
              inst.lastStatus = status;
            }
            if (isSettledStatus(status)) {
              this.clearWatchdog(params.instanceId);
            } else {
              this.resetWatchdog(params.instanceId);
            }
            this.emit('instance:stateChange', params.instanceId, status);
            break;
          }
          case 'context':
            this.emit('instance:context', params.instanceId, {
              used: event.used,
              total: event.total,
              percentage: event.percentage,
              ...remoteContextDetails(rawPayload),
            });
            break;
          case 'complete':
            this.relayResumeProof(params.instanceId, adapter);
            this.emit('instance:complete', params.instanceId, rawPayload as CliResponse,
              params.usageSettlementProtocol === 1);
            break;
          default:
            break;
        }
      });
      runtimeObserverCleanup = () => { stopTelemetry(); stopStderr(); stopRuntime(); };

      adapter.on('heartbeat', () => {
        const inst = this.instances.get(params.instanceId);
        if (!inst || inst.adapter !== adapter || inst.lastStatus === 'idle' || inst.lastStatus === 'ready' || inst.lastStatus === 'waiting_for_input') {
          return;
        }
        this.resetWatchdog(params.instanceId);
        this.emit('instance:heartbeat', params.instanceId);
      });
      adapter.on('exit', () => {
        if (endsOnlyTheTurn(adapter)) return;
        if (this.instances.get(params.instanceId)?.adapter !== adapter) return;
        this.releaseAndroidLease(params.instanceId);
      });

      adapter.on('stream:idle', () => {
        const inst = this.instances.get(params.instanceId);
        // Only emit thinking_deeply if the instance is actually busy.
        // After a response completes, the stream goes quiet but that's normal
        // idle behavior, not deep thinking.
        if (inst?.adapter === adapter && inst.lastStatus !== 'idle' && inst.lastStatus !== 'ready' && inst.lastStatus !== 'waiting_for_input') {
          this.clearWatchdog(params.instanceId);
          this.emit('instance:stateChange', params.instanceId, 'thinking_deeply');
        }
      });

      pendingInstance = {
        instanceId: params.instanceId,
        cliType: params.cliType,
        workingDirectory: params.workingDirectory,
        spawnParams: { ...params },
        adapter,
        runtimeObserverCleanup,
        createdAt: Date.now(),
        watchdogTimer: null,
        lastStatus: 'busy',
      };

      // A cancelled startup still owns this exact adapter until its stop succeeds.
      await adapter.spawn();
      logger.info('Worker spawn policy received', {
        cliType: params.cliType,
        sessionKind: params.claudeSpawnPolicy?.sessionKind ?? params.sessionKind ?? 'chat',
        requestedBashOutputMaxChars: params.claudeSpawnPolicy?.bashOutputMaxChars ?? null,
        rtkEnabled: rtkSpawn.rtk?.enabled === true,
      });
      interaction.catalog();
      if (this.terminateAllInProgress || this.cancelledSpawns.has(params.instanceId)) {
        await adapter.terminate();
        pendingInstance = undefined;
        throw new Error(
          this.terminateAllInProgress
            ? `Instance spawn cancelled during shutdown: ${params.instanceId}`
            : `Instance spawn cancelled: ${params.instanceId}`,
        );
      }

      this.instances.set(params.instanceId, pendingInstance);

      this.startWatchdog(params.instanceId);
    } catch (error) {
      this.interactions.get(params.instanceId)?.cleanup(); this.interactions.delete(params.instanceId);
      if (pendingInstance && (this.terminateAllInProgress || this.cancelledSpawns.has(params.instanceId))) {
        // Keep capacity and retry ownership when cancellation could not stop the provider.
        this.instances.set(params.instanceId, pendingInstance);
        pendingFailure = { error };
      } else {
        runtimeObserverCleanup();
        this.releaseAndroidLease(params.instanceId);
      }
      throw error;
    } finally {
      this.pendingSpawns.delete(params.instanceId);
      this.cancelledSpawns.delete(params.instanceId);
      this.pendingSpawnAdapters.delete(params.instanceId);
      this.pendingSpawnCompletions.delete(params.instanceId);
      pendingCompletion.resolve(pendingFailure);
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

  async sendInput(instanceId: string, message: string, attachments?: FileAttachment[], nativeCommandId?: string): Promise<void> {
    this.modelChanges.assertInputAllowed(instanceId);
    const inst = this.instances.get(instanceId);
    if (!inst) throw new Error(`Instance not found: ${instanceId}`);
    if (nativeCommandId && !resolveNativeOpenCodeCommandInput(inst.cliType, inst.adapter, nativeCommandId, message)) throw new Error('The selected native command is no longer available in this session.');
    await inst.adapter.sendInput(message, attachments);
  }

  async sendRaw(instanceId: string, response: string, permissionKey: string): Promise<void> {
    this.modelChanges.assertInputAllowed(instanceId);
    InstanceSendRawParamsSchema.parse({ instanceId, response, permissionKey });
    const adapter = this.instances.get(instanceId)?.adapter ?? this.pendingSpawnAdapters.get(instanceId);
    if (!adapter) throw new Error(`Instance not found: ${instanceId}`);
    const interaction = this.interactions.get(instanceId);
    if (!interaction || !adapter.sendRaw) throw new Error('Interactive responses are not supported by this adapter.');
    await interaction.interaction.answer(permissionKey, nativeKey => adapter.sendRaw!(response, nativeKey), interaction.resolved);
  }

  async terminate(instanceId: string): Promise<void> {
    this.modelChanges.cancel(instanceId);
    await this.terminateInstance(instanceId);
  }
  private async terminateInstance(instanceId: string): Promise<void> {
    this.interactions.get(instanceId)?.cleanup(); this.interactions.delete(instanceId);
    if (this.pendingSpawns.has(instanceId)) {
      this.cancelledSpawns.add(instanceId);
      const completion = this.pendingSpawnCompletions.get(instanceId);
      const adapter = this.pendingSpawnAdapters.get(instanceId);
      if (adapter) {
        await adapter.terminate();
      }
      const failure = await completion;
      if (failure) throw failure.error;
      return;
    }
    const inst = this.instances.get(instanceId);
    if (!inst) return;
    this.clearWatchdog(instanceId);
    await inst.adapter.terminate();
    inst.runtimeObserverCleanup();
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
    const adapter = inst.adapter;
    onExecTurnInterrupted(adapter, await adapter.interrupt(), () => this.settleInterruptedExecTurn(instanceId, adapter));
  }

  /** Report the interrupted exec turn settled (see onExecTurnInterrupted) and stop the busy watchdog. */
  private settleInterruptedExecTurn(instanceId: string, adapter: WorkerManagedAdapter): void {
    const inst = this.instances.get(instanceId);
    if (!inst || inst.adapter !== adapter || isSettledStatus(inst.lastStatus)) return;
    inst.lastStatus = 'idle'; this.clearWatchdog(instanceId);
    this.emit('instance:stateChange', instanceId, 'idle');
  }

  async hibernate(instanceId: string): Promise<void> {
    const inst = this.instances.get(instanceId);
    if (!inst) throw new Error(`Instance not found: ${instanceId}`);
    this.hibernatedInstances.set(instanceId, {
      ...inst.spawnParams,
      sessionId: inst.adapter.getSessionId?.() ?? inst.spawnParams.sessionId ?? instanceId,
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

function createDeferredCompletion() {
  let resolve: (failure?: PendingSpawnFailure) => void = () => undefined;
  const promise = new Promise<PendingSpawnFailure>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
