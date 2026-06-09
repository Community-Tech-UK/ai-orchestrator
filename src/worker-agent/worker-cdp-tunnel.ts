import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';
import type { WorkerBrowserManager } from './worker-browser-manager';

/**
 * Worker side of the remote browser CDP tunnel (Path 2).
 *
 * The coordinator's gateway drives this node's Chrome by opening a logical CDP
 * session over the worker connection. For each session this tunnel holds a
 * WebSocket to Chrome's browser-level CDP endpoint and relays frames in both
 * directions:
 *   coordinator --(browser.cdp.send)--> tunnel.send() --> Chrome CDP socket
 *   Chrome CDP socket --> 'message' event --> (browser.cdp.message) --> coordinator
 *
 * Node-only (ws + WorkerBrowserManager); no Electron. The whole gateway stays on
 * the coordinator — this tunnel is just a frame pipe.
 */
export interface WorkerCdpTunnelDeps {
  browserManager: Pick<WorkerBrowserManager, 'getBrowserWsEndpoint'>;
  /** Override the WS client factory (tests). */
  wsFactory?: (endpoint: string) => WebSocket;
  /** How long to wait for the Chrome CDP socket to open. */
  openTimeoutMs?: number;
}

const DEFAULT_OPEN_TIMEOUT_MS = 15_000;

type TunnelEvent =
  | { type: 'message'; sessionId: string; frame: string }
  | { type: 'closed'; sessionId: string };

export interface WorkerCdpTunnel {
  on(event: 'message', listener: (e: { sessionId: string; frame: string }) => void): this;
  on(event: 'closed', listener: (e: { sessionId: string }) => void): this;
}

export class WorkerCdpTunnel extends EventEmitter {
  private readonly browserManager: WorkerCdpTunnelDeps['browserManager'];
  private readonly wsFactory: (endpoint: string) => WebSocket;
  private readonly openTimeoutMs: number;
  private readonly sockets = new Map<string, WebSocket>();

  constructor(deps: WorkerCdpTunnelDeps) {
    super();
    this.browserManager = deps.browserManager;
    this.wsFactory = deps.wsFactory ?? ((endpoint) => new WebSocket(endpoint, { maxPayload: 0 }));
    this.openTimeoutMs = deps.openTimeoutMs ?? DEFAULT_OPEN_TIMEOUT_MS;
  }

  /**
   * Open a CDP session: ensure Chrome is up, connect to its browser-level CDP
   * endpoint, and start relaying. Idempotent per sessionId.
   */
  async open(sessionId: string): Promise<void> {
    if (this.sockets.has(sessionId)) {
      return;
    }
    const endpoint = await this.browserManager.getBrowserWsEndpoint();
    const ws = this.wsFactory(endpoint);
    // Register before 'open' so a frame that races the open is not lost.
    this.sockets.set(sessionId, ws);

    ws.on('message', (data: Buffer | ArrayBuffer | Buffer[]) => {
      this.emitEvent({ type: 'message', sessionId, frame: cdpFrameToString(data) });
    });
    ws.on('close', () => {
      if (this.sockets.get(sessionId) === ws) {
        this.sockets.delete(sessionId);
      }
      this.emitEvent({ type: 'closed', sessionId });
    });
    ws.on('error', () => {
      // 'close' always follows 'error' on ws; teardown happens there.
    });

    await this.waitForOpen(ws, sessionId);
  }

  /** Forward a coordinator→Chrome frame. No-op for an unknown/closed session. */
  send(sessionId: string, frame: string): void {
    const ws = this.sockets.get(sessionId);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(frame);
    }
  }

  /** Close one session. Idempotent. */
  close(sessionId: string): void {
    const ws = this.sockets.get(sessionId);
    this.sockets.delete(sessionId);
    try {
      ws?.close();
    } catch {
      /* already closing */
    }
  }

  /** Close all sessions (worker shutdown / node disconnect). */
  closeAll(): void {
    for (const sessionId of [...this.sockets.keys()]) {
      this.close(sessionId);
    }
  }

  activeSessionCount(): number {
    return this.sockets.size;
  }

  private waitForOpen(ws: WebSocket, sessionId: string): Promise<void> {
    if (ws.readyState === WebSocket.OPEN) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        this.close(sessionId);
        reject(new Error('Timed out opening Chrome CDP socket'));
      }, this.openTimeoutMs);
      const onOpen = (): void => {
        cleanup();
        resolve();
      };
      const onError = (err: Error): void => {
        cleanup();
        // Don't rely on a subsequent 'close' to clean up a never-opened socket.
        this.close(sessionId);
        reject(err);
      };
      const cleanup = (): void => {
        clearTimeout(timer);
        ws.off('open', onOpen);
        ws.off('error', onError);
      };
      ws.on('open', onOpen);
      ws.on('error', onError);
    });
  }

  private emitEvent(event: TunnelEvent): void {
    if (event.type === 'message') {
      this.emit('message', { sessionId: event.sessionId, frame: event.frame });
    } else {
      this.emit('closed', { sessionId: event.sessionId });
    }
  }
}

function cdpFrameToString(data: Buffer | ArrayBuffer | Buffer[]): string {
  if (typeof data === 'string') {
    return data;
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString('utf-8');
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString('utf-8');
  }
  return (data as Buffer).toString('utf-8');
}
