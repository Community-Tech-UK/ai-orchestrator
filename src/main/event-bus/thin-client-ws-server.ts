import { WebSocketServer, WebSocket } from 'ws';
import { getLogger } from '../logging/logger';
import type { WsEventTransportOptions } from './ws-event-transport';
import { WsEventTransport } from './ws-event-transport';

const logger = getLogger('ThinClientWsServer');

export interface ThinClientWsStartOptions {
  host: string;
  port: number;
}

export interface ThinClientWsStatus {
  running: boolean;
  host: string;
  port: number;
}

export class ThinClientWsServer {
  private static instance: ThinClientWsServer | null = null;

  private wss: WebSocketServer | null = null;
  private host = '127.0.0.1';
  private port = 0;

  constructor(private readonly transportOptions: WsEventTransportOptions) {}

  static initialize(options: WsEventTransportOptions): ThinClientWsServer {
    this.instance = new ThinClientWsServer(options);
    return this.instance;
  }

  static getInstance(): ThinClientWsServer {
    if (!this.instance) {
      throw new Error('ThinClientWsServer has not been initialized');
    }
    return this.instance;
  }

  static _resetForTesting(): void {
    if (this.instance) {
      void this.instance.stop();
      this.instance = null;
    }
  }

  async start(options: ThinClientWsStartOptions): Promise<ThinClientWsStatus> {
    if (this.wss) {
      return this.getStatus();
    }

    await new Promise<void>((resolve, reject) => {
      const wss = new WebSocketServer({ host: options.host, port: options.port });

      wss.on('connection', (socket) => {
        this.handleConnection(socket);
      });
      wss.on('error', (error) => {
        if (!this.wss) {
          reject(error);
          return;
        }
        logger.error('Thin-client WebSocket server error', error);
      });
      wss.on('listening', () => {
        this.wss = wss;
        this.host = options.host;
        this.port = resolveListeningPort(wss, options.port);
        logger.info('Thin-client WebSocket server listening', {
          host: this.host,
          port: this.port,
        });
        resolve();
      });
    });

    return this.getStatus();
  }

  async stop(): Promise<ThinClientWsStatus> {
    if (!this.wss) {
      return this.getStatus();
    }

    const wss = this.wss;
    this.wss = null;
    for (const client of wss.clients) {
      client.close(1001, 'Server shutting down');
    }

    await new Promise<void>((resolve, reject) => {
      wss.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
    logger.info('Thin-client WebSocket server stopped');
    return this.getStatus();
  }

  getStatus(): ThinClientWsStatus {
    return {
      running: this.wss !== null,
      host: this.host,
      port: this.port,
    };
  }

  private handleConnection(socket: WebSocket): void {
    const transport = new WsEventTransport(socket, this.transportOptions);
    socket.on('message', (data) => {
      if (!transport.handleClientMessage(data)) {
        socket.close(1003, 'Thin-client command required');
      }
    });
  }
}

export function initializeThinClientWsServer(options: WsEventTransportOptions): ThinClientWsServer {
  return ThinClientWsServer.initialize(options);
}

export function getThinClientWsServer(): ThinClientWsServer {
  return ThinClientWsServer.getInstance();
}

function resolveListeningPort(wss: WebSocketServer, fallback: number): number {
  const address = wss.address();
  return typeof address === 'object' && address !== null ? address.port : fallback;
}
