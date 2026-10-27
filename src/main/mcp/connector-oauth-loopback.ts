import * as http from 'node:http';

export interface ConnectorOAuthLoopback {
  redirectUrl: string;
  result: Promise<URLSearchParams>;
  close(): void;
}
/** A bounded, loopback-only callback. Invalid state never consumes the pending flow. */
export async function listenConnectorOAuth(
  state: string,
  timeoutMs = 180_000,
): Promise<ConnectorOAuthLoopback> {
  let accept!: (params: URLSearchParams) => void;
  let fail!: (error: Error) => void;
  let settled = false;
  const result = new Promise<URLSearchParams>((resolve, reject) => {
    accept = resolve;
    fail = reject;
  });
  // Discovery can fail before callers start awaiting the callback.
  void result.catch(() => undefined);
  const server = http.createServer((req, res) => {
    res.setHeader('cache-control', 'no-store');
    res.setHeader('content-type', 'text/plain; charset=utf-8');
    res.setHeader('referrer-policy', 'no-referrer');
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://localhost');
    } catch {
      res.writeHead(400);
      res.end('Sign-in response was invalid.');
      return;
    }
    const params = url.searchParams;
    const keys = [...params.keys()];
    if (
      req.method !== 'GET' ||
      url.pathname !== '/callback' ||
      req.url!.length > 16384 ||
      new Set(keys).size !== keys.length ||
      params.get('state') !== state ||
      Boolean(params.get('code')) === Boolean(params.get('error'))
    ) {
      res.writeHead(400);
      res.end('Sign-in response was invalid.');
      return;
    }
    if (settled) {
      res.writeHead(409);
      res.end('Sign-in response already received.');
      return;
    }
    settled = true;
    res.end('Return to Harness. You can close this window.');
    accept(params);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Could not listen for connector sign-in.');
  const timer = setTimeout(() => {
    if (!settled) {
      settled = true;
      fail(new Error('Connector sign-in timed out. Try again.'));
    }
    close();
  }, timeoutMs);
  timer.unref();
  function close() {
    clearTimeout(timer);
    server.close();
    server.closeAllConnections();
    if (!settled) {
      settled = true;
      fail(new Error('Connector sign-in cancelled.'));
    }
  }
  return { redirectUrl: `http://127.0.0.1:${address.port}/callback`, result, close };
}
