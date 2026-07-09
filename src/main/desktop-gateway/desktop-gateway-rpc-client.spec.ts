import { afterEach, describe, expect, it } from 'vitest';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { DesktopGatewayRpcClient } from './desktop-gateway-rpc-client';

describe('DesktopGatewayRpcClient', () => {
  const servers: net.Server[] = [];
  let sequence = 0;

  afterEach(async () => {
    await Promise.all(
      servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
    );
    servers.length = 0;
  });

  it('returns a structured unavailable result when socket env is missing', async () => {
    const client = new DesktopGatewayRpcClient({ env: {} });

    await expect(client.call('computer.health', {})).resolves.toMatchObject({
      decision: 'denied',
      outcome: 'not_run',
      reason: 'computer_use_rpc_unavailable',
    });
  });

  it('sends JSON-RPC requests with instance and provider identity', async () => {
    const address = socketPath();
    const server = net.createServer((socket) => {
      socket.on('data', (chunk) => {
        const request = JSON.parse(chunk.toString('utf-8'));
        socket.end(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: request })}\n`);
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(address, resolve));

    const client = new DesktopGatewayRpcClient({
      env: {
        AI_ORCHESTRATOR_DESKTOP_GATEWAY_SOCKET: address,
        AI_ORCHESTRATOR_DESKTOP_INSTANCE_ID: 'instance-1',
        AI_ORCHESTRATOR_DESKTOP_PROVIDER: 'claude',
      },
    });

    await expect(client.call('computer.list_apps', {})).resolves.toMatchObject({
      method: 'computer.list_apps',
      params: {
        instanceId: 'instance-1',
        provider: 'claude',
        payload: {},
      },
    });
  });

  function socketPath(): string {
    if (process.platform === 'win32') {
      return `\\\\.\\pipe\\computer-use-${process.pid}-${sequence++}`;
    }
    return path.join(os.tmpdir(), `computer-use-${process.pid}-${sequence++}.sock`);
  }
});
