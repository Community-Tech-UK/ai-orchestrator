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
const EXTENSION_CONTACT_LOST_MS = 90_000;
const POLL_HEARTBEAT_INTERVAL = 500;
// Headroom the poll-forward RPC gets beyond the coordinator's poll hold window
// (network round trip + a loaded coordinator's reply lag).
const POLL_FORWARD_TIMEOUT_BUFFER_MS = 10_000;
// Command-result re-send: 3s/6s/12s/24s backoff, then give up (the
// coordinator-side command has timed out well before then).
const COMMAND_RESULT_RETRY_BASE_MS = 3_000;
const COMMAND_RESULT_MAX_RETRIES = 4;

export interface WorkerExtensionRelayOptions {
  config: WorkerExtensionRelayConfig;
  sendRequest: (method: string, params: Record<string, unknown>, timeoutMs?: number) => Promise<unknown>;
  logger?: Pick<Console, 'info' | 'warn'>;
  now?: () => number;
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

type WorkerExtensionRelayRegistrationSummary = Pick<
  WorkerNodeExtensionRelaySummary,
  'registration' | 'lastRegistrationCheckAt' | 'manifestPath' | 'registrationError'
>;

export class WorkerExtensionRelay {
  private server: net.Server | null = null;
  private stopped = false;
  private readonly retryTimers = new Set<ReturnType<typeof setTimeout>>();
  private config: WorkerExtensionRelayConfig;
  private readonly sendRequest: WorkerExtensionRelayOptions['sendRequest'];
  private readonly logger: Pick<Console, 'info' | 'warn'>;
  private readonly now: () => number;
  private registrationSummary: WorkerExtensionRelayRegistrationSummary | undefined;
  private lastExtensionContactAt: number | undefined;
  private extensionVersion: string | undefined;
  private extensionReloadedAt: number | undefined;
  private extensionContactState: 'never' | 'active' | 'lost' = 'never';
  private authenticatedPollCount = 0;

  constructor(options: WorkerExtensionRelayOptions) {
    this.config = options.config;
    this.sendRequest = options.sendRequest;
    this.logger = options.logger ?? console;
    this.now = options.now ?? Date.now;
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
    this.stopped = false;
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
          this.logger.warn('[WorkerExtensionRelay] Relay socket already has a listener', { socketPath });
          resolve();
          return;
        }
        reject(error);
      };
      server.on('error', onError);
      server.listen(socketPath, () => {
        server.off('error', onError);
        this.server = server;
        this.logger.info('[WorkerExtensionRelay] Relay started', { socketPath });
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    // Ordering matters: a retry timer that already fired removed itself from
    // retryTimers and is awaiting sendRequest — when that send rejects, its
    // .catch would schedule a FRESH timer after this clear. The stopped flag
    // gates scheduleCommandResultRetry so the resurrection is impossible.
    this.stopped = true;
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
    this.logger.info('[WorkerExtensionRelay] Relay stopped', { socketPath: this.getSocketPath() });
  }

  async reconfigure(config: WorkerExtensionRelayConfig): Promise<void> {
    await this.stop();
    this.config = config;
    await this.start();
  }

  setRegistrationSummary(summary: WorkerExtensionRelayRegistrationSummary | undefined): void {
    this.registrationSummary = summary;
  }

  getSummary(): WorkerNodeExtensionRelaySummary | undefined {
    this.updateExtensionContactHealth(this.now());
    if (!this.config.enabled) {
      return this.config
        ? {
            enabled: false,
            running: false,
            ...(this.config.socketPath ? { socketPath: this.config.socketPath } : {}),
            ...(this.registrationSummary ?? {}),
          }
        : undefined;
    }
    return {
      enabled: true,
      running: this.isRunning(),
      socketPath: this.getSocketPath(),
      ...(this.registrationSummary ?? {}),
      ...(this.extensionVersion ? { extensionVersion: this.extensionVersion } : {}),
      ...(this.extensionReloadedAt !== undefined
        ? { extensionReloadedAt: this.extensionReloadedAt }
        : {}),
      ...(this.lastExtensionContactAt !== undefined
        ? { lastExtensionContactAt: this.lastExtensionContactAt }
        : {}),
    };
  }

  async handleExtensionRpcRequest(request: ExtensionRpcRequest): Promise<unknown> {
    const params = this.parseAuthorizedParams(request.params);
    this.recordExtensionRuntimeEvidence(params.payload);
    switch (request.method) {
      case 'browser.extension_attach_tab':
        this.recordExtensionContact();
        return this.sendRequest(
          NODE_TO_COORDINATOR.BROWSER_EXT_ATTACH_TAB,
          {
            ...(params.extensionOrigin ? { extensionOrigin: params.extensionOrigin } : {}),
            payload: params.payload,
          },
        );
      case 'browser.extension_poll_command':
        this.recordExtensionContact();
        this.recordPollHeartbeat();
        return this.forwardPollCommand(params);
      case 'browser.extension_command_result':
        this.recordExtensionContact();
        return this.forwardCommandResult(params);
      case 'browser.extension_command_received':
        this.recordExtensionContact();
        return this.forwardCommandReceived(params);
      case 'browser.extension_disconnected':
        // Deliberately NOT recorded as fresh contact — the channel just died.
        return this.forwardDisconnected(params);
      default:
        throw new Error(`unknown_extension_relay_method:${request.method ?? ''}`);
    }
  }

  private async forwardPollCommand(params: AuthorizedExtensionParams): Promise<unknown> {
    const pollPayload = this.pollCommandPayload(params.payload);
    const payload = {
      ...(params.extensionOrigin ? { extensionOrigin: params.extensionOrigin } : {}),
      ...pollPayload,
    };
    // The coordinator can hold this long-poll for the extension's requested
    // window before answering. The RPC timeout must comfortably OUTLIVE that
    // hold: if the relay gives up first, a command handed to the abandoned
    // poll response at the last moment is silently dropped — it never reaches
    // the extension, and the caller only learns via a much later command
    // timeout. Seen under coordinator load, where a reply can lag well past
    // the poll window.
    const pollWindowMs = typeof pollPayload['timeoutMs'] === 'number'
      ? pollPayload['timeoutMs']
      : 10_000;
    try {
      return await this.sendRequest(
        NODE_TO_COORDINATOR.BROWSER_EXT_POLL_COMMAND,
        payload,
        pollWindowMs + POLL_FORWARD_TIMEOUT_BUFFER_MS,
      );
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
      this.scheduleCommandResultRetry(payload, 0);
      return { ok: true, queued: true };
    }
  }

  private async forwardCommandReceived(params: AuthorizedExtensionParams): Promise<unknown> {
    const commandId = params.payload['commandId'];
    if (typeof commandId !== 'string' || !commandId) {
      throw new Error('invalid_extension_relay_command_received');
    }
    const payload = {
      ...(params.extensionOrigin ? { extensionOrigin: params.extensionOrigin } : {}),
      commandId,
    };
    // Best-effort: a lost receipt only degrades the coordinator's diagnosis
    // (receipt-missing instead of maybe-applied), never correctness.
    try {
      return await this.sendRequest(NODE_TO_COORDINATOR.BROWSER_EXT_COMMAND_RECEIVED, payload);
    } catch {
      return { ok: false };
    }
  }

  private async forwardDisconnected(params: AuthorizedExtensionParams): Promise<unknown> {
    const reason = params.payload['reason'];
    const payload = {
      ...(params.extensionOrigin ? { extensionOrigin: params.extensionOrigin } : {}),
      ...(typeof reason === 'string' && reason ? { reason } : {}),
    };
    try {
      return await this.sendRequest(NODE_TO_COORDINATOR.BROWSER_EXT_DISCONNECTED, payload);
    } catch {
      return { ok: false };
    }
  }

  private shouldRetryCommandResult(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return !message.startsWith('RPC error ');
  }

  /**
   * An executed command's result must not evaporate because one RPC failed —
   * the coordinator would misreport real work as "maybe applied". Re-send with
   * backoff until the coordinator acks or the attempts are exhausted
   * (3s/6s/12s/24s ≈ 45s — beyond that the coordinator-side command has timed
   * out anyway and resolveCommand becomes a no-op, which keeps re-sends
   * idempotent and duplicate-safe).
   */
  private scheduleCommandResultRetry(payload: Record<string, unknown>, attempt: number): void {
    if (this.stopped) {
      return;
    }
    if (attempt >= COMMAND_RESULT_MAX_RETRIES) {
      this.logger.warn('[WorkerExtensionRelay] Dropping command result after exhausted retries', {
        commandId: payload['commandId'],
        attempts: attempt,
      });
      return;
    }
    const timer = setTimeout(() => {
      this.retryTimers.delete(timer);
      void this.sendRequest(NODE_TO_COORDINATOR.BROWSER_EXT_COMMAND_RESULT, payload)
        .catch((error: unknown) => {
          if (!this.shouldRetryCommandResult(error)) {
            return;
          }
          this.scheduleCommandResultRetry(payload, attempt + 1);
        });
    }, COMMAND_RESULT_RETRY_BASE_MS * 2 ** attempt);
    this.retryTimers.add(timer);
  }

  private clearRetryTimers(): void {
    for (const timer of this.retryTimers) {
      clearTimeout(timer);
    }
    this.retryTimers.clear();
  }

  private recordExtensionContact(): void {
    const contactedAt = this.now();
    this.updateExtensionContactHealth(contactedAt);
    const previousState = this.extensionContactState;
    this.lastExtensionContactAt = contactedAt;
    if (previousState === 'never') {
      this.logger.info('[WorkerExtensionRelay] Browser extension first contact', {
        socketPath: this.getSocketPath(),
        lastExtensionContactAt: contactedAt,
      });
    } else if (previousState === 'lost') {
      this.logger.info('[WorkerExtensionRelay] Browser extension contact resumed', {
        socketPath: this.getSocketPath(),
        lastExtensionContactAt: contactedAt,
      });
    }
    this.extensionContactState = 'active';
  }

  private recordExtensionRuntimeEvidence(payload: Record<string, unknown>): void {
    const version = payload['extensionVersion'];
    if (typeof version === 'string' && version.length > 0) {
      this.extensionVersion = version;
    }
    const startedAt = payload['extensionStartedAt'];
    if (typeof startedAt === 'number' && Number.isFinite(startedAt) && startedAt >= 0) {
      this.extensionReloadedAt = Math.floor(startedAt);
    }
  }

  private updateExtensionContactHealth(now: number): void {
    if (
      this.lastExtensionContactAt === undefined
      || this.extensionContactState !== 'active'
      || now - this.lastExtensionContactAt <= EXTENSION_CONTACT_LOST_MS
    ) {
      return;
    }
    this.extensionContactState = 'lost';
    this.logger.warn('[WorkerExtensionRelay] Browser extension contact lost', {
      socketPath: this.getSocketPath(),
      lastExtensionContactAt: this.lastExtensionContactAt,
      staleForMs: now - this.lastExtensionContactAt - EXTENSION_CONTACT_LOST_MS,
    });
  }

  private recordPollHeartbeat(): void {
    this.authenticatedPollCount += 1;
    if (this.authenticatedPollCount % POLL_HEARTBEAT_INTERVAL !== 0) {
      return;
    }
    this.logger.info('[WorkerExtensionRelay] Browser extension poll heartbeat', {
      socketPath: this.getSocketPath(),
      pollCount: this.authenticatedPollCount,
      lastExtensionContactAt: this.lastExtensionContactAt,
    });
  }

  private handleSocket(socket: net.Socket): void {
    let buffer = '';
    // The extension client can vanish at any moment (browser shutdown, pipe
    // teardown). Without an error listener, a write EPIPE/ECONNRESET on this
    // socket becomes an unhandled 'error' event and crashes the whole worker.
    socket.on('error', (error: NodeJS.ErrnoException) => {
      this.logger.warn('[WorkerExtensionRelay] Relay client socket error', {
        code: error.code,
        message: error.message,
      });
    });
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
      this.endSocket(socket, `${JSON.stringify({ jsonrpc: '2.0', id: request.id ?? null, result })}\n`);
    } catch (error) {
      this.writeError(
        socket,
        request?.id ?? null,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private writeError(socket: net.Socket, id: string | number | null, message: string): void {
    this.endSocket(socket, `${JSON.stringify({
      jsonrpc: '2.0',
      id,
      error: { code: -32603, message },
    })}\n`);
  }

  private endSocket(socket: net.Socket, data: string): void {
    if (socket.destroyed || socket.writableEnded) {
      return;
    }
    socket.end(data);
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
      this.logger.warn('[WorkerExtensionRelay] Relay socket already has a listener', { socketPath });
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
