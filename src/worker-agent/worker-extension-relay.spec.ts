import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NODE_TO_COORDINATOR } from '../main/remote-node/worker-node-rpc';
import { WorkerExtensionRelay } from './worker-extension-relay';

function makeRelay() {
  const sendRequest = vi.fn(async () => ({ ok: true }));
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
  };
  let now = 1_000;
  const relay = new WorkerExtensionRelay({
    config: {
      enabled: true,
      socketPath: '/tmp/aio-extension-relay.sock',
      extensionToken: 'extension-token',
    },
    sendRequest,
    logger,
    now: () => now,
  });
  return {
    relay,
    sendRequest,
    logger,
    setNow: (value: number) => {
      now = value;
    },
  };
}

describe('WorkerExtensionRelay', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    vi.useRealTimers();
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function tempSocketPath(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-relay-'));
    tempDirs.push(dir);
    return path.join(dir, 'relay.sock');
  }

  function listen(socketPath: string): Promise<net.Server> {
    return new Promise<net.Server>((resolve, reject) => {
      const server = net.createServer((socket) => socket.end());
      server.once('error', reject);
      server.listen(socketPath, () => {
        server.off('error', reject);
        resolve(server);
      });
    });
  }

  function close(server: net.Server): Promise<void> {
    return new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }

  it('forwards attach-tab RPC to the coordinator relay method', async () => {
    const { relay, sendRequest } = makeRelay();

    await relay.handleExtensionRpcRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'browser.extension_attach_tab',
      params: {
        extensionToken: 'extension-token',
        extensionOrigin: 'chrome-extension://abc/',
        payload: {
          tabId: 1,
          windowId: 2,
          url: 'https://example.com',
        },
      },
    });

    expect(sendRequest).toHaveBeenCalledWith(
      NODE_TO_COORDINATOR.BROWSER_EXT_ATTACH_TAB,
      {
        extensionOrigin: 'chrome-extension://abc/',
        payload: {
          tabId: 1,
          windowId: 2,
          url: 'https://example.com',
        },
      },
    );
  });

  it('forwards poll-command RPC with a bounded worker request timeout', async () => {
    const { relay, sendRequest } = makeRelay();

    await relay.handleExtensionRpcRequest({
      method: 'browser.extension_poll_command',
      params: {
        extensionToken: 'extension-token',
        payload: { timeoutMs: 1000 },
      },
    });

    expect(sendRequest).toHaveBeenCalledWith(
      NODE_TO_COORDINATOR.BROWSER_EXT_POLL_COMMAND,
      { timeoutMs: 1000 },
      15_000,
    );
  });

  it('records the last authenticated extension contact in its summary', async () => {
    const { relay, setNow } = makeRelay();

    await relay.handleExtensionRpcRequest({
      method: 'browser.extension_poll_command',
      params: {
        extensionToken: 'extension-token',
        payload: { timeoutMs: 1000 },
      },
    });
    expect(relay.getSummary()).toMatchObject({
      lastExtensionContactAt: 1_000,
    });

    setNow(2_500);
    await relay.handleExtensionRpcRequest({
      method: 'browser.extension_command_result',
      params: {
        extensionToken: 'extension-token',
        payload: {
          commandId: 'cmd-1',
          ok: true,
          result: { done: true },
        },
      },
    });

    expect(relay.getSummary()).toMatchObject({
      lastExtensionContactAt: 2_500,
    });
  });

  it('logs extension first-contact, contact lost, contact resumed, and poll heartbeats', async () => {
    const { relay, logger, setNow } = makeRelay();

    await relay.handleExtensionRpcRequest({
      method: 'browser.extension_poll_command',
      params: {
        extensionToken: 'extension-token',
        payload: { timeoutMs: 1000 },
      },
    });

    expect(logger.info).toHaveBeenCalledWith(
      '[WorkerExtensionRelay] Browser extension first contact',
      expect.objectContaining({ socketPath: '/tmp/aio-extension-relay.sock' }),
    );

    for (let poll = 2; poll <= 500; poll += 1) {
      setNow(1_000 + poll);
      await relay.handleExtensionRpcRequest({
        method: 'browser.extension_poll_command',
        params: {
          extensionToken: 'extension-token',
          payload: { timeoutMs: 1000 },
        },
      });
    }

    expect(logger.info).toHaveBeenCalledWith(
      '[WorkerExtensionRelay] Browser extension poll heartbeat',
      expect.objectContaining({ pollCount: 500 }),
    );

    setNow(92_000);
    relay.getSummary();

    expect(logger.warn).toHaveBeenCalledWith(
      '[WorkerExtensionRelay] Browser extension contact lost',
      expect.objectContaining({ lastExtensionContactAt: 1_500 }),
    );

    setNow(93_000);
    await relay.handleExtensionRpcRequest({
      method: 'browser.extension_poll_command',
      params: {
        extensionToken: 'extension-token',
        payload: { timeoutMs: 1000 },
      },
    });

    expect(logger.info).toHaveBeenCalledWith(
      '[WorkerExtensionRelay] Browser extension contact resumed',
      expect.objectContaining({ lastExtensionContactAt: 93_000 }),
    );
  });

  it('returns a null poll result when the coordinator is unavailable', async () => {
    const sendRequest = vi.fn(async () => {
      throw new Error('worker_not_registered');
    });
    const relay = new WorkerExtensionRelay({
      config: {
        enabled: true,
        socketPath: '/tmp/aio-extension-relay.sock',
        extensionToken: 'extension-token',
      },
      sendRequest,
    });

    await expect(relay.handleExtensionRpcRequest({
      method: 'browser.extension_poll_command',
      params: {
        extensionToken: 'extension-token',
        payload: { timeoutMs: 1000 },
      },
    })).resolves.toBeNull();
  });

  it('forwards command-result RPC without passing the extension token upstream', async () => {
    const { relay, sendRequest } = makeRelay();

    await relay.handleExtensionRpcRequest({
      method: 'browser.extension_command_result',
      params: {
        extensionToken: 'extension-token',
        payload: {
          commandId: 'cmd-1',
          ok: false,
          error: 'failed',
        },
      },
    });

    expect(sendRequest).toHaveBeenCalledWith(
      NODE_TO_COORDINATOR.BROWSER_EXT_COMMAND_RESULT,
      {
        commandId: 'cmd-1',
        ok: false,
        error: 'failed',
      },
    );
  });

  it('acks command-result locally and retries once after a transient relay failure', async () => {
    vi.useFakeTimers();
    const sendRequest = vi.fn()
      .mockRejectedValueOnce(new Error('coordinator_not_connected'))
      .mockResolvedValueOnce({ ok: true });
    const relay = new WorkerExtensionRelay({
      config: {
        enabled: true,
        socketPath: '/tmp/aio-extension-relay.sock',
        extensionToken: 'extension-token',
      },
      sendRequest,
    });

    await expect(relay.handleExtensionRpcRequest({
      method: 'browser.extension_command_result',
      params: {
        extensionToken: 'extension-token',
        payload: {
          commandId: 'cmd-1',
          ok: true,
          result: { done: true },
        },
      },
    })).resolves.toEqual({ ok: true, queued: true });
    expect(sendRequest).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(3_000);

    expect(sendRequest).toHaveBeenCalledTimes(2);
    expect(sendRequest).toHaveBeenLastCalledWith(
      NODE_TO_COORDINATOR.BROWSER_EXT_COMMAND_RESULT,
      {
        commandId: 'cmd-1',
        ok: true,
        result: { done: true },
      },
    );
  });

  it('rejects requests with an invalid extension token', async () => {
    const { relay } = makeRelay();

    await expect(relay.handleExtensionRpcRequest({
      method: 'browser.extension_poll_command',
      params: {
        extensionToken: 'wrong-token',
        payload: {},
      },
    })).rejects.toThrow('invalid_extension_relay_token');
  });

  it('does not steal a live Unix socket owned by another relay', async () => {
    if (process.platform === 'win32') {
      return;
    }
    const socketPath = tempSocketPath();
    const owner = await listen(socketPath);
    const relay = new WorkerExtensionRelay({
      config: { enabled: true, socketPath, extensionToken: 'extension-token' },
      sendRequest: vi.fn(),
    });

    await relay.start();

    expect(relay.isRunning()).toBe(false);
    expect(fs.existsSync(socketPath)).toBe(true);
    await close(owner);
  });

  it('logs relay start and stop lifecycle events with the socket path', async () => {
    if (process.platform === 'win32') {
      return;
    }
    const socketPath = tempSocketPath();
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
    };
    const relay = new WorkerExtensionRelay({
      config: { enabled: true, socketPath, extensionToken: 'extension-token' },
      sendRequest: vi.fn(),
      logger,
    });

    await relay.start();
    await relay.stop();

    expect(logger.info).toHaveBeenCalledWith(
      '[WorkerExtensionRelay] Relay started',
      { socketPath },
    );
    expect(logger.info).toHaveBeenCalledWith(
      '[WorkerExtensionRelay] Relay stopped',
      { socketPath },
    );
  });

  it('survives a client that disconnects before the response is written', async () => {
    if (process.platform === 'win32') {
      return;
    }
    const socketPath = tempSocketPath();
    let releaseResponse!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseResponse = resolve;
    });
    const sendRequest = vi.fn(async () => {
      await gate;
      return { ok: true };
    });
    const relay = new WorkerExtensionRelay({
      config: { enabled: true, socketPath, extensionToken: 'extension-token' },
      sendRequest,
    });
    await relay.start();

    const client = net.createConnection(socketPath);
    client.on('error', () => undefined);
    await new Promise<void>((resolve) => client.once('connect', () => resolve()));
    client.write(`${JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'browser.extension_attach_tab',
      params: { extensionToken: 'extension-token', payload: { tabId: 1 } },
    })}\n`);
    await vi.waitFor(() => expect(sendRequest).toHaveBeenCalled());

    // Client dies before the relay can write its response. Destroy and
    // release in the same tick so the relay dispatches its write before it
    // observes the FIN — that write fails with EPIPE at the OS level, which
    // crashed the whole worker process before the socket error listener
    // existed (same stack as the 2026-06-11 Windows worker crash).
    client.destroy();
    releaseResponse();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(relay.isRunning()).toBe(true);
    await relay.stop();
  });

  it('cleans up a stale Unix socket file before listening', async () => {
    if (process.platform === 'win32') {
      return;
    }
    const socketPath = tempSocketPath();
    const owner = await listen(socketPath);
    await close(owner);
    const relay = new WorkerExtensionRelay({
      config: { enabled: true, socketPath, extensionToken: 'extension-token' },
      sendRequest: vi.fn(),
    });

    await relay.start();

    expect(relay.isRunning()).toBe(true);
    await relay.stop();
  });
});
