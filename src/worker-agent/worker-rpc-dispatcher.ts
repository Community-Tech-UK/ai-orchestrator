import type { FileAttachment } from '../shared/types/instance.types';
import { handleAuxiliaryModelList, handleAuxiliaryModelGenerate, handleAudioTranscribe } from './worker-auxiliary-rpc';
import { ZodError } from 'zod/v4';
import type {
  FsReadDirectoryParams,
  FsReadFileParams,
  FsReadFileChunkParams,
  FsSearchParams,
  FsStatParams,
  FsUnwatchParams,
  FsWatchParams,
  FsWriteFileParams,
  FsWriteFileChunkParams
} from '../shared/types/remote-fs.types';
import type {
  SyncApplyDeltaParams,
  SyncBlockSigParams,
  SyncComputeDeltaParams,
  SyncDeleteFileParams,
  SyncScanParams
} from '../shared/types/sync.types';
import {
  COORDINATOR_TO_NODE,
  RPC_ERROR_CODES
} from '../main/remote-node/worker-node-rpc';
import {
  AuxiliaryModelListParamsSchema,
  AuxiliaryModelGenerateParamsSchema,
  AudioTranscribeParamsSchema,
  ConfigUpdateParamsSchema,
  InstanceSpawnParamsSchema,
  InstanceChangeModelParamsSchema,
  NodeKeepAwakeParamsSchema,
  LocalModelSessionIdParamsSchema,
  LocalModelSessionSendInputParamsSchema,
  LocalModelSessionStartParamsSchema,
  LocalAiHealthCheckParamsSchema,
  LocalAiHealthCheckResultSchema,
  LocalAiHealthDiagnoseParamsSchema,
  LocalAiHealthDiagnoseResultSchema,
  LocalAiHealthRepairParamsSchema,
  LocalAiHealthRepairResultSchema,
  StreamAckParamsSchema,
  StreamResumeParamsSchema,
} from '../main/remote-node/rpc-schemas';
import type { LocalModelSessionManager } from './local-model-session-manager';
import type {
  WorkerNodeAndroidAutomationSummary,
  WorkerNodeBrowserAutomationSummary,
  WorkerNodeExtensionRelaySummary,
  WorkerNodeFileTransferSummary,
} from '../shared/types/worker-node.types';
import {
  FsRpcError,
  type NodeFilesystemHandler
} from '../main/remote-node/node-filesystem-handler';
import { createServiceManager } from './service/manager-factory';
import type {
  LocalInstanceManager,
  SpawnParams
} from './local-instance-manager';
import {
  diagnoseProviderRuntime,
  isDiagnosableProvider
} from './provider-runtime-diagnostics';
import type { SyncHandler } from './sync-handler';
import type {
  WorkerAndroidAutomationConfig,
  WorkerBrowserAutomationConfig,
  WorkerConfig,
  WorkerExtensionRelayConfig,
  WorkerFileTransferConfig,
} from './worker-config';
import type { WorkerCdpTunnel } from './worker-cdp-tunnel';
import {
  BrowserCdpOpenParamsSchema,
  BrowserCdpSendParamsSchema,
  BrowserCdpCloseParamsSchema,
  BrowserStopManagedParamsSchema,
  BrowserExtensionRecoverParamsSchema,
  BrowserExtensionRecoverResultSchema,
  NodeExecParamsSchema,
  NodeExecResultSchema,
  type BrowserExtensionRecoverResult,
  type NodeExecParams,
  type NodeExecResult,
} from '../main/remote-node/rpc-schemas';
import type { WorkerTerminalHandler } from './worker-terminal-handler';
import type { RpcMessage } from './worker-rpc-types';
import { validateScope } from './worker-rpc-types';
import { WorkerLocalAiHealth } from './worker-local-ai-health';
import { parseBoundedServiceRpcResponse } from '../main/remote-node/worker-node-connection-helpers';
import { NodeExecInvalidParamsError, WorkerNodeExecutor } from './worker-node-executor';
import { configuredNodeExecRoots } from './worker-node-exec-policy';
import { validateWorkerAccountRoute } from './worker-account-route';
import { InstanceSendRawParamsSchema } from '../main/remote-node/instance-interaction-schemas';
import { InstanceSampleStallProcessParamsSchema, StallProcessFactsSchema } from '../main/remote-node/stall-process-rpc';
import { NodeKeepAwakeResultSchema } from '../main/remote-node/keep-awake-rpc';
import { WorkerModelChangeError } from './worker-instance-model-change';

interface WorkerRpcDispatcherDeps {
  config: WorkerConfig;
  instanceManager: LocalInstanceManager;
  setKeepAwake?: (enabled: boolean) => Promise<{ active: boolean }>;
  localModelSessionManager?: LocalModelSessionManager;
  getFilesystemHandler: () => NodeFilesystemHandler;
  getSyncHandler: () => SyncHandler;
  getTerminalHandler: () => WorkerTerminalHandler;
  applyConfigUpdate: (update: {
    browserAutomation?: WorkerBrowserAutomationConfig;
    androidAutomation?: WorkerAndroidAutomationConfig;
    extensionRelay?: WorkerExtensionRelayConfig;
    fileTransfer?: WorkerFileTransferConfig;
  }) => Promise<{
    browserAutomation?: WorkerNodeBrowserAutomationSummary;
    androidAutomation?: WorkerNodeAndroidAutomationSummary;
    extensionRelay?: WorkerNodeExtensionRelaySummary;
    fileTransfer?: WorkerNodeFileTransferSummary;
  }>;
  getCdpTunnel: () => WorkerCdpTunnel;
  stopManagedBrowser: () => Promise<void>;
  executeNodeCommand?: (params: NodeExecParams) => Promise<NodeExecResult>;
  recoverExtensionRelay?: () => Promise<BrowserExtensionRecoverResult>;
  sendResult: (id: string | number, result: unknown) => void;
  /** WS15 — durable-stream replay/ack (absent only in stripped-down tests). */
  replayDurableEvents?: (cursors: { instanceId: string; afterSeq: number }[]) =>
    { instanceId: string; replayed: number; gapThroughSeq?: number }[];
  ackDurableEvents?: (cursors: { instanceId: string; seq: number }[]) => void;
  sendError: (id: string | number, code: number, message: string) => void;
  localAiHealth?: Pick<WorkerLocalAiHealth, 'check' | 'diagnose' | 'repair'>;
}

export class WorkerRpcDispatcher {
  private readonly localAiHealth: Pick<WorkerLocalAiHealth, 'check' | 'diagnose' | 'repair'>;
  private readonly executeNodeCommand: (params: NodeExecParams) => Promise<NodeExecResult>;

  constructor(private readonly deps: WorkerRpcDispatcherDeps) {
    this.localAiHealth = deps.localAiHealth ?? new WorkerLocalAiHealth();
    const nodeExecutor = new WorkerNodeExecutor(() => configuredNodeExecRoots(deps.config));
    this.executeNodeCommand = deps.executeNodeCommand ?? ((params) => nodeExecutor.execute(params));
  }

  handleRpcNotification(msg: RpcMessage): void {
    const err = validateScope(msg, 'service');
    if (err) {
      return;
    }

    const params = (msg.params ?? {}) as Record<string, unknown>;
    try {
      switch (msg.method) {
        case COORDINATOR_TO_NODE.BROWSER_CDP_SEND: {
          const validated = BrowserCdpSendParamsSchema.parse(params);
          this.deps.getCdpTunnel().send(validated.sessionId, validated.frame);
          break;
        }
        case COORDINATOR_TO_NODE.BROWSER_CDP_CLOSE: {
          const validated = BrowserCdpCloseParamsSchema.parse(params);
          this.deps.getCdpTunnel().close(validated.sessionId);
          break;
        }
        case COORDINATOR_TO_NODE.STREAM_ACK: {
          const cursors = StreamAckParamsSchema.parse(params).cursors;
          this.deps.ackDurableEvents?.(cursors);
          break;
        }
        default:
          break;
      }
    } catch {
      // Notifications have no response channel; invalid frames are dropped.
    }
  }

  async handleRpcRequest(msg: RpcMessage): Promise<void> {
    const params = (msg.params ?? {}) as Record<string, unknown>;

    try {
      let result: unknown;
      switch (msg.method) {
        case COORDINATOR_TO_NODE.STREAM_RESUME: {
          const cursors = StreamResumeParamsSchema.parse(params).cursors;
          result = { cursors: this.deps.replayDurableEvents?.(cursors) ?? [] };
          break;
        }
        case COORDINATOR_TO_NODE.INSTANCE_SPAWN: {
          const validated = InstanceSpawnParamsSchema.parse(params);
          if (validated.accountRoute !== undefined) {
            try {
              validateWorkerAccountRoute(validated.cliType, validated.accountRoute);
            } catch (error) {
              this.deps.sendError(msg.id!, RPC_ERROR_CODES.INVALID_PARAMS,
                error instanceof Error ? error.message : 'Invalid account route.');
              return;
            }
          }
          await this.deps.instanceManager.spawn(validated as SpawnParams);
          result = { instanceId: validated.instanceId };
          break;
        }
        case COORDINATOR_TO_NODE.INSTANCE_SEND_RAW: {
          const validated = InstanceSendRawParamsSchema.parse(params);
          await this.deps.instanceManager.sendRaw(validated.instanceId, validated.response, validated.permissionKey);
          result = { ok: true };
          break;
        }
        case COORDINATOR_TO_NODE.INSTANCE_CHANGE_MODEL: {
          const validated = InstanceChangeModelParamsSchema.parse(params);
          await this.deps.instanceManager.changeModel(validated.previousInstanceId, validated.replacement as SpawnParams);
          result = { instanceId: validated.replacement.instanceId };
          break;
        }
        case COORDINATOR_TO_NODE.INSTANCE_SAMPLE_STALL_PROCESS: {
          const validated = InstanceSampleStallProcessParamsSchema.parse(params);
          result = StallProcessFactsSchema.nullable().parse(
            await this.deps.instanceManager.sampleStallProcessFacts(validated.instanceId, validated.silenceMs));
          break;
        }
        case COORDINATOR_TO_NODE.NODE_KEEP_AWAKE: {
          if (!this.hasServiceScope(msg)) return;
          const validated = NodeKeepAwakeParamsSchema.parse(params);
          if (!this.deps.setKeepAwake) throw new Error('Worker keep-awake is unavailable.');
          result = NodeKeepAwakeResultSchema.parse(await this.deps.setKeepAwake(validated.enabled));
          break;
        }
        case COORDINATOR_TO_NODE.INSTANCE_SEND_INPUT: {
          const attachments = params['attachments'] as
            | FileAttachment[]
            | undefined;
          await this.deps.instanceManager.sendInput(
            params['instanceId'] as string,
            params['message'] as string,
            attachments,
            params['nativeCommandId'] as string | undefined,
          );
          result = { ok: true };
          break;
        }
        case COORDINATOR_TO_NODE.INSTANCE_TERMINATE:
          await this.deps.instanceManager.terminate(params['instanceId'] as string);
          result = { ok: true };
          break;
        case COORDINATOR_TO_NODE.INSTANCE_INTERRUPT:
          await this.deps.instanceManager.interrupt(params['instanceId'] as string);
          result = { ok: true };
          break;
        case COORDINATOR_TO_NODE.INSTANCE_HIBERNATE:
          await this.deps.instanceManager.hibernate(params['instanceId'] as string);
          result = { ok: true };
          break;
        case COORDINATOR_TO_NODE.INSTANCE_WAKE:
          await this.deps.instanceManager.wake(params['instanceId'] as string);
          result = { ok: true };
          break;
        case COORDINATOR_TO_NODE.LOCAL_MODEL_SESSION_START: {
          const validated = LocalModelSessionStartParamsSchema.parse(params);
          result = await this.requireLocalModelSessionManager().start(validated);
          break;
        }
        case COORDINATOR_TO_NODE.LOCAL_MODEL_SESSION_SEND_INPUT: {
          const validated = LocalModelSessionSendInputParamsSchema.parse(params);
          await this.requireLocalModelSessionManager().sendInput(validated);
          result = { ok: true };
          break;
        }
        case COORDINATOR_TO_NODE.LOCAL_MODEL_SESSION_TERMINATE: {
          const validated = LocalModelSessionIdParamsSchema.parse(params);
          await this.requireLocalModelSessionManager().terminate(validated);
          result = { ok: true };
          break;
        }
        case COORDINATOR_TO_NODE.LOCAL_MODEL_SESSION_INTERRUPT: {
          const validated = LocalModelSessionIdParamsSchema.parse(params);
          result = await this.requireLocalModelSessionManager().interrupt(validated);
          break;
        }
        case COORDINATOR_TO_NODE.NODE_PING:
          result = { pong: Date.now() };
          break;
        case COORDINATOR_TO_NODE.NODE_EXEC: {
          if (!this.hasServiceScope(msg)) return;
          const validated = NodeExecParamsSchema.parse(params);
          result = NodeExecResultSchema.parse(await this.executeNodeCommand(validated));
          break;
        }
        case COORDINATOR_TO_NODE.TERMINAL_CREATE:
          result = this.deps.getTerminalHandler().create({
            sessionId: params['sessionId'] as string,
            cwd: params['cwd'] as string,
            shell: params['shell'] as string | undefined,
            env: params['env'] as Record<string, string> | undefined,
            cols: params['cols'] as number | undefined,
            rows: params['rows'] as number | undefined
          });
          break;
        case COORDINATOR_TO_NODE.TERMINAL_INPUT:
          this.deps.getTerminalHandler().input(
            params['sessionId'] as string,
            params['data'] as string
          );
          result = { ok: true };
          break;
        case COORDINATOR_TO_NODE.TERMINAL_RESIZE:
          this.deps.getTerminalHandler().resize(
            params['sessionId'] as string,
            params['cols'] as number,
            params['rows'] as number
          );
          result = { ok: true };
          break;
        case COORDINATOR_TO_NODE.TERMINAL_KILL:
          this.deps.getTerminalHandler().kill(
            params['sessionId'] as string,
            params['signal'] as string | undefined
          );
          result = { ok: true };
          break;
        case COORDINATOR_TO_NODE.FS_READ_DIRECTORY:
          result = await this.deps.getFilesystemHandler().readDirectory(
            params as unknown as FsReadDirectoryParams
          );
          break;
        case COORDINATOR_TO_NODE.FS_STAT:
          result = await this.deps.getFilesystemHandler().stat(
            params as unknown as FsStatParams
          );
          break;
        case COORDINATOR_TO_NODE.FS_SEARCH:
          result = await this.deps.getFilesystemHandler().search(
            params as unknown as FsSearchParams
          );
          break;
        case COORDINATOR_TO_NODE.FS_WATCH:
          result = await this.deps.getFilesystemHandler().watch(
            params as unknown as FsWatchParams
          );
          break;
        case COORDINATOR_TO_NODE.FS_UNWATCH:
          await this.deps.getFilesystemHandler().unwatch(
            params as unknown as FsUnwatchParams
          );
          result = { ok: true };
          break;
        case COORDINATOR_TO_NODE.FS_READ_FILE:
          result = await this.deps.getFilesystemHandler().readFile(
            params as unknown as FsReadFileParams
          );
          break;
        case COORDINATOR_TO_NODE.FS_WRITE_FILE:
          result = await this.deps.getFilesystemHandler().writeFile(
            params as unknown as FsWriteFileParams
          );
          break;
        case COORDINATOR_TO_NODE.FS_READ_FILE_CHUNK:
          result = await this.deps.getFilesystemHandler().readFileChunk(
            params as unknown as FsReadFileChunkParams
          );
          break;
        case COORDINATOR_TO_NODE.FS_WRITE_FILE_CHUNK:
          result = await this.deps.getFilesystemHandler().writeFileChunk(
            params as unknown as FsWriteFileChunkParams
          );
          break;
        case COORDINATOR_TO_NODE.SYNC_SCAN_DIRECTORY:
          result = await this.deps.getSyncHandler().scanDirectory(
            params as unknown as SyncScanParams
          );
          break;
        case COORDINATOR_TO_NODE.SYNC_GET_BLOCK_SIGNATURES:
          result = await this.deps.getSyncHandler().getBlockSignatures(
            params as unknown as SyncBlockSigParams
          );
          break;
        case COORDINATOR_TO_NODE.SYNC_COMPUTE_DELTA:
          result = await this.deps.getSyncHandler().computeDelta(
            params as unknown as SyncComputeDeltaParams
          );
          break;
        case COORDINATOR_TO_NODE.SYNC_APPLY_DELTA:
          result = await this.deps.getSyncHandler().applyDelta(
            params as unknown as SyncApplyDeltaParams
          );
          break;
        case COORDINATOR_TO_NODE.SYNC_DELETE_FILE:
          result = await this.deps.getSyncHandler().deleteFile(
            params as unknown as SyncDeleteFileParams
          );
          break;
        case COORDINATOR_TO_NODE.PROVIDER_DIAGNOSE: {
          if (!this.hasServiceScope(msg)) return;
          const provider = params['provider'];
          if (!isDiagnosableProvider(provider)) {
            this.deps.sendError(
              msg.id!,
              RPC_ERROR_CODES.INVALID_PARAMS,
              'provider.diagnose requires a concrete supported provider'
            );
            return;
          }
          result = await diagnoseProviderRuntime(provider);
          break;
        }
        case COORDINATOR_TO_NODE.SERVICE_STATUS: {
          const err = validateScope(msg, 'service');
          if (err) {
            this.deps.sendError(msg.id!, RPC_ERROR_CODES.UNAUTHORIZED, err);
            return;
          }
          const mgr = await createServiceManager();
          result = await mgr.status();
          break;
        }
        case COORDINATOR_TO_NODE.SERVICE_RESTART: {
          const err = validateScope(msg, 'service');
          if (err) {
            this.deps.sendError(msg.id!, RPC_ERROR_CODES.UNAUTHORIZED, err);
            return;
          }
          this.deps.sendResult(msg.id!, { scheduled: true });
          setTimeout(async () => {
            try {
              const mgr = await createServiceManager();
              await mgr.restart();
            } catch (e) {
              console.error('[WorkerAgent] service.restart failed', e);
            }
          }, 250);
          return;
        }
        case COORDINATOR_TO_NODE.SERVICE_STOP: {
          const err = validateScope(msg, 'service');
          if (err) {
            this.deps.sendError(msg.id!, RPC_ERROR_CODES.UNAUTHORIZED, err);
            return;
          }
          this.deps.sendResult(msg.id!, { scheduled: true });
          setTimeout(async () => {
            try {
              const mgr = await createServiceManager();
              await mgr.stop();
            } catch (e) {
              console.error('[WorkerAgent] service.stop failed', e);
            }
          }, 250);
          return;
        }
        case COORDINATOR_TO_NODE.SERVICE_UNINSTALL: {
          const err = validateScope(msg, 'service');
          if (err) {
            this.deps.sendError(msg.id!, RPC_ERROR_CODES.UNAUTHORIZED, err);
            return;
          }
          this.deps.sendResult(msg.id!, { scheduled: true });
          setTimeout(async () => {
            try {
              const mgr = await createServiceManager();
              await mgr.uninstall();
            } catch (e) {
              console.error('[WorkerAgent] service.uninstall failed', e);
            }
          }, 250);
          return;
        }
        case COORDINATOR_TO_NODE.CONFIG_UPDATE: {
          // Privileged: turning on browser or Android automation enables an
          // ungoverned automation surface, so require service-level scope.
          if (!this.hasServiceScope(msg)) return;
          const validated = ConfigUpdateParamsSchema.parse(params);
          const summary = await this.deps.applyConfigUpdate({
            browserAutomation: validated.browserAutomation,
            androidAutomation: validated.androidAutomation,
            extensionRelay: validated.extensionRelay,
            fileTransfer: validated.fileTransfer,
          });
          result = summary;
          break;
        }
        case COORDINATOR_TO_NODE.BROWSER_CDP_OPEN: {
          const err = validateScope(msg, 'service');
          if (err) {
            this.deps.sendError(msg.id!, RPC_ERROR_CODES.UNAUTHORIZED, err);
            return;
          }
          const validated = BrowserCdpOpenParamsSchema.parse(params);
          await this.deps.getCdpTunnel().open(validated.sessionId);
          result = { ok: true };
          break;
        }
        case COORDINATOR_TO_NODE.BROWSER_CDP_SEND: {
          const err = validateScope(msg, 'service');
          if (err) {
            this.deps.sendError(msg.id!, RPC_ERROR_CODES.UNAUTHORIZED, err);
            return;
          }
          const validated = BrowserCdpSendParamsSchema.parse(params);
          this.deps.getCdpTunnel().send(validated.sessionId, validated.frame);
          result = { ok: true };
          break;
        }
        case COORDINATOR_TO_NODE.BROWSER_CDP_CLOSE: {
          const err = validateScope(msg, 'service');
          if (err) {
            this.deps.sendError(msg.id!, RPC_ERROR_CODES.UNAUTHORIZED, err);
            return;
          }
          const validated = BrowserCdpCloseParamsSchema.parse(params);
          this.deps.getCdpTunnel().close(validated.sessionId);
          result = { ok: true };
          break;
        }
        case COORDINATOR_TO_NODE.BROWSER_STOP_MANAGED: {
          if (!this.hasServiceScope(msg)) return;
          BrowserStopManagedParamsSchema.parse(params);
          await this.deps.stopManagedBrowser();
          result = { ok: true };
          break;
        }
        case COORDINATOR_TO_NODE.BROWSER_EXTENSION_RECOVER: {
          if (!this.hasServiceScope(msg)) return;
          BrowserExtensionRecoverParamsSchema.parse(params);
          if (!this.deps.recoverExtensionRelay) {
            throw new Error('Browser extension relay recovery is unavailable on this worker');
          }
          result = BrowserExtensionRecoverResultSchema.parse(await this.deps.recoverExtensionRelay());
          break;
        }
        case COORDINATOR_TO_NODE.AUXILIARY_MODEL_LIST: {
          const validated = AuxiliaryModelListParamsSchema.parse(params);
          const models = await handleAuxiliaryModelList(validated.provider);
          result = { models };
          break;
        }
        case COORDINATOR_TO_NODE.AUXILIARY_MODEL_GENERATE: {
          const validated = AuxiliaryModelGenerateParamsSchema.parse(params);
          const text = await handleAuxiliaryModelGenerate(validated);
          result = { text };
          break;
        }
        case COORDINATOR_TO_NODE.AUDIO_TRANSCRIBE: {
          const validated = AudioTranscribeParamsSchema.parse(params);
          const text = await handleAudioTranscribe(validated);
          result = { text };
          break;
        }
        case COORDINATOR_TO_NODE.LOCAL_AI_HEALTH_CHECK: {
          const err = validateScope(msg, 'service');
          if (err) {
            this.deps.sendError(msg.id!, RPC_ERROR_CODES.UNAUTHORIZED, err);
            return;
          }
          const validated = LocalAiHealthCheckParamsSchema.parse(params);
          result = parseBoundedServiceRpcResponse(
            LocalAiHealthCheckResultSchema,
            await this.localAiHealth.check(validated),
          );
          break;
        }
        case COORDINATOR_TO_NODE.LOCAL_AI_HEALTH_DIAGNOSE: {
          const err = validateScope(msg, 'service');
          if (err) {
            this.deps.sendError(msg.id!, RPC_ERROR_CODES.UNAUTHORIZED, err);
            return;
          }
          const validated = LocalAiHealthDiagnoseParamsSchema.parse(params);
          result = parseBoundedServiceRpcResponse(
            LocalAiHealthDiagnoseResultSchema,
            await this.localAiHealth.diagnose(validated),
          );
          break;
        }
        case COORDINATOR_TO_NODE.LOCAL_AI_HEALTH_REPAIR: {
          const err = validateScope(msg, 'service');
          if (err) {
            this.deps.sendError(msg.id!, RPC_ERROR_CODES.UNAUTHORIZED, err);
            return;
          }
          const validated = LocalAiHealthRepairParamsSchema.parse(params);
          result = parseBoundedServiceRpcResponse(
            LocalAiHealthRepairResultSchema,
            await this.localAiHealth.repair(validated),
          );
          break;
        }
        default:
          this.deps.sendError(
            msg.id!,
            RPC_ERROR_CODES.METHOD_NOT_FOUND,
            `Unknown method: ${msg.method}`
          );
          return;
      }
      this.deps.sendResult(msg.id!, result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.deps.sendError(msg.id!, this.getRpcErrorCode(msg.method, err), message);
    }
  }

  private getRpcErrorCode(method: string | undefined, err: unknown): number {
    if (err instanceof WorkerModelChangeError) {
      return err.previousRuntime === 'retained' ? RPC_ERROR_CODES.MODEL_CHANGE_REJECTED
        : err.previousRuntime === 'terminated' ? RPC_ERROR_CODES.MODEL_CHANGE_FAILED_AFTER_TEARDOWN : RPC_ERROR_CODES.INTERNAL_ERROR;
    }
    if (err instanceof Error && 'code' in err && err.code === 'INPUT_REQUIRED_NOT_PENDING') return RPC_ERROR_CODES.INPUT_REQUIRED_NOT_PENDING;
    if (err instanceof FsRpcError) {
      return RPC_ERROR_CODES.FILESYSTEM_ERROR;
    }
    if (err instanceof ZodError) {
      return RPC_ERROR_CODES.INVALID_PARAMS;
    }
    if (err instanceof NodeExecInvalidParamsError) {
      return RPC_ERROR_CODES.INVALID_PARAMS;
    }
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('Instance not found')) {
      return RPC_ERROR_CODES.INSTANCE_NOT_FOUND;
    }
    if (method === COORDINATOR_TO_NODE.INSTANCE_SPAWN) {
      return RPC_ERROR_CODES.SPAWN_FAILED;
    }
    return RPC_ERROR_CODES.INTERNAL_ERROR;
  }

  private hasServiceScope(msg: RpcMessage): boolean {
    const error = validateScope(msg, 'service');
    if (!error) return true;
    this.deps.sendError(msg.id!, RPC_ERROR_CODES.UNAUTHORIZED, error);
    return false;
  }

  private requireLocalModelSessionManager(): LocalModelSessionManager {
    if (!this.deps.localModelSessionManager) {
      throw new Error('Local model session manager is unavailable on this worker');
    }
    return this.deps.localModelSessionManager;
  }
}
