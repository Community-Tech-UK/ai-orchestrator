import { describe, expect, it, vi } from 'vitest';
import {
  createNativeMessageFrame,
  parseNativeMessageFrame,
  handleBrowserExtensionNativeMessage,
} from './browser-extension-native-host';

describe('browser extension native host', () => {
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

  it('forwards extension command polling and completion messages to Browser Gateway RPC', async () => {
    const send = vi.fn()
      .mockResolvedValueOnce({
        id: 'command-1',
        kind: 'refresh_tab',
        status: 'sent',
      })
      .mockResolvedValueOnce({
        decision: 'allowed',
        outcome: 'succeeded',
      });
    const runtimeConfig = {
      socketPath: '/tmp/browser.sock',
      extensionToken: 'native-token',
      updatedAt: 1,
    };

    await expect(handleBrowserExtensionNativeMessage({
      message: {
        type: 'poll_commands',
        tab: {
          profileId: 'existing-tab:7:42',
          targetId: 'existing-tab:7:42:target',
          tabId: 42,
          windowId: 7,
        },
      },
      extensionOrigin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/',
      runtimeConfig,
      send,
    })).resolves.toEqual({
      ok: true,
      result: {
        id: 'command-1',
        kind: 'refresh_tab',
        status: 'sent',
      },
    });

    await expect(handleBrowserExtensionNativeMessage({
      message: {
        type: 'complete_command',
        commandId: 'command-1',
        tab: {
          profileId: 'existing-tab:7:42',
          targetId: 'existing-tab:7:42:target',
          tabId: 42,
          windowId: 7,
          url: 'https://play.google.com/console',
          title: 'Google Play Console',
          text: 'Updated release dashboard',
          screenshotBase64: 'cG5n',
          capturedAt: 1000,
        },
        status: 'succeeded',
      },
      extensionOrigin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/',
      runtimeConfig,
      send,
    })).resolves.toEqual({
      ok: true,
      result: {
        decision: 'allowed',
        outcome: 'succeeded',
      },
    });

    expect(send).toHaveBeenNthCalledWith(1, {
      socketPath: '/tmp/browser.sock',
      method: 'browser.extension_poll_commands',
      extensionToken: 'native-token',
      extensionOrigin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/',
      payload: {
        profileId: 'existing-tab:7:42',
        targetId: 'existing-tab:7:42:target',
        tabId: 42,
        windowId: 7,
      },
    });
    expect(send).toHaveBeenNthCalledWith(2, {
      socketPath: '/tmp/browser.sock',
      method: 'browser.extension_complete_command',
      extensionToken: 'native-token',
      extensionOrigin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/',
      payload: {
        commandId: 'command-1',
        profileId: 'existing-tab:7:42',
        targetId: 'existing-tab:7:42:target',
        tabId: 42,
        windowId: 7,
        status: 'succeeded',
        tab: {
          tabId: 42,
          windowId: 7,
          url: 'https://play.google.com/console',
          title: 'Google Play Console',
          text: 'Updated release dashboard',
          screenshotBase64: 'cG5n',
          capturedAt: 1000,
        },
      },
    });
  });
});
