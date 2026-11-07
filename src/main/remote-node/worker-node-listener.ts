import * as fs from 'fs';
import * as https from 'https';
import { WebSocketServer } from 'ws';
import { getLogger } from '../logging/logger';
import { WORKER_NODE_WS_MAX_PAYLOAD_BYTES } from './rpc-schemas';
import type { RemoteNodeConfig } from './remote-node-config';

const logger = getLogger('WorkerNodeConnection');

export interface WorkerNodeListenInput {
  port: number;
  host: string;
  config: Pick<RemoteNodeConfig, 'tlsCertPath' | 'tlsKeyPath' | 'tlsCaPath'>;
  /** Whether the server already finished starting (later errors are logged, not thrown). */
  isRunning: () => boolean;
}

/**
 * Opens the worker WebSocket server on `host`: WSS when a certificate and key are
 * configured, plain WS otherwise. Resolves once it is listening; a failure to
 * listen rejects, while a later error is logged.
 */
export function listenWorkerNodeServer(input: WorkerNodeListenInput): Promise<WebSocketServer> {
  const { port, host, config } = input;
  return new Promise<WebSocketServer>((resolve, reject) => {
    if (config.tlsCertPath && config.tlsKeyPath) {
      const server = https.createServer({
        cert: fs.readFileSync(config.tlsCertPath),
        key: fs.readFileSync(config.tlsKeyPath),
        ...(config.tlsCaPath ? { ca: fs.readFileSync(config.tlsCaPath), requestCert: true, rejectUnauthorized: true } : {}),
      });
      const wss = new WebSocketServer({ server, maxPayload: WORKER_NODE_WS_MAX_PAYLOAD_BYTES });
      // `ws` re-emits the HTTPS server's errors on itself; without a listener
      // that re-emit throws before the handler below can reject or log it.
      wss.on('error', () => undefined);

      server.on('error', (err) => {
        if (!input.isRunning()) reject(err);
        else logger.error('HTTPS server error', err);
      });
      server.listen(port, host, () => {
        logger.info('WorkerNodeConnectionServer listening (WSS/TLS)', { host, port });
        resolve(wss);
      });
      return;
    }

    const wss = new WebSocketServer({ host, port, maxPayload: WORKER_NODE_WS_MAX_PAYLOAD_BYTES });
    wss.on('error', (err) => {
      if (!input.isRunning()) reject(err);
      else logger.error('WebSocket server error', err);
    });
    wss.on('listening', () => {
      logger.info('WorkerNodeConnectionServer listening', { host, port });
      resolve(wss);
    });
  });
}
