import * as http from 'node:http';
import type { ILoopbackClient } from '@azure/msal-node';

type GraphAuthorizeResponse = Awaited<ReturnType<ILoopbackClient['listenForAuthCode']>>;

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

/**
 * MSAL-compatible localhost callback listener with an explicit lifetime.
 * MSAL still owns PKCE, state validation, and the authorization-code exchange.
 */
export class TimedGraphLoopbackClient implements ILoopbackClient {
  private server: http.Server | null = null;
  private deadline: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly timeoutMs: number) {}

  listenForAuthCode(
    successTemplate?: string,
    errorTemplate?: string,
  ): Promise<GraphAuthorizeResponse> {
    if (this.server) {
      throw new GraphLoopbackUnavailableError('loopback server already exists');
    }

    return new Promise<GraphAuthorizeResponse>((resolve, reject) => {
      let pendingResponse: GraphAuthorizeResponse | null = null;
      let settled = false;
      const prepareToSettle = (): boolean => {
        if (settled) return false;
        settled = true;
        this.clearDeadline();
        return true;
      };
      const succeed = (value: GraphAuthorizeResponse): void => {
        if (prepareToSettle()) resolve(value);
      };
      const fail = (error: Error): void => {
        if (prepareToSettle()) reject(error);
      };

      this.server = http.createServer((request, response) => {
        if (request.method !== 'GET') {
          response.writeHead(405, { allow: 'GET' });
          response.end('Method Not Allowed');
          return;
        }
        if (!request.url) {
          response.writeHead(400);
          response.end(errorTemplate ?? 'Microsoft sign-in callback was invalid.');
          fail(new GraphLoopbackUnavailableError('callback URL was missing'));
          return;
        }

        const callback = new URL(request.url, this.getRedirectUri());
        if (callback.pathname === '/complete' && pendingResponse) {
          response.writeHead(200, {
            'cache-control': 'no-store',
            'content-type': 'text/plain; charset=utf-8',
            'referrer-policy': 'no-referrer',
          });
          response.end(
            successTemplate ??
              'Auth code was successfully acquired. You can close this window now.',
          );
          succeed(pendingResponse);
          return;
        }

        const parsed = Object.fromEntries(callback.searchParams.entries()) as GraphAuthorizeResponse;
        if (typeof parsed.error === 'string') {
          response.writeHead(200, {
            'cache-control': 'no-store',
            'content-type': 'text/plain; charset=utf-8',
            'referrer-policy': 'no-referrer',
          });
          response.end(errorTemplate ?? `Microsoft sign-in failed: ${parsed.error}`);
          succeed(parsed);
          return;
        }
        if (typeof parsed.code !== 'string') {
          response.writeHead(200, { 'cache-control': 'no-store' });
          response.end();
          return;
        }

        pendingResponse = parsed;
        response.writeHead(302, {
          'cache-control': 'no-store',
          location: `${this.getRedirectUri()}/complete`,
          'referrer-policy': 'no-referrer',
        });
        response.end();
      });
      this.server.once('error', (error) => {
        this.closeServer();
        fail(new GraphLoopbackUnavailableError('could not listen on localhost', error));
      });
      this.server.listen(0, '127.0.0.1', () => {
        this.deadline = setTimeout(() => {
          this.closeServer();
          fail(new GraphInteractiveTimeoutError());
        }, this.timeoutMs);
        this.deadline.unref?.();
      });
    });
  }

  getRedirectUri(): string {
    const address = this.server?.address();
    if (!this.server?.listening || !address || typeof address === 'string') {
      throw new GraphLoopbackUnavailableError('loopback server is not listening');
    }
    return `http://localhost:${address.port}`;
  }

  closeServer(): void {
    this.clearDeadline();
    const server = this.server;
    this.server = null;
    if (!server) return;
    server.close();
    server.closeAllConnections?.();
    server.unref();
  }

  private clearDeadline(): void {
    if (this.deadline) clearTimeout(this.deadline);
    this.deadline = null;
  }
}
