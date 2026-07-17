import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  BrowserAttachExistingTabRequestSchema,
  BrowserWorkflowCheckpointResumeRequestSchema,
  BrowserWorkflowCheckpointSaveRequestSchema,
} from '@contracts/schemas/browser';
import { app } from 'electron';
import { registerCleanup as registerGlobalCleanup } from '../util/cleanup-registry';
import {
  BrowserGatewayService,
  getBrowserGatewayService,
} from './browser-gateway-service';
import {
  getBrowserExtensionCommandStore,
  type BrowserExtensionCommandResult,
  type BrowserExtensionCommandStore,
  type BrowserExtensionPollRequest,
  type BrowserExtensionQueuedCommand,
} from './browser-extension-command-store';
import { getBrowserExtensionContactState } from './browser-extension-contact-state';
import {
  handleUnattendedRpcMethod,
  isUnattendedRpcMethod,
} from './browser-unattended-rpc-operations';
import {
  BrowserWorkflowCheckpointStore,
  getBrowserWorkflowCheckpointStore,
} from './browser-workflow-checkpoint-store';
import {
  handleReportToolSurface,
  parseBoundedNameList,
  validateBrowserRpcPayload,
} from './browser-rpc-server-support';
import {
  getBrowserToolRevealStore,
  type BrowserToolRevealStore,
} from './browser-tool-reveal-store';

interface BrowserGatewayRpcRequest {
  jsonrpc?: '2.0';
  id?: number | string | null;
  method: string;
  params?: unknown;
}

interface BrowserGatewayRpcParams {
  instanceId: string;
  provider?: string;
  payload: Record<string, unknown>;
}

interface BrowserGatewayExtensionRpcParams {
  extensionToken: string;
  extensionOrigin?: string;
  payload: Record<string, unknown>;
}

export interface BrowserGatewayRpcServerOptions {
  service?: Partial<BrowserGatewayService>;
  extensionCommandStore?: Pick<
    BrowserExtensionCommandStore,
    'pollCommand' | 'resolveCommand' | 'markReceived'
  >;
  checkpointStore?: Pick<BrowserWorkflowCheckpointStore, 'saveStep' | 'get'>;
  toolRevealStore?: BrowserToolRevealStore;
  resolveCheckpointOwner?: (instanceId: string) => string;
  onExtensionDisconnected?: (reason: string) => void;
  userDataPath?: string;
  isKnownLocalInstance?: (instanceId: string) => boolean;
  extensionToken?: string;
  registerCleanup?: (cleanup: () => void | Promise<void>) => void | (() => void);
  maxPayloadBytes?: number;
  rateLimit?: {
    maxRequests: number;
    maxBytes?: number;
    windowMs: number;
  };
}

const DEFAULT_MAX_PAYLOAD_BYTES = 1024 * 1024;
const MAX_RPC_ENVELOPE_BYTES = 16 * 1024;
const MAX_UNIX_SOCKET_PATH_BYTES = 100;

interface BrowserGatewayRateBucketEntry {
  timestamp: number;
  bytes: number;
}

export class BrowserGatewayRpcServer {
  private readonly service: Partial<BrowserGatewayService>;
  private readonly extensionCommandStore: Pick<
    BrowserExtensionCommandStore,
    'pollCommand' | 'resolveCommand' | 'markReceived'
  >;
  private readonly checkpointStore?: Pick<BrowserWorkflowCheckpointStore, 'saveStep' | 'get'>;
  private readonly toolRevealStore?: BrowserToolRevealStore;
  private readonly resolveCheckpointOwner: (instanceId: string) => string;
  private readonly onExtensionDisconnected: (reason: string) => void;
  private readonly userDataPath: string;
  private readonly isKnownLocalInstance: (instanceId: string) => boolean;
  private readonly extensionToken: string;
  private readonly maxPayloadBytes: number;
  private readonly rateLimit: { maxRequests: number; maxBytes: number; windowMs: number };
  private readonly buckets = new Map<string, BrowserGatewayRateBucketEntry[]>();
  private server: net.Server | null = null;
  private socketPath: string | null = null;
  private socketDirToCleanup: string | null = null;

  constructor(options: BrowserGatewayRpcServerOptions = {}) {
    this.service = options.service ?? getBrowserGatewayService();
    this.extensionCommandStore =
      options.extensionCommandStore ?? getBrowserExtensionCommandStore();
    this.checkpointStore = options.checkpointStore;
    this.toolRevealStore = options.toolRevealStore;
    this.resolveCheckpointOwner = options.resolveCheckpointOwner ?? ((instanceId) => instanceId);
    this.onExtensionDisconnected = options.onExtensionDisconnected
      ?? ((reason: string) =>
        getBrowserExtensionContactState().markExtensionDisconnect('local', reason));
    this.userDataPath = options.userDataPath ?? app.getPath('userData');
    this.isKnownLocalInstance = options.isKnownLocalInstance ?? (() => false);
    this.extensionToken = options.extensionToken ?? crypto.randomBytes(32).toString('hex');
    this.maxPayloadBytes = options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES;
    this.rateLimit = {
      maxRequests: options.rateLimit?.maxRequests ?? 30,
      maxBytes: options.rateLimit?.maxBytes ?? this.maxPayloadBytes * 10,
      windowMs: options.rateLimit?.windowMs ?? 10_000,
    };
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
  }

  getSocketPath(): string | null {
    return this.socketPath;
  }

  getExtensionToken(): string {
    return this.extensionToken;
  }

  async handleRequest(request: BrowserGatewayRpcRequest): Promise<unknown> {
    if (request.method === 'browser.extension_attach_tab') {
      return this.handleExtensionAttachTab(request);
    }
    if (request.method === 'browser.extension_poll_command') {
      return this.handleExtensionPollCommand(request);
    }
    if (request.method === 'browser.extension_command_result') {
      return this.handleExtensionCommandResult(request);
    }
    if (request.method === 'browser.extension_command_received') {
      return this.handleExtensionCommandReceived(request);
    }
    if (request.method === 'browser.extension_disconnected') {
      return this.handleExtensionDisconnected(request);
    }

    const params = this.parseParams(request.params);
    if (!this.isKnownLocalInstance(params.instanceId)) {
      throw new Error('unknown browser gateway instance');
    }
    const payloadBytes = this.enforcePayloadSize(params.payload);
    this.enforceRateLimit(params.instanceId, payloadBytes);

    // Unattended-layer runtime methods (escalations, campaign leases, session
    // sentinel) validate their own payloads and dispatch to the unattended
    // singletons rather than per-tool service methods.
    if (isUnattendedRpcMethod(request.method)) {
      return handleUnattendedRpcMethod(request.method, params.payload, {
        instanceId: params.instanceId,
        ...(params.provider ? { provider: params.provider } : {}),
        service: this.service,
      });
    }

    // Forwarder tool-surface continuity (reliability hardening): lets a
    // restarted MCP forwarder restore its pre-reconnect revealed tool set and
    // report its contract version + surface hash for parity/health checks.
    if (request.method === 'browser.tool_reveal_get') {
      return {
        revealedNames: this.getToolRevealStore().getRevealed(params.instanceId),
      };
    }
    if (request.method === 'browser.tool_reveal_record') {
      this.getToolRevealStore().recordRevealed(
        params.instanceId,
        parseBoundedNameList(params.payload['names']),
      );
      return { ok: true };
    }
    if (request.method === 'browser.report_tool_surface') {
      return handleReportToolSurface(
        this.getToolRevealStore(),
        params.instanceId,
        params.payload,
      );
    }

    const payload = this.validatePayload(request.method, params.payload);
    const withContext = {
      ...payload,
      instanceId: params.instanceId,
      ...(params.provider ? { provider: params.provider } : {}),
    };

    switch (request.method) {
      case 'browser.list_profiles':
        return this.requireMethod('listProfiles')(withContext);
      case 'browser.create_profile':
        return this.requireMethod('createProfile')(withContext);
      case 'browser.list_targets':
        return this.requireMethod('listTargets')(withContext);
      case 'browser.find_or_open':
        return this.requireMethod('findOrOpen')(withContext);
      case 'browser.open_profile':
        return this.requireMethod('openProfile')(withContext);
      case 'browser.close_profile':
        return this.requireMethod('closeProfile')(withContext);
      case 'browser.select_target':
        return this.requireMethod('selectTarget')(withContext);
      case 'browser.navigate':
        return this.requireMethod('navigate')(withContext);
      case 'browser.click':
        return this.requireMethod('click')(withContext);
      case 'browser.type':
        return this.requireMethod('type')(withContext);
      case 'browser.fill_form':
        return this.requireMethod('fillForm')(withContext);
      case 'browser.select':
        return this.requireMethod('select')(withContext);
      case 'browser.execute_fill_plan':
        return this.requireMethod('executeFillPlan')(withContext);
      case 'browser.fill_credential':
        return this.requireMethod('fillCredential')(withContext);
      case 'browser.fill_secret':
        return this.requireMethod('fillSecret')(withContext);
      case 'browser.create_agent_credential':
        return this.requireMethod('createAgentCredential')(withContext);
      case 'browser.upload_file':
        return this.requireMethod('uploadFile')(withContext);
      case 'browser.download_file':
        return this.requireMethod('downloadFile')(withContext);
      case 'browser.request_user_login':
        return this.requireMethod('requestUserLogin')(withContext);
      case 'browser.pause_for_manual_step':
        return this.requireMethod('pauseForManualStep')(withContext);
      case 'browser.request_grant':
        return this.requireMethod('requestGrant')(withContext);
      case 'browser.get_approval_status':
        return this.requireMethod('getApprovalStatus')(withContext);
      case 'browser.list_grants':
        return this.requireMethod('listGrants')(withContext);
      case 'browser.revoke_grant':
        return this.requireMethod('revokeGrant')(withContext);
      case 'browser.snapshot':
        return this.requireMethod('snapshot')(withContext);
      case 'browser.accessibility_snapshot':
        return this.requireMethod('accessibilitySnapshot')(withContext);
      case 'browser.evaluate':
        return this.requireMethod('evaluate')(withContext);
      case 'browser.screenshot':
        return this.requireMethod('screenshot')(withContext);
      case 'browser.console_messages':
        return this.requireMethod('consoleMessages')(withContext);
      case 'browser.network_requests':
        return this.requireMethod('networkRequests')(withContext);
      case 'browser.wait_for':
        return this.requireMethod('waitFor')(withContext);
      case 'browser.query_elements':
        return this.requireMethod('queryElements')(withContext);
      case 'browser.assert_persisted':
        return this.requireMethod('assertPersisted')(withContext);
      case 'browser.write_journal':
        return this.requireMethod('writeJournalList')(withContext);
      case 'browser.health':
        return this.requireMethod('getHealth')(withContext);
      case 'browser.get_audit_log':
        return this.requireMethod('getAuditLog')(withContext);
      case 'browser.checkpoint_save':
        return this.handleCheckpointSave(this.resolveCheckpointOwner(params.instanceId), payload);
      case 'browser.checkpoint_resume':
        return this.handleCheckpointResume(this.resolveCheckpointOwner(params.instanceId), payload);
      default:
        throw new Error(`Unknown Browser Gateway RPC method: ${request.method}`);
    }
  }

  private handleCheckpointSave(ownerId: string, payload: Record<string, unknown>): unknown {
    const result = BrowserWorkflowCheckpointSaveRequestSchema.safeParse(payload);
    if (!result.success) {
      throw new Error('Invalid browser gateway RPC payload');
    }
    return this.getCheckpointStore().saveStep({ ownerId, ...result.data });
  }

  private handleCheckpointResume(ownerId: string, payload: Record<string, unknown>): unknown {
    const result = BrowserWorkflowCheckpointResumeRequestSchema.safeParse(payload);
    if (!result.success) {
      throw new Error('Invalid browser gateway RPC payload');
    }
    return this.getCheckpointStore().get(ownerId, result.data.workflowId);
  }

  private getCheckpointStore(): Pick<BrowserWorkflowCheckpointStore, 'saveStep' | 'get'> {
    return this.checkpointStore ?? getBrowserWorkflowCheckpointStore();
  }

  private getToolRevealStore(): BrowserToolRevealStore {
    return this.toolRevealStore ?? getBrowserToolRevealStore();
  }

  private handleExtensionAttachTab(request: BrowserGatewayRpcRequest): unknown {
    const params = this.parseAuthorizedExtensionParams(request.params);
    const result = BrowserAttachExistingTabRequestSchema.safeParse(params.payload);
    if (!result.success) {
      throw new Error('Invalid browser gateway RPC payload');
    }
    return this.requireMethod('attachExistingTab')({
      ...result.data,
      provider: 'orchestrator',
      ...(params.extensionOrigin ? { extensionOrigin: params.extensionOrigin } : {}),
    });
  }

  private handleExtensionPollCommand(
    request: BrowserGatewayRpcRequest,
  ): Promise<BrowserExtensionQueuedCommand | null> {
    const params = this.parseAuthorizedExtensionParams(request.params);
    return this.extensionCommandStore.pollCommand(
      this.validateExtensionPollPayload(params.payload),
    );
  }

  private handleExtensionCommandResult(request: BrowserGatewayRpcRequest): { ok: true } {
    const params = this.parseAuthorizedExtensionParams(request.params);
    this.extensionCommandStore.resolveCommand(
      this.validateExtensionCommandResultPayload(params.payload),
    );
    return { ok: true };
  }

  private handleExtensionCommandReceived(request: BrowserGatewayRpcRequest): { ok: true } {
    const params = this.parseAuthorizedExtensionParams(request.params);
    const commandId = params.payload['commandId'];
    if (typeof commandId !== 'string' || !commandId) {
      throw new Error('Invalid browser gateway RPC payload');
    }
    this.extensionCommandStore.markReceived('local', commandId);
    return { ok: true };
  }

  private handleExtensionDisconnected(request: BrowserGatewayRpcRequest): { ok: true } {
    const params = this.parseAuthorizedExtensionParams(request.params);
    const reason = params.payload['reason'];
    this.onExtensionDisconnected(
      typeof reason === 'string' && reason ? reason : 'unknown',
    );
    return { ok: true };
  }

  private handleSocket(socket: net.Socket): void {
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf-8');
      if (
        Buffer.byteLength(buffer, 'utf-8') >
        this.maxPayloadBytes + MAX_RPC_ENVELOPE_BYTES
      ) {
        this.writeError(socket, null, 'Browser Gateway RPC request too large');
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
    let request: BrowserGatewayRpcRequest | null = null;
    try {
      request = JSON.parse(line) as BrowserGatewayRpcRequest;
      const result = await this.handleRequest(request);
      socket.end(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n`);
    } catch (error) {
      this.writeError(
        socket,
        request?.id ?? null,
        error instanceof SyntaxError
          ? 'Invalid Browser Gateway RPC request JSON'
          : error instanceof Error
            ? error.message
            : String(error),
      );
    }
  }

  private writeError(
    socket: net.Socket,
    id: BrowserGatewayRpcRequest['id'],
    message: string,
  ): void {
    socket.end(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id,
        error: {
          code: -32000,
          message,
        },
      })}\n`,
    );
  }

  private parseParams(params: unknown): BrowserGatewayRpcParams {
    if (!params || typeof params !== 'object') {
      throw new Error('Browser Gateway RPC params are required');
    }
    const value = params as Partial<BrowserGatewayRpcParams>;
    if (typeof value.instanceId !== 'string' || !value.instanceId) {
      throw new Error('Browser Gateway RPC instanceId is required');
    }
    if (!value.payload || typeof value.payload !== 'object' || Array.isArray(value.payload)) {
      throw new Error('Browser Gateway RPC payload is required');
    }
    const parsed = {
      instanceId: value.instanceId,
      payload: value.payload,
    };
    return typeof value.provider === 'string' && value.provider
      ? { ...parsed, provider: value.provider }
      : parsed;
  }

  private parseExtensionParams(params: unknown): BrowserGatewayExtensionRpcParams {
    if (!params || typeof params !== 'object') {
      throw new Error('Browser Gateway extension RPC params are required');
    }
    const value = params as Partial<BrowserGatewayExtensionRpcParams>;
    if (typeof value.extensionToken !== 'string' || !value.extensionToken) {
      throw new Error('Browser Gateway extension token is required');
    }
    if (!value.payload || typeof value.payload !== 'object' || Array.isArray(value.payload)) {
      throw new Error('Browser Gateway RPC payload is required');
    }
    return {
      extensionToken: value.extensionToken,
      ...(typeof value.extensionOrigin === 'string' && value.extensionOrigin
        ? { extensionOrigin: value.extensionOrigin }
        : {}),
      payload: value.payload,
    };
  }

  private parseAuthorizedExtensionParams(params: unknown): BrowserGatewayExtensionRpcParams {
    const parsed = this.parseExtensionParams(params);
    if (parsed.extensionToken !== this.extensionToken) {
      throw new Error('invalid browser extension host token');
    }
    const payloadBytes = this.enforcePayloadSize(parsed.payload);
    this.enforceRateLimit(
      `extension:${parsed.extensionOrigin ?? 'unknown'}`,
      payloadBytes,
    );
    return parsed;
  }

  private enforcePayloadSize(payload: Record<string, unknown>): number {
    const payloadBytes = Buffer.byteLength(JSON.stringify(payload), 'utf-8');
    if (payloadBytes > this.maxPayloadBytes) {
      throw new Error('Browser Gateway RPC payload too large');
    }
    return payloadBytes;
  }

  private enforceRateLimit(instanceId: string, payloadBytes: number): void {
    const now = Date.now();
    const bucket = (this.buckets.get(instanceId) ?? []).filter(
      (entry) => now - entry.timestamp < this.rateLimit.windowMs,
    );
    if (bucket.length >= this.rateLimit.maxRequests) {
      throw new Error('Browser Gateway RPC rate limit exceeded');
    }
    const bytesInWindow = bucket.reduce((total, entry) => total + entry.bytes, 0);
    if (bytesInWindow + payloadBytes > this.rateLimit.maxBytes) {
      throw new Error('Browser Gateway RPC byte rate limit exceeded');
    }
    bucket.push({ timestamp: now, bytes: payloadBytes });
    this.buckets.set(instanceId, bucket);
  }

  private createSocketPath(): string {
    if (process.platform === 'win32') {
      return `\\\\.\\pipe\\browser-gateway-${crypto.randomUUID()}`;
    }

    const id = crypto.randomUUID().replace(/-/g, '').slice(0, 12);
    const userDataSocketPath = path.join(this.userDataPath, `bg-${id}.sock`);
    if (Buffer.byteLength(userDataSocketPath, 'utf-8') <= MAX_UNIX_SOCKET_PATH_BYTES) {
      return userDataSocketPath;
    }

    const fallbackDir = path.join(os.tmpdir(), `aio-bg-${process.pid}-${id}`);
    fs.mkdirSync(fallbackDir, {
      recursive: true,
      mode: 0o700,
    });
    fs.chmodSync(fallbackDir, 0o700);
    this.socketDirToCleanup = fallbackDir;
    return path.join(fallbackDir, 'bg.sock');
  }

  private validatePayload(method: string, payload: Record<string, unknown>): Record<string, unknown> {
    return validateBrowserRpcPayload(method, payload);
  }

  private validateExtensionPollPayload(
    payload: Record<string, unknown>,
  ): BrowserExtensionPollRequest {
    const timeoutMs = payload['timeoutMs'];
    if (timeoutMs === undefined) {
      return {};
    }
    if (
      typeof timeoutMs !== 'number'
      || !Number.isInteger(timeoutMs)
      || timeoutMs < 0
      || timeoutMs > 25_000
    ) {
      throw new Error('Invalid browser gateway extension command payload');
    }
    return { timeoutMs };
  }

  private validateExtensionCommandResultPayload(
    payload: Record<string, unknown>,
  ): BrowserExtensionCommandResult {
    const commandId = payload['commandId'];
    const ok = payload['ok'];
    if (typeof commandId !== 'string' || !commandId) {
      throw new Error('Invalid browser gateway extension command payload');
    }
    if (typeof ok !== 'boolean') {
      throw new Error('Invalid browser gateway extension command payload');
    }
    const result: BrowserExtensionCommandResult = {
      commandId,
      ok,
    };
    if ('result' in payload) {
      result.result = payload['result'];
    }
    const error = payload['error'];
    if (error !== undefined) {
      if (typeof error !== 'string' || !error) {
        throw new Error('Invalid browser gateway extension command payload');
      }
      result.error = error;
    }
    return result;
  }

  private requireMethod(name: keyof BrowserGatewayService): (payload: Record<string, unknown>) => unknown {
    const method = this.service[name];
    if (typeof method !== 'function') {
      throw new Error(`Browser Gateway service method unavailable: ${String(name)}`);
    }
    return method.bind(this.service) as (payload: Record<string, unknown>) => unknown;
  }
}

let browserGatewayRpcServer: BrowserGatewayRpcServer | null = null;

export function getBrowserGatewayRpcServer(
  options: BrowserGatewayRpcServerOptions = {},
): BrowserGatewayRpcServer {
  if (!browserGatewayRpcServer) {
    browserGatewayRpcServer = new BrowserGatewayRpcServer(options);
  }
  return browserGatewayRpcServer;
}

export async function initializeBrowserGatewayRpcServer(
  options: BrowserGatewayRpcServerOptions = {},
): Promise<BrowserGatewayRpcServer> {
  const server = getBrowserGatewayRpcServer(options);
  await server.start();
  return server;
}

export function getBrowserGatewayRpcSocketPath(): string | null {
  return browserGatewayRpcServer?.getSocketPath() ?? null;
}
