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

});
