import { describe, expect, it, vi } from 'vitest';
import { BrowserGatewayRpcServer } from './browser-gateway-rpc-server';
import { BrowserExtensionCommandStore } from './browser-extension-command-store';
import { RemoteBrowserExtensionBridge } from './remote-extension-bridge';
import { withBrowserSession } from './browser-session-context';
import { BrowserExtensionContactState } from './browser-extension-contact-state';

describe('session ownership on mixed extension versions', () => {
  for (const channel of ['local', 'remote'] as const) {
    for (const extensionVersion of ['0.2.52', '0.2.54']) {
      it(`${channel}: ${extensionVersion} ${extensionVersion === '0.2.54' ? 'enforces' : 'cannot bypass'} a cached target's owner`, async () => {
        const store = new BrowserExtensionCommandStore();
        const contactState = new BrowserExtensionContactState();
        const queueKey = channel === 'local' ? 'local' : 'node:TEST_NODE_PLACEHOLDER';
        const pending = withBrowserSession('/tmp', 'SESSION_PLACEHOLDER', () => store.sendCommand({
          queueKey, command: 'snapshot', target: { tabId: 7 },
        }));
        const refused = extensionVersion === '0.2.52'
          ? expect(pending).rejects.toThrow('browser_extension_session_claims_unavailable') : undefined;
        const runtime = { extensionVersion, extensionStartedAt: 1_000, extensionInstanceId: 'PROFILE_PLACEHOLDER', timeoutMs: 0 };
        let command;
        if (channel === 'local') {
          const server = new BrowserGatewayRpcServer({
            service: {}, extensionCommandStore: store, userDataPath: '/tmp',
            extensionContactState: contactState,
            extensionToken: 'EXTENSION_TOKEN_PLACEHOLDER', registerCleanup: vi.fn(),
          });
          command = await server.handleRequest({ method: 'browser.extension_poll_command', params: {
            extensionToken: 'EXTENSION_TOKEN_PLACEHOLDER', payload: runtime,
          } });
        } else {
          const bridge = new RemoteBrowserExtensionBridge({
            service: { attachExistingTab: vi.fn() }, commandStore: store,
            contactState,
            registry: { getNode: () => undefined },
            tabStore: { suspendNode: vi.fn(), restoreNode: vi.fn(() => 0) },
            reliabilityEvents: { record: vi.fn() }, logger: { info: vi.fn(), warn: vi.fn() },
          });
          command = await bridge.pollCommand('TEST_NODE_PLACEHOLDER', runtime, null);
        }
        if (extensionVersion === '0.2.52') {
          if (command) store.resolveCommand({ queueKey, commandId: (command as { id: string }).id, ok: true, result: {} });
          await refused;
          expect(command).toBeNull();
        } else {
          expect(command).toMatchObject({ command: 'snapshot', sessionOwner: expect.any(String) });
          store.resolveCommand({ queueKey, commandId: (command as { id: string }).id, ok: true, result: { done: true } });
          await pending;
        }
      });
    }
  }
});
