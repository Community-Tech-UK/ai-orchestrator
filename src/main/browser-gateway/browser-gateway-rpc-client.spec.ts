import { afterEach, describe, expect, it } from 'vitest';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { BrowserGatewayRpcClient } from './browser-gateway-rpc-client';

describe('BrowserGatewayRpcClient', () => {
  const servers: net.Server[] = [];

  afterEach(async () => {
    await Promise.all(
      servers.map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
    );
    servers.length = 0;
  });

  it('returns a structured unavailable result when socket env is missing', async () => {
    const client = new BrowserGatewayRpcClient({ env: {} });

    await expect(client.call('browser.health', {})).resolves.toMatchObject({
      decision: 'denied',
      outcome: 'not_run',
      reason: 'browser_gateway_unavailable',
    });
  });

  it('sends JSON-RPC requests with the injected instance id', async () => {
    const socketPath = path.join(os.tmpdir(), `browser-gateway-${process.pid}.sock`);
    const server = net.createServer((socket) => {
      socket.on('data', (chunk) => {
        const request = JSON.parse(chunk.toString('utf-8'));
        socket.end(
          `${JSON.stringify({
            jsonrpc: '2.0',
            id: request.id,
            result: {
              method: request.method,
              params: request.params,
            },
          })}\n`,
        );
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));

    const client = new BrowserGatewayRpcClient({
      env: {
        AI_ORCHESTRATOR_BROWSER_GATEWAY_SOCKET: socketPath,
        AI_ORCHESTRATOR_BROWSER_INSTANCE_ID: 'instance-1',
        AI_ORCHESTRATOR_BROWSER_PROVIDER: 'copilot',
      },
    });

    await expect(client.call('browser.navigate', { profileId: 'profile-1' })).resolves.toMatchObject({
      method: 'browser.navigate',
      params: {
        instanceId: 'instance-1',
        provider: 'copilot',
        payload: {
          profileId: 'profile-1',
        },
      },
    });
  });
});
