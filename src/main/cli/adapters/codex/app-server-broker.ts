/**
 * Codex App-Server Broker Manager
 *
 * Manages a shared broker process that allows multiple orchestrator instances
 * to share a single Codex app-server process. This saves memory and startup
 * time when running multiple Codex instances in parallel.
 *
 * Lifecycle:
 *   1. `ensureBrokerSession()` — start or reuse an existing broker
 *   2. Clients connect to the broker endpoint via SocketAppServerClient
 *   3. `teardownBrokerSession()` — kill the broker and clean up
 *
 * The broker is a separate `codex app-server` process running in "broker"
 * mode that multiplexes requests from multiple clients through a single
 * Codex process. When the broker is busy with a streaming operation from
 * one client, it returns BROKER_BUSY_RPC_CODE (-32001) to other clients,
 * which can then fall back to direct spawn.
 *
 * Derived from the codex-plugin-cc reference implementation (broker-lifecycle.mjs).
 */

import { ChildProcess, spawn } from 'child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import net from 'net';
import { join } from 'path';
import { app } from 'electron';
import { getLogger } from '../../../logging/logger';
import { getSafeEnvForTrustedProcess } from '../../../security/env-filter';
import { terminateProcessTree } from './app-server-client';
import { CODEX_TIMEOUTS } from '../../../../shared/constants/limits';

const logger = getLogger('CodexBrokerManager');

// ─── Types ──────────────────────────────────────────────────────────────────

interface BrokerSession {
  endpoint: string;
  pid: number;
  socketPath: string;
  startedAt: string;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const BROKER_STARTUP_TIMEOUT_MS = CODEX_TIMEOUTS.BROKER_STARTUP_MS;
const BROKER_POLL_INTERVAL_MS = 50;
const BROKER_SESSION_FILENAME = 'broker.json';

// ─── Broker Manager ─────────────────────────────────────────────────────────

/**
 * Manages the lifecycle of a shared Codex app-server broker process.
 * Singleton per orchestrator instance.
 */
export class CodexBrokerManager {
  private static instance: CodexBrokerManager;

  private session: BrokerSession | null = null;
  private brokerProcess: ChildProcess | null = null;
  private sessionDir: string;

  static getInstance(): CodexBrokerManager {
    if (!this.instance) {
      this.instance = new CodexBrokerManager();
    }
    return this.instance;
  }

  static _resetForTesting(): void {
    if (this.instance) {
      this.instance.teardownSync();
    }
    (this.instance as unknown) = undefined;
  }

  private constructor() {
    // Register shutdown handler to clean up broker on app exit.
    // This prevents orphaned codex app-server --broker processes.
    process.on('beforeExit', () => this.teardownSync());
    process.on('SIGTERM', () => this.teardownSync());
    process.on('SIGINT', () => this.teardownSync());

    // Store broker state alongside orchestrator data
    let userDataPath: string;
    try {
      userDataPath = app.getPath('userData');
    } catch {
      // Fallback for non-Electron environments (tests, headless)
      userDataPath = join(process.env['HOME'] || process.env['USERPROFILE'] || '/tmp', '.ai-orchestrator');
    }
    this.sessionDir = join(userDataPath, 'codex-broker');
  }

  /**
   * Ensures a broker is running and returns its endpoint.
   * If a broker is already alive, reuses it. Otherwise spawns a new one.
   */
  async ensureBrokerSession(cwd: string): Promise<string | null> {
    // Check if existing session is alive
    if (this.session) {
      const alive = await this.isEndpointAlive(this.session.endpoint);
      if (alive) {
        logger.debug('Reusing existing broker session', { endpoint: this.session.endpoint });
        return this.session.endpoint;
      }
      logger.debug('Existing broker session is dead, cleaning up');
      this.teardownSync();
    }

    // Check for a persisted session from a previous orchestrator run
    const persisted = this.loadPersistedSession();
    if (persisted) {
      const alive = await this.isEndpointAlive(persisted.endpoint);
      if (alive) {
        this.session = persisted;
        logger.debug('Restored persisted broker session', { endpoint: persisted.endpoint });
        return persisted.endpoint;
      }
      this.cleanupPersistedSession();
    }

    // Spawn a new broker
    try {
      const endpoint = await this.spawnBroker(cwd);
      return endpoint;
    } catch (err) {
      logger.warn('Failed to start codex broker, will use direct spawn', {
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /**
   * Tears down the broker process and cleans up all resources.
   */
  async teardown(): Promise<void> {
    this.teardownSync();
  }

  // ─── Internal ───────────────────────────────────────────────────────

  private async spawnBroker(cwd: string): Promise<string> {
    // Prepare session directory
    if (!existsSync(this.sessionDir)) {
      mkdirSync(this.sessionDir, { recursive: true });
    }

    const socketPath = this.createSocketPath();
    const endpoint = process.platform === 'win32'
      ? `pipe:${socketPath}`
      : `unix:${socketPath}`;

    // Spawn broker as detached process so it survives if the orchestrator restarts.
    // Use sanitized env to prevent credential leakage (matching BaseCliAdapter behavior).
    const logFile = join(this.sessionDir, 'broker.log');
    const safeEnv = getSafeEnvForTrustedProcess();
    const proc = spawn('codex', ['app-server', '--broker', '--endpoint', endpoint], {
      cwd,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: safeEnv,
    });

    // Redirect output to log file
    const logStream = createWriteStream(logFile, { flags: 'a' });
    proc.stdout?.pipe(logStream);
    proc.stderr?.pipe(logStream);

    proc.unref();

    this.brokerProcess = proc;

    // Wait for the broker to be ready
    const ready = await this.waitForEndpoint(endpoint, BROKER_STARTUP_TIMEOUT_MS);
    if (!ready) {
      proc.kill('SIGTERM');
      this.brokerProcess = null;
      throw new Error(`Broker failed to start within ${BROKER_STARTUP_TIMEOUT_MS}ms`);
    }

    // Persist session state
    this.session = {
      endpoint,
      pid: proc.pid!,
      socketPath,
      startedAt: new Date().toISOString(),
    };
    this.persistSession(this.session);

    logger.info('Codex broker started', { endpoint, pid: proc.pid });
    return endpoint;
  }

  private teardownSync(): void {
    if (this.session) {
      // Kill the broker process
      if (this.session.pid) {
        terminateProcessTree(this.session.pid);
      }

      // Clean up socket file
      try {
        if (existsSync(this.session.socketPath)) {
          rmSync(this.session.socketPath, { force: true });
        }
      } catch { /* best effort */ }

      this.session = null;
    }

    if (this.brokerProcess) {
      try { this.brokerProcess.kill('SIGTERM'); } catch { /* already dead */ }
      this.brokerProcess = null;
    }

    this.cleanupPersistedSession();
    logger.debug('Broker session torn down');
  }

  private async isEndpointAlive(endpoint: string): Promise<boolean> {
    const socketPath = parseEndpointToPath(endpoint);
    if (!socketPath) return false;

    return new Promise((resolve) => {
      const socket = net.createConnection(socketPath, () => {
        socket.end();
        resolve(true);
      });
      socket.on('error', () => resolve(false));
      socket.setTimeout(1000, () => {
        socket.destroy();
        resolve(false);
      });
    });
  }

  private async waitForEndpoint(endpoint: string, timeoutMs: number): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const alive = await this.isEndpointAlive(endpoint);
      if (alive) return true;
      await new Promise((resolve) => setTimeout(resolve, BROKER_POLL_INTERVAL_MS));
    }
    return false;
  }

  private createSocketPath(): string {
    if (process.platform === 'win32') {
      const id = `ai-orchestrator-codex-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      return `\\\\.\\pipe\\${id}`;
    }
    return join(this.sessionDir, 'broker.sock');
  }

  private persistSession(session: BrokerSession): void {
    try {
      const filePath = join(this.sessionDir, BROKER_SESSION_FILENAME);
      writeFileSync(filePath, JSON.stringify(session, null, 2), 'utf-8');
    } catch {
      logger.debug('Failed to persist broker session');
    }
  }

  private loadPersistedSession(): BrokerSession | null {
    try {
      const filePath = join(this.sessionDir, BROKER_SESSION_FILENAME);
      if (!existsSync(filePath)) return null;
      const raw = readFileSync(filePath, 'utf-8');
      return JSON.parse(raw) as BrokerSession;
    } catch {
      return null;
    }
  }

  private cleanupPersistedSession(): void {
    try {
      const filePath = join(this.sessionDir, BROKER_SESSION_FILENAME);
      if (existsSync(filePath)) {
        rmSync(filePath, { force: true });
      }
    } catch { /* best effort */ }
  }
}

// ─── Utilities ──────────────────────────────────────────────────────────────

function parseEndpointToPath(endpoint: string): string | null {
  if (endpoint.startsWith('unix:')) return endpoint.slice(5);
  if (endpoint.startsWith('pipe:')) return endpoint.slice(5);
  if (endpoint.startsWith('/') || endpoint.startsWith('\\\\.\\pipe\\')) return endpoint;
  return null;
}

/** Convenience getter. */
export function getCodexBrokerManager(): CodexBrokerManager {
  return CodexBrokerManager.getInstance();
}
