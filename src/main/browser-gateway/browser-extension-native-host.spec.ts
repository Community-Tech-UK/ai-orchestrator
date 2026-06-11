import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import {
  createNativeMessageFrame,
  parseNativeMessageFrame,
  handleBrowserExtensionNativeMessage,
} from './browser-extension-native-host';

describe('browser extension native host', () => {
  it('keeps native host runtime files electron-free for worker builds', () => {
    const files = [
      'browser-extension-native-host.ts',
      'browser-extension-native-runtime.ts',
    ];

    for (const file of files) {
      const source = readFileSync(path.join(__dirname, file), 'utf-8');
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
    });
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

});
