import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { OrchestratorToolsRpcServer } from './orchestrator-tools-rpc-server';
import { OrchestratorToolsRpcClient } from './orchestrator-tools-rpc-client';
import { connectorAccessRegistry } from './connector-access';
const mocks = vi.hoisted(() => ({ token: vi.fn(async () => 'PLACEHOLDER_ACCESS') }));
vi.mock('./mcp-multi-provider-singletons', () => ({
  getOrchestratorMcpRepository: () => ({
    list: () => [
      {
        record: {
          id: 'private',
          name: 'example',
          url: 'https://example.test/mcp',
          autoConnect: true,
        },
      },
    ],
  }),
}));
vi.mock('./connector-auth-service', () => ({
  getConnectorAuthService: () => ({ getAccessToken: mocks.token }),
}));

describe('connector access over the authenticated parent socket', () => {
  it('requires the instance capability as well as the per-connector session grant', async () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'connector-socket-'));
    const server = new OrchestratorToolsRpcServer({
      userDataPath: temporary,
      operatorDbPath: path.join(temporary, 'operator.db'),
      isKnownLocalInstance: (id) => ['allowed', 'other'].includes(id),
      registerCleanup: () => undefined,
      toolFactory: () => [],
    });
    try {
      await server.start();
      connectorAccessRegistry.grant('allowed', ['private']);
      const client = (id: string, capability?: string) =>
        new OrchestratorToolsRpcClient({
          env: {
            AI_ORCHESTRATOR_ORCHESTRATOR_TOOLS_SOCKET: server.getSocketPath()!,
            AI_ORCHESTRATOR_INSTANCE_ID: id,
            AI_ORCHESTRATOR_ORCHESTRATOR_TOOLS_CAPABILITY:
              capability ?? server.getInstanceCapability(id)!,
          },
        });
      await expect(
        client('allowed', 'PLACEHOLDER_WRONG_CAPABILITY').call('connectors.connection', {
          name: 'example',
        }),
      ).rejects.toThrow('capability');
      await expect(
        client('other').call('connectors.connection', { name: 'example' }),
      ).rejects.toThrow('not given');
      expect(mocks.token).not.toHaveBeenCalled();
      expect(
        await client('allowed').call('connectors.connection', { name: 'example' }),
      ).toMatchObject({ accessToken: 'PLACEHOLDER_ACCESS' });
    } finally {
      await server.stop();
      connectorAccessRegistry.clear();
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  });
});
