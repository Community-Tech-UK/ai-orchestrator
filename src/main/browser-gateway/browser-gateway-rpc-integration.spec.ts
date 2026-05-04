import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrowserGatewayRpcClient } from './browser-gateway-rpc-client';
import {
  BrowserGatewayRpcServer,
  type BrowserGatewayRpcServerOptions,
} from './browser-gateway-rpc-server';

describe('Browser Gateway RPC integration', () => {
  const servers: BrowserGatewayRpcServer[] = [];
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(servers.map((server) => server.stop()));
    servers.length = 0;
    for (const tempDir of tempDirs.splice(0)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('forwards client calls over the local socket with injected instance context', async () => {
    const getHealth = vi.fn(async (payload: Record<string, unknown>) => ({
      decision: 'allowed',
      outcome: 'succeeded',
      auditId: 'audit-1',
      data: payload,
    }));
    const server = await startServer({
      service: { getHealth },
      isKnownLocalInstance: (instanceId) => instanceId === 'instance-1',
    });
    const client = new BrowserGatewayRpcClient({
      env: {
        AI_ORCHESTRATOR_BROWSER_GATEWAY_SOCKET: server.getSocketPath()!,
        AI_ORCHESTRATOR_BROWSER_INSTANCE_ID: 'instance-1',
      },
      timeoutMs: 1_000,
    });

    await expect(client.call('browser.health', {})).resolves.toMatchObject({
      decision: 'allowed',
      outcome: 'succeeded',
      auditId: 'audit-1',
      data: {
        instanceId: 'instance-1',
      },
    });
    expect(getHealth).toHaveBeenCalledWith({
      instanceId: 'instance-1',
    });
  });

  it('returns unavailable when the server rejects the instance id', async () => {
    const getHealth = vi.fn();
    const server = await startServer({
      service: { getHealth },
      isKnownLocalInstance: () => false,
    });
    const client = new BrowserGatewayRpcClient({
      env: {
        AI_ORCHESTRATOR_BROWSER_GATEWAY_SOCKET: server.getSocketPath()!,
        AI_ORCHESTRATOR_BROWSER_INSTANCE_ID: 'unknown-instance',
      },
      timeoutMs: 1_000,
    });

    await expect(client.call('browser.health', {})).resolves.toMatchObject({
      decision: 'denied',
      outcome: 'not_run',
      reason: 'browser_gateway_unavailable',
    });
    expect(getHealth).not.toHaveBeenCalled();
  });

  async function startServer(
    options: Pick<BrowserGatewayRpcServerOptions, 'service' | 'isKnownLocalInstance'>,
  ): Promise<BrowserGatewayRpcServer> {
    const userDataPath = fs.mkdtempSync(
      path.join(os.tmpdir(), 'browser-gateway-rpc-integration-'),
    );
    tempDirs.push(userDataPath);
    const server = new BrowserGatewayRpcServer({
      ...options,
      userDataPath,
      registerCleanup: vi.fn(),
    });
    servers.push(server);
    await server.start();
    expect(server.getSocketPath()).toBeTruthy();
    return server;
  }
});
