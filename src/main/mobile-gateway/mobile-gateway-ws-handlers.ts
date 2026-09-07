/**
 * WebSocket connection handlers for the mobile gateway.
 *
 * Split out of mobile-gateway-server.ts, following the same deps-object pattern
 * this module already uses for its HTTP route handlers (mobile-gateway-history-
 * handlers, mobile-gateway-model-handlers, etc.). The gateway passes its
 * connection state and callbacks via WsHandlerDeps; these functions hold no
 * state of their own.
 */
import type { IncomingMessage } from 'http';
import type { Duplex } from 'stream';
import { URL } from 'url';
import type { WebSocketServer, WebSocket } from 'ws';
import { getLogger } from '../logging/logger';
import type { MobileDeviceRegistry } from './mobile-device-registry';
import { bearerFromHeader } from './mobile-gateway-http-utils';
import type {
  MobileClientEvent,
  MobileServerEvent,
  MobileSnapshot,
} from '../../shared/types/mobile-gateway.types';

const logger = getLogger('MobileGatewayWs');

/** State and callbacks the WS handlers need from the gateway server. */
export interface WsHandlerDeps {
  readonly registry: MobileDeviceRegistry;
  readonly wss: WebSocketServer | null;
  readonly clients: Set<WebSocket>;
  readonly clientAlive: WeakMap<WebSocket, boolean>;
  readonly activeViewByClient: Map<WebSocket, string>;
  /**
   * Which device each live socket belongs to. The token is only checked at the
   * upgrade, so without this a revoked device keeps streaming on the socket it
   * already holds — exactly the case revoking a lost phone needs to stop.
   */
  readonly deviceIdByClient: Map<WebSocket, string>;
  buildSnapshot(): MobileSnapshot;
  markCompletionViewed(instanceId: string): void;
}

export function handleWsUpgrade(
  deps: WsHandlerDeps,
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
): void {
  try {
    const url = new URL(req.url || '/', 'http://localhost');
    if (url.pathname !== '/ws') {
      socket.destroy();
      return;
    }
    const token = url.searchParams.get('token') || bearerFromHeader(req.headers['authorization']);
    const device = deps.registry.validateToken(token);
    if (!device) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    const wss = deps.wss;
    if (!wss) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      handleWsConnection(deps, ws, device.deviceId);
    });
  } catch (err) {
    logger.warn('WS upgrade failed', { error: err instanceof Error ? err.message : String(err) });
    socket.destroy();
  }
}

export function handleWsConnection(deps: WsHandlerDeps, ws: WebSocket, deviceId?: string): void {
  deps.clients.add(ws);
  deps.clientAlive.set(ws, true);
  if (deviceId) {
    deps.deviceIdByClient.set(ws, deviceId);
  }
  ws.on('pong', () => deps.clientAlive.set(ws, true));
  ws.on('message', (data) => handleWsClientMessage(deps, ws, data));
  ws.on('close', () => {
    deps.clients.delete(ws);
    deps.activeViewByClient.delete(ws);
    deps.deviceIdByClient.delete(ws);
  });
  ws.on('error', () => {
    deps.clients.delete(ws);
    deps.activeViewByClient.delete(ws);
    deps.deviceIdByClient.delete(ws);
  });
  // Initial snapshot (includes pending prompts + pause state).
  ws.send(
    JSON.stringify({ type: 'snapshot', data: deps.buildSnapshot() } satisfies MobileServerEvent),
  );
}

/**
 * Parse a client control frame. Currently only the `view` report, which
 * records (per socket) the conversation the phone is looking at so completions
 * for that session don't raise the unread dot. Defensive: malformed frames are
 * silently ignored — a client must never be able to crash the gateway.
 */
export function handleWsClientMessage(deps: WsHandlerDeps, ws: WebSocket, data: unknown): void {
  try {
    const raw = Array.isArray(data)
      ? Buffer.concat(data as Buffer[]).toString('utf8')
      : Buffer.isBuffer(data)
        ? data.toString('utf8')
        : data instanceof ArrayBuffer
          ? Buffer.from(data).toString('utf8')
          : String(data);
    const event = JSON.parse(raw) as MobileClientEvent;
    if (event?.type === 'view') {
      const id = typeof event.instanceId === 'string' && event.instanceId ? event.instanceId : null;
      if (id) {
        deps.activeViewByClient.set(ws, id);
        // Opening a conversation counts as viewing it — drop any existing dot.
        deps.markCompletionViewed(id);
      } else {
        deps.activeViewByClient.delete(ws);
      }
    }
  } catch {
    /* ignore malformed control frame */
  }
}

/** True while any connected client has this instance's conversation open. */
export function isInstanceBeingViewed(deps: WsHandlerDeps, instanceId: string): boolean {
  for (const viewed of deps.activeViewByClient.values()) {
    if (viewed === instanceId) return true;
  }
  return false;
}

/**
 * Drop every live socket belonging to a revoked device.
 *
 * The bearer token is validated only at the upgrade, so deleting it stops the
 * next connection but not the one already open. Without this, a lost phone
 * revoked from the desktop kept receiving output on the socket it already held —
 * which is the whole point of revoking it. 4001 is an application close code
 * meaning "your pairing was revoked".
 */
export function closeSocketsForDevice(deps: WsHandlerDeps, deviceId: string): void {
  let closed = 0;
  for (const [client, id] of deps.deviceIdByClient) {
    if (id !== deviceId) continue;
    deps.deviceIdByClient.delete(client);
    deps.clients.delete(client);
    deps.activeViewByClient.delete(client);
    closed += 1;
    try {
      client.close(4001, 'Device revoked');
    } catch {
      // Already dead; nothing left for the close handlers to clean up.
    }
  }
  if (closed > 0) {
    logger.info('Closed sockets for revoked mobile device', { deviceId, closed });
  }
}
