import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  BrowserApprovalStatusRequestSchema,
  BrowserAttachExistingTabRequestSchema,
  BrowserClickRequestSchema,
  BrowserCreateProfileRequestSchema,
  BrowserFillFormRequestSchema,
  BrowserListAuditLogRequestSchema,
  BrowserListGrantsRequestSchema,
  BrowserListTargetsRequestSchema,
  BrowserNavigateRequestSchema,
  BrowserProfileRequestSchema,
  BrowserRequestGrantRequestSchema,
  BrowserRevokeGrantRequestSchema,
  BrowserScreenshotRequestSchema,
  BrowserSelectRequestSchema,
  BrowserTargetRequestSchema,
  BrowserTypeRequestSchema,
  BrowserUploadFileRequestSchema,
  BrowserWaitForRequestSchema,
} from '@contracts/schemas/browser';
import { app } from 'electron';
import { registerCleanup as registerGlobalCleanup } from '../util/cleanup-registry';
import {
  BrowserGatewayService,
  getBrowserGatewayService,
} from './browser-gateway-service';
import { z } from 'zod';

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
  userDataPath?: string;
  isKnownLocalInstance?: (instanceId: string) => boolean;
  extensionToken?: string;
  registerCleanup?: (cleanup: () => void | Promise<void>) => void | (() => void);
  maxPayloadBytes?: number;
  rateLimit?: {
    maxRequests: number;
    windowMs: number;
  };
}

const DEFAULT_MAX_PAYLOAD_BYTES = 1024 * 1024;
const MAX_RPC_ENVELOPE_BYTES = 16 * 1024;
const MAX_UNIX_SOCKET_PATH_BYTES = 100;
const browserExtensionCommandTargetSchema = z
  .object({
    profileId: z.string().min(1).max(200),
    targetId: z.string().min(1).max(200),
    tabId: z.number().int().nonnegative(),
    windowId: z.number().int(),
  })
  .strict();
const browserExtensionCompleteCommandSchema = browserExtensionCommandTargetSchema.extend({
  commandId: z.string().min(1).max(200),
  status: z.enum(['succeeded', 'failed']),
  error: z.string().min(1).max(1000).optional(),
  tab: BrowserAttachExistingTabRequestSchema.optional(),
}).strict();

export class BrowserGatewayRpcServer {
  private readonly service: Partial<BrowserGatewayService>;
  private readonly userDataPath: string;
  private readonly isKnownLocalInstance: (instanceId: string) => boolean;
  private readonly extensionToken: string;
  private readonly maxPayloadBytes: number;
  private readonly rateLimit: { maxRequests: number; windowMs: number };
  private readonly buckets = new Map<string, number[]>();
  private server: net.Server | null = null;
  private socketPath: string | null = null;
  private socketDirToCleanup: string | null = null;

  constructor(options: BrowserGatewayRpcServerOptions = {}) {
    this.service = options.service ?? getBrowserGatewayService();
    this.userDataPath = options.userDataPath ?? app.getPath('userData');
    this.isKnownLocalInstance = options.isKnownLocalInstance ?? (() => false);
    this.extensionToken = options.extensionToken ?? crypto.randomBytes(32).toString('hex');
    this.maxPayloadBytes = options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES;
    this.rateLimit = options.rateLimit ?? { maxRequests: 30, windowMs: 10_000 };
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
    if (request.method === 'browser.extension_poll_commands') {
      return this.handleExtensionPollCommands(request);
    }
    if (request.method === 'browser.extension_complete_command') {
      return this.handleExtensionCompleteCommand(request);
    }

    const params = this.parseParams(request.params);
    if (!this.isKnownLocalInstance(params.instanceId)) {
      throw new Error('unknown browser gateway instance');
    }
    this.enforceRateLimit(params.instanceId);
    this.enforcePayloadSize(params.payload);
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
      case 'browser.open_profile':
        return this.requireMethod('openProfile')(withContext);
      case 'browser.close_profile':
        return this.requireMethod('closeProfile')(withContext);
      case 'browser.select_target':
        return this.requireMethod('selectTarget')(withContext);
      case 'browser.refresh_existing_tab':
        return this.requireMethod('refreshExistingTab')(withContext);
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
      case 'browser.upload_file':
        return this.requireMethod('uploadFile')(withContext);
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
      case 'browser.screenshot':
        return this.requireMethod('screenshot')(withContext);
      case 'browser.console_messages':
        return this.requireMethod('consoleMessages')(withContext);
      case 'browser.network_requests':
        return this.requireMethod('networkRequests')(withContext);
      case 'browser.wait_for':
        return this.requireMethod('waitFor')(withContext);
      case 'browser.health':
        return this.requireMethod('getHealth')(withContext);
      case 'browser.get_audit_log':
        return this.requireMethod('getAuditLog')(withContext);
      default:
        throw new Error(`Unknown Browser Gateway RPC method: ${request.method}`);
    }
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

  private handleExtensionPollCommands(request: BrowserGatewayRpcRequest): unknown {
    const params = this.parseAuthorizedExtensionParams(request.params);
    const result = browserExtensionCommandTargetSchema.safeParse(params.payload);
    if (!result.success) {
      throw new Error('Invalid browser gateway RPC payload');
    }
    return this.requireMethod('pollExistingTabCommand')(result.data);
  }

  private handleExtensionCompleteCommand(request: BrowserGatewayRpcRequest): unknown {
    const params = this.parseAuthorizedExtensionParams(request.params);
    const result = browserExtensionCompleteCommandSchema.safeParse(params.payload);
    if (!result.success) {
      throw new Error('Invalid browser gateway RPC payload');
    }
    const data = result.data;
    return this.requireMethod('completeExistingTabCommand')(
      data.tab && params.extensionOrigin
        ? { ...data, tab: { ...data.tab, extensionOrigin: params.extensionOrigin } }
        : data,
    );
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
    this.enforceRateLimit(`extension:${parsed.extensionOrigin ?? 'unknown'}`);
    this.enforcePayloadSize(parsed.payload);
    return parsed;
  }

  private enforcePayloadSize(payload: Record<string, unknown>): void {
    if (Buffer.byteLength(JSON.stringify(payload), 'utf-8') > this.maxPayloadBytes) {
      throw new Error('Browser Gateway RPC payload too large');
    }
  }

  private enforceRateLimit(instanceId: string): void {
    const now = Date.now();
    const bucket = (this.buckets.get(instanceId) ?? []).filter(
      (timestamp) => now - timestamp < this.rateLimit.windowMs,
    );
    if (bucket.length >= this.rateLimit.maxRequests) {
      throw new Error('Browser Gateway RPC rate limit exceeded');
    }
    bucket.push(now);
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
    const schema = (() => {
      switch (method) {
        case 'browser.create_profile':
          return BrowserCreateProfileRequestSchema;
        case 'browser.navigate':
          return BrowserNavigateRequestSchema;
        case 'browser.click':
          return BrowserClickRequestSchema;
        case 'browser.type':
          return BrowserTypeRequestSchema;
        case 'browser.fill_form':
          return BrowserFillFormRequestSchema;
        case 'browser.select':
          return BrowserSelectRequestSchema;
        case 'browser.upload_file':
          return BrowserUploadFileRequestSchema;
        case 'browser.request_grant':
          return BrowserRequestGrantRequestSchema;
        case 'browser.get_approval_status':
          return BrowserApprovalStatusRequestSchema;
        case 'browser.list_grants':
          return BrowserListGrantsRequestSchema.optional().default({});
        case 'browser.revoke_grant':
          return BrowserRevokeGrantRequestSchema;
        case 'browser.screenshot':
          return BrowserScreenshotRequestSchema;
        case 'browser.open_profile':
        case 'browser.close_profile':
          return BrowserProfileRequestSchema;
        case 'browser.list_targets':
          return BrowserListTargetsRequestSchema;
        case 'browser.select_target':
        case 'browser.refresh_existing_tab':
        case 'browser.snapshot':
        case 'browser.console_messages':
        case 'browser.network_requests':
          return BrowserTargetRequestSchema;
        case 'browser.wait_for':
          return BrowserWaitForRequestSchema;
        case 'browser.get_audit_log':
          return BrowserListAuditLogRequestSchema;
        default:
          return null;
      }
    })();
    if (!schema) {
      return payload;
    }
    const result = schema.safeParse(payload);
    if (!result.success) {
      throw new Error('Invalid browser gateway RPC payload');
    }
    return result.data as Record<string, unknown>;
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

export function _resetBrowserGatewayRpcServerForTesting(): void {
  browserGatewayRpcServer = null;
}
