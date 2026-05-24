/**
 * Orchestrator-Tools RPC Client (forwarder-side).
 *
 * Used by the `aio-mcp orchestrator-tools` thin stdio forwarder to proxy every
 * MCP tool invocation back to `OrchestratorToolsRpcServer` running in the
 * parent process. Talks line-delimited JSON-RPC 2.0 over the Unix socket the
 * parent advertises via `AI_ORCHESTRATOR_ORCHESTRATOR_TOOLS_SOCKET` (or a
 * named pipe on Windows), authenticating with the per-child instance id
 * passed in `AI_ORCHESTRATOR_INSTANCE_ID`.
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

export interface OrchestratorToolsRpcClientLike {
  call(method: string, payload: Record<string, unknown>): Promise<unknown>;
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

  async call(method: string, payload: Record<string, unknown>): Promise<unknown> {
    const socketPath = this.env['AI_ORCHESTRATOR_ORCHESTRATOR_TOOLS_SOCKET'];
    const instanceId = this.env['AI_ORCHESTRATOR_INSTANCE_ID'];
    if (!socketPath || !instanceId) {
      throw new OrchestratorToolsUnavailableError();
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
        reject(new Error('orchestrator-tools RPC request timed out'));
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
          reject(new Error(response.error.message ?? 'orchestrator-tools RPC failed'));
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
