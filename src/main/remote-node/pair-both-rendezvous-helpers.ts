import { WebSocket, WebSocketServer } from 'ws';
import type { PairBothWireMessage } from './pair-both-wire-schema';

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
