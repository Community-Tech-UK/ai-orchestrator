/**
 * Codemem RPC Server (parent-side).
 *
 * Exposes the codemem MCP read surface (`find_symbol`, `find_references`,
 * `document_symbols`, `workspace_symbols`, `call_hierarchy`,
 * `find_implementations`, `hover`, `diagnostics`) over a per-app Unix-domain
 * socket. The `aio-mcp codemem` thin stdio forwarder dispatches every MCP
 * tool invocation through here, so all `better-sqlite3` access happens in
 * the parent process — keeping native modules out of the SEA dispatcher
 * runtime and letting us re-disable the `RunAsNode` Electron fuse.
 *
 * Mirrors `OrchestratorToolsRpcServer` and `BrowserGatewayRpcServer`: line-
 * delimited JSON-RPC 2.0 over 0700 Unix socket (or named pipe on Windows),
 * per-instance auth, payload-size + rate-limit caps. Each method validates
 * its payload with the same Zod schemas the existing MCP tools use, so
 * forwarder ↔ server contract stays in lockstep with the documented MCP
 * surface.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { app } from 'electron';
import { z } from 'zod';
import { registerCleanup as registerGlobalCleanup } from '../util/cleanup-registry';
import { getLogger } from '../logging/logger';
import { defaultDriverFactory } from '../db/better-sqlite3-driver';
import type { SqliteDriver } from '../db/sqlite-driver';
import { LspWorkerGateway } from '../lsp-worker/gateway-rpc';
import { AgentLspFacade } from './agent-lsp-facade';
import { CasStore } from './cas-store';
import { migrate } from './cas-schema';
import {
  CodememCallHierarchyArgsSchema,
  CodememDiagnosticsArgsSchema,
  CodememDocumentSymbolsArgsSchema,
  CodememFindReferencesArgsSchema,
  CodememFindSymbolArgsSchema,
  CodememSymbolLookupArgsSchema,
  CodememWorkspaceSymbolsArgsSchema,
} from '../../shared/validation/codemem-schemas';

const logger = getLogger('CodememRpcServer');

const DEFAULT_MAX_PAYLOAD_BYTES = 256 * 1024;
const MAX_RPC_ENVELOPE_BYTES = 16 * 1024;
const MAX_UNIX_SOCKET_PATH_BYTES = 100;

interface CodememRpcRequest {
  jsonrpc?: '2.0';
  id?: number | string | null;
  method: string;
  params?: unknown;
}

interface CodememRpcParams {
  instanceId: string;
  payload: Record<string, unknown>;
}

/** Surface the RPC server exposes — kept as a `Pick`-able interface so tests
 *  can inject a stub facade without standing up CasStore / LspWorkerGateway. */
export type CodememFacadeLike = Pick<
  AgentLspFacade,
  | 'findSymbol'
  | 'findReferences'
  | 'documentSymbols'
  | 'workspaceSymbols'
  | 'callHierarchy'
  | 'findImplementations'
  | 'hover'
  | 'diagnostics'
>;

export interface CodememRpcServerOptions {
  dbPath?: string;
  userDataPath?: string;
  isKnownLocalInstance?: (instanceId: string) => boolean;
  registerCleanup?: (cleanup: () => void | Promise<void>) => void | (() => void);
  maxPayloadBytes?: number;
  rateLimit?: {
    maxRequests: number;
    windowMs: number;
  };
  /** Inject a facade in tests so we don't touch the real DB or LSP worker. */
  facadeFactory?: () => CodememFacadeLike | Promise<CodememFacadeLike>;
}

export class CodememRpcServer {
  private readonly dbPath: string;
  private readonly userDataPath: string;
  private readonly isKnownLocalInstance: (instanceId: string) => boolean;
  private readonly maxPayloadBytes: number;
  private readonly rateLimit: { maxRequests: number; windowMs: number };
  private readonly buckets = new Map<string, number[]>();
  private readonly facadeFactory: NonNullable<CodememRpcServerOptions['facadeFactory']>;
  private readonly facadeInjected: boolean;
  private server: net.Server | null = null;
  private socketPath: string | null = null;
  private socketDirToCleanup: string | null = null;
  private db: SqliteDriver | null = null;
  private gateway: LspWorkerGateway | null = null;
  private facade: CodememFacadeLike | null = null;

  constructor(options: CodememRpcServerOptions = {}) {
    this.dbPath = options.dbPath ?? path.join(
      options.userDataPath ?? app.getPath('userData'),
      'codemem.sqlite',
    );
    this.userDataPath = options.userDataPath ?? app.getPath('userData');
    this.isKnownLocalInstance = options.isKnownLocalInstance ?? (() => false);
    this.maxPayloadBytes = options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES;
    this.rateLimit = options.rateLimit ?? { maxRequests: 60, windowMs: 10_000 };
    this.facadeInjected = options.facadeFactory !== undefined;
    this.facadeFactory = options.facadeFactory ?? (() => this.buildDefaultFacade());
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
    logger.info('Codemem RPC server listening', { socketPath: this.socketPath });
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
    if (this.gateway) {
      await this.gateway.stop();
      this.gateway = null;
    }
    if (this.db) {
      this.db.close();
      this.db = null;
    }
    this.facade = null;
  }

  getSocketPath(): string | null {
    return this.socketPath;
  }

  async handleRequest(request: CodememRpcRequest): Promise<unknown> {
    const params = this.parseParams(request.params);
    if (!this.isKnownLocalInstance(params.instanceId)) {
      throw new Error('unknown codemem instance');
    }
    this.enforceRateLimit(params.instanceId);
    this.enforcePayloadSize(params.payload);
    const facade = await this.ensureFacade();

    switch (request.method) {
      case 'codemem.find_symbol': {
        const v = CodememFindSymbolArgsSchema.parse(params.payload);
        return facade.findSymbol(v.name, v);
      }
      case 'codemem.find_references': {
        const v = CodememFindReferencesArgsSchema.parse(params.payload);
        return facade.findReferences(v.symbolId, v);
      }
      case 'codemem.document_symbols': {
        const v = CodememDocumentSymbolsArgsSchema.parse(params.payload);
        return facade.documentSymbols(v.path);
      }
      case 'codemem.workspace_symbols': {
        const v = CodememWorkspaceSymbolsArgsSchema.parse(params.payload);
        return facade.workspaceSymbols(v.query, v);
      }
      case 'codemem.call_hierarchy': {
        const v = CodememCallHierarchyArgsSchema.parse(params.payload);
        return facade.callHierarchy(v.symbolId, v);
      }
      case 'codemem.find_implementations': {
        const v = CodememSymbolLookupArgsSchema.parse(params.payload);
        return facade.findImplementations(v.symbolId, v);
      }
      case 'codemem.hover': {
        const v = CodememSymbolLookupArgsSchema.parse(params.payload);
        return facade.hover(v.symbolId, v);
      }
      case 'codemem.diagnostics': {
        const v = CodememDiagnosticsArgsSchema.parse(params.payload);
        return facade.diagnostics(v.path, v);
      }
      default:
        throw new Error(`Unknown codemem RPC method: ${request.method}`);
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
        this.writeError(socket, null, 'Codemem RPC request too large');
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
    let request: CodememRpcRequest | null = null;
    try {
      request = JSON.parse(line) as CodememRpcRequest;
      const result = await this.handleRequest(request);
      socket.end(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n`);
    } catch (error) {
      this.writeError(
        socket,
        request?.id ?? null,
        error instanceof SyntaxError
          ? 'Invalid codemem RPC request JSON'
          : error instanceof z.ZodError
            ? `Invalid codemem RPC payload: ${error.issues[0]?.message ?? 'validation failed'}`
            : error instanceof Error
              ? error.message
              : String(error),
      );
    }
  }

  private writeError(
    socket: net.Socket,
    id: CodememRpcRequest['id'],
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

  private parseParams(params: unknown): CodememRpcParams {
    if (!params || typeof params !== 'object') {
      throw new Error('Codemem RPC params are required');
    }
    const value = params as Partial<CodememRpcParams>;
    if (typeof value.instanceId !== 'string' || !value.instanceId) {
      throw new Error('Codemem RPC instanceId is required');
    }
    if (!value.payload || typeof value.payload !== 'object' || Array.isArray(value.payload)) {
      throw new Error('Codemem RPC payload is required');
    }
    return { instanceId: value.instanceId, payload: value.payload };
  }

  private enforcePayloadSize(payload: Record<string, unknown>): void {
    if (Buffer.byteLength(JSON.stringify(payload), 'utf-8') > this.maxPayloadBytes) {
      throw new Error('Codemem RPC payload too large');
    }
  }

  private enforceRateLimit(instanceId: string): void {
    const now = Date.now();
    const bucket = (this.buckets.get(instanceId) ?? []).filter(
      (timestamp) => now - timestamp < this.rateLimit.windowMs,
    );
    if (bucket.length >= this.rateLimit.maxRequests) {
      throw new Error('Codemem RPC rate limit exceeded');
    }
    bucket.push(now);
    this.buckets.set(instanceId, bucket);
  }

  private async ensureFacade(): Promise<CodememFacadeLike> {
    if (this.facade) {
      return this.facade;
    }
    this.facade = await this.facadeFactory();
    return this.facade;
  }

  private buildDefaultFacade(): CodememFacadeLike {
    if (this.facadeInjected) {
      throw new Error('buildDefaultFacade called despite facadeFactory injection');
    }
    const db = defaultDriverFactory(this.dbPath);
    migrate(db);
    this.db = db;
    const store = new CasStore(db);
    const gateway = new LspWorkerGateway();
    this.gateway = gateway;
    return new AgentLspFacade({ store, gateway });
  }

  private createSocketPath(): string {
    if (process.platform === 'win32') {
      return `\\\\.\\pipe\\codemem-${crypto.randomUUID()}`;
    }
    const id = crypto.randomUUID().replace(/-/g, '').slice(0, 12);
    const userDataSocketPath = path.join(this.userDataPath, `cm-${id}.sock`);
    if (Buffer.byteLength(userDataSocketPath, 'utf-8') <= MAX_UNIX_SOCKET_PATH_BYTES) {
      return userDataSocketPath;
    }
    const fallbackDir = path.join(os.tmpdir(), `aio-cm-${process.pid}-${id}`);
    fs.mkdirSync(fallbackDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(fallbackDir, 0o700);
    this.socketDirToCleanup = fallbackDir;
    return path.join(fallbackDir, 'cm.sock');
  }
}

let codememRpcServer: CodememRpcServer | null = null;

export function getCodememRpcServer(options: CodememRpcServerOptions = {}): CodememRpcServer {
  if (!codememRpcServer) {
    codememRpcServer = new CodememRpcServer(options);
  }
  return codememRpcServer;
}

export async function initializeCodememRpcServer(
  options: CodememRpcServerOptions = {},
): Promise<CodememRpcServer> {
  const server = getCodememRpcServer(options);
  await server.start();
  return server;
}

export function getCodememRpcSocketPath(): string | null {
  return codememRpcServer?.getSocketPath() ?? null;
}

export function _resetCodememRpcServerForTesting(): void {
  codememRpcServer = null;
}
