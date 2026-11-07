import { WebSocket, WebSocketServer } from 'ws';
import { formatHostPort } from '../../shared/remote-node/host-address';
import { listenDualStack } from './dual-stack-listen';
import type { PairBothWireMessage } from './pair-both-wire-schema';

const LOG_TEXT_MAX_CHARS = 200;

/**
 * Text from the other computer (its name, a close reason, an error message) as
 * it may appear in a log line: one line, at most 200 characters.
 */
export function capForLog(text: string | undefined, maxChars = LOG_TEXT_MAX_CHARS): string {
  const oneLine = (text ?? '').replace(/[\r\n\t]+/g, ' ').trim();
  return oneLine.length > maxChars ? `${oneLine.slice(0, maxChars)}...` : oneLine;
}

export interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

export function createDeferred<T>(): Deferred<T> {
  let resolveFn: (value: T) => void = () => undefined;
  let rejectFn: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolveFn = resolve;
    rejectFn = reject;
  });
  return { promise, resolve: resolveFn, reject: rejectFn };
}

export function sendPairBothMessage(
  socket: WebSocket,
  message: PairBothWireMessage,
): void {
  socket.send(JSON.stringify(message));
}

export function isPairingRateLimitError(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith('Too many pairing attempts');
}

export function waitForServerListening(server: WebSocketServer): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      server.off('listening', onListening);
      server.off('error', onError);
    };
    const onListening = (): void => {
      cleanup();
      resolve();
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    server.once('listening', onListening);
    server.once('error', onError);
  });
}

export function closeServer(server: WebSocketServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

export function closeSocket(socket: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    if (socket.readyState === WebSocket.CLOSED) {
      resolve();
      return;
    }
    socket.once('close', () => resolve());
    socket.close();
  });
}

export interface OpenFirstReachableSocketInput {
  /** Hosts to try in order. */
  addresses: string[];
  port: number;
  maxPayload: number;
  /** How long each address gets to answer before the next is tried. */
  perAddressTimeoutMs: number;
  /** Stop trying once this returns false (the pairing offer has expired). */
  shouldContinue?: () => boolean;
  onAttemptFailed?: (address: string, reason: string) => void;
}

/**
 * Dials each address in turn and returns the first socket that opens. The other
 * computer may be reachable on some of its addresses only (a Tailscale name this
 * network cannot route, a LAN address on another subnet), so one dead address
 * must not end the attempt.
 */
export async function openFirstReachableSocket(
  input: OpenFirstReachableSocketInput,
): Promise<{ socket: WebSocket; address: string }> {
  let tried = 0;
  for (const address of input.addresses) {
    if (input.shouldContinue && !input.shouldContinue()) break;
    tried += 1;
    try {
      return { socket: await openSocket(address, input), address };
    } catch (error) {
      input.onAttemptFailed?.(address, error instanceof Error ? error.message : String(error));
    }
  }
  throw new Error(
    `Pair-both could not reach the other computer on any of its addresses (tried ${tried} of ${input.addresses.length})`,
  );
}

function openSocket(address: string, input: OpenFirstReachableSocketInput): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://${formatHostPort(address, input.port)}`, {
      maxPayload: input.maxPayload,
      handshakeTimeout: input.perAddressTimeoutMs,
    });
    const onOpen = (): void => {
      socket.off('error', onError);
      resolve(socket);
    };
    const onError = (error: Error): void => {
      socket.off('open', onOpen);
      reject(error);
    };
    socket.once('open', onOpen);
    socket.once('error', onError);
  });
}

/** Opens the rendezvous listener on a free port; "all interfaces" also takes IPv6 workers. */
export function listenPairBothServer(host: string, maxPayload: number): Promise<WebSocketServer> {
  return listenDualStack(host, async (listenHost) => {
    const server = new WebSocketServer({ host: listenHost, port: 0, maxPayload });
    await waitForServerListening(server);
    return server;
  });
}

/** Closes every client of a rendezvous listener that is still open or connecting. */
export function closeServerClients(server: WebSocketServer): void {
  for (const client of server.clients) {
    if (client.readyState === WebSocket.OPEN || client.readyState === WebSocket.CONNECTING) {
      client.close();
    }
  }
}
