import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import { NODE_TO_COORDINATOR } from '../main/remote-node/worker-node-rpc';
import {
  defaultExtensionRelaySocketPath,
  type WorkerExtensionRelayConfig,
} from './worker-config';
import type { WorkerNodeExtensionRelaySummary } from '../shared/types/worker-node.types';

const MAX_RELAY_PAYLOAD_BYTES = 4 * 1024 * 1024;

export interface WorkerExtensionRelayOptions {
  config: WorkerExtensionRelayConfig;
  sendRequest: (method: string, params: Record<string, unknown>, timeoutMs?: number) => Promise<unknown>;
}

interface ExtensionRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: unknown;
}

interface AuthorizedExtensionParams {
  extensionOrigin?: string;
  payload: Record<string, unknown>;
}

export class WorkerExtensionRelay {
  private server: net.Server | null = null;
  private readonly retryTimers = new Set<ReturnType<typeof setTimeout>>();
  private config: WorkerExtensionRelayConfig;
  private readonly sendRequest: WorkerExtensionRelayOptions['sendRequest'];

  constructor(options: WorkerExtensionRelayOptions) {
    this.config = options.config;
    this.sendRequest = options.sendRequest;
  }

  getSocketPath(): string {
    return this.config.socketPath ?? defaultExtensionRelaySocketPath();
  }

  getExtensionToken(): string | undefined {
    return this.config.extensionToken;
  }

  isEnabled(): boolean {
    return this.config.enabled === true;
  }

  isRunning(): boolean {
    return Boolean(this.server?.listening);
  }

  async start(): Promise<void> {
    if (!this.isEnabled() || this.server) {
      return;
    }
    if (!this.config.extensionToken) {
      throw new Error('extension_relay_token_missing');
    }

    const socketPath = this.getSocketPath();
    if (!(await this.prepareSocketPath(socketPath))) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const server = net.createServer((socket) => this.handleSocket(socket));
      const onError = (error: NodeJS.ErrnoException) => {
        server.off('error', onError);
        if (error.code === 'EADDRINUSE') {
          console.warn('[WorkerExtensionRelay] Relay socket already has a listener', { socketPath });
          resolve();
          return;
        }
        reject(error);
      };
      server.on('error', onError);
      server.listen(socketPath, () => {
        server.off('error', onError);
        this.server = server;
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    this.clearRetryTimers();
    const server = this.server;
    this.server = null;
    if (!server) {
      return;
    }
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    if (process.platform !== 'win32') {
      try {
        fs.unlinkSync(this.getSocketPath());
      } catch {
        // Socket file is already gone.
      }
    }
  }

  async reconfigure(config: WorkerExtensionRelayConfig): Promise<void> {
    await this.stop();
    this.config = config;
    await this.start();
  }

  getSummary(): WorkerNodeExtensionRelaySummary | undefined {
    if (!this.config.enabled) {
      return this.config
        ? { enabled: false, running: false, ...(this.config.socketPath ? { socketPath: this.config.socketPath } : {}) }
        : undefined;
    }
    return {
      enabled: true,
      running: this.isRunning(),
      socketPath: this.getSocketPath(),
    };
  }

  async handleExtensionRpcRequest(request: ExtensionRpcRequest): Promise<unknown> {
    const params = this.parseAuthorizedParams(request.params);
    switch (request.method) {
      case 'browser.extension_attach_tab':
        return this.sendRequest(
          NODE_TO_COORDINATOR.BROWSER_EXT_ATTACH_TAB,
          {
            ...(params.extensionOrigin ? { extensionOrigin: params.extensionOrigin } : {}),
            payload: params.payload,
          },
        );
      case 'browser.extension_poll_command':
        return this.forwardPollCommand(params);
      case 'browser.extension_command_result':
        return this.forwardCommandResult(params);
      default:
        throw new Error(`unknown_extension_relay_method:${request.method ?? ''}`);
    }
  }

  private async forwardPollCommand(params: AuthorizedExtensionParams): Promise<unknown> {
    const payload = {
      ...(params.extensionOrigin ? { extensionOrigin: params.extensionOrigin } : {}),
      ...this.pollCommandPayload(params.payload),
    };
    try {
      return await this.sendRequest(NODE_TO_COORDINATOR.BROWSER_EXT_POLL_COMMAND, payload, 15_000);
    } catch {
      return null;
    }
  }

  private async forwardCommandResult(params: AuthorizedExtensionParams): Promise<unknown> {
    const payload = {
      ...(params.extensionOrigin ? { extensionOrigin: params.extensionOrigin } : {}),
      ...this.commandResultPayload(params.payload),
    };
    try {
      return await this.sendRequest(NODE_TO_COORDINATOR.BROWSER_EXT_COMMAND_RESULT, payload);
    } catch (error) {
      if (!this.shouldRetryCommandResult(error)) {
        throw error;
      }
      this.scheduleCommandResultRetry(payload);
      return { ok: true, queued: true };
    }
  }

  private shouldRetryCommandResult(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return !message.startsWith('RPC error ');
  }

  private scheduleCommandResultRetry(payload: Record<string, unknown>): void {
    const timer = setTimeout(() => {
      this.retryTimers.delete(timer);
      void this.sendRequest(NODE_TO_COORDINATOR.BROWSER_EXT_COMMAND_RESULT, payload).catch(() => undefined);
    }, 3_000);
    this.retryTimers.add(timer);
  }

  private clearRetryTimers(): void {
    for (const timer of this.retryTimers) {
      clearTimeout(timer);
    }
    this.retryTimers.clear();
  }

  private handleSocket(socket: net.Socket): void {
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      if (Buffer.byteLength(buffer, 'utf8') > MAX_RELAY_PAYLOAD_BYTES) {
        this.writeError(socket, null, 'extension_relay_payload_too_large');
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
    let request: ExtensionRpcRequest | null = null;
    try {
      request = JSON.parse(line) as ExtensionRpcRequest;
      const result = await this.handleExtensionRpcRequest(request);
      socket.end(`${JSON.stringify({ jsonrpc: '2.0', id: request.id ?? null, result })}\n`);
    } catch (error) {
      this.writeError(
        socket,
        request?.id ?? null,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private writeError(socket: net.Socket, id: string | number | null, message: string): void {
    socket.end(`${JSON.stringify({
      jsonrpc: '2.0',
      id,
      error: { code: -32603, message },
    })}\n`);
  }

  private parseAuthorizedParams(params: unknown): AuthorizedExtensionParams {
    if (!params || typeof params !== 'object') {
      throw new Error('invalid_extension_relay_params');
    }
    const record = params as Record<string, unknown>;
    if (record['extensionToken'] !== this.config.extensionToken) {
      throw new Error('invalid_extension_relay_token');
    }
    const payload = record['payload'];
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new Error('invalid_extension_relay_payload');
    }
    const extensionOrigin = record['extensionOrigin'];
    return {
      ...(typeof extensionOrigin === 'string' && extensionOrigin
        ? { extensionOrigin }
        : {}),
      payload: payload as Record<string, unknown>,
    };
  }

  private pollCommandPayload(payload: Record<string, unknown>): Record<string, unknown> {
    const timeoutMs = payload['timeoutMs'];
    if (timeoutMs === undefined) {
      return {};
    }
    if (typeof timeoutMs !== 'number') {
      throw new Error('invalid_extension_relay_poll_timeout');
    }
    return { timeoutMs };
  }

  private commandResultPayload(payload: Record<string, unknown>): Record<string, unknown> {
    const commandId = payload['commandId'];
    const ok = payload['ok'];
    if (typeof commandId !== 'string' || typeof ok !== 'boolean') {
      throw new Error('invalid_extension_relay_command_result');
    }
    return {
      commandId,
      ok,
      ...(Object.prototype.hasOwnProperty.call(payload, 'result')
        ? { result: payload['result'] }
        : {}),
      ...(typeof payload['error'] === 'string' && payload['error']
        ? { error: payload['error'] }
        : {}),
    };
  }

  private async prepareSocketPath(socketPath: string): Promise<boolean> {
    if (process.platform === 'win32') {
      return true;
    }
    fs.mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o700 });
    if (!fs.existsSync(socketPath)) {
      return true;
    }
    if (await this.hasLiveUnixSocket(socketPath)) {
      console.warn('[WorkerExtensionRelay] Relay socket already has a listener', { socketPath });
      return false;
    }
    try {
      fs.unlinkSync(socketPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
    return true;
  }

  private hasLiveUnixSocket(socketPath: string): Promise<boolean> {
    return new Promise<boolean>((resolve, reject) => {
      const socket = net.createConnection(socketPath);
      const finish = (result: boolean, error?: Error) => {
        socket.removeAllListeners();
        socket.destroy();
        if (error) {
          reject(error);
          return;
        }
        resolve(result);
      };
      socket.once('connect', () => finish(true));
      socket.once('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'ECONNREFUSED' || error.code === 'ENOENT') {
          finish(false);
          return;
        }
        finish(false, error);
      });
      socket.setTimeout(250, () => finish(true));
    });
  }
}

export function defaultWorkerExtensionRelaySocketPath(): string {
  return defaultExtensionRelaySocketPath();
}
