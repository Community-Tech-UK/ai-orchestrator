import type * as net from 'node:net';

export interface OrchestratorToolsRpcSocketRequest {
  jsonrpc?: '2.0';
  id?: number | string | null;
  method: string;
  params?: unknown;
}

interface OneShotRpcSocketOptions {
  maxMessageBytes: number;
  /** Throws to reject the request before `handle` runs (e.g. bad capability). */
  authenticate: (request: OrchestratorToolsRpcSocketRequest) => void;
  handle: (
    request: OrchestratorToolsRpcSocketRequest,
    abortSignal: AbortSignal,
  ) => Promise<unknown>;
}

/**
 * Serve one line-delimited JSON-RPC request for a short-lived child
 * connection (matches `OrchestratorToolsRpcClient`, which opens a fresh
 * socket per call). The abort signal mirrors socket disconnects so a
 * long-polling tool (e.g. `read_node_output` with `waitMs`) can release
 * main-process state — stop polling/sleeping — as soon as the caller goes
 * away, instead of running out its full wait budget for nobody.
 */
export function handleOneShotOrchestratorToolsRpcSocket(
  socket: net.Socket,
  options: OneShotRpcSocketOptions,
): void {
  let buffer = '';
  let finished = false;
  let requestStarted = false;
  const finish = (payload: string): void => {
    if (finished) return;
    finished = true;
    socket.off('data', onData);
    socket.end(payload);
  };
  const onData = (chunk: Buffer) => {
    if (finished) return;
    buffer += chunk.toString('utf-8');
    if (Buffer.byteLength(buffer, 'utf-8') > options.maxMessageBytes) {
      finish(errorPayload(null, 'Orchestrator-tools RPC request too large'));
      return;
    }
    const newline = buffer.indexOf('\n');
    if (newline === -1) return;
    const line = buffer.slice(0, newline);
    // One request per connection: detach before awaiting the handler so a
    // second data event can never dispatch a second request while the first
    // is still in flight.
    if (requestStarted) return;
    requestStarted = true;
    buffer = '';
    socket.off('data', onData);
    void handleLine(socket, line, options, finish);
  };
  // A peer can reset immediately after receiving a response; absorb that
  // expected transport error instead of an uncaught process error.
  socket.on('error', () => undefined);
  socket.on('data', onData);
}

async function handleLine(
  socket: net.Socket,
  line: string,
  options: OneShotRpcSocketOptions,
  finish: (payload: string) => void,
): Promise<void> {
  let request: OrchestratorToolsRpcSocketRequest | null = null;
  const abortController = new AbortController();
  const abortOnDisconnect = () => abortController.abort();
  socket.once('close', abortOnDisconnect);
  try {
    request = JSON.parse(line) as OrchestratorToolsRpcSocketRequest;
    options.authenticate(request);
    const result = await options.handle(request, abortController.signal);
    finish(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n`);
  } catch (error) {
    finish(errorPayload(
      request?.id ?? null,
      error instanceof SyntaxError
        ? 'Invalid orchestrator-tools RPC request JSON'
        : error instanceof Error
          ? error.message
          : String(error),
    ));
  } finally {
    socket.off('close', abortOnDisconnect);
  }
}

function errorPayload(
  id: OrchestratorToolsRpcSocketRequest['id'],
  message: string,
): string {
  return `${JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32000, message } })}\n`;
}
