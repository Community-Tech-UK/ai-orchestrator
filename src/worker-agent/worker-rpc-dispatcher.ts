import type { FileAttachment } from '../shared/types/instance.types';
import type {
  FsReadDirectoryParams,
  FsReadFileParams,
  FsSearchParams,
  FsStatParams,
  FsUnwatchParams,
  FsWatchParams,
  FsWriteFileParams
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
} from '../main/remote-node/rpc-schemas';
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
import type { WorkerConfig } from './worker-config';
import type { WorkerTerminalHandler } from './worker-terminal-handler';
import type { RpcMessage } from './worker-rpc-types';
import { validateScope } from './worker-rpc-types';

interface WorkerRpcDispatcherDeps {
  config: WorkerConfig;
  instanceManager: LocalInstanceManager;
  getFilesystemHandler: () => NodeFilesystemHandler;
  getSyncHandler: () => SyncHandler;
  getTerminalHandler: () => WorkerTerminalHandler;
  sendResult: (id: string | number, result: unknown) => void;
  sendError: (id: string | number, code: number, message: string) => void;
}

export class WorkerRpcDispatcher {
  constructor(private readonly deps: WorkerRpcDispatcherDeps) {}

  async handleRpcRequest(msg: RpcMessage): Promise<void> {
    const params = (msg.params ?? {}) as Record<string, unknown>;

    try {
      let result: unknown;
      switch (msg.method) {
        case COORDINATOR_TO_NODE.INSTANCE_SPAWN:
          await this.deps.instanceManager.spawn(params as unknown as SpawnParams);
          result = { instanceId: params['instanceId'] };
          break;
        case COORDINATOR_TO_NODE.INSTANCE_SEND_INPUT: {
          const attachments = params['attachments'] as
            | FileAttachment[]
            | undefined;
          console.log('[WorkerAgent] INSTANCE_SEND_INPUT received', {
            instanceId: params['instanceId'],
            messageLength: (params['message'] as string)?.length,
            attachmentsCount: attachments?.length ?? 0,
            attachmentNames: attachments?.map((a) => a.name)
          });
          await this.deps.instanceManager.sendInput(
            params['instanceId'] as string,
            params['message'] as string,
            attachments
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
        case COORDINATOR_TO_NODE.NODE_PING:
          result = { pong: Date.now() };
          break;
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
          const err = validateScope(msg, 'service');
          if (err) {
            this.deps.sendError(msg.id!, RPC_ERROR_CODES.UNAUTHORIZED, err);
            return;
          }
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
        case COORDINATOR_TO_NODE.AUXILIARY_MODEL_LIST: {
          const validated = AuxiliaryModelListParamsSchema.parse(params);
          const models = await this.handleAuxiliaryModelList(validated.provider);
          result = { models };
          break;
        }
        case COORDINATOR_TO_NODE.AUXILIARY_MODEL_GENERATE: {
          const validated = AuxiliaryModelGenerateParamsSchema.parse(params);
          const text = await this.handleAuxiliaryModelGenerate(validated);
          result = { text };
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

  private async handleAuxiliaryModelList(provider: 'ollama' | 'openai-compatible'): Promise<string[]> {
    if (provider === 'ollama') {
      const resp = await fetch('http://127.0.0.1:11434/api/tags', { method: 'GET' });
      if (!resp.ok) throw new Error(`Ollama list failed: ${resp.status}`);
      const data = await resp.json() as { models?: Array<{ name: string }> };
      return (data.models ?? []).map((m) => m.name);
    }
    throw new Error(`Unsupported provider: ${provider}`);
  }

  private async handleAuxiliaryModelGenerate(params: {
    provider: string;
    model: string;
    systemPrompt: string;
    userPrompt: string;
    temperature: number;
    maxOutputTokens: number;
    timeoutMs: number;
    requireJson: boolean;
  }): Promise<string> {
    if (params.provider === 'ollama') {
      const controller = new AbortController();
      const tid = setTimeout(() => controller.abort(), params.timeoutMs);
      try {
        const resp = await fetch('http://127.0.0.1:11434/api/generate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: params.model,
            prompt: `${params.systemPrompt}\n\nUser: ${params.userPrompt}`,
            stream: false,
            format: params.requireJson ? 'json' : undefined,
            options: { temperature: params.temperature, num_predict: params.maxOutputTokens },
          }),
          signal: controller.signal,
        });
        if (!resp.ok) throw new Error(`Ollama generate failed: ${resp.status}`);
        const data = await resp.json() as { response: string };
        return data.response ?? '';
      } finally {
        clearTimeout(tid);
      }
    }
    throw new Error(`Unsupported provider: ${params.provider}`);
  }

  private getRpcErrorCode(method: string | undefined, err: unknown): number {
    if (err instanceof FsRpcError) {
      return RPC_ERROR_CODES.FILESYSTEM_ERROR;
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
}
