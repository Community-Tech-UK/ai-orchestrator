/**
 * Parent-side RPC server for the orchestrator-tools MCP surface. Thin stdio
 * forwarders in `aio-mcp` call this socket so native DB modules stay in the
 * Electron parent process.
 */

import * as fs from 'node:fs';
import * as net from 'node:net';
import { app } from 'electron';
import { registerCleanup as registerGlobalCleanup } from '../util/cleanup-registry';
import { getLogger } from '../logging/logger';
import { defaultDriverFactory } from '../db/better-sqlite3-driver';
import type { SqliteDriver } from '../db/sqlite-driver';
import { getConversationLedgerService, type ConversationLedgerService } from '../conversation-ledger';
import { createOperatorTables } from '../operator/operator-schema';
import { defaultOperatorDbPath } from '../operator/operator-database';
import {
  createOrchestratorToolDefinitions,
  CreateAutomationArgsSchema,
  DeleteAutomationArgsSchema,
  GitBatchPullArgsSchema,
  ListAutomationsArgsSchema,
  ListRemoteNodesArgsSchema,
  PostponeAutomationArgsSchema,
  ReadNodeOutputArgsSchema,
  TerminateNodeInstanceArgsSchema,
  RunOnNodeArgsSchema,
  UpdateAutomationArgsSchema,
  type CreateAutomationFn,
  type DeleteAutomationFn,
  type FileTransferToolContext,
  type ListAutomationsFn,
  type ListRemoteNodesFn,
  type OrchestratorToolRuntimeContext,
  type PostponeAutomationFn,
  type ReadInstanceOutputFn,
  type TerminateNodeInstancesFn,
  type SpawnRemoteInstanceFn,
  type UpdateAutomationFn,
} from './orchestrator-tools';
import type { GetDocReviewResultFn, RequestDocReviewFn } from './doc-review-tools';
import {
  SettingsPrivilegedGetPayloadSchema,
  SettingsPrivilegedListPayloadSchema,
  SettingsPrivilegedResetPayloadSchema,
  SettingsPrivilegedSetPayloadSchema,
  SettingsToolGetPayloadSchema,
  SettingsToolListPayloadSchema,
  SettingsToolResetPayloadSchema,
  SettingsToolSetPayloadSchema,
  SettingsToolUpdateNodeConfigPayloadSchema,
} from '@contracts/schemas/settings';
import type {
  SettingsChangeBroadcaster,
  SettingsManagerForTools,
  SettingsToolContext,
  UpdateNodeConfigFn,
} from './orchestrator-settings-tools';
import {
  privilegedGetSetting,
  privilegedListSettings,
  privilegedResetSetting,
  privilegedSetSetting,
} from './orchestrator-settings-tools';
import type { McpServerToolDefinition } from './mcp-server-tools';
import { createToolsetRegistry } from '../tools/toolsets';
import {
  FILE_TRANSFER_RPC_SPECS,
  FILE_TRANSFER_TOOL_NAMES,
} from './orchestrator-tools-rpc-file-transfer';
import type { OrchestratorEvidenceToolContext } from './orchestrator-evidence-tools';
import { EVIDENCE_RPC_SPECS } from './orchestrator-tools-rpc-evidence';
import { createOrchestratorToolsSocketPath } from './orchestrator-tools-socket-path';

const logger = getLogger('OrchestratorToolsRpcServer');

/** Per-surface tool scoping for spawn-depth defense-in-depth. */
const ORCHESTRATOR_TOOLSETS = createToolsetRegistry([
  { name: 'orchestrator-tools-full', tools: ['git_batch_pull', 'list_remote_nodes', 'run_on_node', 'read_node_output', ...FILE_TRANSFER_TOOL_NAMES, 'list_settings', 'get_setting', 'set_setting', 'reset_setting', 'update_node_config', 'create_automation', 'list_automations', 'delete_automation', 'update_automation', 'postpone_automation', 'request_doc_review', 'get_doc_review_result', 'evidence_list', 'evidence_search', 'evidence_read', 'evidence_compare', 'evidence_verify'] },
  { name: 'orchestrator-tools-leaf', includes: ['orchestrator-tools-full'], tools: ['!run_on_node'] },
]);

const DEFAULT_MAX_PAYLOAD_BYTES = 256 * 1024;
const MAX_RPC_ENVELOPE_BYTES = 16 * 1024;

interface OrchestratorToolsRpcRequest {
  jsonrpc?: '2.0';
  id?: number | string | null;
  method: string;
  params?: unknown;
}

interface OrchestratorToolsRpcParams {
  instanceId: string;
  payload: Record<string, unknown>;
}

export interface ReleaseMutationAuthorizationRequest {
  instanceId: string;
  method: 'orchestrator_tools.execute_android_play_release'
    | 'orchestrator_tools.execute_ios_asc_finalization';
  payload: Record<string, unknown>;
}

export interface OrchestratorToolsRpcServerOptions extends FileTransferToolContext {
  operatorDbPath?: string;
  userDataPath?: string;
  isKnownLocalInstance?: (instanceId: string) => boolean;
  registerCleanup?: (cleanup: () => void | Promise<void>) => void | (() => void);
  maxPayloadBytes?: number;
  rateLimit?: {
    maxRequests: number;
    windowMs: number;
  };
  /** Backs `list_remote_nodes`; injected to avoid importing remote-node singletons. */
  listRemoteNodes?: ListRemoteNodesFn | null;
  /** Backs `run_on_node`; injected to avoid importing instance/remote-node singletons. */
  spawnRemoteInstance?: SpawnRemoteInstanceFn | null;
  readInstanceOutput?: ReadInstanceOutputFn | null;
  /** Backs `terminate_node_instance`. */
  terminateNodeInstances?: TerminateNodeInstancesFn | null;
  /** SettingsManager used by settings_* MCP tools. */
  settingsManager?: SettingsManagerForTools | null;
  /** Renderer broadcast hook used after tool-initiated settings writes. */
  broadcastSettingsChange?: SettingsChangeBroadcaster | null;
  /** Sends service-scoped config.update RPCs for update_node_config. */
  updateNodeConfig?: UpdateNodeConfigFn | null;
  /** Backs `create_automation`. */
  createAutomation?: CreateAutomationFn | null;
  /** Backs `list_automations`. */
  listAutomations?: ListAutomationsFn | null;
  /** Backs `delete_automation`. */
  deleteAutomation?: DeleteAutomationFn | null;
  /** Backs `update_automation`. */
  updateAutomation?: UpdateAutomationFn | null;
  /** Backs `postpone_automation`. */
  postponeAutomation?: PostponeAutomationFn | null;
  /** Back `request_doc_review` / `get_doc_review_result`. */
  requestDocReview?: RequestDocReviewFn | null; getDocReviewResult?: GetDocReviewResultFn | null;
  /**
   * Returns whether the given instance may still spawn (i.e. is below the
   * configured spawn-depth limit). When it returns false, the spawn-capable
   * `run_on_node` tool is stripped from that instance's tool list (#18a). When
   * omitted, every instance keeps the full toolset.
   */
  resolveSpawnEligibility?: (instanceId: string) => boolean;
  resolveContextEvidence?: (
    instanceId: string,
  ) => Omit<OrchestratorEvidenceToolContext, 'instanceId'> | null;
  authorizeReleaseMutation?: (
    request: ReleaseMutationAuthorizationRequest,
  ) => Promise<boolean>;
  toolFactory?: (deps: OrchestratorToolRuntimeContext) => McpServerToolDefinition[];
}

export class OrchestratorToolsRpcServer {
  private readonly operatorDbPath: string;
  private readonly userDataPath: string;
  private readonly isKnownLocalInstance: (instanceId: string) => boolean;
  private readonly maxPayloadBytes: number;
  private readonly rateLimit: { maxRequests: number; windowMs: number };
  private readonly listRemoteNodes: ListRemoteNodesFn | null;
  private readonly fileTransferTools: FileTransferToolContext;
  private readonly spawnRemoteInstance: SpawnRemoteInstanceFn | null;
  private readonly readInstanceOutput: ReadInstanceOutputFn | null;
  private readonly terminateNodeInstances: TerminateNodeInstancesFn | null;
  private readonly settingsManager: SettingsManagerForTools | null;
  private readonly broadcastSettingsChange: SettingsChangeBroadcaster | null;
  private readonly updateNodeConfig: UpdateNodeConfigFn | null;
  private readonly createAutomation: CreateAutomationFn | null;
  private readonly listAutomations: ListAutomationsFn | null;
  private readonly deleteAutomation: DeleteAutomationFn | null;
  private readonly updateAutomation: UpdateAutomationFn | null;
  private readonly postponeAutomation: PostponeAutomationFn | null;
  private readonly requestDocReview: RequestDocReviewFn | null;
  private readonly getDocReviewResult: GetDocReviewResultFn | null;
  private readonly resolveSpawnEligibility: ((instanceId: string) => boolean) | null;
  private readonly resolveContextEvidence: NonNullable<
    OrchestratorToolsRpcServerOptions['resolveContextEvidence']
  >;
  private readonly authorizeReleaseMutation: NonNullable<
    OrchestratorToolsRpcServerOptions['authorizeReleaseMutation']
  >;
  private readonly buckets = new Map<string, number[]>();
  private readonly toolFactory: NonNullable<OrchestratorToolsRpcServerOptions['toolFactory']>;
  /** True when callers provided their own toolFactory — usually tests that
   *  don't need (or want) the real operator DB to be opened. */
  private readonly toolFactoryInjected: boolean;
  private server: net.Server | null = null;
  private socketPath: string | null = null;
  private socketDirToCleanup: string | null = null;
  private db: SqliteDriver | null = null;
  private ledger: ConversationLedgerService | null = null;

  constructor(options: OrchestratorToolsRpcServerOptions = {}) {
    this.operatorDbPath = options.operatorDbPath ?? defaultOperatorDbPath();
    this.userDataPath = options.userDataPath ?? app.getPath('userData');
    this.isKnownLocalInstance = options.isKnownLocalInstance ?? (() => false);
    this.maxPayloadBytes = options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES;
    this.rateLimit = options.rateLimit ?? { maxRequests: 30, windowMs: 10_000 };
    this.listRemoteNodes = options.listRemoteNodes ?? null;
    this.fileTransferTools = {
      listNodeFiles: options.listNodeFiles ?? null,
      findNodeFiles: options.findNodeFiles ?? null,
      getNodeFileInfo: options.getNodeFileInfo ?? null,
      downloadFromNode: options.downloadFromNode ?? null,
      uploadToNode: options.uploadToNode ?? null,
      syncToNode: options.syncToNode ?? null,
      syncFromNode: options.syncFromNode ?? null,
      collectBrowserDownload: options.collectBrowserDownload ?? null,
    };
    this.spawnRemoteInstance = options.spawnRemoteInstance ?? null;
    this.readInstanceOutput = options.readInstanceOutput ?? null;
    this.terminateNodeInstances = options.terminateNodeInstances ?? null;
    this.settingsManager = options.settingsManager ?? null;
    this.broadcastSettingsChange = options.broadcastSettingsChange ?? null;
    this.updateNodeConfig = options.updateNodeConfig ?? null;
    this.createAutomation = options.createAutomation ?? null;
    this.listAutomations = options.listAutomations ?? null;
    this.deleteAutomation = options.deleteAutomation ?? null;
    this.updateAutomation = options.updateAutomation ?? null;
    this.postponeAutomation = options.postponeAutomation ?? null;
    this.requestDocReview = options.requestDocReview ?? null; this.getDocReviewResult = options.getDocReviewResult ?? null;
    this.resolveSpawnEligibility = options.resolveSpawnEligibility ?? null;
    this.resolveContextEvidence = options.resolveContextEvidence ?? (() => null);
    this.authorizeReleaseMutation = options.authorizeReleaseMutation ?? (async () => false);
    this.toolFactoryInjected = options.toolFactory !== undefined;
    this.toolFactory = options.toolFactory ?? createOrchestratorToolDefinitions;
    const register = options.registerCleanup ?? registerGlobalCleanup;
    register(() => this.stop());
  }

  async start(): Promise<void> {
    if (this.server) {
      return;
    }
    this.socketPath = this.createSocketPath();
    this.server = net.createServer((socket) => this.handleSocket(socket));
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(this.socketPath!, () => resolve());
    });
    if (process.platform !== 'win32' && this.socketPath) {
      fs.chmodSync(this.socketPath, 0o600);
    }
    logger.info('Orchestrator-tools RPC server listening', { socketPath: this.socketPath });
  }

  async stop(): Promise<void> {
    const server = this.server;
    const socketPath = this.socketPath;
    const socketDirToCleanup = this.socketDirToCleanup;
    this.server = null;
    this.socketPath = null;
    this.socketDirToCleanup = null;
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    if (socketPath && process.platform !== 'win32' && fs.existsSync(socketPath)) {
      fs.unlinkSync(socketPath);
    }
    if (socketDirToCleanup && fs.existsSync(socketDirToCleanup)) {
      fs.rmdirSync(socketDirToCleanup);
    }
    this.ledger = null;
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  getSocketPath(): string | null {
    return this.socketPath;
  }

  async handleRequest(request: OrchestratorToolsRpcRequest): Promise<unknown> {
    const params = this.parseParams(request.params);
    if (!this.isKnownLocalInstance(params.instanceId)) {
      throw new Error('unknown orchestrator-tools instance');
    }
    this.enforceRateLimit(params.instanceId);
    this.enforcePayloadSize(params.payload);
    const fileTransferSpec = FILE_TRANSFER_RPC_SPECS.find((spec) => spec.method === request.method);
    if (fileTransferSpec) {
      return this.dispatchValidatedTool(fileTransferSpec.toolName, fileTransferSpec.schema, params);
    }
    const evidenceSpec = EVIDENCE_RPC_SPECS.find((spec) => spec.method === request.method);
    if (evidenceSpec) {
      return this.dispatchValidatedTool(evidenceSpec.toolName, evidenceSpec.schema, params);
    }

    switch (request.method) {
      case 'orchestrator_tools.git_batch_pull': {
        const validated = GitBatchPullArgsSchema.parse(params.payload);
        const tools = this.getToolsForInstance(params.instanceId);
        const tool = tools.find((t) => t.name === 'git_batch_pull');
        if (!tool) {
          throw new Error('git_batch_pull tool unavailable');
        }
        return tool.handler(validated);
      }
      case 'orchestrator_tools.list_remote_nodes': {
        const validated = ListRemoteNodesArgsSchema.parse(params.payload);
        const tools = this.getToolsForInstance(params.instanceId);
        const tool = tools.find((t) => t.name === 'list_remote_nodes');
        if (!tool) {
          throw new Error('list_remote_nodes tool unavailable');
        }
        return tool.handler(validated);
      }
      case 'orchestrator_tools.run_on_node': {
        const validated = RunOnNodeArgsSchema.parse(params.payload);
        const tools = this.getToolsForInstance(params.instanceId);
        const tool = tools.find((t) => t.name === 'run_on_node');
        if (!tool) {
          throw new Error('run_on_node tool unavailable');
        }
        return tool.handler(validated);
      }
      case 'orchestrator_tools.read_node_output': {
        const validated = ReadNodeOutputArgsSchema.parse(params.payload);
        const tools = this.getToolsForInstance(params.instanceId);
        const tool = tools.find((t) => t.name === 'read_node_output');
        if (!tool) {
          throw new Error('read_node_output tool unavailable');
        }
        return tool.handler(validated);
      }
      case 'orchestrator_tools.terminate_node_instance': {
        const validated = TerminateNodeInstanceArgsSchema.parse(params.payload);
        const tools = this.getToolsForInstance(params.instanceId);
        const tool = tools.find((t) => t.name === 'terminate_node_instance');
        if (!tool) {
          throw new Error('terminate_node_instance tool unavailable');
        }
        return tool.handler(validated);
      }
      case 'orchestrator_tools.settings.privileged_list': {
        const validated = SettingsPrivilegedListPayloadSchema.parse(params.payload);
        return privilegedListSettings(this.getSettingsContext(), validated);
      }
      case 'orchestrator_tools.settings.privileged_get': {
        const validated = SettingsPrivilegedGetPayloadSchema.parse(params.payload);
        return privilegedGetSetting(this.getSettingsContext(), validated);
      }
      case 'orchestrator_tools.settings.privileged_set': {
        const validated = SettingsPrivilegedSetPayloadSchema.parse(params.payload);
        return privilegedSetSetting(this.getSettingsContext(), validated);
      }
      case 'orchestrator_tools.settings.privileged_reset': {
        const validated = SettingsPrivilegedResetPayloadSchema.parse(params.payload);
        return privilegedResetSetting(this.getSettingsContext(), validated);
      }
      case 'orchestrator_tools.settings.list': {
        const validated = SettingsToolListPayloadSchema.parse(params.payload);
        const tools = this.getToolsForInstance(params.instanceId);
        const tool = tools.find((t) => t.name === 'list_settings');
        if (!tool) {
          throw new Error('list_settings tool unavailable');
        }
        return tool.handler(validated);
      }
      case 'orchestrator_tools.settings.get': {
        const validated = SettingsToolGetPayloadSchema.parse(params.payload);
        const tools = this.getToolsForInstance(params.instanceId);
        const tool = tools.find((t) => t.name === 'get_setting');
        if (!tool) {
          throw new Error('get_setting tool unavailable');
        }
        return tool.handler(validated);
      }
      case 'orchestrator_tools.settings.set': {
        const validated = SettingsToolSetPayloadSchema.parse(params.payload);
        const tools = this.getToolsForInstance(params.instanceId);
        const tool = tools.find((t) => t.name === 'set_setting');
        if (!tool) {
          throw new Error('set_setting tool unavailable');
        }
        return tool.handler(validated);
      }
      case 'orchestrator_tools.settings.reset': {
        const validated = SettingsToolResetPayloadSchema.parse(params.payload);
        const tools = this.getToolsForInstance(params.instanceId);
        const tool = tools.find((t) => t.name === 'reset_setting');
        if (!tool) {
          throw new Error('reset_setting tool unavailable');
        }
        return tool.handler(validated);
      }
      case 'orchestrator_tools.node_config.update': {
        const validated = SettingsToolUpdateNodeConfigPayloadSchema.parse(params.payload);
        const tools = this.getToolsForInstance(params.instanceId);
        const tool = tools.find((t) => t.name === 'update_node_config');
        if (!tool) {
          throw new Error('update_node_config tool unavailable');
        }
        return tool.handler(validated);
      }
      case 'orchestrator_tools.create_automation': {
        const validated = CreateAutomationArgsSchema.parse(params.payload);
        const tools = this.getToolsForInstance(params.instanceId);
        const tool = tools.find((t) => t.name === 'create_automation');
        if (!tool) {
          throw new Error('create_automation tool unavailable');
        }
        return tool.handler(validated);
      }
      case 'orchestrator_tools.list_automations': {
        const validated = ListAutomationsArgsSchema.parse(params.payload);
        const tools = this.getToolsForInstance(params.instanceId);
        const tool = tools.find((t) => t.name === 'list_automations');
        if (!tool) {
          throw new Error('list_automations tool unavailable');
        }
        return tool.handler(validated);
      }
      case 'orchestrator_tools.delete_automation': {
        const validated = DeleteAutomationArgsSchema.parse(params.payload);
        const tools = this.getToolsForInstance(params.instanceId);
        const tool = tools.find((t) => t.name === 'delete_automation');
        if (!tool) {
          throw new Error('delete_automation tool unavailable');
        }
        return tool.handler(validated);
      }
      case 'orchestrator_tools.update_automation': {
        const validated = UpdateAutomationArgsSchema.parse(params.payload);
        const tools = this.getToolsForInstance(params.instanceId);
        const tool = tools.find((t) => t.name === 'update_automation');
        if (!tool) {
          throw new Error('update_automation tool unavailable');
        }
        return tool.handler(validated);
      }
      case 'orchestrator_tools.postpone_automation': {
        const validated = PostponeAutomationArgsSchema.parse(params.payload);
        const tools = this.getToolsForInstance(params.instanceId);
        const tool = tools.find((t) => t.name === 'postpone_automation');
        if (!tool) {
          throw new Error('postpone_automation tool unavailable');
        }
        return tool.handler(validated);
      }
      case 'orchestrator_tools.build_release_operational_readiness_report':
      case 'orchestrator_tools.build_ios_release_plan':
      case 'orchestrator_tools.build_android_release_plan':
      case 'orchestrator_tools.build_new_app_setup_plan':
      case 'orchestrator_tools.generate_play_data_safety_csv':
        return this.dispatchSameNameTool(request.method, params);
      case 'orchestrator_tools.execute_android_play_release':
      case 'orchestrator_tools.execute_ios_asc_finalization': {
        const authorized = await this.authorizeReleaseMutation({
          instanceId: params.instanceId,
          method: request.method,
          payload: params.payload,
        });
        if (!authorized) {
          throw new Error('release_operator_authorization_required');
        }
        return this.dispatchSameNameTool(request.method, params);
      }
      default:
        throw new Error(`Unknown orchestrator-tools RPC method: ${request.method}`);
    }
  }

  private async dispatchSameNameTool(
    method: string,
    params: OrchestratorToolsRpcParams,
  ): Promise<unknown> {
    const toolName = method.slice('orchestrator_tools.'.length);
    const tool = this.getToolsForInstance(params.instanceId).find((candidate) => candidate.name === toolName);
    if (!tool) {
      throw new Error(`${toolName} tool unavailable`);
    }
    return tool.handler(params.payload);
  }

  private getSettingsContext(): SettingsToolContext {
    return {
      settingsManager: this.settingsManager,
      broadcastSettingsChange: this.broadcastSettingsChange,
      updateNodeConfig: this.updateNodeConfig,
    };
  }

  private async dispatchValidatedTool(
    toolName: string,
    schema: { parse(value: unknown): Record<string, unknown> },
    params: OrchestratorToolsRpcParams,
  ): Promise<unknown> {
    const validated = schema.parse(params.payload);
    const tool = this.getToolsForInstance(params.instanceId).find((candidate) => candidate.name === toolName);
    if (!tool) {
      throw new Error(`${toolName} tool unavailable`);
    }
    return tool.handler(validated);
  }

  private handleSocket(socket: net.Socket): void {
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf-8');
      if (
        Buffer.byteLength(buffer, 'utf-8') >
        this.maxPayloadBytes + MAX_RPC_ENVELOPE_BYTES
      ) {
        this.writeError(socket, null, 'Orchestrator-tools RPC request too large');
        return;
      }
      const newline = buffer.indexOf('\n');
      if (newline === -1) {
        return;
      }
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      void this.handleSocketLine(socket, line);
    });
  }

  private async handleSocketLine(socket: net.Socket, line: string): Promise<void> {
    let request: OrchestratorToolsRpcRequest | null = null;
    try {
      request = JSON.parse(line) as OrchestratorToolsRpcRequest;
      const result = await this.handleRequest(request);
      socket.end(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n`);
    } catch (error) {
      this.writeError(
        socket,
        request?.id ?? null,
        error instanceof SyntaxError
          ? 'Invalid orchestrator-tools RPC request JSON'
          : error instanceof Error
            ? error.message
            : String(error),
      );
    }
  }

  private writeError(
    socket: net.Socket,
    id: OrchestratorToolsRpcRequest['id'],
    message: string,
  ): void {
    socket.end(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id,
        error: { code: -32000, message },
      })}\n`,
    );
  }

  private parseParams(params: unknown): OrchestratorToolsRpcParams {
    if (!params || typeof params !== 'object') {
      throw new Error('Orchestrator-tools RPC params are required');
    }
    const value = params as Partial<OrchestratorToolsRpcParams>;
    if (typeof value.instanceId !== 'string' || !value.instanceId) {
      throw new Error('Orchestrator-tools RPC instanceId is required');
    }
    if (!value.payload || typeof value.payload !== 'object' || Array.isArray(value.payload)) {
      throw new Error('Orchestrator-tools RPC payload is required');
    }
    return { instanceId: value.instanceId, payload: value.payload };
  }

  private enforcePayloadSize(payload: Record<string, unknown>): void {
    if (Buffer.byteLength(JSON.stringify(payload), 'utf-8') > this.maxPayloadBytes) {
      throw new Error('Orchestrator-tools RPC payload too large');
    }
  }

  private enforceRateLimit(instanceId: string): void {
    const now = Date.now();
    const bucket = (this.buckets.get(instanceId) ?? []).filter(
      (timestamp) => now - timestamp < this.rateLimit.windowMs,
    );
    if (bucket.length >= this.rateLimit.maxRequests) {
      throw new Error('Orchestrator-tools RPC rate limit exceeded');
    }
    bucket.push(now);
    this.buckets.set(instanceId, bucket);
  }

  /** Lazy-open the operator DB the first time a request needs it. */
  private ensureRuntimeReady(): void {
    if (this.db) return;
    const db = defaultDriverFactory(this.operatorDbPath);
    db.pragma('journal_mode = WAL');
    createOperatorTables(db);
    this.db = db;
    this.ledger = getConversationLedgerService();
  }

  private getToolsForInstance(instanceId: string): McpServerToolDefinition[] {
    if (this.toolFactoryInjected) {
      // Tests inject a factory that ignores its `db`/`ledger` args; opening
      // the real operator DB here would defeat the point of injection.
      return this.scopeToolsForInstance(instanceId, this.toolFactory({
        db: null as unknown as SqliteDriver,
        ledger: null,
        instanceId,
        listRemoteNodes: this.listRemoteNodes,
        ...this.fileTransferTools,
        spawnRemoteInstance: this.spawnRemoteInstance,
        readInstanceOutput: this.readInstanceOutput,
        terminateNodeInstances: this.terminateNodeInstances,
        settingsManager: this.settingsManager,
        broadcastSettingsChange: this.broadcastSettingsChange,
        updateNodeConfig: this.updateNodeConfig,
        createAutomation: this.createAutomation,
        listAutomations: this.listAutomations,
        deleteAutomation: this.deleteAutomation,
        updateAutomation: this.updateAutomation,
        postponeAutomation: this.postponeAutomation,
        requestDocReview: this.requestDocReview,
        getDocReviewResult: this.getDocReviewResult,
        contextEvidence: this.resolveContextEvidence(instanceId),
      }));
    }
    this.ensureRuntimeReady();
    if (!this.db) {
      throw new Error('Orchestrator-tools runtime failed to initialize');
    }
    return this.scopeToolsForInstance(instanceId, this.toolFactory({
      db: this.db,
      ledger: this.ledger,
      instanceId,
      listRemoteNodes: this.listRemoteNodes,
      ...this.fileTransferTools,
      spawnRemoteInstance: this.spawnRemoteInstance,
      readInstanceOutput: this.readInstanceOutput,
      terminateNodeInstances: this.terminateNodeInstances,
      settingsManager: this.settingsManager,
      broadcastSettingsChange: this.broadcastSettingsChange,
      updateNodeConfig: this.updateNodeConfig,
      createAutomation: this.createAutomation,
      listAutomations: this.listAutomations,
      deleteAutomation: this.deleteAutomation,
      updateAutomation: this.updateAutomation,
      postponeAutomation: this.postponeAutomation,
      requestDocReview: this.requestDocReview,
      getDocReviewResult: this.getDocReviewResult,
      contextEvidence: this.resolveContextEvidence(instanceId),
    }));
  }

  /**
   * Strip spawn-capable tools (`run_on_node`) from instances that have reached
   * the spawn-depth limit (#18a/#19). No-op when no eligibility resolver is
   * wired or the instance is still allowed to spawn.
   */
  private scopeToolsForInstance(
    instanceId: string,
    tools: McpServerToolDefinition[],
  ): McpServerToolDefinition[] {
    if (!this.resolveSpawnEligibility || this.resolveSpawnEligibility(instanceId)) {
      return tools;
    }
    // Strip exactly the tools that the leaf toolset removes from the full set
    // (i.e. run_on_node) — never drop unrelated/future tools.
    const leaf = new Set(ORCHESTRATOR_TOOLSETS.resolve('orchestrator-tools-leaf'));
    const stripped = new Set(
      ORCHESTRATOR_TOOLSETS.resolve('orchestrator-tools-full').filter((t) => !leaf.has(t)),
    );
    return tools.filter((tool) => !stripped.has(tool.name));
  }

  private createSocketPath(): string {
    const result = createOrchestratorToolsSocketPath(this.userDataPath);
    this.socketDirToCleanup = result.cleanupDir;
    return result.socketPath;
  }
}

let orchestratorToolsRpcServer: OrchestratorToolsRpcServer | null = null;

export function getOrchestratorToolsRpcServer(
  options: OrchestratorToolsRpcServerOptions = {},
): OrchestratorToolsRpcServer {
  if (!orchestratorToolsRpcServer) {
    orchestratorToolsRpcServer = new OrchestratorToolsRpcServer(options);
  }
  return orchestratorToolsRpcServer;
}

export async function initializeOrchestratorToolsRpcServer(
  options: OrchestratorToolsRpcServerOptions = {},
): Promise<OrchestratorToolsRpcServer> {
  const server = getOrchestratorToolsRpcServer(options);
  await server.start();
  return server;
}

export function getOrchestratorToolsRpcSocketPath(): string | null {
  return orchestratorToolsRpcServer?.getSocketPath() ?? null;
}

export function _resetOrchestratorToolsRpcServerForTesting(): void {
  orchestratorToolsRpcServer = null;
}
