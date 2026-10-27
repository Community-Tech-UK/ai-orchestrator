/**
 * Orchestrator-Tools RPC Client (forwarder-side).
 *
 * Used by the `aio-mcp orchestrator-tools` thin stdio forwarder to proxy every
 * MCP tool invocation back to `OrchestratorToolsRpcServer` running in the
 * parent process. Talks line-delimited JSON-RPC 2.0 over the Unix socket the
 * parent advertises via `AI_ORCHESTRATOR_ORCHESTRATOR_TOOLS_SOCKET` (or a
 * named pipe on Windows), authenticating with the per-child instance id
 * passed in `AI_ORCHESTRATOR_INSTANCE_ID` plus the per-spawn capability
 * token passed in `AI_ORCHESTRATOR_ORCHESTRATOR_TOOLS_CAPABILITY` — the
 * instance id alone is guessable (and visible to any process that can read
 * another instance's env), so the server rejects a request missing a
 * matching capability.
 *
 * Errors surface as plain rejections — the forwarder turns them into MCP
 * JSON-RPC error responses on stdout. Connection is one-shot per call
 * (matches `BrowserGatewayRpcClient`).
 */

import * as net from 'node:net';

export interface OrchestratorToolsRpcClientOptions {
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
}

export interface OrchestratorToolsRpcCallOptions {
  signal?: AbortSignal;
}

export interface OrchestratorToolsRpcClientLike {
  call(
    method: string,
    payload: Record<string, unknown>,
    options?: OrchestratorToolsRpcCallOptions,
  ): Promise<unknown>;
}

let nextRequestId = 1;

export class OrchestratorToolsUnavailableError extends Error {
  constructor() {
    super('orchestrator-tools RPC unavailable: parent socket/instance id missing');
    this.name = 'OrchestratorToolsUnavailableError';
  }
}

export class OrchestratorToolsRpcClient implements OrchestratorToolsRpcClientLike {
  private readonly env: Record<string, string | undefined>;
  private readonly timeoutMs: number;

  constructor(options: OrchestratorToolsRpcClientOptions = {}) {
    this.env = options.env ?? process.env;
    this.timeoutMs = options.timeoutMs ?? 5 * 60_000; // long-running git pulls
  }

  async call(
    method: string,
    payload: Record<string, unknown>,
    options: OrchestratorToolsRpcCallOptions = {},
  ): Promise<unknown> {
    const socketPath = this.env['AI_ORCHESTRATOR_ORCHESTRATOR_TOOLS_SOCKET'];
    const instanceId = this.env['AI_ORCHESTRATOR_INSTANCE_ID'];
    const capability = this.env['AI_ORCHESTRATOR_ORCHESTRATOR_TOOLS_CAPABILITY'];
    if (!socketPath || !instanceId || !capability) {
      throw new OrchestratorToolsUnavailableError();
    }
    return this.send(
      socketPath,
      {
        jsonrpc: '2.0',
        id: nextRequestId++,
        method,
        params: { instanceId, capability, payload },
      },
      options.signal,
    );
  }

  private send(
    socketPath: string,
    request: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error('orchestrator-tools RPC request cancelled'));
        return;
      }
      const socket = net.connect(socketPath);
      let buffer = '';
      let settled = false;
      const finish = (error: Error | null, result?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        signal?.removeEventListener('abort', abort);
        if (error) {
          socket.destroy();
          reject(error);
        } else {
          socket.end();
          resolve(result);
        }
      };
      const abort = () => finish(new Error('orchestrator-tools RPC request cancelled'));
      const timeout = setTimeout(
        () => finish(new Error('orchestrator-tools RPC request timed out')),
        this.timeoutMs,
      );
      signal?.addEventListener('abort', abort, { once: true });
      socket.once('connect', () => socket.write(`${JSON.stringify(request)}\n`));
      socket.on('data', (chunk) => {
        if (settled) return;
        buffer += chunk.toString('utf-8');
        const newline = buffer.indexOf('\n');
        if (newline === -1) return;
        let response: { result?: unknown; error?: { message?: string } };
        try {
          response = JSON.parse(buffer.slice(0, newline)) as typeof response;
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)));
          return;
        }
        if (response.error)
          finish(new Error(response.error.message ?? 'orchestrator-tools RPC failed'));
        else finish(null, response.result);
      });
      socket.once('error', (error) => finish(error));
      socket.once('close', () => {
        if (!settled) finish(new Error('orchestrator-tools RPC connection closed before a reply'));
      });
    });
  }
}
