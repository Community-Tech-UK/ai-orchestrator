import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  appendNativeHostErrorLog,
  createNativeMessageFrame,
  parseNativeMessageFrame,
  handleBrowserExtensionNativeMessage,
  sendBrowserExtensionDisconnected,
} from './browser-extension-native-host';

describe('browser extension native host', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps native host runtime files electron-free for worker builds', () => {
    const files = [
      'browser-extension-native-host.ts',
      'browser-extension-native-runtime.ts',
    ];

    for (const file of files) {
      const source = fs.readFileSync(path.join(__dirname, file), 'utf-8');
      expect(source).not.toMatch(/from ['"]electron['"]|require\(['"]electron['"]\)/);
    }
  });

  it('encodes and decodes Chrome native messaging frames', () => {
    const frame = createNativeMessageFrame({ type: 'ok', value: 'hello' });

    expect(frame.readUInt32LE(0)).toBe(Buffer.byteLength(JSON.stringify({ type: 'ok', value: 'hello' })));
    expect(parseNativeMessageFrame(frame)).toEqual({ type: 'ok', value: 'hello' });
  });

  it('forwards attach_tab messages to Browser Gateway extension RPC', async () => {
    const send = vi.fn().mockResolvedValue({ decision: 'allowed' });

    await expect(handleBrowserExtensionNativeMessage({
      message: {
        type: 'attach_tab',
        tab: {
          tabId: 42,
          windowId: 7,
          url: 'https://play.google.com/console',
          title: 'Google Play Console',
          text: 'Release dashboard',
          screenshotBase64: 'cG5n',
          capturedAt: 1000,
        },
      },
      extensionOrigin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/',
      runtimeConfig: {
        socketPath: '/tmp/browser.sock',
        extensionToken: 'native-token',
        updatedAt: 1,
      },
      send,
    })).resolves.toEqual({
      ok: true,
      ackType: 'attach_tab',
      result: { decision: 'allowed' },
    });
    expect(send).toHaveBeenCalledWith({
      socketPath: '/tmp/browser.sock',
      method: 'browser.extension_attach_tab',
      extensionToken: 'native-token',
      extensionOrigin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/',
      payload: {
        tabId: 42,
        windowId: 7,
        url: 'https://play.google.com/console',
        title: 'Google Play Console',
        text: 'Release dashboard',
        screenshotBase64: 'cG5n',
        capturedAt: 1000,
      },
    });
  });

  it('forwards tab inventory messages as existing-tab attachments', async () => {
    const send = vi.fn()
      .mockResolvedValueOnce({ decision: 'allowed', data: { targetId: 'target-1' } })
      .mockResolvedValueOnce({ decision: 'allowed', data: { targetId: 'target-2' } });

    await expect(handleBrowserExtensionNativeMessage({
      message: {
        type: 'tab_inventory',
        tabs: [
          {
            tabId: 42,
            windowId: 7,
            url: 'https://play.google.com/console',
            title: 'Google Play Console',
          },
          {
            tabId: 43,
            windowId: 7,
            url: 'https://example.com/settings',
            title: 'Settings',
          },
        ],
      },
      extensionOrigin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/',
      runtimeConfig: {
        socketPath: '/tmp/browser.sock',
        extensionToken: 'native-token',
        updatedAt: 1,
      },
      send,
    })).resolves.toEqual({
      ok: true,
      ackType: 'tab_inventory',
      result: {
        attached: 2,
        results: [
          { decision: 'allowed', data: { targetId: 'target-1' } },
          { decision: 'allowed', data: { targetId: 'target-2' } },
        ],
      },
    });
    expect(send).toHaveBeenNthCalledWith(1, {
      socketPath: '/tmp/browser.sock',
      method: 'browser.extension_attach_tab',
      extensionToken: 'native-token',
      extensionOrigin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/',
      payload: {
        tabId: 42,
        windowId: 7,
        url: 'https://play.google.com/console',
        title: 'Google Play Console',
      },
    });
    expect(send).toHaveBeenNthCalledWith(2, {
      socketPath: '/tmp/browser.sock',
      method: 'browser.extension_attach_tab',
      extensionToken: 'native-token',
      extensionOrigin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/',
      payload: {
        tabId: 43,
        windowId: 7,
        url: 'https://example.com/settings',
        title: 'Settings',
      },
    });
  });

  it('polls Browser Gateway for queued commands and returns them to Chrome', async () => {
    const send = vi.fn().mockResolvedValue({
      id: 'command-1',
      command: 'click',
      target: {
        tabId: 42,
        windowId: 7,
      },
      payload: {
        selector: '#continue',
      },
      createdAt: 1000,
    });

    await expect(handleBrowserExtensionNativeMessage({
      message: {
        type: 'poll_command',
        timeoutMs: 25,
      },
      runtimeConfig: {
        socketPath: '/tmp/browser.sock',
        extensionToken: 'native-token',
        updatedAt: 1,
      },
      send,
    })).resolves.toEqual({
      type: 'browser_command',
      command: {
        id: 'command-1',
        command: 'click',
        target: {
          tabId: 42,
          windowId: 7,
        },
        payload: {
          selector: '#continue',
        },
        createdAt: 1000,
      },
    });
    expect(send).toHaveBeenCalledWith({
      socketPath: '/tmp/browser.sock',
      method: 'browser.extension_poll_command',
      extensionToken: 'native-token',
      payload: {
        timeoutMs: 25,
      },
      // Poll window + 15s buffer: the socket must outlive the relay's own
      // poll-forward budget or a freshly dequeued command is dropped.
      timeoutMs: 15_025,
    });
  });

  it('acks command receipt fire-and-forget without blocking the frame chain', async () => {
    // The RPC never resolves — the reply must still come back immediately,
    // otherwise a stalled coordinator head-of-line blocks the command result
    // (and next poll) queued behind this frame.
    const send = vi.fn().mockReturnValue(new Promise(() => undefined));

    await expect(handleBrowserExtensionNativeMessage({
      message: {
        type: 'command_received',
        commandId: 'command-9',
      },
      runtimeConfig: {
        socketPath: '/tmp/browser.sock',
        extensionToken: 'native-token',
        updatedAt: 1,
      },
      send,
    })).resolves.toEqual({
      ok: true,
      ackType: 'command_received',
      commandId: 'command-9',
    });
    expect(send).toHaveBeenCalledWith({
      socketPath: '/tmp/browser.sock',
      method: 'browser.extension_command_received',
      extensionToken: 'native-token',
      payload: {
        commandId: 'command-9',
      },
    });
  });

  it('swallows receipt forward failures instead of emitting an error reply', async () => {
    // A lost receipt already degrades to receipt_missing at the coordinator;
    // an {ok:false} reply here would (on old extension builds) be misread as
    // a poll error and spawn a concurrent second command.
    const send = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(handleBrowserExtensionNativeMessage({
      message: {
        type: 'command_received',
        commandId: 'command-9',
      },
      runtimeConfig: {
        socketPath: '/tmp/browser.sock',
        extensionToken: 'native-token',
        updatedAt: 1,
      },
      send,
    })).resolves.toEqual({
      ok: true,
      ackType: 'command_received',
      commandId: 'command-9',
    });
  });

  it('reports channel disconnects best-effort and swallows transport failures', async () => {
    const send = vi.fn().mockResolvedValue({ ok: true });
    await sendBrowserExtensionDisconnected({
      runtimeConfig: {
        socketPath: '/tmp/browser.sock',
        extensionToken: 'native-token',
        updatedAt: 1,
      },
      reason: 'native_host_stdin_eof',
      send,
    });
    expect(send).toHaveBeenCalledWith({
      socketPath: '/tmp/browser.sock',
      method: 'browser.extension_disconnected',
      extensionToken: 'native-token',
      payload: {
        reason: 'native_host_stdin_eof',
      },
      timeoutMs: 3_000,
    });

    // The gateway being gone must not throw out of the shutdown path.
    const failingSend = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(sendBrowserExtensionDisconnected({
      runtimeConfig: {
        socketPath: '/tmp/browser.sock',
        extensionToken: 'native-token',
        updatedAt: 1,
      },
      reason: 'native_host_stdin_eof',
      send: failingSend,
    })).resolves.toBeUndefined();
  });

  it('forwards command result messages to Browser Gateway extension RPC', async () => {
    const send = vi.fn().mockResolvedValue({ ok: true });

    await expect(handleBrowserExtensionNativeMessage({
      message: {
        type: 'command_result',
        commandId: 'command-1',
        ok: true,
        result: {
          text: 'Done',
        },
      },
      runtimeConfig: {
        socketPath: '/tmp/browser.sock',
        extensionToken: 'native-token',
        updatedAt: 1,
      },
      send,
    })).resolves.toEqual({
      ok: true,
      ackType: 'command_result',
      commandId: 'command-1',
      result: { ok: true },
    });
    expect(send).toHaveBeenCalledWith({
      socketPath: '/tmp/browser.sock',
      method: 'browser.extension_command_result',
      extensionToken: 'native-token',
      payload: {
        commandId: 'command-1',
        ok: true,
        result: {
          text: 'Done',
        },
      },
    });
  });

  it('appends native-host fatal startup diagnostics next to runtime config with a size cap', () => {
    const nativeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aio-native-host-'));
    tempDirs.push(nativeDir);
    const configPath = path.join(nativeDir, 'runtime-relay.json');
    const logPath = path.join(nativeDir, 'native-host-error.log');

    appendNativeHostErrorLog({
      configPath,
      message: 'first startup failure',
      now: () => 1_000,
      maxBytes: 180,
    });
    appendNativeHostErrorLog({
      configPath,
      message: 'second startup failure '.repeat(8),
      now: () => 2_000,
      maxBytes: 180,
    });

    const log = fs.readFileSync(logPath, 'utf-8');
    expect(Buffer.byteLength(log, 'utf-8')).toBeLessThanOrEqual(180);
    expect(log).toContain('second startup failure');
    expect(log).not.toContain('first startup failure');
  });

});
