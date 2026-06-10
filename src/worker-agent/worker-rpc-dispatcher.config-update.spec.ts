import { describe, it, expect, vi } from 'vitest';
import { WorkerRpcDispatcher } from './worker-rpc-dispatcher';
import { COORDINATOR_TO_NODE } from '../main/remote-node/worker-node-rpc';
import type { RpcMessage } from './worker-rpc-types';

function makeDispatcher(
  applyConfigUpdate: ReturnType<typeof vi.fn>,
  cdpTunnel: { open: ReturnType<typeof vi.fn>; send: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> } = {
    open: vi.fn(async () => undefined),
    send: vi.fn(),
    close: vi.fn(),
  },
  stopManagedBrowser: ReturnType<typeof vi.fn> = vi.fn(async () => undefined),
) {
  const sendResult = vi.fn();
  const sendError = vi.fn();
  const dispatcher = new WorkerRpcDispatcher({
    config: {} as never,
    instanceManager: {} as never,
    getFilesystemHandler: () => ({}) as never,
    getSyncHandler: () => ({}) as never,
    getTerminalHandler: () => ({}) as never,
    applyConfigUpdate: applyConfigUpdate as never,
    getCdpTunnel: () => cdpTunnel as never,
    stopManagedBrowser,
    sendResult,
    sendError,
  });
  return { dispatcher, sendResult, sendError, cdpTunnel, stopManagedBrowser };
}

function configUpdateMsg(overrides: Partial<RpcMessage>): RpcMessage {
  return {
    jsonrpc: '2.0',
    id: 1,
    method: COORDINATOR_TO_NODE.CONFIG_UPDATE,
    params: { browserAutomation: { enabled: true, profileDir: '/p' } },
    ...overrides,
  } as RpcMessage;
}

describe('WorkerRpcDispatcher config.update', () => {
  it('rejects when the request lacks service scope', async () => {
    const applyConfigUpdate = vi.fn();
    const { dispatcher, sendError, sendResult } = makeDispatcher(applyConfigUpdate);

    await dispatcher.handleRpcRequest(configUpdateMsg({ id: 1 })); // no scope

    expect(applyConfigUpdate).not.toHaveBeenCalled();
    expect(sendResult).not.toHaveBeenCalled();
    expect(sendError).toHaveBeenCalledWith(
      1,
      expect.any(Number),
      expect.stringContaining('scope=service'),
    );
  });

  it('applies with service scope and returns the node summary', async () => {
    const summary = {
      browserAutomation: { enabled: true, headless: false, profileDir: '/p', running: false },
    };
    const applyConfigUpdate = vi.fn(async () => summary);
    const { dispatcher, sendResult, sendError } = makeDispatcher(applyConfigUpdate);

    await dispatcher.handleRpcRequest(configUpdateMsg({ id: 2, scope: 'service' }));

    expect(applyConfigUpdate).toHaveBeenCalledWith({
      browserAutomation: { enabled: true, profileDir: '/p' },
    });
    expect(sendResult).toHaveBeenCalledWith(2, summary);
    expect(sendError).not.toHaveBeenCalled();
  });

  it('accepts androidAutomation updates with service scope', async () => {
    const summary = {
      androidAutomation: {
        enabled: true,
        sdkPath: 'C:/Android/Sdk',
        avds: [],
        connectedDevices: [],
        emulatorRunning: false,
        hasMaestro: false,
      },
    };
    const applyConfigUpdate = vi.fn(async () => summary);
    const { dispatcher, sendResult, sendError } = makeDispatcher(applyConfigUpdate);

    await dispatcher.handleRpcRequest(configUpdateMsg({
      id: 4,
      scope: 'service',
      params: {
        androidAutomation: {
          enabled: true,
          sdkPath: 'C:/Android/Sdk',
          defaultAvd: 'aio-pixel7-api35',
          maxEmulators: 2,
        },
      },
    }));

    expect(applyConfigUpdate).toHaveBeenCalledWith({
      browserAutomation: undefined,
      androidAutomation: {
        enabled: true,
        sdkPath: 'C:/Android/Sdk',
        defaultAvd: 'aio-pixel7-api35',
        maxEmulators: 2,
      },
    });
    expect(sendResult).toHaveBeenCalledWith(4, summary);
    expect(sendError).not.toHaveBeenCalled();
  });

  it('rejects invalid params even with service scope', async () => {
    const applyConfigUpdate = vi.fn();
    const { dispatcher, sendError } = makeDispatcher(applyConfigUpdate);

    await dispatcher.handleRpcRequest(
      configUpdateMsg({
        id: 3,
        scope: 'service',
        params: { browserAutomation: { enabled: 'yes' } } as never,
      }),
    );

    expect(applyConfigUpdate).not.toHaveBeenCalled();
    expect(sendError).toHaveBeenCalled();
  });
});

describe('WorkerRpcDispatcher browser.cdp.*', () => {
  function cdpMsg(method: string, params: unknown, overrides: Partial<RpcMessage> = {}): RpcMessage {
    return { jsonrpc: '2.0', id: 9, method, params, ...overrides } as RpcMessage;
  }

  it('rejects browser.cdp.open without service scope', async () => {
    const { dispatcher, sendError, cdpTunnel } = makeDispatcher(vi.fn());
    await dispatcher.handleRpcRequest(
      cdpMsg(COORDINATOR_TO_NODE.BROWSER_CDP_OPEN, { sessionId: 's1' }),
    );
    expect(cdpTunnel.open).not.toHaveBeenCalled();
    expect(sendError).toHaveBeenCalledWith(9, expect.any(Number), expect.stringContaining('scope=service'));
  });

  it('opens a CDP session with service scope', async () => {
    const { dispatcher, sendResult, cdpTunnel } = makeDispatcher(vi.fn());
    await dispatcher.handleRpcRequest(
      cdpMsg(COORDINATOR_TO_NODE.BROWSER_CDP_OPEN, { sessionId: 's1' }, { scope: 'service' }),
    );
    expect(cdpTunnel.open).toHaveBeenCalledWith('s1');
    expect(sendResult).toHaveBeenCalledWith(9, { ok: true });
  });

  it('forwards a CDP frame on browser.cdp.send', async () => {
    const { dispatcher, cdpTunnel } = makeDispatcher(vi.fn());
    await dispatcher.handleRpcRequest(
      cdpMsg(COORDINATOR_TO_NODE.BROWSER_CDP_SEND, { sessionId: 's1', frame: 'f' }, { scope: 'service' }),
    );
    expect(cdpTunnel.send).toHaveBeenCalledWith('s1', 'f');
  });

  it('closes a CDP session on browser.cdp.close', async () => {
    const { dispatcher, cdpTunnel } = makeDispatcher(vi.fn());
    await dispatcher.handleRpcRequest(
      cdpMsg(COORDINATOR_TO_NODE.BROWSER_CDP_CLOSE, { sessionId: 's1' }, { scope: 'service' }),
    );
    expect(cdpTunnel.close).toHaveBeenCalledWith('s1');
  });

  it('accepts service-scoped browser.cdp.send notifications without sending a response', () => {
    const { dispatcher, cdpTunnel, sendResult, sendError } = makeDispatcher(vi.fn());

    (dispatcher as unknown as {
      handleRpcNotification(msg: RpcMessage): void;
    }).handleRpcNotification(
      cdpMsg(COORDINATOR_TO_NODE.BROWSER_CDP_SEND, { sessionId: 's1', frame: 'f' }, { scope: 'service', id: undefined }),
    );

    expect(cdpTunnel.send).toHaveBeenCalledWith('s1', 'f');
    expect(sendResult).not.toHaveBeenCalled();
    expect(sendError).not.toHaveBeenCalled();
  });

  it('ignores browser.cdp.send notifications without service scope', () => {
    const { dispatcher, cdpTunnel, sendResult, sendError } = makeDispatcher(vi.fn());

    (dispatcher as unknown as {
      handleRpcNotification(msg: RpcMessage): void;
    }).handleRpcNotification(
      cdpMsg(COORDINATOR_TO_NODE.BROWSER_CDP_SEND, { sessionId: 's1', frame: 'f' }, { id: undefined }),
    );

    expect(cdpTunnel.send).not.toHaveBeenCalled();
    expect(sendResult).not.toHaveBeenCalled();
    expect(sendError).not.toHaveBeenCalled();
  });

  it('stops the managed browser on browser.stopManaged (service-scoped)', async () => {
    const stop = vi.fn(async () => undefined);
    const { dispatcher, sendResult, sendError } = makeDispatcher(vi.fn(), undefined, stop);
    await dispatcher.handleRpcRequest(
      cdpMsg(COORDINATOR_TO_NODE.BROWSER_STOP_MANAGED, {}, { scope: 'service' }),
    );
    expect(stop).toHaveBeenCalledTimes(1);
    expect(sendResult).toHaveBeenCalledWith(9, { ok: true });
    expect(sendError).not.toHaveBeenCalled();
  });

  it('rejects browser.stopManaged without service scope', async () => {
    const stop = vi.fn(async () => undefined);
    const { dispatcher, sendError } = makeDispatcher(vi.fn(), undefined, stop);
    await dispatcher.handleRpcRequest(cdpMsg(COORDINATOR_TO_NODE.BROWSER_STOP_MANAGED, {}));
    expect(stop).not.toHaveBeenCalled();
    expect(sendError).toHaveBeenCalledWith(9, expect.any(Number), expect.stringContaining('scope=service'));
  });
});

describe('WorkerRpcDispatcher instance input', () => {
  it('forwards input without logging message or attachment metadata', async () => {
    const sendInput = vi.fn(async () => undefined);
    const sendResult = vi.fn();
    const sendError = vi.fn();
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const dispatcher = new WorkerRpcDispatcher({
      config: {} as never,
      instanceManager: { sendInput } as never,
      getFilesystemHandler: () => ({}) as never,
      getSyncHandler: () => ({}) as never,
      getTerminalHandler: () => ({}) as never,
      applyConfigUpdate: vi.fn() as never,
      getCdpTunnel: () => ({ open: vi.fn(), send: vi.fn(), close: vi.fn() }) as never,
      stopManagedBrowser: vi.fn(async () => undefined),
      sendResult,
      sendError,
    });

    try {
      await dispatcher.handleRpcRequest({
        jsonrpc: '2.0',
        id: 10,
        method: COORDINATOR_TO_NODE.INSTANCE_SEND_INPUT,
        params: {
          instanceId: 'inst-1',
          message: 'contains user text',
          attachments: [{ name: 'private-file.txt', path: '/tmp/private-file.txt' }],
        },
      } as RpcMessage);

      expect(sendInput).toHaveBeenCalledWith(
        'inst-1',
        'contains user text',
        [{ name: 'private-file.txt', path: '/tmp/private-file.txt' }],
      );
      expect(consoleLog).not.toHaveBeenCalled();
      expect(sendResult).toHaveBeenCalledWith(10, { ok: true });
      expect(sendError).not.toHaveBeenCalled();
    } finally {
      consoleLog.mockRestore();
    }
  });
});
