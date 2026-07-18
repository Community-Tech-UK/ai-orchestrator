/**
 * Codex App-Server Client
 *
 * JSON-RPC 2.0 client for the `codex app-server` persistent server.
 * Supports two transport modes:
 *   1. Direct: spawns `codex app-server` as a child process (stdio pipes)
 *   2. Broker: connects to a shared broker via Unix socket (or Windows named pipe)
 *
 * Derived from the codex-plugin-cc reference implementation (app-server.mjs).
 */

import { ChildProcess, spawn } from 'child_process';
import { createHash } from 'node:crypto';
import net from 'net';
import readline from 'readline';
import { getLogger } from '../../../logging/logger';
import { getSafeEnvForTrustedProcess } from '../../../security/env-filter';
import { getClampedLoadWatchdogMultiplier } from '../../../runtime/system-load-monitor';
import { CODEX_TIMEOUTS } from '../../../../shared/constants/limits';
import { buildCliSpawnOptions } from '../../cli-environment';
import { parseNdjsonLine } from '../../json-parse';
import { CliStreamLineParser } from '../cli-stream-line-parser';
import {
  checkAppServerAvailability,
  parseBrokerEndpoint,
  terminateProcessTree,
} from './app-server-process-utils';
import type {
  AppServerMethod,
  AppServerNotification,
  AppServerNotificationHandler,
  AppServerRequestParams,
  AppServerResponseResult,
  CodexAppServerClientOptions,
  InitializeCapabilities,
  ClientInfo,
  JsonRpcResponse,
} from './app-server-types';
import {
  BROKER_BUSY_RPC_CODE,
  BROKER_ENDPOINT_ENV,
  DEFAULT_OPT_OUT_NOTIFICATIONS,
  SERVICE_NAME,
} from './app-server-types';
import { AppServerNotificationHub } from './app-server-notification-hub';
import type { CodexContextPressureCollector } from './context-pressure-diagnostics';
import {
  rpcFailure,
  timeoutFailure,
  transportFailure,
  validateGeneratedRequest,
  validateGeneratedResponse,
} from './app-server-client-protocol';

const logger = getLogger('CodexAppServerClient');

// ─── Protocol Error ─────────────────────────────────────────────────────────

export class ProtocolError extends Error {
  data?: unknown;
  rpcCode?: number;
  code?: string;

  constructor(message: string, data?: unknown) {
    super(message);
    this.name = 'ProtocolError';
    this.data = data;
    if (data && typeof data === 'object' && 'code' in data) {
      this.rpcCode = (data as { code: number }).code;
    }
  }
}

// ─── Pending Request Tracker ────────────────────────────────────────────────

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  method: string;
  timer: ReturnType<typeof setTimeout> | null;
}

// ─── Default Constants ──────────────────────────────────────────────────────

const DEFAULT_CLIENT_INFO: ClientInfo = {
  title: 'Harness',
  name: 'ai-orchestrator',
  version: '1.0.0',
};

const DEFAULT_CAPABILITIES: InitializeCapabilities = {
  // Required by thread/resume.excludeTurns, which keeps resume responses
  // metadata-only instead of rehydrating large or interrupted turn history.
  experimentalApi: true,
  optOutNotificationMethods: DEFAULT_OPT_OUT_NOTIFICATIONS,
};

const GRACEFUL_SHUTDOWN_MS = CODEX_TIMEOUTS.GRACEFUL_SHUTDOWN_MS;

/** Host-load timeout scale for control RPCs (clamped, throw-safe). */
function loadScale(): number { return getClampedLoadWatchdogMultiplier(); }

// ─── Abstract Base Client ───────────────────────────────────────────────────

/** Base JSON-RPC client shared by direct and broker transports. */
export abstract class AppServerClientBase {
  readonly cwd: string;
  readonly transport: 'direct' | 'broker';

  protected pending = new Map<number, PendingRequest>();
  protected nextId = 1;
  protected closed = false;
  private readonly lineParser = new CliStreamLineParser();
  private readonly notificationHub = new AppServerNotificationHub((notification, error) => {
    logger.warn('App-server notification observer failed', {
      method: notification.method,
      error: error instanceof Error ? error.message : String(error),
    });
  });
  private contextDiagnosticsCollector: CodexContextPressureCollector | null = null;
  protected exitError: Error | null = null;

  /** Resolves when the connection/process exits. */
  readonly exitPromise: Promise<void>;
  protected resolveExit!: () => void;

  /** Returns the error that caused the connection to close, if any. */
  getExitError(): Error | null {
    return this.exitError;
  }

  isRunning(): boolean { return !this.closed; }
  getPid(): number | undefined { return undefined; }

  constructor(cwd: string, transport: 'direct' | 'broker') {
    this.cwd = cwd;
    this.transport = transport;
    this.exitPromise = new Promise((resolve) => {
      this.resolveExit = resolve;
    });
  }

  /** Compatibility surface for callers that still own one primary handler. */
  get notificationHandler(): AppServerNotificationHandler | null { return this.notificationHub.primary; }
  set notificationHandler(handler: AppServerNotificationHandler | null) { this.notificationHub.primary = handler; }
  setNotificationHandler(handler: AppServerNotificationHandler | null): void { this.notificationHub.primary = handler; }
  subscribeNotifications(handler: AppServerNotificationHandler): () => void { return this.notificationHub.subscribe(handler); }
  setContextDiagnosticsCollector(collector: CodexContextPressureCollector | null): void { this.contextDiagnosticsCollector = collector; }

  /** Sends a typed JSON-RPC request with method-specific timeout handling. */
  request<M extends AppServerMethod>(
    method: M,
    params: AppServerRequestParams<M>,
    timeoutMs?: number,
  ): Promise<AppServerResponseResult<M>> {
    if (this.closed) {
      throw transportFailure(method, 'codex app-server client is closed.');
    }
    validateGeneratedRequest(method, params);

    const id = this.nextId++;
    const effectiveTimeout = timeoutMs ?? this.resolveDefaultTimeout(method);

    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | null = null;

      if (effectiveTimeout > 0) {
        timer = setTimeout(() => {
          this.pending.delete(id);
          logger.warn('RPC timeout', { method, id, timeoutMs: effectiveTimeout });
          reject(timeoutFailure(method, effectiveTimeout));
        }, effectiveTimeout);
        timer.unref();
      }

      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        method,
        timer,
      });
      try {
        this.sendMessage({ id, method, params: params as Record<string, unknown> });
      } catch (error) {
        if (timer) clearTimeout(timer);
        this.pending.delete(id);
        reject(transportFailure(method, `Failed to write Codex app-server request: ${method}`, error));
      }
    });
  }

  /** Control timeouts scale with host load; turn/start uses the turn watchdog. */
  private resolveDefaultTimeout(method: string): number {
    const controlMethods = ['initialize', 'thread/start', 'thread/resume', 'thread/read', 'thread/list', 'thread/turns/list', 'thread/compact/start'];
    if (controlMethods.includes(method)) {
      return CODEX_TIMEOUTS.RPC_CONTROL_MS * loadScale();
    }
    if (method === 'turn/start') {
      return 0; // Long-running — turn-level timeout handles this
    }
    return CODEX_TIMEOUTS.RPC_DEFAULT_MS * loadScale();
  }

  /**
   * Sends a fire-and-forget notification (no response expected).
   */
  notify(method: string, params: Record<string, unknown> = {}): void {
    if (this.closed) {
      return;
    }
    this.sendMessage({ method, params });
  }

  /**
   * Runs the initialize handshake: sends `initialize` request, then `initialized` notification.
   */
  async initialize(
    clientInfo: ClientInfo = DEFAULT_CLIENT_INFO,
    capabilities: InitializeCapabilities = DEFAULT_CAPABILITIES
  ): Promise<void> {
    await this.request('initialize', { clientInfo, capabilities } as AppServerRequestParams<'initialize'>);
    this.notify('initialized');
    logger.debug('App-server initialized', { transport: this.transport });
  }

  abstract close(): Promise<void>;
  protected abstract sendMessage(message: Record<string, unknown>): void;

  // ─── Line Processing ────────────────────────────────────────────────

  /**
   * Processes a single JSONL line from the server.
   * Routes to pending requests, notification handler, or logs unknown messages.
   */
  protected handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;

    const parsedLine = parseNdjsonLine<Record<string, unknown>>(trimmed);
    if (!parsedLine.ok || !isJsonRpcRecord(parsedLine.value)) {
      logger.warn('Failed to parse JSONL line from app-server', { line: trimmed.slice(0, 200) });
      return;
    }
    const message = parsedLine.value;

    // Server-initiated request. Route this before responses: both carry an id,
    // and the previous order silently swallowed approval/user-input requests.
    if (
      'id' in message
      && (typeof message['id'] === 'number' || typeof message['id'] === 'string')
      && 'method' in message
      && typeof message['method'] === 'string'
    ) {
      this.sendMessage({
        id: message['id'],
        error: { code: -32601, message: 'Method not supported by client' },
      });
      return;
    }

    // Response to a pending request
    if ('id' in message && typeof message['id'] === 'number') {
      const pending = this.pending.get(message['id']);
      if (pending) {
        if (pending.timer) clearTimeout(pending.timer);
        this.pending.delete(message['id']);
        const response = message as unknown as JsonRpcResponse;
        if (response.error) {
          pending.reject(rpcFailure(pending.method, response.error));
        } else {
          try {
            pending.resolve(validateGeneratedResponse(pending.method, response.result));
          } catch (error) {
            pending.reject(error instanceof Error ? error : new Error(String(error)));
          }
        }
      }
      return;
    }

    // Notification (no id field, has method)
    if ('method' in message && typeof message['method'] === 'string') {
      const notification = message as unknown as AppServerNotification;
      this.recordTransportContextDiagnostics(notification);
      this.notificationHub.dispatch(notification);
      return;
    }

  }

  private recordTransportContextDiagnostics(notification: AppServerNotification): void {
    const collector = this.contextDiagnosticsCollector;
    if (!collector) return;
    if (notification.method !== 'thread/tokenUsage/updated' && notification.method !== 'thread/compacted') return;

    try {
      const threadId = notification.params?.['threadId'];
      if (typeof threadId !== 'string') return;
      const correlation = createHash('sha256').update(threadId).digest('hex').slice(0, 12);
      collector.recordTransportNotification(notification, correlation);
    } catch {
      // Transport diagnostics are observational and must never affect routing.
    }
  }

  /**
   * Handles arbitrary data chunks from socket-based transports.
   * Buffers partial lines and emits complete lines to handleLine().
   */
  protected handleChunk(chunk: string): void {
    for (const line of this.lineParser.push(chunk)) {
      if (line.trim()) {
        this.handleLine(line);
      }
    }
  }

  /**
   * Called when the transport exits (process close or socket disconnect).
   * Rejects all pending requests and resolves the exit promise.
   */
  protected handleExit(error?: Error): void {
    this.closed = true;
    this.exitError = error || null;
    this.lineParser.reset();

    for (const [id, pending] of this.pending) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(transportFailure(pending.method, error?.message ?? 'Connection closed', error));
      this.pending.delete(id);
    }

    this.resolveExit();
  }
}

function isJsonRpcRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}


// ─── Direct (Spawned) Client ────────────────────────────────────────────────

/**
 * Spawns `codex app-server` as a child process and communicates via stdio.
 */
class SpawnedAppServerClient extends AppServerClientBase {
  private proc: ChildProcess | null = null;
  private rl: readline.Interface | null = null;
  private stderr = '';

  constructor(cwd: string) {
    super(cwd, 'direct');
  }

  async connect(options: CodexAppServerClientOptions = {}): Promise<void> {
    const spawnOptions = buildCliSpawnOptions(options.env || getSafeEnvForTrustedProcess());
    this.proc = spawn('codex', ['app-server'], {
      cwd: this.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      // Unix: isolate into its own process group for clean tree kills
      detached: !spawnOptions.shell,
      ...spawnOptions,
    });

    // Prevent detached child from keeping Electron alive
    if (this.proc.pid && !spawnOptions.shell) {
      this.proc.unref();
    }

    if (!this.proc.stdout || !this.proc.stdin) {
      throw new ProtocolError('Failed to open stdio pipes to codex app-server');
    }

    // Parse stdout line-by-line
    this.rl = readline.createInterface({ input: this.proc.stdout });
    this.rl.on('line', (line) => this.handleLine(line));

    // Capture stderr for diagnostics
    this.proc.stderr?.on('data', (data) => {
      this.stderr += data.toString();
    });

    // Handle process exit
    this.proc.on('exit', (code, signal) => {
      const error = code !== 0
        ? new ProtocolError(`codex app-server exited with code ${code} (signal: ${signal}).\nStderr: ${this.stderr}`)
        : undefined;
      this.handleExit(error);
    });

    this.proc.on('error', (err) => {
      const error = new ProtocolError(`codex app-server spawn error: ${err.message}`);
      error.code = (err as NodeJS.ErrnoException).code;
      this.handleExit(error);
    });

    // Run initialize handshake
    await this.initialize(
      options.clientInfo || DEFAULT_CLIENT_INFO,
      options.capabilities || DEFAULT_CAPABILITIES
    );
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    this.rl?.close();
    this.rl = null;

    if (this.proc && !this.proc.killed) {
      // Graceful: close stdin, give the process time to exit, then SIGTERM
      this.proc.stdin?.end();

      const gracefulTimer = setTimeout(() => {
        if (this.proc && !this.proc.killed) {
          terminateProcessTree(this.proc.pid);
        }
      }, GRACEFUL_SHUTDOWN_MS);
      gracefulTimer.unref();

      await this.exitPromise;
      clearTimeout(gracefulTimer);
    }

    this.proc = null;
  }

  protected sendMessage(message: Record<string, unknown>): void {
    if (this.proc?.stdin?.writable && !this.closed) {
      this.proc.stdin.write(JSON.stringify(message) + '\n');
    } else if (!this.closed) {
      logger.warn('Cannot write to codex app-server stdin: pipe not writable');
    }
  }

  /** Returns the PID of the spawned process, if running. */
  override getPid(): number | undefined {
    return this.proc?.pid;
  }
}

// ─── Socket (Broker) Client ────────────────────────────────────────────────

/**
 * Connects to a running broker process via Unix socket or Windows named pipe.
 */
class SocketAppServerClient extends AppServerClientBase {
  private socket: net.Socket | null = null;

  constructor(cwd: string) {
    super(cwd, 'broker');
  }

  async connect(endpoint: string, options: CodexAppServerClientOptions = {}): Promise<void> {
    const socketPath = parseBrokerEndpoint(endpoint);
    if (!socketPath) {
      throw new ProtocolError(`Invalid broker endpoint: ${endpoint}`);
    }

    this.socket = await new Promise<net.Socket>((resolve, reject) => {
      const sock = net.createConnection(socketPath, () => {
        // Hand error ownership to the permanent handler below — leaving this
        // listener attached would fire the settled promise's reject on every
        // later socket error alongside the real handler.
        sock.off('error', reject);
        resolve(sock);
      });
      sock.once('error', reject);
    });

    this.socket.on('data', (data) => this.handleChunk(data.toString()));

    this.socket.on('close', () => {
      this.handleExit();
    });

    this.socket.on('error', (err) => {
      const error = new ProtocolError(`Broker socket error: ${err.message}`);
      error.code = (err as NodeJS.ErrnoException).code;
      this.handleExit(error);
    });

    // Run initialize handshake
    await this.initialize(
      options.clientInfo || DEFAULT_CLIENT_INFO,
      options.capabilities || DEFAULT_CAPABILITIES
    );
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    const socket = this.socket;
    this.socket = null;
    if (!socket) return;

    // Graceful half-close; if the broker never FINs back, force-drop the
    // connection so pending requests reject and the fd + listeners release
    // instead of lingering until process exit.
    socket.end();
    const destroyTimer = setTimeout(() => socket.destroy(), GRACEFUL_SHUTDOWN_MS);
    destroyTimer.unref();
    await this.exitPromise;
    clearTimeout(destroyTimer);
    socket.removeAllListeners();
  }

  protected sendMessage(message: Record<string, unknown>): void {
    if (this.socket && !this.closed) {
      this.socket.write(JSON.stringify(message) + '\n');
    }
  }
}

// ─── Factory ────────────────────────────────────────────────────────────────

export type AppServerClient = SpawnedAppServerClient | SocketAppServerClient;

/**
 * Connects to a Codex app-server, preferring broker when available.
 * Returns a persistent client that the caller is responsible for closing.
 *
 * Connection strategy:
 *   1. Check for broker endpoint (env var or ensureBrokerSession)
 *   2. If broker available, connect via socket
 *   3. If broker unavailable or disabled, spawn direct process
 */
export async function connectToAppServer(
  cwd: string,
  options: CodexAppServerClientOptions = {}
): Promise<AppServerClient> {
  // Try broker first (unless disabled)
  if (!options.disableBroker) {
    const brokerEndpoint = options.brokerEndpoint || process.env[BROKER_ENDPOINT_ENV];
    if (brokerEndpoint) {
      try {
        const client = new SocketAppServerClient(cwd);
        await client.connect(brokerEndpoint, options);
        logger.debug('Connected to codex app-server via broker', { endpoint: brokerEndpoint });
        return client;
      } catch (err) {
        logger.debug('Broker connection failed, falling back to direct spawn', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  // Fall back to direct spawn
  const client = new SpawnedAppServerClient(cwd);
  await client.connect(options);
  logger.debug('Connected to codex app-server via direct spawn');
  return client;
}

/**
 * Resilient wrapper that executes a function with an app-server client.
 *
 * If the broker returns BROKER_BUSY or the connection fails, retries with
 * a direct spawn. Always closes the client in the finally block.
 */
export async function withAppServer<T>(
  cwd: string,
  fn: (client: AppServerClient) => Promise<T>,
  options: CodexAppServerClientOptions = {}
): Promise<T> {
  let client: AppServerClient | null = null;
  try {
    client = await connectToAppServer(cwd, options);
    const result = await fn(client);
    await client.close();
    return result;
  } catch (error) {
    const isBrokerBusy = error instanceof ProtocolError && error.rpcCode === BROKER_BUSY_RPC_CODE;
    const isConnectionError = error instanceof ProtocolError
      && (error.code === 'ENOENT' || error.code === 'ECONNREFUSED');
    const wasBroker = client?.transport === 'broker';

    if (client) {
      await client.close().catch(() => {
        // Ignore close errors
      });
      client = null;
    }

    // Retry with direct spawn if broker was the problem
    if (wasBroker && (isBrokerBusy || isConnectionError)) {
      logger.info('Broker unavailable, retrying with direct spawn', {
        reason: isBrokerBusy ? 'busy' : 'connection-error',
      });
      const directClient = await connectToAppServer(cwd, { ...options, disableBroker: true });
      try {
        return await fn(directClient);
      } finally {
        await directClient.close();
      }
    }

    throw error;
  }
}

// Re-export types, constants, and process utilities for convenience — existing
// importers (and vi.mock overrides) reach everything through this module.
export { checkAppServerAvailability, terminateProcessTree };
export { BROKER_BUSY_RPC_CODE, BROKER_ENDPOINT_ENV, SERVICE_NAME };
export type { AppServerClient as CodexAppServerClientInstance };
