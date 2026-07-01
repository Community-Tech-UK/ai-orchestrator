import type { FileAttachment } from '../shared/types/instance.types';
import { DEFAULT_OLLAMA_KEEP_ALIVE } from '../shared/types/auxiliary-llm.types';
import { generateOpenAiCompatibleOnWorker } from './worker-auxiliary-generate';
import { OLLAMA_LOCAL_BASE_URL, LMSTUDIO_LOCAL_BASE_URL } from './local-model-config';
import { z, ZodError } from 'zod/v4';
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
  AudioTranscribeParamsSchema,
  ConfigUpdateParamsSchema,
} from '../main/remote-node/rpc-schemas';
import type {
  WorkerNodeAndroidAutomationSummary,
  WorkerNodeBrowserAutomationSummary,
  WorkerNodeExtensionRelaySummary,
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
} from './worker-config';
import type { WorkerCdpTunnel } from './worker-cdp-tunnel';
import {
  BrowserCdpOpenParamsSchema,
  BrowserCdpSendParamsSchema,
  BrowserCdpCloseParamsSchema,
  BrowserStopManagedParamsSchema,
} from '../main/remote-node/rpc-schemas';
import type { WorkerTerminalHandler } from './worker-terminal-handler';
import type { RpcMessage } from './worker-rpc-types';
import { validateScope } from './worker-rpc-types';

type AudioTranscribeParams = z.infer<typeof AudioTranscribeParamsSchema>;

interface WorkerRpcDispatcherDeps {
  config: WorkerConfig;
  instanceManager: LocalInstanceManager;
  getFilesystemHandler: () => NodeFilesystemHandler;
  getSyncHandler: () => SyncHandler;
  getTerminalHandler: () => WorkerTerminalHandler;
  applyConfigUpdate: (update: {
    browserAutomation?: WorkerBrowserAutomationConfig;
    androidAutomation?: WorkerAndroidAutomationConfig;
    extensionRelay?: WorkerExtensionRelayConfig;
  }) => Promise<{
    browserAutomation?: WorkerNodeBrowserAutomationSummary;
    androidAutomation?: WorkerNodeAndroidAutomationSummary;
    extensionRelay?: WorkerNodeExtensionRelaySummary;
  }>;
  getCdpTunnel: () => WorkerCdpTunnel;
  stopManagedBrowser: () => Promise<void>;
  sendResult: (id: string | number, result: unknown) => void;
  sendError: (id: string | number, code: number, message: string) => void;
}

export class WorkerRpcDispatcher {
  constructor(private readonly deps: WorkerRpcDispatcherDeps) {}

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
        case COORDINATOR_TO_NODE.INSTANCE_SPAWN:
          await this.deps.instanceManager.spawn(params as unknown as SpawnParams);
          result = { instanceId: params['instanceId'] };
          break;
        case COORDINATOR_TO_NODE.INSTANCE_SEND_INPUT: {
          const attachments = params['attachments'] as
            | FileAttachment[]
            | undefined;
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
        case COORDINATOR_TO_NODE.CONFIG_UPDATE: {
          // Privileged: turning on browser or Android automation enables an
          // ungoverned automation surface, so require service-level scope.
          const err = validateScope(msg, 'service');
          if (err) {
            this.deps.sendError(msg.id!, RPC_ERROR_CODES.UNAUTHORIZED, err);
            return;
          }
          const validated = ConfigUpdateParamsSchema.parse(params);
          const summary = await this.deps.applyConfigUpdate({
            browserAutomation: validated.browserAutomation,
            androidAutomation: validated.androidAutomation,
            extensionRelay: validated.extensionRelay,
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
          const err = validateScope(msg, 'service');
          if (err) {
            this.deps.sendError(msg.id!, RPC_ERROR_CODES.UNAUTHORIZED, err);
            return;
          }
          BrowserStopManagedParamsSchema.parse(params);
          await this.deps.stopManagedBrowser();
          result = { ok: true };
          break;
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
        case COORDINATOR_TO_NODE.AUDIO_TRANSCRIBE: {
          const validated = AudioTranscribeParamsSchema.parse(params);
          const text = await this.handleAudioTranscribe(validated);
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
      const resp = await fetch(`${OLLAMA_LOCAL_BASE_URL}/api/tags`, { method: 'GET' });
      if (!resp.ok) throw new Error(`Ollama list failed: ${resp.status}`);
      const data = await resp.json() as { models?: Array<{ name: string }> };
      return (data.models ?? []).map((m) => m.name);
    }
    if (provider === 'openai-compatible') {
      const resp = await fetch(`${LMSTUDIO_LOCAL_BASE_URL}/v1/models`, { method: 'GET' });
      if (!resp.ok) throw new Error(`OpenAI-compatible list failed: ${resp.status}`);
      const data = await resp.json() as { data?: Array<{ id: string }> };
      return (data.data ?? []).map((m) => m.id);
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
    numCtx?: number;
  }): Promise<string> {
    if (params.provider === 'ollama') {
      const controller = new AbortController();
      const tid = setTimeout(() => controller.abort(), params.timeoutMs);
      try {
        const resp = await fetch(`${OLLAMA_LOCAL_BASE_URL}/api/generate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: params.model,
            prompt: `${params.systemPrompt}\n\nUser: ${params.userPrompt}`,
            stream: false,
            keep_alive: DEFAULT_OLLAMA_KEEP_ALIVE,
            format: params.requireJson ? 'json' : undefined,
            options: {
              temperature: params.temperature,
              num_predict: params.maxOutputTokens,
              ...(params.numCtx ? { num_ctx: params.numCtx } : {}),
            },
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
    if (params.provider === 'openai-compatible') {
      return generateOpenAiCompatibleOnWorker(LMSTUDIO_LOCAL_BASE_URL, params);
    }
    throw new Error(`Unsupported provider: ${params.provider}`);
  }

  private async handleAudioTranscribe(params: AudioTranscribeParams): Promise<string> {
    if (params.provider !== 'openai-compatible') {
      throw new Error(`Unsupported audio transcription provider: ${params.provider}`);
    }

    const baseUrl = normalizeWorkerLocalBaseUrl(params.baseUrl);
    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), params.timeoutMs);
    try {
      const body = new FormData();
      body.append('file', new Blob([Buffer.from(params.audioBase64, 'base64')], {
        type: 'audio/wav',
      }), 'segment.wav');
      body.append('model', params.model);
      body.append('language', params.language);
      body.append('task', params.task);
      body.append('response_format', 'json');

      const response = await fetch(`${baseUrl}/v1/audio/transcriptions`, {
        method: 'POST',
        body,
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`audio.transcribe failed: ${response.status}`);
      }
      const data = await response.json() as { text?: unknown };
      if (typeof data.text !== 'string') {
        throw new Error('audio.transcribe response missing text');
      }
      return data.text;
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error(`audio.transcribe timed out after ${params.timeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(tid);
    }
  }

  private getRpcErrorCode(method: string | undefined, err: unknown): number {
    if (err instanceof FsRpcError) {
      return RPC_ERROR_CODES.FILESYSTEM_ERROR;
    }
    if (err instanceof ZodError) {
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
}

function normalizeWorkerLocalBaseUrl(raw: string): string {
  const url = new URL(raw);
  if (!['127.0.0.1', 'localhost', '::1'].includes(url.hostname)) {
    throw new Error('audio.transcribe baseUrl must be worker-local loopback.');
  }
  return url.toString().replace(/\/+$/, '');
}
