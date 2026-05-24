/**
 * Codemem RPC Client (forwarder-side).
 *
 * Used by the `aio-mcp codemem` thin stdio forwarder to proxy every MCP
 * codemem tool invocation back to `CodememRpcServer` running in the parent
 * process. Talks line-delimited JSON-RPC 2.0 over the Unix socket the parent
 * advertises via `AI_ORCHESTRATOR_CODEMEM_SOCKET` (or a named pipe on
 * Windows), authenticating with the per-child instance id passed in
 * `AI_ORCHESTRATOR_INSTANCE_ID`.
 *
 * One-shot connect-send-recv-close per call, matching the established
 * `BrowserGatewayRpcClient` and `OrchestratorToolsRpcClient` patterns.
 */

import * as net from 'node:net';

export interface CodememRpcClientOptions {
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
}

export interface CodememRpcClientLike {
  call(method: string, payload: Record<string, unknown>): Promise<unknown>;
}

let nextRequestId = 1;

export class CodememUnavailableError extends Error {
  constructor() {
    super('codemem RPC unavailable: parent socket/instance id missing');
    this.name = 'CodememUnavailableError';
  }
}

export class CodememRpcClient implements CodememRpcClientLike {
  private readonly env: Record<string, string | undefined>;
  private readonly timeoutMs: number;

  constructor(options: CodememRpcClientOptions = {}) {
    this.env = options.env ?? process.env;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  async call(method: string, payload: Record<string, unknown>): Promise<unknown> {
    const socketPath = this.env['AI_ORCHESTRATOR_CODEMEM_SOCKET'];
    const instanceId = this.env['AI_ORCHESTRATOR_INSTANCE_ID'];
    if (!socketPath || !instanceId) {
      throw new CodememUnavailableError();
    }
    return this.send(socketPath, {
      jsonrpc: '2.0',
      id: nextRequestId++,
      method,
      params: { instanceId, payload },
    });
  }

  private send(socketPath: string, request: Record<string, unknown>): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      const socket = net.connect(socketPath);
      let buffer = '';
      const timeout = setTimeout(() => {
        socket.destroy();
        reject(new Error('codemem RPC request timed out'));
      }, this.timeoutMs);

      socket.on('connect', () => {
        socket.write(`${JSON.stringify(request)}\n`);
      });
      socket.on('data', (chunk) => {
        buffer += chunk.toString('utf-8');
        const newline = buffer.indexOf('\n');
        if (newline === -1) {
          return;
        }
        const line = buffer.slice(0, newline);
        clearTimeout(timeout);
        socket.end();
        let response: { result?: unknown; error?: { message?: string } };
        try {
          response = JSON.parse(line) as { result?: unknown; error?: { message?: string } };
        } catch (parseError) {
          reject(parseError instanceof Error ? parseError : new Error(String(parseError)));
          return;
        }
        if (response.error) {
          reject(new Error(response.error.message ?? 'codemem RPC failed'));
          return;
        }
        resolve(response.result);
      });
      socket.on('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });
  }
}
