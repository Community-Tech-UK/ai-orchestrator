import type {
  AdapterCapabilities,
  AdapterRuntimeCapabilities,
  CliSpawnMode,
  ContextUsageObservation,
  InterruptResult,
  ProviderRuntimeSnapshot,
  ResumeAttemptResult,
} from './base-cli-adapter';
import { CodexExecAdapter } from './codex-exec-adapter';
import type { CodexCliConfig } from './codex-adapter-config';
import type { AppServerClient } from './codex/app-server-client';
import {
  CodexAppServerThreadRuntime,
  type CodexAppServerRuntimeClient,
} from './codex/app-server-thread-runtime';
import { CODEX_TIMEOUTS } from '../../../shared/constants/limits';
import { getClampedLoadWatchdogMultiplier } from '../../runtime/system-load-monitor';
import type { FileAttachment, InstanceStatus } from '../../../shared/types/instance.types';
import { getLogger } from '../../logging/logger';
import { generateId } from '../../../shared/utils/id-generator';
import { isProviderNotice } from '../provider-notice';
import {
  isCodexInputTooLargeError,
  isRecoverableThreadResumeError,
} from './codex/exec-error-classifier';
import { planCodexAppServerRecovery } from './codex/app-server-recovery-policy';
import type { ProviderContextCapabilities } from '@contracts/types/context-evidence';
import type { ResumeCursor } from '../../session/session-continuity';
import type { AppServerNotification, UserInput } from './codex/app-server-types';
import { getSafeEnvForTrustedProcess } from '../../security/env-filter';
import { buildMessageWithFiles, processAttachments } from '../file-handler';
import { supportsCodexInlineImage } from './codex/attachments';
import { startThreadWithRetry } from './codex/thread-start-retry';
import { SERVICE_NAME } from './codex/app-server-types';
import { recoverFromInputCap } from './codex/input-cap-recovery';
import { CodexSessionScanner } from './codex/session-scanner';
import { initializeCodexAppServer } from './codex/app-server-initializer';
import {
  CodexContextPressureCollector,
  type CodexContextDiagnosticRecord,
  type CodexContextDiagnosticSink,
} from './codex/context-pressure-diagnostics';
import { CodexContextCostController } from './codex/context-cost-controller';
import { buildObservedCompactionEvents } from './codex/compaction-presentation';
import type {
  ProviderContextActionHandlerResult,
  ProviderContextExecutableAction,
} from '../../context-evidence/provider-context-action-executor';

const logger = getLogger('CodexCliAdapter');
const contextDiagnosticsLogger = getLogger('CodexContextDiagnostics');

export function isCodexContextDiagnosticsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['AIO_CODEX_CONTEXT_DIAGNOSTICS'] === '1';
}

/** App-server connection/thread state layered over the exec fallback adapter. */
export abstract class CodexAppServerAdapter extends CodexExecAdapter {
  protected useAppServer = false;
  protected override spawnMode: CliSpawnMode = 'unknown';
  protected appServerClient: AppServerClient | null = null;
  protected appServerThreadId: string | null = null;
  protected readonly appServerRuntime = new CodexAppServerThreadRuntime();
  protected appServerInitEpoch = 0;
  protected isSpawned = false;
  private readonly sessionScanner = new CodexSessionScanner();
  protected readonly contextDiagnostics: CodexContextPressureCollector | null;
  protected readonly contextCostController: CodexContextCostController;
  private contextDiagnosticsSink: CodexContextDiagnosticSink | null;
  private contextDiagnosticsWarningLogged = false;
  private contextActionProofRecorder: ((
    action: string,
    stage: 'requested' | 'acknowledged' | 'observed',
  ) => void) | null = null;

  protected constructor(config: CodexCliConfig = {}) {
    super(config);
    this.contextDiagnosticsSink = isCodexContextDiagnosticsEnabled()
      ? { write: (record) => contextDiagnosticsLogger.info('context-pressure-observation', record as Record<string, unknown>) }
      : null;
    this.contextDiagnostics = this.contextDiagnosticsSink
      ? new CodexContextPressureCollector({ write: (record) => this.writeContextDiagnosticRecord(record) })
      : null;
    this.contextCostController = new CodexContextCostController({
      compactionTimeoutMs: CODEX_TIMEOUTS.COMPACTION_SETTLE_MS,
      interrupt: () => this.interrupt(),
      getCompactionTarget: () => this.getAppServerClient() && this.getAppServerThreadId() && this.useAppServer
        ? {
            threadId: this.getAppServerThreadId()!,
            start: () => this.getAppServerClient()!.request('thread/compact/start', { threadId: this.getAppServerThreadId()! }),
          }
        : null,
      emitSystem: (content, metadata) => this.emit('output', {
        id: generateId(),
        timestamp: Date.now(),
        type: 'system',
        content,
        metadata,
      }),
      recordRecovery: (stage, reasonCode) => this.contextDiagnostics?.recordCostRecovery(stage, reasonCode),
      recordCompactionRpc: (stage) => this.contextDiagnostics?.recordCompactionRpc(stage),
      recordActionProof: (action, stage) => {
        this.emit('context_action_proof', { action, stage, at: Date.now() });
        this.contextActionProofRecorder?.(action, stage);
      },
    });
  }

  private writeContextDiagnosticRecord(record: CodexContextDiagnosticRecord): void {
    try {
      this.contextDiagnosticsSink?.write(record);
    } catch {
      if (this.contextDiagnosticsWarningLogged) return;
      this.contextDiagnosticsWarningLogged = true;
      try { contextDiagnosticsLogger.warn('Context-pressure diagnostic write failed'); } catch { /* isolated */ }
    }
  }

  protected async initAppServerMode(initEpoch?: number): Promise<void> {
    const cwd = this.cliConfig.workingDir || process.cwd();
    const client = await this.connectAppServer(cwd);
    client.setContextDiagnosticsCollector?.(this.contextDiagnostics);
    const result = await initializeCodexAppServer({
      client,
      config: this.cliConfig,
      cwd,
      sandbox: this.mapSandboxMode(),
      sessionId: this.sessionId,
      sessionScanner: this.sessionScanner,
      shouldResume: this.shouldResumeNextTurn,
      isCurrent: () => initEpoch === undefined || initEpoch === this.appServerInitEpoch,
      onFailedAttempt: (attempt) => {
        this.lastResumeAttemptResult = attempt;
      },
    });
    if (!result) return;

    this.lastResumeAttemptResult = result.resumeAttempt;
    this.shouldResumeNextTurn = false;
    this.resumeCursor = result.resumeCursor;
    this.appServerClient = result.client;
    this.appServerThreadId = result.threadId;
    if (!result.threadId) return;

    this.sessionId = result.threadId;
    this.appServerRuntime.attach(
      result.client,
      {
        threadId: result.threadId,
        resumeCursor: this.resumeCursor,
        resumeProof: this.lastResumeAttemptResult,
      },
      (notification) => this.handleIdleAppServerNotification(notification),
      (exitError) => {
        if (!this.isSpawned) return;
        this.handleAppServerRuntimeExit(exitError);
        const code = exitError ? 1 : 0;
        logger.warn('App-server process exited, forwarding to adapter exit event', {
          threadId: this.getAppServerThreadId(),
          hasError: !!exitError,
          error: exitError?.message,
        });
        this.emit('exit', code, null);
      },
    );
  }

  /** Triggers native app-server compaction and requires the completion notification. */
  async compactContext(): Promise<boolean> {
    return this.contextCostController.compactContext(CODEX_TIMEOUTS.COMPACTION_SETTLE_MS);
  }

  protected clearPendingContextCost(): void {
    this.contextCostController.clearPending();
  }

  /** Executes only the provider-specific command selected by the shared policy. */
  async executeContextAction(
    action: ProviderContextExecutableAction,
  ): Promise<ProviderContextActionHandlerResult> {
    switch (action) {
      case 'native-compaction':
        return { proof: await this.compactContext() ? 'observed' : 'none' };
      case 'controlled-interrupt':
      case 'controlled-recovery':
        return this.contextCostController.requestRecovery(action);
      case 'rebuild-working-set':
      case 'same-thread-continuation':
        return { proof: 'none' };
    }
  }

  setContextActionProofRecorder(
    recorder: ((
      action: string,
      stage: 'requested' | 'acknowledged' | 'observed',
    ) => void) | null,
  ): void {
    this.contextActionProofRecorder = recorder;
  }

  protected handleIdleAppServerNotification(notification: AppServerNotification): void {
    if (notification.method !== 'thread/compacted') return;
    const threadId = notification.params['threadId'];
    if (typeof threadId !== 'string' || threadId !== this.getAppServerThreadId()) return;
    this.contextDiagnostics?.recordCompactionObserved();
    this.handleObservedThreadCompaction(threadId);
  }

  protected handleObservedThreadCompaction(threadId: string): void {
    logger.info('Thread compacted by Codex app-server', { threadId });
    this.contextCostController.recordCompactionObserved(this.cumulativeTokensUsed);
    this.lastTurnTokens = 0;
    const events = buildObservedCompactionEvents({
      contextWindow: this.resolveContextWindow(),
      cumulativeTokens: this.cumulativeTokensUsed,
      costEstimate: this.cumulativeCostUsd,
    });
    this.emit('output', events.output);
    this.emit('context', events.context);
  }

  async spawn(): Promise<number> {
    if (this.isSpawned) throw new Error('Adapter already spawned');

    const status = await this.checkStatus();
    if (!status.available) throw new Error(status.error || 'Codex CLI is unavailable');

    const appServerAvailable =
      Boolean(status.metadata?.['appServerAvailable']) && !this.isHardenedModeConfigured();
    if (this.cliConfig.mcpServersConfigToml) {
      this.prepareCodexHome('exec');
    } else if (!this.config.env?.['CODEX_HOME']) {
      this.prepareCodexHome(appServerAvailable ? 'app-server' : 'exec');
    }

    if (appServerAvailable) {
      const initBudgetMs =
        CODEX_TIMEOUTS.APP_SERVER_INIT_MS * getClampedLoadWatchdogMultiplier();
      const initEpoch = ++this.appServerInitEpoch;
      let initBudgetTimer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          this.initAppServerMode(initEpoch),
          new Promise<never>((_, reject) => {
            initBudgetTimer = setTimeout(
              () => reject(new Error(
                `Codex app-server initialization timed out after ${Math.round(initBudgetMs / 1000)}s`,
              )),
              initBudgetMs,
            );
            initBudgetTimer.unref?.();
          }),
        ]);
        this.useAppServer = true;
        this.setSpawnMode('app-server');
        logger.info('Codex adapter using app-server mode');
      } catch (error) {
        this.appServerInitEpoch++;
        const reason = error instanceof Error ? error.message : String(error);
        logger.warn('App-server initialization failed, falling back to exec mode', {
          reason,
          isTimeout: reason.includes('timed out'),
        });
        this.useAppServer = false;
        this.setSpawnMode('subprocess-exec', { reason, degraded: true });
        if (this.preparedHomeKind === 'app-server' || !this.config.env?.['CODEX_HOME']) {
          this.prepareCodexHome('exec');
        }
      } finally {
        if (initBudgetTimer) clearTimeout(initBudgetTimer);
      }
    } else {
      this.useAppServer = false;
      if (this.preparedHomeKind === 'app-server' || !this.config.env?.['CODEX_HOME']) {
        this.prepareCodexHome('exec');
      }
      this.setSpawnMode('subprocess-exec');
      logger.info('Codex adapter using exec mode (app-server not available)');
    }

    this.isSpawned = true;
    const fakePid = this.getAppServerClient()
      ? (this.appServerRuntime.getPid()
        ?? this.appServerClient?.getPid()
        ?? Math.floor(Math.random() * 100000) + 10000)
      : Math.floor(Math.random() * 100000) + 10000;
    this.emit('spawned', fakePid);
    this.emit('status', 'idle' as InstanceStatus);
    return fakePid;
  }

  protected getAppServerClient(): CodexAppServerRuntimeClient | null {
    return this.appServerRuntime.getClient() ?? this.appServerClient;
  }

  protected getAppServerThreadId(): string | null {
    return this.appServerRuntime.getThreadId() ?? this.appServerThreadId;
  }

  protected ensureAppServerRuntimeAttached(): void {
    if (this.appServerRuntime.getClient()) return;
    if (!this.appServerClient || !this.appServerThreadId) {
      throw new Error('App-server not initialized');
    }
    this.appServerRuntime.attach(this.appServerClient, {
      threadId: this.appServerThreadId,
      resumeCursor: this.resumeCursor,
      resumeProof: this.lastResumeAttemptResult,
    });
  }

  protected async connectAppServer(cwd: string): Promise<AppServerClient> {
    const { connectToAppServer } = await import('./codex/app-server-client');
    return connectToAppServer(cwd, this.config.env?.['CODEX_HOME']
      ? {
          env: { ...getSafeEnvForTrustedProcess(), ...this.config.env },
          disableBroker: true,
        }
      : {});
  }

  protected mapSandboxMode(): 'read-only' | 'workspace-write' | 'danger-full-access' {
    if (this.cliConfig.approvalMode === 'full-auto') return 'danger-full-access';
    return this.cliConfig.sandboxMode || 'read-only';
  }

  protected async prepareAttachmentsForAppServer(
    message: string,
    attachments: FileAttachment[],
  ): Promise<{ input: UserInput[]; text: string }> {
    if (attachments.length === 0) return { input: [], text: message };
    const workingDirectory = this.cliConfig.workingDir || process.cwd();
    const processed = await processAttachments(
      attachments,
      this.sessionId || generateId(),
      workingDirectory,
    );
    if (processed.length === 0) return { input: [], text: message };

    const imageInputs: UserInput[] = processed
      .filter((attachment) => attachment.isImage && supportsCodexInlineImage(attachment.mimeType))
      .map((attachment) => ({ type: 'localImage', path: attachment.filePath }));
    const fileAttachments = processed.filter(
      (attachment) => !attachment.isImage || !supportsCodexInlineImage(attachment.mimeType),
    );
    return {
      input: imageInputs,
      text: fileAttachments.length > 0
        ? buildMessageWithFiles(message, fileAttachments)
        : message,
    };
  }

  protected async reopenAppServerThread(): Promise<void> {
    if (!this.appServerClient) {
      throw new Error('Cannot reopen thread: app-server client is not connected');
    }
    const cwd = this.cliConfig.workingDir || process.cwd();
    const startResult = await startThreadWithRetry(this.appServerClient, {
      cwd,
      model: this.cliConfig.model || null,
      approvalPolicy: 'never',
      sandbox: this.mapSandboxMode(),
      serviceName: SERVICE_NAME,
      ephemeral: this.cliConfig.ephemeral ?? false,
      serviceTier: this.cliConfig.fastMode ? 'priority' : null,
    });
    const newThreadId = startResult.threadId || startResult.thread?.id || null;
    if (!newThreadId) {
      throw new Error('Thread reopen failed: app-server returned no thread id');
    }
    logger.info('App-server thread reopened after loss', {
      previousThreadId: this.appServerThreadId,
      newThreadId,
    });
    const nextResumeCursor: ResumeCursor = {
      provider: 'openai',
      threadId: newThreadId,
      workspacePath: cwd,
      capturedAt: Date.now(),
      scanSource: 'native',
    };
    if (this.appServerRuntime.getClient()) {
      this.appServerRuntime.replaceBinding({
        threadId: newThreadId,
        resumeCursor: nextResumeCursor,
        resumeProof: this.lastResumeAttemptResult,
      });
    }
    this.appServerThreadId = newThreadId;
    this.sessionId = newThreadId;
    this.resumeCursor = nextResumeCursor;
    this.systemPromptSent = false;
    this.rtkAwarenessSent = false;
  }

  protected async appServerSendMessage(
    message: string,
    attachments?: FileAttachment[],
  ): Promise<void> {
    try {
      await this.appServerSendMessageInner(message, attachments);
    } catch (error) {
      if (isCodexInputTooLargeError(error)) {
        logger.warn('Codex app-server turn exceeded per-turn input char cap; recovering', {
          threadId: this.appServerThreadId,
          cause: error instanceof Error ? error.message : String(error),
        });
        await recoverFromInputCap({
          send: () => this.appServerSendMessageInner(message, attachments),
          compact: () => this.compactContext(),
          reopenThread: () => this.reopenAppServerThread(),
          onThreadReset: () => this.emit('output', {
            id: generateId(),
            timestamp: Date.now(),
            type: 'system',
            content:
              'The conversation exceeded Codex’s per-turn size limit and could not be compacted, so a fresh Codex thread was started. Earlier context from this thread was cleared.',
            metadata: { threadReset: true, reason: 'per-turn-input-cap' },
          }),
        });
        return;
      }
      if (!isRecoverableThreadResumeError(error)) throw error;
      logger.warn('Codex app-server thread became unavailable; refusing context-empty retry', {
        threadId: this.appServerThreadId,
        cause: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      this.clearPendingContextCost();
    }
  }

  protected override async sendInputImpl(
    message: string,
    attachments?: FileAttachment[],
  ): Promise<void> {
    if (!this.isSpawned) throw new Error('Adapter not spawned - call spawn() first');
    this.emit('status', 'busy' as InstanceStatus);

    try {
      if (this.useAppServer && this.getAppServerClient()) {
        await this.appServerSendMessage(message, attachments);
      } else {
        await this.execSendMessage(message, attachments);
      }
      this.emit('status', 'idle' as InstanceStatus);
    } catch (error) {
      const errorText = error instanceof Error ? error.message : String(error);
      this.emit('output', {
        id: generateId(),
        timestamp: Date.now(),
        type: 'error',
        content: `Codex error: ${errorText}`,
      });
      const recoverable =
        !this.useAppServer ||
        isProviderNotice(errorText) ||
        this.isRecoverableTurnError(error);
      this.emit('status', (recoverable ? 'idle' : 'error') as InstanceStatus);
      throw error;
    }
  }

  override isRunning(): boolean {
    if (!this.useAppServer) return super.isRunning();
    const runtimeClient = this.appServerRuntime.getClient();
    return this.isSpawned && (runtimeClient
      ? this.appServerRuntime.isRunning()
      : (this.appServerClient?.isRunning() ?? false));
  }

  override getPid(): number | null {
    if (!this.useAppServer) return super.getPid();
    return this.appServerRuntime.getClient()
      ? this.appServerRuntime.getPid()
      : this.appServerClient?.isRunning()
        ? this.appServerClient.getPid() ?? null
        : null;
  }

  override interrupt(): InterruptResult {
    if (this.useAppServer && this.appServerRuntime.getClient()) {
      return this.appServerRuntime.interrupt();
    }
    return super.interrupt();
  }

  override async terminate(graceful = true): Promise<void> {
    this.isSpawned = false;
    this.useAppServer = false;
    if (this.appServerRuntime.getClient()) {
      try { await this.appServerRuntime.close(); } catch { /* best effort */ }
    } else if (this.appServerClient) {
      try { await this.appServerClient.close(); } catch { /* best effort */ }
    }
    this.appServerClient = null;
    this.appServerThreadId = null;
    this.cleanupCodexHome();
    await super.terminate(graceful);
  }

  isAppServerMode(): boolean {
    return this.useAppServer;
  }

  override getAdapterCapabilities(): AdapterCapabilities {
    const resident = this.useAppServer;
    return {
      residentSession: resident,
      liveInterrupt: resident,
      liveSteer: resident,
    };
  }

  override getRuntimeCapabilities(): AdapterRuntimeCapabilities {
    return {
      supportsResume: this.supportsNativeResume(),
      supportsForkSession: false,
      supportsNativeCompaction: this.useAppServer,
      selfManagedAutoCompaction: this.useAppServer,
      supportsPermissionPrompts: false,
      supportsDeferPermission: false,
    };
  }

  override getContextCapabilities(): ProviderContextCapabilities {
    if (this.useAppServer) {
      return {
        toolResultControl: 'post-retention',
        toolResultVisibility: 'full',
        transcriptControl: 'native-compaction',
        occupancyReporting: 'current',
        cumulativeReporting: 'available',
        interruptProof: 'observed',
        compactionProof: 'observed',
        sameThreadContinuation: true,
      };
    }
    return {
      toolResultControl: 'post-retention',
      toolResultVisibility: 'full',
      transcriptControl: 'none',
      occupancyReporting: 'aggregate-only',
      cumulativeReporting: 'available',
      interruptProof: 'none',
      compactionProof: 'none',
      sameThreadContinuation: false,
    };
  }

  override getLastContextUsage(): ContextUsageObservation {
    if (!this.useAppServer) return { status: 'unknown', reason: 'aggregate-only' };
    if (!Number.isFinite(this.lastTurnTokens) || this.lastTurnTokens < 0) {
      return { status: 'unknown', reason: 'invalid-sample' };
    }
    if (this.lastTurnTokens === 0) return { status: 'unknown', reason: 'not-reported' };
    const total = this.resolveContextWindow();
    if (!Number.isFinite(total) || total <= 0) {
      return { status: 'unknown', reason: 'invalid-sample' };
    }
    return { status: 'known', used: this.lastTurnTokens, total, source: 'provider-turn' };
  }

  getResumeCursor(): ResumeCursor | null {
    return this.appServerRuntime.getClient()
      ? this.appServerRuntime.getSnapshot().resumeCursor
      : this.resumeCursor;
  }

  override getRuntimeSnapshot(): ProviderRuntimeSnapshot {
    if (this.appServerRuntime.getClient()) return this.appServerRuntime.getSnapshot();
    return {
      ...super.getRuntimeSnapshot(),
      nativeThreadId: this.appServerThreadId,
      activeTurnId: null,
      connectionPhase: this.useAppServer ? 'detached' : 'exec',
      turnPhase: 'idle',
      resumeCursor: this.resumeCursor ? { ...this.resumeCursor } : null,
      resumeProof: this.lastResumeAttemptResult ? { ...this.lastResumeAttemptResult } : null,
    };
  }

  getResumeAttemptResult(): ResumeAttemptResult | null {
    return this.appServerRuntime.getClient()
      ? this.appServerRuntime.getSnapshot().resumeProof
      : this.lastResumeAttemptResult;
  }

  getCurrentTurnId(): string | null {
    return this.appServerRuntime.getCurrentTurnId();
  }

  protected handleAppServerRuntimeExit(error: Error | null): void {
    this.useAppServer = false;
    this.setSpawnMode(
      'unknown',
      error ? { reason: error.message, degraded: true } : undefined,
    );
  }

  private isRecoverableTurnError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    if (isCodexInputTooLargeError(message) || /per-turn size limit/i.test(message)) {
      return true;
    }
    return planCodexAppServerRecovery(error).keepInstanceUsable;
  }

  protected abstract appServerSendMessageInner(
    message: string,
    attachments?: FileAttachment[],
    costRecoveryCount?: number,
  ): Promise<void>;
}
