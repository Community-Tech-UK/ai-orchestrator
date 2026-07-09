import { describe, expect, it, vi } from 'vitest';
import { DesktopGatewayRpcServer } from './desktop-gateway-rpc-server';

describe('DesktopGatewayRpcServer', () => {
  it('rejects unknown local instances before dispatching to the service', async () => {
    const service = { health: vi.fn() };
    const server = new DesktopGatewayRpcServer({
      service,
      isKnownLocalInstance: () => false,
      registerCleanup: () => undefined,
    });

    await expect(
      server.handleRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'computer.health',
        params: { instanceId: 'missing', payload: {} },
      }),
    ).rejects.toThrow(/unknown computer-use instance/);
    expect(service.health).not.toHaveBeenCalled();
  });

  it('validates payloads and dispatches known computer methods', async () => {
    const service = {
      health: vi.fn(async () => ({ decision: 'allowed', outcome: 'ok' })),
      listApps: vi.fn(),
    };
    const server = new DesktopGatewayRpcServer({
      service,
      isKnownLocalInstance: (id) => id === 'instance-1',
      registerCleanup: () => undefined,
    });

    await expect(
      server.handleRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'computer.health',
        params: { instanceId: 'instance-1', provider: 'codex', payload: {} },
      }),
    ).resolves.toEqual({ decision: 'allowed', outcome: 'ok' });
    expect(service.health).toHaveBeenCalledWith(
      { instanceId: 'instance-1', provider: 'codex' },
      {},
    );

    await expect(
      server.handleRequest({
        jsonrpc: '2.0',
        id: 2,
        method: 'computer.list_apps',
        params: { instanceId: 'instance-1', payload: { limit: 'a lot' } },
      }),
    ).rejects.toThrow(/Invalid computer-use RPC payload/);
  });

  it('rejects display-only screenshots until Computer Use has display-scoped policy', async () => {
    const server = new DesktopGatewayRpcServer({
      service: { screenshot: vi.fn() },
      isKnownLocalInstance: (id) => id === 'instance-1',
      registerCleanup: () => undefined,
    });

    await expect(
      server.handleRequest({
        jsonrpc: '2.0',
        id: 3,
        method: 'computer.screenshot',
        params: { instanceId: 'instance-1', payload: { displayId: 'screen:1' } },
      }),
    ).rejects.toThrow(/Invalid computer-use RPC payload/);
  });

  it('validates and dispatches input actions through the service', async () => {
    const service = {
      click: vi.fn(async () => ({ decision: 'allowed', outcome: 'ok' })),
    };
    const server = new DesktopGatewayRpcServer({
      service,
      isKnownLocalInstance: (id) => id === 'instance-1',
      registerCleanup: () => undefined,
    });

    await expect(
      server.handleRequest({
        jsonrpc: '2.0',
        id: 4,
        method: 'computer.click',
        params: {
          instanceId: 'instance-1',
          payload: {
            appId: 'darwin-window:preview:1',
            observationToken: 'obs_123',
            x: 10,
            y: 20,
          },
        },
      }),
    ).resolves.toEqual({ decision: 'allowed', outcome: 'ok' });
    expect(service.click).toHaveBeenCalledWith(
      { instanceId: 'instance-1' },
      {
        appId: 'darwin-window:preview:1',
        observationToken: 'obs_123',
        x: 10,
        y: 20,
      },
    );

    await expect(
      server.handleRequest({
        jsonrpc: '2.0',
        id: 5,
        method: 'computer.click',
        params: {
          instanceId: 'instance-1',
          payload: {
            appId: 'darwin-window:preview:1',
            observationToken: 'obs_123',
          },
        },
      }),
    ).rejects.toThrow(/Invalid computer-use RPC payload/);
  });

  it('preserves exact type_text payload content during RPC validation', async () => {
    const service = {
      typeText: vi.fn(async () => ({ decision: 'allowed', outcome: 'ok' })),
    };
    const server = new DesktopGatewayRpcServer({
      service,
      isKnownLocalInstance: (id) => id === 'instance-1',
      registerCleanup: () => undefined,
    });

    await expect(
      server.handleRequest({
        jsonrpc: '2.0',
        id: 6,
        method: 'computer.type_text',
        params: {
          instanceId: 'instance-1',
          payload: {
            appId: 'darwin-window:preview:1',
            observationToken: 'obs_123',
            text: '  keep exact spacing  ',
          },
        },
      }),
    ).resolves.toEqual({ decision: 'allowed', outcome: 'ok' });
    expect(service.typeText).toHaveBeenCalledWith(
      { instanceId: 'instance-1' },
      {
        appId: 'darwin-window:preview:1',
        observationToken: 'obs_123',
        text: '  keep exact spacing  ',
      },
    );
  });
});
