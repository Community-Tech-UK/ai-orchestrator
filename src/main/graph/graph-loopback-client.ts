import * as http from 'node:http';
import type { AuthorizeResponse } from '@azure/msal-node';

const MAX_CALLBACK_BYTES = 16_384;

interface GraphLoopbackResult {
  redirectUri: string;
  response: AuthorizeResponse;
}

export class GraphInteractiveTimeoutError extends Error {
  constructor() {
    super('GRAPH_INTERACTIVE_TIMEOUT: Microsoft sign-in was not completed before the deadline');
    this.name = 'GraphInteractiveTimeoutError';
  }
}

export class GraphLoopbackUnavailableError extends Error {
  constructor(message: string, cause?: unknown) {
    super(`GRAPH_LOOPBACK_UNAVAILABLE: ${message}`, { cause });
    this.name = 'GraphLoopbackUnavailableError';
  }
}

/** Bounded form-post callback transport; MSAL owns PKCE and token validation. */
export class TimedGraphLoopbackClient {
  private server: http.Server | null = null;
  private deadline: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly timeoutMs: number,
    private readonly expectedState: string,
  ) {}

  async listenForAuthCode(
    openBrowser: (redirectUri: string) => Promise<void>,
  ): Promise<GraphLoopbackResult> {
    if (this.server) {
      throw new GraphLoopbackUnavailableError('loopback server already exists');
    }

    try {
      return await new Promise<GraphLoopbackResult>((resolve, reject) => {
        let settled = false;
        const settle = (response?: AuthorizeResponse, error?: unknown): void => {
          if (settled) return;
          settled = true;
          this.clearDeadline();
          if (response) {
            resolve({ redirectUri: this.getRedirectUri(), response });
          } else {
            reject(error);
          }
        };

        this.server = http.createServer((request, response) => {
          response.setHeader('cache-control', 'no-store');
          response.setHeader('content-type', 'text/plain; charset=utf-8');
          response.setHeader('referrer-policy', 'no-referrer');
          if (request.method !== 'GET' && request.method !== 'POST') {
            response.writeHead(405, { allow: 'GET, POST' });
            response.end('Method Not Allowed');
            return;
          }
          if (request.url !== '/') {
            response.writeHead(400);
            response.end('Microsoft sign-in response was invalid.');
            return;
          }
          if (request.method === 'GET') {
            response.end('Microsoft sign-in is waiting for a response.');
            return;
          }
          const contentType = request.headers['content-type']?.split(';')[0]?.trim().toLowerCase();
          if (contentType !== 'application/x-www-form-urlencoded') {
            response.writeHead(415);
            response.end('Unsupported Media Type');
            return;
          }

          let body = '';
          let receivedBytes = 0;
          request.on('error', () => {
            if (!response.headersSent) response.writeHead(400);
            if (!response.writableEnded) response.end();
          });
          request.on('data', (chunk: Buffer) => {
            receivedBytes += chunk.length;
            if (receivedBytes > MAX_CALLBACK_BYTES) {
              if (!response.headersSent) {
                response.writeHead(413);
                response.end('Microsoft sign-in response was too large.');
              }
              return;
            }
            body += chunk.toString('utf8');
          });
          request.on('end', () => {
            if (response.writableEnded) return;
            const params = new URLSearchParams(body);
            const keys = [...params.keys()];
            if (
              new Set(keys).size !== keys.length
              || params.get('state') !== this.expectedState
              || Boolean(params.get('code')) === Boolean(params.get('error'))
            ) {
              response.writeHead(400);
              response.end('Microsoft sign-in response was invalid.');
              return;
            }
            // Callback fields must never become token-request configuration.
            const parsed: AuthorizeResponse = {};
            for (const key of ['code', 'state', 'client_info', 'error', 'error_description', 'suberror'] as const) {
              const value = params.get(key);
              if (value !== null) parsed[key] = value;
            }
            response.end(
              parsed.error
                ? 'Microsoft sign-in failed. You can close this window now.'
                : 'Auth code was successfully acquired. You can close this window now.',
              () => settle(parsed),
            );
          });
        });
        this.server.once('error', (error) => {
          settle(undefined, new GraphLoopbackUnavailableError('could not listen on localhost', error));
        });
        this.server.listen(0, '127.0.0.1', () => {
          this.deadline = setTimeout(() => {
            settle(undefined, new GraphInteractiveTimeoutError());
          }, this.timeoutMs);
          this.deadline.unref?.();
          Promise.resolve()
            .then(() => openBrowser(this.getRedirectUri()))
            .catch((error: unknown) => settle(undefined, error));
        });
      });
    } finally {
      this.closeServer();
    }
  }

  getRedirectUri(): string {
    const address = this.server?.address();
    if (!this.server?.listening || !address || typeof address === 'string') {
      throw new GraphLoopbackUnavailableError('loopback server is not listening');
    }
    return `http://localhost:${address.port}`;
  }

  private closeServer(): void {
    this.clearDeadline();
    const server = this.server;
    this.server = null;
    if (!server) return;
    server.close();
    server.closeAllConnections();
    server.unref();
  }

  private clearDeadline(): void {
    if (this.deadline) clearTimeout(this.deadline);
    this.deadline = null;
  }
}
