/**
 * Orchestrator-Tools RPC Server (parent-side).
 *
 * Exposes the orchestrator-tools MCP surface (currently just `git_batch_pull`)
 * over a per-app Unix-domain socket. Thin stdio forwarders running inside the
 * `aio-mcp` Node SEA dispatch tool invocations here so that all database +
 * git work happens in the parent process — keeping native modules
 * (better-sqlite3 in particular) out of the spawned child runtime and
 * letting us re-disable the `RunAsNode` Electron fuse.
 *
 * Mirrors the established `BrowserGatewayRpcServer` pattern: line-delimited
 * JSON-RPC 2.0 over a 0700 Unix socket (or a Windows named pipe), per-instance
 * auth, payload-size and rate-limit caps. Tool handlers are reused as-is from
 * `createOrchestratorToolDefinitions` so the wire surface is one method per
 * MCP tool (currently `orchestrator_tools.git_batch_pull`).
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { app } from 'electron';
import { registerCleanup as registerGlobalCleanup } from '../util/cleanup-registry';
import { getLogger } from '../logging/logger';
import { defaultDriverFactory } from '../db/better-sqlite3-driver';
import type { SqliteDriver } from '../db/sqlite-driver';
import type { ConversationLedgerService } from '../conversation-ledger';
import { createOperatorTables } from '../operator/operator-schema';
import { defaultOperatorDbPath } from '../operator/operator-database';
import {
  createLedgerForOrchestratorTools,
  createOrchestratorToolDefinitions,
  GitBatchPullArgsSchema,
} from './orchestrator-tools';
import type { McpServerToolDefinition } from './mcp-server-tools';

const logger = getLogger('OrchestratorToolsRpcServer');

const DEFAULT_MAX_PAYLOAD_BYTES = 256 * 1024;
const MAX_RPC_ENVELOPE_BYTES = 16 * 1024;
const MAX_UNIX_SOCKET_PATH_BYTES = 100;

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

export interface OrchestratorToolsRpcServerOptions {
  operatorDbPath?: string;
  conversationLedgerDbPath?: string;
  userDataPath?: string;
  isKnownLocalInstance?: (instanceId: string) => boolean;
  registerCleanup?: (cleanup: () => void | Promise<void>) => void | (() => void);
  maxPayloadBytes?: number;
  rateLimit?: {
    maxRequests: number;
    windowMs: number;
  };
  /** Inject the tool factory in tests so we can avoid touching the real DB. */
  toolFactory?: (deps: {
    db: SqliteDriver;
    ledger: ConversationLedgerService | null;
    instanceId: string | null;
  }) => McpServerToolDefinition[];
}

export class OrchestratorToolsRpcServer {
  private readonly operatorDbPath: string;
  private readonly conversationLedgerDbPath: string | null;
  private readonly userDataPath: string;
  private readonly isKnownLocalInstance: (instanceId: string) => boolean;
  private readonly maxPayloadBytes: number;
  private readonly rateLimit: { maxRequests: number; windowMs: number };
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
    this.conversationLedgerDbPath = options.conversationLedgerDbPath ?? null;
    this.userDataPath = options.userDataPath ?? app.getPath('userData');
    this.isKnownLocalInstance = options.isKnownLocalInstance ?? (() => false);
    this.maxPayloadBytes = options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES;
    this.rateLimit = options.rateLimit ?? { maxRequests: 30, windowMs: 10_000 };
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
    if (this.ledger) {
      this.ledger.close();
      this.ledger = null;
    }
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
      default:
        throw new Error(`Unknown orchestrator-tools RPC method: ${request.method}`);
    }
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
    if (this.conversationLedgerDbPath) {
      this.ledger = createLedgerForOrchestratorTools(this.conversationLedgerDbPath);
    }
  }

  private getToolsForInstance(instanceId: string): McpServerToolDefinition[] {
    if (this.toolFactoryInjected) {
      // Tests inject a factory that ignores its `db`/`ledger` args; opening
      // the real operator DB here would defeat the point of injection.
      return this.toolFactory({
        db: null as unknown as SqliteDriver,
        ledger: null,
        instanceId,
      });
    }
    this.ensureRuntimeReady();
    if (!this.db) {
      throw new Error('Orchestrator-tools runtime failed to initialize');
    }
    return this.toolFactory({
      db: this.db,
      ledger: this.ledger,
      instanceId,
    });
  }

  private createSocketPath(): string {
    if (process.platform === 'win32') {
      return `\\\\.\\pipe\\orchestrator-tools-${crypto.randomUUID()}`;
    }
    const id = crypto.randomUUID().replace(/-/g, '').slice(0, 12);
    const userDataSocketPath = path.join(this.userDataPath, `ot-${id}.sock`);
    if (Buffer.byteLength(userDataSocketPath, 'utf-8') <= MAX_UNIX_SOCKET_PATH_BYTES) {
      return userDataSocketPath;
    }
    const fallbackDir = path.join(os.tmpdir(), `aio-ot-${process.pid}-${id}`);
    fs.mkdirSync(fallbackDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(fallbackDir, 0o700);
    this.socketDirToCleanup = fallbackDir;
    return path.join(fallbackDir, 'ot.sock');
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
