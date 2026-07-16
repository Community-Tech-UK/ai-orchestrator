/**
 * Coordinator-side manager for remote terminal sessions (Piece C).
 *
 * Mirrors {@link RemoteCliAdapter}: it proxies terminal operations to a worker
 * node over the WebSocket RPC connection and turns the worker's
 * `terminal.output` / `terminal.exit` notifications (re-emitted by
 * `RpcEventRouter` as registry events) into local EventEmitter events that the
 * IPC layer relays to the renderer.
 *
 * Scope: REMOTE terminals only (a `nodeId` is always required). Local terminals
 * would require node-pty inside the Electron main process; that is intentionally
 * deferred so node-pty stays confined to the worker bundle.
 */

import { EventEmitter } from 'events';
import { getLogger } from '../logging/logger';
import { getWorkerNodeConnectionServer } from './worker-node-connection';
import { getWorkerNodeRegistry } from './worker-node-registry';
import { COORDINATOR_TO_NODE } from './worker-node-rpc';

const logger = getLogger('RemoteTerminalManager');

export interface RemoteTerminalSpawnRequest {
  nodeId: string;
  cwd: string;
  shell?: string;
  env?: Record<string, string>;
  cols?: number;
  rows?: number;
}

export interface RemoteTerminalSpawnResult {
  sessionId: string;
  pid: number;
  nodeId: string;
}

interface RegistryTerminalOutputEvent {
  nodeId: string;
  sessionId: string;
  data: string;
}

interface RegistryTerminalExitEvent {
  nodeId: string;
  sessionId: string;
  exitCode: number | null;
  signal: string | null;
}

interface ManagedRemoteSession {
  nodeId: string;
  /** WS11.7 ring buffer: recent output chunks, trimmed to RETAINED_OUTPUT_BYTES. */
  outputChunks: string[];
  outputBytes: number;
}

/**
 * WS11.7: retained output per terminal session (256 KiB default) so a renderer
 * that (re)attaches — reopened panel, window reload — can replay recent
 * scrollback instead of starting blank.
 */
export const RETAINED_OUTPUT_BYTES = 256 * 1024;

let sessionCounter = 0;

export class RemoteTerminalManager extends EventEmitter {
  private static instance: RemoteTerminalManager | null = null;

  private readonly sessions = new Map<string, ManagedRemoteSession>();
  private listenersAttached = false;

  private readonly onTerminalOutput = (event: RegistryTerminalOutputEvent): void => {
    const session = this.sessions.get(event.sessionId);
    if (!session || session.nodeId !== event.nodeId) return;
    // WS11.7: retain a bounded scrollback for replay on renderer (re)attach.
    session.outputChunks.push(event.data);
    session.outputBytes += Buffer.byteLength(event.data);
    while (session.outputBytes > RETAINED_OUTPUT_BYTES && session.outputChunks.length > 1) {
      const dropped = session.outputChunks.shift()!;
      session.outputBytes -= Buffer.byteLength(dropped);
    }
    this.emit('output', { sessionId: event.sessionId, data: event.data });
  };

  private readonly onTerminalExit = (event: RegistryTerminalExitEvent): void => {
    const session = this.sessions.get(event.sessionId);
    if (!session || session.nodeId !== event.nodeId) return;
    this.sessions.delete(event.sessionId);
    this.emit('exit', {
      sessionId: event.sessionId,
      exitCode: event.exitCode,
      signal: event.signal,
    });
  };

  static getInstance(): RemoteTerminalManager {
    if (!this.instance) {
      this.instance = new RemoteTerminalManager();
    }
    return this.instance;
  }

  static _resetForTesting(): void {
    this.instance?.dispose();
    this.instance = null;
  }

  private constructor() {
    super();
  }

  /** Spawn a terminal on a connected worker node. */
  async spawn(req: RemoteTerminalSpawnRequest): Promise<RemoteTerminalSpawnResult> {
    if (!req.nodeId) {
      throw new Error('RemoteTerminalManager.spawn requires a nodeId');
    }
    const connection = getWorkerNodeConnectionServer();
    if (!connection.isNodeConnected(req.nodeId)) {
      throw new Error(`Worker node not connected: ${req.nodeId}`);
    }

    this.ensureListeners();

    const sessionId = `term-${Date.now()}-${++sessionCounter}`;
    // Register the session BEFORE the RPC resolves so output that races ahead of
    // the create response isn't dropped (mirrors RemoteCliAdapter.spawn).
    this.sessions.set(sessionId, { nodeId: req.nodeId, outputChunks: [], outputBytes: 0 });

    try {
      const result = await connection.sendRpc<{ sessionId: string; pid: number }>(
        req.nodeId,
        COORDINATOR_TO_NODE.TERMINAL_CREATE,
        {
          sessionId,
          cwd: req.cwd,
          shell: req.shell,
          env: req.env,
          cols: req.cols,
          rows: req.rows,
        },
      );
      logger.info('Remote terminal spawned', { nodeId: req.nodeId, sessionId, pid: result.pid });
      this.emit('spawned', { sessionId, pid: result.pid, nodeId: req.nodeId });
      return { sessionId, pid: result.pid, nodeId: req.nodeId };
    } catch (err) {
      this.sessions.delete(sessionId);
      logger.warn('Remote terminal spawn failed', {
        nodeId: req.nodeId,
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  async write(sessionId: string, data: string): Promise<void> {
    const session = this.requireSession(sessionId);
    await getWorkerNodeConnectionServer().sendRpc(
      session.nodeId,
      COORDINATOR_TO_NODE.TERMINAL_INPUT,
      { sessionId, data },
    );
  }

  async resize(sessionId: string, cols: number, rows: number): Promise<void> {
    const session = this.requireSession(sessionId);
    await getWorkerNodeConnectionServer().sendRpc(
      session.nodeId,
      COORDINATOR_TO_NODE.TERMINAL_RESIZE,
      { sessionId, cols, rows },
    );
  }

  /** Request termination. The session is dropped when the worker's exit arrives. */
  async kill(sessionId: string, signal?: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return; // idempotent
    try {
      await getWorkerNodeConnectionServer().sendRpc(
        session.nodeId,
        COORDINATOR_TO_NODE.TERMINAL_KILL,
        { sessionId, signal },
      );
    } catch (err) {
      logger.warn('Remote terminal kill RPC failed', {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  getNodeForSession(sessionId: string): string | undefined {
    return this.sessions.get(sessionId)?.nodeId;
  }

  /**
   * WS11.7: the retained scrollback (last ~256 KiB) for a live session, or
   * null when the session is unknown/exited. The renderer writes this to the
   * terminal before subscribing to live output on (re)attach.
   */
  getBufferedOutput(sessionId: string): string | null {
    const session = this.sessions.get(sessionId);
    return session ? session.outputChunks.join('') : null;
  }

  activeSessionCount(): number {
    return this.sessions.size;
  }

  dispose(): void {
    if (this.listenersAttached) {
      const registry = getWorkerNodeRegistry();
      registry.off('remote:terminal-output', this.onTerminalOutput);
      registry.off('remote:terminal-exit', this.onTerminalExit);
      this.listenersAttached = false;
    }
    this.sessions.clear();
    this.removeAllListeners();
  }

  private ensureListeners(): void {
    if (this.listenersAttached) return;
    const registry = getWorkerNodeRegistry();
    registry.on('remote:terminal-output', this.onTerminalOutput);
    registry.on('remote:terminal-exit', this.onTerminalExit);
    this.listenersAttached = true;
  }

  private requireSession(sessionId: string): ManagedRemoteSession {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Remote terminal session not found: ${sessionId}`);
    }
    return session;
  }
}

export function getRemoteTerminalManager(): RemoteTerminalManager {
  return RemoteTerminalManager.getInstance();
}
