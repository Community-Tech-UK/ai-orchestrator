import * as net from 'node:net';

export interface BrowserGatewayRpcClientOptions {
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
}

export interface BrowserGatewayRpcClientLike {
  call(method: string, payload: Record<string, unknown>): Promise<unknown>;
}

let nextRequestId = 1;

class BrowserGatewayRpcError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BrowserGatewayRpcError';
  }
}

function unavailable(): Record<string, unknown> {
  return {
    decision: 'denied',
    outcome: 'not_run',
    reason: 'browser_gateway_unavailable',
  };
}

function deniedForRpcError(error: BrowserGatewayRpcError): Record<string, unknown> {
  return {
    decision: 'denied',
    outcome: 'not_run',
    reason: normalizeRpcErrorReason(error.message),
    data: {
      message: error.message,
    },
  };
}

function normalizeRpcErrorReason(message: string): string {
  const normalized = message.toLowerCase();
  if (normalized.includes('unknown browser gateway instance')) {
    return 'unknown_browser_gateway_instance';
  }
  if (normalized.includes('invalid browser gateway rpc payload')) {
    return 'invalid_browser_gateway_rpc_payload';
  }
  if (normalized.includes('payload too large')) {
    return 'browser_gateway_rpc_payload_too_large';
  }
  if (normalized.includes('rate limit')) {
    return 'browser_gateway_rpc_rate_limited';
  }
  if (normalized.includes('service method unavailable')) {
    return 'browser_gateway_service_method_unavailable';
  }
  return 'browser_gateway_rpc_error';
}

export class BrowserGatewayRpcClient implements BrowserGatewayRpcClientLike {
  private readonly env: Record<string, string | undefined>;
  private readonly timeoutMs: number;

  constructor(options: BrowserGatewayRpcClientOptions = {}) {
    this.env = options.env ?? process.env;
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  async call(method: string, payload: Record<string, unknown>): Promise<unknown> {
    const socketPath = this.env['AI_ORCHESTRATOR_BROWSER_GATEWAY_SOCKET'];
    const instanceId = this.env['AI_ORCHESTRATOR_BROWSER_INSTANCE_ID'];
    const provider = this.env['AI_ORCHESTRATOR_BROWSER_PROVIDER'];
    if (!socketPath || !instanceId) {
      return unavailable();
    }

    try {
      return await this.send(socketPath, {
        jsonrpc: '2.0',
        id: nextRequestId++,
        method,
        params: {
          instanceId,
          ...(provider ? { provider } : {}),
          payload,
        },
      });
    } catch (error) {
      if (error instanceof BrowserGatewayRpcError) {
        return deniedForRpcError(error);
      }
      return unavailable();
    }
  }

  private send(socketPath: string, request: Record<string, unknown>): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      const socket = net.connect(socketPath);
      let buffer = '';
      const timeout = setTimeout(() => {
        socket.destroy();
        reject(new Error('Browser Gateway RPC request timed out'));
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
        const response = JSON.parse(line) as {
          result?: unknown;
          error?: { message?: string };
        };
        if (response.error) {
          reject(new BrowserGatewayRpcError(response.error.message ?? 'Browser Gateway RPC failed'));
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
