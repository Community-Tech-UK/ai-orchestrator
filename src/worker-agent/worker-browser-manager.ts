import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveChromeExecutablePath } from './capability-reporter';
import {
  defaultBrowserAutomationProfileDir,
  type WorkerBrowserAutomationConfig,
} from './worker-config';
import type { WorkerNodeBrowserAutomationSummary } from '../shared/types/worker-node.types';

/**
 * Owns a single long-lived Chrome on the worker, launched with remote debugging
 * against a DEDICATED automation profile. The worker injects a `chrome-devtools`
 * MCP server (attached via `--browserUrl http://127.0.0.1:<port>`) into the CLI
 * instances it spawns, so remote agents get `mcp__chrome-devtools__*` tools that
 * drive THIS Chrome — keeping the (logged-in) session local to the node.
 *
 * Design notes:
 * - Node builtins only (child_process/fs/path/fetch). No Electron, no Puppeteer —
 *   the worker process crashes on transitive Electron imports, and we don't want
 *   to bundle Puppeteer into it.
 * - One Chrome shared by all instances. chrome-devtools-mcp creates its own CDP
 *   target/page per client, so concurrent agents don't fight over one tab.
 * - The CDP port stays bound to loopback (Chrome's default) — never exposed to
 *   the LAN. Agents reach it only by running ON this node.
 */
export interface WorkerBrowserManagerOptions {
  config: WorkerBrowserAutomationConfig;
  /** Override Chrome resolution (tests). */
  resolveChromePath?: () => string | null;
  /** Override process spawn (tests). */
  spawnProcess?: typeof spawn;
  /** Override the readiness probe (tests). */
  probe?: (browserUrl: string) => Promise<boolean>;
  /** Total readiness budget before giving up. */
  readyTimeoutMs?: number;
}

const DEFAULT_READY_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 250;
const DEVTOOLS_ACTIVE_PORT_FILE = 'DevToolsActivePort';

function log(message: string, extra?: Record<string, unknown>): void {
  // Match the worker's console-based logging (avoids the Electron-coupled logger).
  console.log(`[WorkerBrowserManager] ${message}`, extra ? JSON.stringify(extra) : '');
}

async function defaultProbe(browserUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${browserUrl}/json/version`, { method: 'GET' });
    return res.ok;
  } catch {
    return false;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class WorkerBrowserManager {
  private config: WorkerBrowserAutomationConfig;
  private readonly resolveChromePath: () => string | null;
  private readonly spawnProcess: typeof spawn;
  private readonly probe: (browserUrl: string) => Promise<boolean>;
  private readonly readyTimeoutMs: number;

  private child: ChildProcess | null = null;
  private browserUrl: string | null = null;
  private startPromise: Promise<string> | null = null;

  constructor(options: WorkerBrowserManagerOptions) {
    this.config = options.config;
    this.resolveChromePath = options.resolveChromePath ?? resolveChromeExecutablePath;
    this.spawnProcess = options.spawnProcess ?? spawn;
    this.probe = options.probe ?? defaultProbe;
    this.readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
  }

  isEnabled(): boolean {
    return this.config.enabled === true;
  }

  /** The CDP base URL if Chrome is up, else null. */
  getBrowserUrl(): string | null {
    return this.browserUrl;
  }

  /**
   * Ensure Chrome is running and return its browser-level CDP WebSocket endpoint
   * (`ws://127.0.0.1:<port>/devtools/browser/<id>`). Used by the remote CDP
   * tunnel to relay frames to the coordinator's puppeteer transport.
   */
  async getBrowserWsEndpoint(): Promise<string> {
    const browserUrl = await this.ensureRunning();
    const res = await fetch(`${browserUrl}/json/version`, { method: 'GET' });
    if (!res.ok) {
      throw new Error(`Failed to read Chrome CDP version (${res.status})`);
    }
    const data = (await res.json()) as { webSocketDebuggerUrl?: string };
    if (!data.webSocketDebuggerUrl) {
      throw new Error('Chrome did not report a webSocketDebuggerUrl');
    }
    return data.webSocketDebuggerUrl;
  }

  /** Resolved automation profile directory (config or default). */
  private resolvedProfileDir(): string {
    return this.config.profileDir ?? defaultBrowserAutomationProfileDir();
  }

  /** Non-secret summary for capability reporting. */
  getSummary(): WorkerNodeBrowserAutomationSummary {
    return {
      enabled: this.config.enabled === true,
      headless: this.config.headless === true,
      profileDir: this.resolvedProfileDir(),
      // True only once the managed Chrome is actually up (CDP reachable).
      running: this.browserUrl !== null && this.child !== null && this.child.exitCode === null,
    };
  }

  /**
   * Apply a new config at runtime (from a coordinator `config.update`). If the
   * managed Chrome is running and a launch-relevant field changed — or the node
   * is being disabled — the current Chrome is shut down so the next browser-
   * enabled spawn relaunches with the new settings.
   */
  async reconfigure(next: WorkerBrowserAutomationConfig): Promise<void> {
    const prev = this.config;
    const launchRelevantChanged =
      prev.profileDir !== next.profileDir ||
      prev.chromePath !== next.chromePath ||
      (prev.headless === true) !== (next.headless === true) ||
      prev.remoteDebuggingPort !== next.remoteDebuggingPort;
    const becameDisabled = prev.enabled === true && next.enabled !== true;

    this.config = next;

    const isRunning = this.browserUrl !== null && this.child !== null && this.child.exitCode === null;
    if (isRunning && (becameDisabled || launchRelevantChanged)) {
      await this.shutdown();
    }
  }

  /**
   * Ensure the managed Chrome is running and return its CDP base URL
   * (`http://127.0.0.1:<port>`). Idempotent and safe under concurrent callers —
   * the first call launches Chrome, the rest await the same start.
   */
  async ensureRunning(): Promise<string> {
    if (!this.isEnabled()) {
      throw new Error('Browser automation is not enabled on this worker');
    }
    if (this.browserUrl && this.child && this.child.exitCode === null) {
      return this.browserUrl;
    }
    if (this.startPromise) {
      return this.startPromise;
    }
    this.startPromise = this.launch().catch((err) => {
      // Clear the cached promise so a later call can retry a failed launch.
      this.startPromise = null;
      throw err;
    });
    return this.startPromise;
  }

  private async launch(): Promise<string> {
    const chromePath = this.config.chromePath ?? this.resolveChromePath();
    if (!chromePath) {
      throw new Error('No Chrome/Chromium executable found for browser automation');
    }

    const profileDir = this.resolvedProfileDir();
    fs.mkdirSync(profileDir, { recursive: true });

    // A stale DevToolsActivePort from a previous crash would let us read the
    // wrong port; remove it so we only trust a file the new Chrome writes.
    const activePortFile = path.join(profileDir, DEVTOOLS_ACTIVE_PORT_FILE);
    try { fs.rmSync(activePortFile, { force: true }); } catch { /* best effort */ }

    const requestedPort = this.config.remoteDebuggingPort ?? 0;
    const args = [
      `--remote-debugging-port=${requestedPort}`,
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      // Required since Chrome 111 for CDP websocket connections whose Origin
      // doesn't match — chrome-devtools-mcp attaches over ws.
      '--remote-allow-origins=*',
      ...(this.config.headless ? ['--headless=new'] : []),
      'about:blank',
    ];

    log('launching Chrome', { chromePath, profileDir, requestedPort, headless: !!this.config.headless });
    const child = this.spawnProcess(chromePath, args, {
      stdio: 'ignore',
      detached: false,
    });
    this.child = child;

    child.on('exit', (code, signal) => {
      log('Chrome exited', { code, signal });
      if (this.child === child) {
        this.child = null;
        this.browserUrl = null;
        this.startPromise = null;
      }
    });
    child.on('error', (err) => {
      log('Chrome process error', { error: err instanceof Error ? err.message : String(err) });
    });

    const port = await this.resolvePort(child, requestedPort, activePortFile);
    const browserUrl = `http://127.0.0.1:${port}`;
    await this.waitForReady(child, browserUrl);
    this.browserUrl = browserUrl;
    log('Chrome ready', { browserUrl });
    return browserUrl;
  }

  /**
   * Determine the actual CDP port. With a fixed port we trust the config; with
   * port 0 we read the port Chrome chose from its DevToolsActivePort file. The
   * `child` is passed explicitly (not `this.child`) so the exit guard still fires
   * after the exit handler has nulled the field.
   */
  private async resolvePort(
    child: ChildProcess,
    requestedPort: number,
    activePortFile: string,
  ): Promise<number> {
    if (requestedPort > 0) {
      return requestedPort;
    }
    const deadline = Date.now() + this.readyTimeoutMs;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) {
        throw new Error(`Chrome exited before reporting a debugging port (code ${child.exitCode})`);
      }
      try {
        const firstLine = fs.readFileSync(activePortFile, 'utf-8').split(/\r?\n/)[0]?.trim();
        const parsed = firstLine ? Number.parseInt(firstLine, 10) : NaN;
        if (Number.isInteger(parsed) && parsed > 0) {
          return parsed;
        }
      } catch { /* file not written yet */ }
      await delay(POLL_INTERVAL_MS);
    }
    throw new Error('Timed out waiting for Chrome to report its remote debugging port');
  }

  private async waitForReady(child: ChildProcess, browserUrl: string): Promise<void> {
    const deadline = Date.now() + this.readyTimeoutMs;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) {
        throw new Error(`Chrome exited before becoming ready (code ${child.exitCode})`);
      }
      if (await this.probe(browserUrl)) {
        return;
      }
      await delay(POLL_INTERVAL_MS);
    }
    throw new Error(`Chrome CDP endpoint did not become ready within ${this.readyTimeoutMs}ms`);
  }

  /** Kill the managed Chrome. Safe to call when nothing is running. */
  async shutdown(): Promise<void> {
    const child = this.child;
    this.child = null;
    this.browserUrl = null;
    this.startPromise = null;
    if (!child || child.exitCode !== null) {
      return;
    }
    try {
      child.kill();
    } catch {
      /* already gone */
    }
  }
}
