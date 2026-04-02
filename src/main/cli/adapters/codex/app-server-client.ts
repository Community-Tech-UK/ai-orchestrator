/**
 * Codex App-Server Client
 *
 * JSON-RPC 2.0 client for the `codex app-server` persistent server.
 * Supports two transport modes:
 *   1. Direct: spawns `codex app-server` as a child process (stdio pipes)
 *   2. Broker: connects to a shared broker via Unix socket (or Windows named pipe)
 *
 * The client handles the full lifecycle:
 *   - Connection and initialize handshake
 *   - Typed request/response with pending correlation
 *   - Notification routing via swappable handler
 *   - Graceful shutdown with process tree cleanup
 *
 * Derived from the codex-plugin-cc reference implementation (app-server.mjs).
 */

import { ChildProcess, spawn, spawnSync } from 'child_process';
import net from 'net';
import readline from 'readline';
import { getLogger } from '../../../logging/logger';
import { getSafeEnvForTrustedProcess } from '../../../security/env-filter';
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
}

// ─── Default Constants ──────────────────────────────────────────────────────

const DEFAULT_CLIENT_INFO: ClientInfo = {
  title: 'AI Orchestrator',
  name: 'ai-orchestrator',
  version: '1.0.0',
};

const DEFAULT_CAPABILITIES: InitializeCapabilities = {
  experimentalApi: false,
  optOutNotificationMethods: DEFAULT_OPT_OUT_NOTIFICATIONS,
};

const GRACEFUL_SHUTDOWN_MS = 50;

// ─── Abstract Base Client ───────────────────────────────────────────────────

/**
 * Base class for JSON-RPC communication with the Codex app-server.
 * Subclasses implement transport-specific `sendMessage()` and `close()`.
 */
abstract class AppServerClientBase {
  readonly cwd: string;
  readonly transport: 'direct' | 'broker';

  protected pending = new Map<number, PendingRequest>();
  protected nextId = 1;
  protected closed = false;
  protected lineBuffer = '';
  /** Current notification handler. Public for save/restore in turn capture. */
  notificationHandler: AppServerNotificationHandler | null = null;
  protected exitError: Error | null = null;

  /** Resolves when the connection/process exits. */
  readonly exitPromise: Promise<void>;
  protected resolveExit!: () => void;

  constructor(cwd: string, transport: 'direct' | 'broker') {
    this.cwd = cwd;
    this.transport = transport;
    this.exitPromise = new Promise((resolve) => {
      this.resolveExit = resolve;
    });
  }

  /**
   * Sets the handler that receives streaming notifications from the server.
   * Can be swapped per-turn to route notifications to different consumers.
   */
  setNotificationHandler(handler: AppServerNotificationHandler | null): void {
    this.notificationHandler = handler;
  }

  /**
   * Sends a typed JSON-RPC request and returns the result.
   */
  request<M extends AppServerMethod>(
    method: M,
    params: AppServerRequestParams<M>
  ): Promise<AppServerResponseResult<M>> {
    if (this.closed) {
      throw new ProtocolError('codex app-server client is closed.');
    }

    const id = this.nextId++;

    return new Promise((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        method,
      });
      this.sendMessage({ id, method, params: params as Record<string, unknown> });
    });
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

    let message: Record<string, unknown>;
    try {
      message = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      logger.warn('Failed to parse JSONL line from app-server', { line: trimmed.slice(0, 200) });
      return;
    }

    // Response to a pending request
    if ('id' in message && typeof message['id'] === 'number') {
      const pending = this.pending.get(message['id']);
      if (pending) {
        this.pending.delete(message['id']);
        const response = message as unknown as JsonRpcResponse;
        if (response.error) {
          const err = new ProtocolError(
            response.error.message || 'Unknown RPC error',
            response.error
          );
          err.rpcCode = response.error.code;
          pending.reject(err);
        } else {
          pending.resolve(response.result);
        }
      }
      return;
    }

    // Notification (no id field, has method)
    if ('method' in message && typeof message['method'] === 'string') {
      if (this.notificationHandler) {
        this.notificationHandler(message as unknown as AppServerNotification);
      }
      return;
    }

    // Server-initiated request (unsupported — respond with method-not-found)
    if ('id' in message && 'method' in message) {
      this.sendMessage({
        id: message['id'],
        error: { code: -32601, message: 'Method not supported by client' },
      });
    }
  }

  /**
   * Handles arbitrary data chunks from socket-based transports.
   * Buffers partial lines and emits complete lines to handleLine().
   */
  protected handleChunk(chunk: string): void {
    const combined = this.lineBuffer + chunk;
    const lines = combined.split('\n');
    this.lineBuffer = lines.pop() || '';
    for (const line of lines) {
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

    for (const [id, pending] of this.pending) {
      pending.reject(error || new ProtocolError('Connection closed'));
      this.pending.delete(id);
    }

    this.resolveExit();
  }
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
    const env = options.env || getSafeEnvForTrustedProcess();
    const isWindows = process.platform === 'win32';

    this.proc = spawn('codex', ['app-server'], {
      cwd: this.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
      // On Windows, codex is a cmd.exe wrapper — need shell: true
      shell: isWindows,
    });

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
    if (this.proc?.stdin && !this.closed) {
      this.proc.stdin.write(JSON.stringify(message) + '\n');
    }
  }

  /** Returns the PID of the spawned process, if running. */
  getPid(): number | undefined {
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
      const sock = net.createConnection(socketPath, () => resolve(sock));
      sock.on('error', reject);
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

    if (this.socket) {
      this.socket.end();
      this.socket = null;
    }
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

// ─── Utilities ──────────────────────────────────────────────────────────────

/**
 * Parses a broker endpoint string into a socket path.
 * Formats: `unix:/path/to/broker.sock` or `pipe:\\.\pipe\name`
 */
function parseBrokerEndpoint(endpoint: string): string | null {
  if (endpoint.startsWith('unix:')) {
    return endpoint.slice(5);
  }
  if (endpoint.startsWith('pipe:')) {
    return endpoint.slice(5);
  }
  // Bare path — treat as Unix socket
  if (endpoint.startsWith('/') || endpoint.startsWith('\\\\.\\pipe\\')) {
    return endpoint;
  }
  return null;
}

/**
 * Cross-platform process tree termination.
 *
 * - Windows: `taskkill /PID /T /F` to kill the entire process tree
 * - Unix: `process.kill(-pid, 'SIGTERM')` to kill the process group,
 *   with fallback to single-process kill
 */
export function terminateProcessTree(pid: number | undefined): void {
  if (pid === undefined) return;

  const isWindows = process.platform === 'win32';

  if (isWindows) {
    try {
      const result = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
        timeout: 5000,
      });
      if (result.error && (result.error as NodeJS.ErrnoException).code === 'ENOENT') {
        // taskkill not available, fall back to single process kill
        try { process.kill(pid); } catch { /* already dead */ }
      }
    } catch {
      try { process.kill(pid); } catch { /* already dead */ }
    }
    return;
  }

  // Unix: kill process group (negative PID)
  try {
    process.kill(-pid, 'SIGTERM');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ESRCH') {
      // Process group kill failed for non-ESRCH reason — try single kill
      try { process.kill(pid, 'SIGTERM'); } catch { /* already dead */ }
    }
    // ESRCH = no such process, already dead — that's fine
  }
}

/**
 * Checks whether `codex app-server` is available by running `codex app-server --help`.
 * Returns true if the subcommand exists, false otherwise.
 */
export function checkAppServerAvailability(): boolean {
  try {
    const result = spawnSync('codex', ['app-server', '--help'], {
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return result.status === 0 || (result.stdout?.toString() || '').includes('app-server');
  } catch {
    return false;
  }
}

// Re-export types and constants for convenience
export { BROKER_BUSY_RPC_CODE, BROKER_ENDPOINT_ENV, SERVICE_NAME };
export type { AppServerClient as CodexAppServerClientInstance };
