import * as fs from 'fs';
import * as path from 'path';
import {
  WORKER_INTERNAL_CONNECT_ERROR,
  type WorkerConnectionSnapshot,
  type WorkerConnectionState,
} from '../shared/types/pair-both.types';
import { isProcessAlive } from './single-instance-lock';

/**
 * The worker's own report of whether it reached the main Harness.
 *
 * Harness starts the worker with its output ignored (and on Windows the
 * sign-in task starts it with Harness closed), so without this the Worker Mode
 * page could only tell that a process was alive: "running" looked the same
 * whether the worker was connected, could not reach the main Harness, or had
 * its credential refused. The worker writes a small JSON file beside its
 * config at each connection step and Harness reads it.
 *
 * The file never holds a credential: only the state, the coordinator address,
 * and a short reason.
 */

const STATUS_FILE_VERSION = 1;
/** Rewrite an unchanged report at most this often (heartbeats refresh it). */
const TOUCH_INTERVAL_MS = 30_000;
/**
 * A connected worker that has heard nothing from the main Harness (no message,
 * no pong) for this long says it cannot reach it. A link that dies without a
 * close event (sleep, Wi-Fi or VPN change) can leave the socket "open" for
 * minutes, and heartbeats alone would keep saying "connected".
 */
const COORDINATOR_SILENCE_MS = 45_000;
/** Silence must outlast this many heartbeats, however slowly they are configured. */
const SILENT_HEARTBEATS = 3;
export const SILENT_COORDINATOR_MESSAGE = 'It stopped answering.';
export const NO_SAVED_ADDRESS_MESSAGE = 'This computer has no saved address for it and could not find it on this network.';
export const INTERNAL_CONNECT_ERROR_MESSAGE = WORKER_INTERNAL_CONNECT_ERROR;

/** "No answer from mac:4878, 100.64.0.2:4878." — addresses as host:port, not full URLs. */
export function noAnswerMessage(urls: string[]): string {
  const hosts = urls.map((url) => {
    try {
      return new URL(url).host || url;
    } catch {
      return url;
    }
  });
  return `No answer from ${hosts.join(', ')}.`;
}
/** A live worker that has not rewritten its report for this long may be stuck. */
const STALE_AFTER_MS = 2 * 60_000;
/** A report from a worker that exited is still worth showing for this long. */
const DEAD_REPORT_TTL_MS = 10 * 60_000;
const MAX_MESSAGE_LENGTH = 300;

interface WorkerConnectionStatusFile {
  version: number;
  pid: number;
  nodeId: string;
  state: WorkerConnectionState;
  coordinatorUrl?: string;
  message?: string;
  since: number;
  updatedAt: number;
}

export interface WorkerConnectionStatusDetails {
  coordinatorUrl?: string;
  message?: string;
}

/** `~/.orchestrator/worker-node.json` → `~/.orchestrator/worker-node.status.json`. */
export function workerConnectionStatusPath(configPath: string): string {
  const parsed = path.parse(configPath);
  return path.join(parsed.dir, `${parsed.name}.status.json`);
}

/** What the worker needs from the writer (tests pass a recorder). */
export type WorkerConnectionReporter = Pick<WorkerConnectionStatusWriter, 'set' | 'heartbeat' | 'noteContact'>;

export interface WorkerConnectionStatusWriterOptions {
  /** The worker's heartbeat interval; a slow one lengthens the silence budget. */
  heartbeatIntervalMs?: number;
  /** This worker's own credentials, removed from any reason before it is written. */
  secrets?: () => Array<string | undefined>;
  now?: () => number;
  pid?: number;
  writeFile?: (filePath: string, contents: string) => void;
}

/**
 * Writes the report. Failures to write are swallowed: a worker must never stop
 * working because it could not describe itself.
 */
export class WorkerConnectionStatusWriter {
  private readonly filePath: string;
  private readonly now: () => number;
  private readonly pid: number;
  private readonly writeFile: (filePath: string, contents: string) => void;
  private readonly secrets: () => Array<string | undefined>;
  private readonly silenceMs: number;
  private current: WorkerConnectionStatusFile | null = null;
  private writeFailureLogged = false;
  private lastContactAt = 0;
  /** The current `unreachable` came from silence on an open socket, not a failed connect. */
  private silenced = false;

  constructor(
    configPath: string,
    private readonly nodeId: string,
    options: WorkerConnectionStatusWriterOptions = {},
  ) {
    this.filePath = workerConnectionStatusPath(configPath);
    this.now = options.now ?? Date.now;
    this.pid = options.pid ?? process.pid;
    this.writeFile = options.writeFile ?? writeFileAtomically;
    this.secrets = options.secrets ?? (() => []);
    this.silenceMs = Math.max(COORDINATOR_SILENCE_MS, (options.heartbeatIntervalMs ?? 0) * SILENT_HEARTBEATS);
  }

  get state(): WorkerConnectionState | null {
    return this.current?.state ?? null;
  }

  set(state: WorkerConnectionState, details: WorkerConnectionStatusDetails = {}): void {
    const previous = this.current;
    if (previous && keepsCurrentState(previous.state, state)) {
      this.touch();
      return;
    }
    const at = this.now();
    if (state === 'connected') {
      this.lastContactAt = at;
    }
    this.silenced = false;
    const coordinatorUrl = details.coordinatorUrl ?? previous?.coordinatorUrl;
    const message = details.message ? truncate(this.redact(details.message)) : undefined;
    const unchanged = previous?.state === state
      && previous.coordinatorUrl === coordinatorUrl
      && previous.message === message;
    if (unchanged) {
      this.touch();
      return;
    }
    this.current = {
      version: STATUS_FILE_VERSION,
      pid: this.pid,
      nodeId: this.nodeId,
      state,
      ...(coordinatorUrl ? { coordinatorUrl } : {}),
      ...(message ? { message } : {}),
      since: at,
      updatedAt: at,
    };
    this.flush();
  }

  /**
   * Called on each heartbeat with a way to ping the main Harness. Keeps a
   * connected report fresh while the main Harness keeps answering, and says it
   * cannot be reached once it has been silent too long. Returns true at that
   * moment, so the worker drops the dead socket and reconnects.
   */
  heartbeat(ping: () => void): boolean {
    try {
      ping();
    } catch {
      // The socket is still opening or already closing; its own events report that.
    }
    if (this.current?.state === 'connected' && this.now() - this.lastContactAt > this.silenceMs) {
      this.set('unreachable', { message: SILENT_COORDINATOR_MESSAGE });
      this.silenced = true;
      return true;
    }
    this.touch();
    return false;
  }

  /** The main Harness sent something (a message or a pong). */
  noteContact(): void {
    this.lastContactAt = this.now();
    if (this.silenced && this.current?.state === 'unreachable') {
      this.set('connected');
    }
  }

  /** Mark the report as current without changing it (throttled). */
  touch(): void {
    if (!this.current) {
      return;
    }
    const at = this.now();
    if (at - this.current.updatedAt < TOUCH_INTERVAL_MS) {
      return;
    }
    this.current = { ...this.current, updatedAt: at };
    this.flush();
  }

  private redact(message: string): string {
    return this.secrets()
      .filter((secret): secret is string => typeof secret === 'string' && secret.length >= 6)
      .reduce((text, secret) => text.split(secret).join('[hidden]'), message);
  }

  private flush(): void {
    if (!this.current) {
      return;
    }
    try {
      this.writeFile(this.filePath, `${JSON.stringify(this.current, null, 2)}\n`);
      this.writeFailureLogged = false;
    } catch (error) {
      if (this.writeFailureLogged) {
        return;
      }
      this.writeFailureLogged = true;
      console.warn(
        '[WorkerAgent] Could not write the worker status file',
        error instanceof Error ? error.message : String(error),
      );
    }
  }
}

/**
 * Every connection attempt, first or retry, starts with `connecting`; only the
 * first one (or one after a deliberate stop) should say so. Retry steps also
 * must not hide a failure the user needs to see: a worker that cannot reach
 * the main Harness, or was refused, keeps retrying, and showing each retry
 * would make the page flicker between "Connecting..." and the real problem.
 */
function keepsCurrentState(previous: WorkerConnectionState, next: WorkerConnectionState): boolean {
  if (next === 'connecting') {
    return previous !== 'stopped' && previous !== 'failed';
  }
  if (previous === 'rejected') {
    return next === 'reconnecting' || next === 'registering';
  }
  if (previous === 'unreachable') {
    return next === 'reconnecting';
  }
  return false;
}

function truncate(message: string): string {
  // Reasons come from the worker and from the main Harness's error text. Beyond
  // this worker's own credentials (see redact), hide anything shaped like one:
  // a long unbroken run of token characters. Dots, slashes and colons end a
  // run, so host names and addresses survive.
  const singleLine = message
    .replace(/\s+/g, ' ')
    .replace(/[A-Za-z0-9_\-+=]{32,}/g, '[hidden]')
    .trim();
  return singleLine.length > MAX_MESSAGE_LENGTH
    ? `${singleLine.slice(0, MAX_MESSAGE_LENGTH - 3)}...`
    : singleLine;
}

/**
 * Write to a temporary file and rename it into place, so a reader does not see
 * a half-written report. Where the rename is refused (Windows, while the
 * reader holds the file open) it writes in place; a reader that catches that
 * write half-done gets an unreadable file, which it treats as no report.
 */
function writeFileAtomically(filePath: string, contents: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, contents, 'utf-8');
    fs.renameSync(temporaryPath, filePath);
  } catch {
    try {
      fs.writeFileSync(filePath, contents, 'utf-8');
    } finally {
      fs.rmSync(temporaryPath, { force: true });
    }
  }
}

/** Remove the report, for example when this computer is paired again or unpaired. */
export function clearWorkerConnectionStatus(configPath: string): void {
  try {
    fs.rmSync(workerConnectionStatusPath(configPath), { force: true });
  } catch {
    // A leftover report is filtered by node id and process liveness anyway.
  }
}

export interface ReadWorkerConnectionStatusOptions {
  /** Ignore a report written for another node id (unpairing and pairing afresh mints a new one). */
  expectedNodeId?: string;
  now?: () => number;
  isProcessAlive?: (pid: number) => boolean;
  readFile?: (filePath: string) => string;
}

/**
 * Read the report for the worker using `configPath`. Returns null when there
 * is none, it is unreadable, it belongs to another pairing, or it came from a
 * worker that has since exited (apart from a recent `failed` report, which
 * explains why the worker is not running).
 */
export function readWorkerConnectionStatus(
  configPath: string,
  options: ReadWorkerConnectionStatusOptions = {},
): WorkerConnectionSnapshot | null {
  const readFile = options.readFile ?? ((filePath: string) => fs.readFileSync(filePath, 'utf-8'));
  const now = (options.now ?? Date.now)();
  const isAlive = options.isProcessAlive ?? isProcessAlive;

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFile(workerConnectionStatusPath(configPath)));
  } catch {
    return null;
  }
  const record = toStatusFile(parsed);
  if (!record) {
    return null;
  }
  if (options.expectedNodeId && record.nodeId !== options.expectedNodeId) {
    return null;
  }

  const alive = isAlive(record.pid);
  if (!alive && !(record.state === 'failed' && now - record.updatedAt < DEAD_REPORT_TTL_MS)) {
    return null;
  }
  return {
    state: record.state,
    ...(record.coordinatorUrl ? { coordinatorUrl: record.coordinatorUrl } : {}),
    ...(record.message ? { message: record.message } : {}),
    since: record.since,
    updatedAt: record.updatedAt,
    alive,
    stale: alive && now - record.updatedAt > STALE_AFTER_MS,
  };
}

const STATES = new Set<WorkerConnectionState>([
  'connecting',
  'registering',
  'connected',
  'reconnecting',
  'unreachable',
  'rejected',
  'stopped',
  'failed',
]);

function toStatusFile(value: unknown): WorkerConnectionStatusFile | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const raw = value as Record<string, unknown>;
  if (
    typeof raw['pid'] !== 'number'
    || typeof raw['nodeId'] !== 'string'
    || typeof raw['state'] !== 'string'
    || !STATES.has(raw['state'] as WorkerConnectionState)
    || typeof raw['since'] !== 'number'
    || typeof raw['updatedAt'] !== 'number'
  ) {
    return null;
  }
  return {
    version: typeof raw['version'] === 'number' ? raw['version'] : STATUS_FILE_VERSION,
    pid: raw['pid'],
    nodeId: raw['nodeId'],
    state: raw['state'] as WorkerConnectionState,
    ...(typeof raw['coordinatorUrl'] === 'string' ? { coordinatorUrl: raw['coordinatorUrl'] } : {}),
    ...(typeof raw['message'] === 'string' ? { message: raw['message'] } : {}),
    since: raw['since'],
    updatedAt: raw['updatedAt'],
  };
}
