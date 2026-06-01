import type { RpcScope } from '../main/remote-node/worker-node-rpc';

export interface RpcMessage {
  jsonrpc: '2.0';
  id?: string | number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
  scope?: RpcScope;
}

export function validateScope(msg: RpcMessage, expected: RpcScope): string | null {
  const scope = msg.scope ?? 'instance';
  if (scope !== expected) {
    return `Method ${msg.method} requires scope=${expected} (received ${scope})`;
  }
  return null;
}
