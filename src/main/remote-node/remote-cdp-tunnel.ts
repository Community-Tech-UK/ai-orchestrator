import { randomUUID } from 'node:crypto';
import puppeteer, { type Browser } from 'puppeteer-core';
import { getWorkerNodeConnectionServer, type WorkerNodeConnectionServer } from './worker-node-connection';
import { getWorkerNodeRegistry, type WorkerNodeRegistry } from './worker-node-registry';
import { COORDINATOR_TO_NODE } from './worker-node-rpc';
import { getLogger } from '../logging/logger';

const logger = getLogger('RemoteCdpTunnel');

/** Open is awaited; per-frame sends are fire-and-forget over the WS. */
const OPEN_TIMEOUT_MS = 20_000;

/**
 * Structural copy of puppeteer's `ConnectionTransport`. Declared locally because
 * the renderer tsconfig (moduleResolution: bundler) also type-checks this
 * main-only file and resolves a narrower puppeteer-core type surface that omits
 * `ConnectionTransport`. The shape is stable and tiny; the real puppeteer that
 * consumes it only runs in the main process.
 */
export interface CdpConnectionTransport {
  send(message: string): void;
  close(): void;
  onmessage?: (message: string) => void;
  onclose?: () => void;
}

/** puppeteer.connect typed loosely to accept a custom transport under both tsconfigs. */
type PuppeteerConnect = (options: { transport: CdpConnectionTransport }) => Promise<Browser>;

/**
 * A puppeteer transport whose CDP frames are tunneled to a remote node's Chrome
 * over the worker connection. Incoming frames arriving before puppeteer wires
 * `onmessage` are buffered and flushed once it is set, so no early frame is lost.
 */
export class RemoteCdpTransport implements CdpConnectionTransport {
  private messageHandler?: (message: string) => void;
  private readonly pending: string[] = [];
  onclose?: () => void;

  constructor(
    private readonly opts: {
      send: (frame: string) => void;
      close: () => void;
    },
  ) {}

  get onmessage(): ((message: string) => void) | undefined {
    return this.messageHandler;
  }

  set onmessage(handler: ((message: string) => void) | undefined) {
    this.messageHandler = handler;
    if (handler && this.pending.length > 0) {
      const queued = this.pending.splice(0, this.pending.length);
      for (const frame of queued) {
        handler(frame);
      }
    }
  }

  send(message: string): void {
    this.opts.send(message);
  }

  close(): void {
    this.opts.close();
  }

  /** Deliver an inbound CDP frame from the node's Chrome. */
  deliverMessage(frame: string): void {
    if (this.messageHandler) {
      this.messageHandler(frame);
    } else {
      this.pending.push(frame);
    }
  }

  /** Signal the underlying Chrome socket closed. */
  deliverClose(): void {
    this.onclose?.();
  }
}

interface RemoteCdpTunnelClientDeps {
  connection: Pick<WorkerNodeConnectionServer, 'sendRpc' | 'sendNotification'>;
  registry: Pick<WorkerNodeRegistry, 'on'>;
  connectPuppeteer?: (transport: CdpConnectionTransport) => Promise<Browser>;
}

/** `${nodeId}::${sessionId}` */
function sessionKey(nodeId: string, sessionId: string): string {
  return `${nodeId}::${sessionId}`;
}

/**
 * Coordinator-side manager of remote CDP sessions. Routes node→coordinator
 * `browser.cdp.message`/`closed` events (re-emitted on the registry) to the right
 * transport, and exposes `connectBrowser(nodeId)` which returns a puppeteer
 * `Browser` driving that node's Chrome. The gateway then uses that Browser
 * exactly as it uses a locally-launched one — all governance stays here.
 */
export class RemoteCdpTunnelClient {
  private readonly connection: RemoteCdpTunnelClientDeps['connection'];
  private readonly connectPuppeteer: (transport: CdpConnectionTransport) => Promise<Browser>;
  private readonly transports = new Map<string, RemoteCdpTransport>();

  constructor(deps: RemoteCdpTunnelClientDeps) {
    this.connection = deps.connection;
    this.connectPuppeteer = deps.connectPuppeteer
      ?? ((transport) => (puppeteer.connect as unknown as PuppeteerConnect)({ transport }));

    deps.registry.on('remote:browser-cdp-message', (e: { nodeId: string; sessionId: string; frame: string }) => {
      this.transports.get(sessionKey(e.nodeId, e.sessionId))?.deliverMessage(e.frame);
    });
    deps.registry.on('remote:browser-cdp-closed', (e: { nodeId: string; sessionId: string }) => {
      const key = sessionKey(e.nodeId, e.sessionId);
      const transport = this.transports.get(key);
      this.transports.delete(key);
      transport?.deliverClose();
    });
    deps.registry.on('node:disconnected', (node: { id: string }) => {
      this.closeNodeSessions(node.id);
    });
  }

  /**
   * Open a CDP tunnel to the node and return a puppeteer Browser bound to its
   * Chrome. The caller owns the returned Browser; disconnecting it tears down
   * the session.
   */
  async connectBrowser(nodeId: string): Promise<Browser> {
    const sessionId = randomUUID();
    const key = sessionKey(nodeId, sessionId);

    await this.connection.sendRpc(
      nodeId,
      COORDINATOR_TO_NODE.BROWSER_CDP_OPEN,
      { sessionId },
      OPEN_TIMEOUT_MS,
      'service',
    );

    const transport = new RemoteCdpTransport({
      send: (frame) => {
        // Fire-and-forget: ws.send is enqueued in call order, preserving CDP
        // ordering; we don't need the per-frame ack.
        this.connection.sendNotification(
          nodeId,
          COORDINATOR_TO_NODE.BROWSER_CDP_SEND,
          { sessionId, frame },
          'service',
        );
      },
      close: () => {
        this.connection.sendNotification(
          nodeId,
          COORDINATOR_TO_NODE.BROWSER_CDP_CLOSE,
          { sessionId },
          'service',
        );
        this.transports.delete(key);
      },
    });
    this.transports.set(key, transport);

    try {
      const browser = await this.connectPuppeteer(transport);
      // `Browser` extends EventEmitter at runtime; the narrow type under the
      // renderer tsconfig doesn't expose `.on`, so reach it structurally.
      (browser as unknown as { on(event: string, cb: () => void): void }).on('disconnected', () => {
        this.transports.delete(key);
      });
      logger.info('Connected remote browser over CDP tunnel', { nodeId, sessionId });
      return browser;
    } catch (error) {
      this.transports.delete(key);
      transport.close();
      throw error;
    }
  }

  activeSessionCount(): number {
    return this.transports.size;
  }

  private closeNodeSessions(nodeId: string): void {
    const prefix = `${nodeId}::`;
    for (const [key, transport] of this.transports) {
      if (!key.startsWith(prefix)) {
        continue;
      }
      this.transports.delete(key);
      transport.deliverClose();
    }
  }
}

let singleton: RemoteCdpTunnelClient | null = null;

export function getRemoteCdpTunnelClient(): RemoteCdpTunnelClient {
  if (!singleton) {
    singleton = new RemoteCdpTunnelClient({
      connection: getWorkerNodeConnectionServer(),
      registry: getWorkerNodeRegistry(),
    });
  }
  return singleton;
}

export function _resetRemoteCdpTunnelClientForTesting(): void {
  singleton = null;
}
