import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { app } from 'electron';
import {
  DesktopAccessibilitySnapshotRequestSchema,
  DesktopApprovalStatusRequestSchema,
  DesktopAuditLogRequestSchema,
  DesktopHealthRequestSchema,
  DesktopHotkeyRequestSchema,
  DesktopListAppsRequestSchema,
  DesktopListGrantsRequestSchema,
  DesktopQueryElementsRequestSchema,
  DesktopRaiseEscalationRequestSchema,
  DesktopRequestAppGrantSchema,
  DesktopRevokeGrantRequestSchema,
  DesktopScrollRequestSchema,
  DesktopScreenshotRequestSchema,
  DesktopClickRequestSchema,
  DesktopDragRequestSchema,
  DesktopTypeTextRequestSchema,
  DesktopWaitForRequestSchema,
} from '../../shared/validation/desktop-gateway-schemas';
import { registerCleanup as registerGlobalCleanup } from '../util/cleanup-registry';
import {
  getDesktopGatewayService,
  type DesktopGatewayService,
} from './desktop-gateway-service';

interface DesktopGatewayRpcRequest {
  jsonrpc?: '2.0';
  id?: number | string | null;
  method: string;
  params?: unknown;
}

interface DesktopGatewayRpcParams {
  instanceId: string;
  provider?: string;
  payload: Record<string, unknown>;
}

export interface DesktopGatewayRpcServerOptions {
  service?: Partial<DesktopGatewayService>;
  userDataPath?: string;
  isKnownLocalInstance?: (instanceId: string) => boolean;
  registerCleanup?: (cleanup: () => void | Promise<void>) => void | (() => void);
  maxPayloadBytes?: number;
  rateLimit?: {
    maxRequests: number;
    maxBytes?: number;
    windowMs: number;
  };
}

const DEFAULT_MAX_PAYLOAD_BYTES = 512 * 1024;
const MAX_RPC_ENVELOPE_BYTES = 16 * 1024;
const MAX_UNIX_SOCKET_PATH_BYTES = 100;

interface DesktopGatewayRateBucketEntry {
  timestamp: number;
  bytes: number;
}

export class DesktopGatewayRpcServer {
  private readonly service: Partial<DesktopGatewayService>;
  private readonly userDataPath: string;
  private readonly isKnownLocalInstance: (instanceId: string) => boolean;
  private readonly maxPayloadBytes: number;
  private readonly rateLimit: { maxRequests: number; maxBytes: number; windowMs: number };
  private readonly buckets = new Map<string, DesktopGatewayRateBucketEntry[]>();
  private server: net.Server | null = null;
  private socketPath: string | null = null;
  private socketDirToCleanup: string | null = null;

  constructor(options: DesktopGatewayRpcServerOptions = {}) {
    this.service = options.service ?? getDesktopGatewayService();
    this.userDataPath = options.userDataPath ?? app?.getPath?.('userData') ?? os.tmpdir();
    this.isKnownLocalInstance = options.isKnownLocalInstance ?? (() => false);
    this.maxPayloadBytes = options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES;
    this.rateLimit = {
      maxRequests: options.rateLimit?.maxRequests ?? 60,
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

  async handleRequest(request: DesktopGatewayRpcRequest): Promise<unknown> {
    const params = this.parseParams(request.params);
    if (!this.isKnownLocalInstance(params.instanceId)) {
      throw new Error('unknown computer-use instance');
    }
    const payloadBytes = this.enforcePayloadSize(params.payload);
    this.enforceRateLimit(params.instanceId, payloadBytes);
    const payload = this.validatePayload(request.method, params.payload);
    const context = {
      instanceId: params.instanceId,
      ...(params.provider ? { provider: params.provider } : {}),
    };

    switch (request.method) {
      case 'computer.health':
        return this.requireMethod('health')(context, payload);
      case 'computer.list_apps':
        return this.requireMethod('listApps')(context, payload);
      case 'computer.request_app_grant':
        return this.requireMethod('requestAppGrant')(context, payload);
      case 'computer.get_approval_status':
        return this.requireMethod('getApprovalStatus')(context, payload);
      case 'computer.screenshot':
        return this.requireMethod('screenshot')(context, payload);
      case 'computer.accessibility_snapshot':
        return this.requireMethod('accessibilitySnapshot')(context, payload);
      case 'computer.click':
        return this.requireMethod('click')(context, payload);
      case 'computer.type_text':
        return this.requireMethod('typeText')(context, payload);
      case 'computer.hotkey':
        return this.requireMethod('hotkey')(context, payload);
      case 'computer.scroll':
        return this.requireMethod('scroll')(context, payload);
      case 'computer.drag':
        return this.requireMethod('drag')(context, payload);
      case 'computer.wait_for':
        return this.requireMethod('waitFor')(context, payload);
      case 'computer.query_elements':
        return this.requireMethod('queryElements')(context, payload);
      case 'computer.list_grants':
        return this.requireMethod('listGrants')(context, payload);
      case 'computer.revoke_grant':
        return this.requireMethod('revokeGrant')(context, payload);
      case 'computer.get_audit_log':
        return this.requireMethod('getAuditLog')(context, payload);
      case 'computer.raise_escalation':
        return this.requireMethod('raiseEscalation')(context, payload);
      default:
        throw new Error(`Unknown computer-use RPC method: ${request.method}`);
    }
  }

  private handleSocket(socket: net.Socket): void {
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf-8');
      if (Buffer.byteLength(buffer, 'utf-8') > this.maxPayloadBytes + MAX_RPC_ENVELOPE_BYTES) {
        this.writeError(socket, null, 'Computer Use RPC payload too large');
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
    let request: DesktopGatewayRpcRequest | null = null;
    try {
      request = JSON.parse(line) as DesktopGatewayRpcRequest;
      const result = await this.handleRequest(request);
      socket.end(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n`);
    } catch (error) {
      this.writeError(
        socket,
        request?.id ?? null,
        error instanceof SyntaxError
          ? 'Invalid Computer Use RPC request JSON'
          : error instanceof Error
            ? error.message
            : String(error),
      );
    }
  }

  private writeError(
    socket: net.Socket,
    id: DesktopGatewayRpcRequest['id'],
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

  private parseParams(params: unknown): DesktopGatewayRpcParams {
    if (!params || typeof params !== 'object') {
      throw new Error('Computer Use RPC params are required');
    }
    const value = params as Partial<DesktopGatewayRpcParams>;
    if (typeof value.instanceId !== 'string' || !value.instanceId) {
      throw new Error('Computer Use RPC instanceId is required');
    }
    if (!value.payload || typeof value.payload !== 'object' || Array.isArray(value.payload)) {
      throw new Error('Computer Use RPC payload is required');
    }
    const parsed = {
      instanceId: value.instanceId,
      payload: value.payload,
    };
    return typeof value.provider === 'string' && value.provider
      ? { ...parsed, provider: value.provider }
      : parsed;
  }

  private enforcePayloadSize(payload: Record<string, unknown>): number {
    const payloadBytes = Buffer.byteLength(JSON.stringify(payload), 'utf-8');
    if (payloadBytes > this.maxPayloadBytes) {
      throw new Error('Computer Use RPC payload too large');
    }
    return payloadBytes;
  }

  private enforceRateLimit(instanceId: string, payloadBytes: number): void {
    const now = Date.now();
    const bucket = (this.buckets.get(instanceId) ?? []).filter(
      (entry) => now - entry.timestamp < this.rateLimit.windowMs,
    );
    if (bucket.length >= this.rateLimit.maxRequests) {
      throw new Error('Computer Use RPC rate limit exceeded');
    }
    const bytesInWindow = bucket.reduce((total, entry) => total + entry.bytes, 0);
    if (bytesInWindow + payloadBytes > this.rateLimit.maxBytes) {
      throw new Error('Computer Use RPC byte rate limit exceeded');
    }
    bucket.push({ timestamp: now, bytes: payloadBytes });
    this.buckets.set(instanceId, bucket);
  }

  private validatePayload(method: string, payload: Record<string, unknown>): Record<string, unknown> {
    const schema = (() => {
      switch (method) {
        case 'computer.health':
          return DesktopHealthRequestSchema;
        case 'computer.list_apps':
          return DesktopListAppsRequestSchema;
        case 'computer.request_app_grant':
          return DesktopRequestAppGrantSchema;
        case 'computer.get_approval_status':
          return DesktopApprovalStatusRequestSchema;
        case 'computer.screenshot':
          return DesktopScreenshotRequestSchema;
        case 'computer.accessibility_snapshot':
          return DesktopAccessibilitySnapshotRequestSchema;
        case 'computer.click':
          return DesktopClickRequestSchema;
        case 'computer.type_text':
          return DesktopTypeTextRequestSchema;
        case 'computer.hotkey':
          return DesktopHotkeyRequestSchema;
        case 'computer.scroll':
          return DesktopScrollRequestSchema;
        case 'computer.drag':
          return DesktopDragRequestSchema;
        case 'computer.wait_for':
          return DesktopWaitForRequestSchema;
        case 'computer.query_elements':
          return DesktopQueryElementsRequestSchema;
        case 'computer.list_grants':
          return DesktopListGrantsRequestSchema;
        case 'computer.revoke_grant':
          return DesktopRevokeGrantRequestSchema;
        case 'computer.get_audit_log':
          return DesktopAuditLogRequestSchema;
        case 'computer.raise_escalation':
          return DesktopRaiseEscalationRequestSchema;
        default:
          return null;
      }
    })();
    if (!schema) {
      return payload;
    }
    const result = schema.safeParse(payload);
    if (!result.success) {
      throw new Error('Invalid computer-use RPC payload');
    }
    return result.data as Record<string, unknown>;
  }

  private createSocketPath(): string {
    if (process.platform === 'win32') {
      return `\\\\.\\pipe\\computer-use-${crypto.randomUUID()}`;
    }
    const id = crypto.randomUUID().replace(/-/g, '').slice(0, 12);
    const userDataSocketPath = path.join(this.userDataPath, `cu-${id}.sock`);
    if (Buffer.byteLength(userDataSocketPath, 'utf-8') <= MAX_UNIX_SOCKET_PATH_BYTES) {
      return userDataSocketPath;
    }
    const fallbackDir = path.join(os.tmpdir(), `aio-cu-${process.pid}-${id}`);
    fs.mkdirSync(fallbackDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(fallbackDir, 0o700);
    this.socketDirToCleanup = fallbackDir;
    return path.join(fallbackDir, 'cu.sock');
  }

  private requireMethod(name: keyof DesktopGatewayService): (
    context: Record<string, unknown>,
    payload: Record<string, unknown>,
  ) => unknown {
    const method = this.service[name];
    if (typeof method !== 'function') {
      throw new Error(`Computer Use service method unavailable: ${String(name)}`);
    }
    return method.bind(this.service) as unknown as (
      context: Record<string, unknown>,
      payload: Record<string, unknown>,
    ) => unknown;
  }
}

let desktopGatewayRpcServer: DesktopGatewayRpcServer | null = null;

export function getDesktopGatewayRpcServer(
  options: DesktopGatewayRpcServerOptions = {},
): DesktopGatewayRpcServer {
  if (!desktopGatewayRpcServer) {
    desktopGatewayRpcServer = new DesktopGatewayRpcServer(options);
  }
  return desktopGatewayRpcServer;
}

export async function initializeDesktopGatewayRpcServer(
  options: DesktopGatewayRpcServerOptions = {},
): Promise<DesktopGatewayRpcServer> {
  const server = getDesktopGatewayRpcServer(options);
  await server.start();
  return server;
}

export function getDesktopGatewayRpcSocketPath(): string | null {
  return desktopGatewayRpcServer?.getSocketPath() ?? null;
}

export function _resetDesktopGatewayRpcServerForTesting(): void {
  desktopGatewayRpcServer = null;
}
