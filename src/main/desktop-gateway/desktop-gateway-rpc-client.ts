import * as net from 'node:net';

export interface DesktopGatewayRpcClientOptions {
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
}

export interface DesktopGatewayRpcClientLike {
  call(method: string, payload: Record<string, unknown>): Promise<unknown>;
}

const DEFAULT_RPC_TIMEOUT_MS = 60_000;
let nextRequestId = 1;

class DesktopGatewayRpcError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DesktopGatewayRpcError';
  }
}

function unavailable(reason = 'computer_use_rpc_unavailable'): Record<string, unknown> {
  return {
    decision: 'denied',
    outcome: 'not_run',
    reason,
  };
}

function deniedForRpcError(error: DesktopGatewayRpcError): Record<string, unknown> {
  return {
    decision: 'denied',
    outcome: 'not_run',
    reason: normalizeRpcErrorReason(error.message),
    data: { message: error.message },
  };
}

function normalizeRpcErrorReason(message: string): string {
  const normalized = message.toLowerCase();
  if (normalized.includes('unknown computer-use instance')) {
    return 'unknown_computer_use_instance';
  }
  if (normalized.includes('invalid computer-use rpc payload')) {
    return 'invalid_computer_use_rpc_payload';
  }
  if (normalized.includes('payload too large')) {
    return 'computer_use_rpc_payload_too_large';
  }
  if (normalized.includes('rate limit')) {
    return 'computer_use_rpc_rate_limited';
  }
  return 'computer_use_rpc_error';
}

export class DesktopGatewayRpcClient implements DesktopGatewayRpcClientLike {
  private readonly env: Record<string, string | undefined>;
  private readonly timeoutMs: number;

  constructor(options: DesktopGatewayRpcClientOptions = {}) {
    this.env = options.env ?? process.env;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_RPC_TIMEOUT_MS;
  }

  async call(method: string, payload: Record<string, unknown>): Promise<unknown> {
    const socketPath = this.env['AI_ORCHESTRATOR_DESKTOP_GATEWAY_SOCKET'];
    const instanceId = this.env['AI_ORCHESTRATOR_DESKTOP_INSTANCE_ID'];
    const provider = this.env['AI_ORCHESTRATOR_DESKTOP_PROVIDER'];
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
      if (error instanceof DesktopGatewayRpcError) {
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
        reject(new DesktopGatewayRpcError('Computer Use RPC request timed out'));
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
        clearTimeout(timeout);
        socket.end();
        const response = JSON.parse(buffer.slice(0, newline)) as {
          result?: unknown;
          error?: { message?: string };
        };
        if (response.error) {
          reject(new DesktopGatewayRpcError(response.error.message ?? 'Computer Use RPC failed'));
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
