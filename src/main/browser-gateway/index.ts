import { app } from 'electron';
import type { BrowserGatewayRpcServerOptions } from './browser-gateway-rpc-server';
import {
  initializeBrowserGatewayService,
  type BrowserGatewayServiceOptions,
} from './browser-gateway-service';
import {
  getBrowserGatewayRpcSocketPath,
  initializeBrowserGatewayRpcServer,
} from './browser-gateway-rpc-server';
import { prepareBrowserExtensionNativeHostRuntime } from './browser-extension-native-runtime';
import { setBrowserGatewayMcpBridgeAvailabilityProvider } from './browser-health-service';
import { deriveManagedDebugPort } from './chrome-devtools-attach';
import { getLogger } from '../logging/logger';
import { getSettingsManager } from '../core/config/settings-manager';
import { resolveAioMcpCliPath } from '../util/aio-mcp-cli-path';

const logger = getLogger('BrowserGatewayRuntime');

export * from './browser-audit-store';
export * from './browser-action-classifier';
export * from './browser-auto-approve';
export * from './browser-approval-store';
export * from './chrome-devtools-attach';
export * from './chrome-devtools-mcp-config';
export * from './browser-gateway-service';
export * from './browser-gateway-rpc-client';
export * from './browser-gateway-rpc-server';
export * from './browser-extension-tab-store';
export * from './browser-extension-command-store';
export * from './browser-extension-native-host';
export * from './browser-extension-native-runtime';
export * from './browser-grant-policy';
export * from './browser-grant-store';
export * from './browser-health-service';
export * from './browser-mcp-config';
export * from './browser-mcp-tools';
export * from './browser-origin-policy';
export * from './browser-process-launcher';
export * from './browser-profile-registry';
export * from './browser-profile-store';
export * from './browser-redaction';
export * from './browser-safe-dto';
export * from './browser-target-registry';
export * from './browser-types';
export * from './browser-upload-policy';
export * from './puppeteer-browser-driver';

export interface BrowserGatewayRuntimeOptions extends BrowserGatewayRpcServerOptions {
  autoApproveRequests?: BrowserGatewayServiceOptions['autoApproveRequests'];
}

export async function initializeBrowserGatewayRuntime(
  options: BrowserGatewayRuntimeOptions = {},
): Promise<void> {
  const service = initializeBrowserGatewayService({
    autoApproveRequests: options.autoApproveRequests,
    // Pin the managed profile's CDP port to the derived value when it is the
    // designated chrome-devtools attach profile, so the agent's spawn-time
    // `--browserUrl` matches the live port. Otherwise use a random free port.
    resolvePreferredDebugPort: (profileId) => {
      try {
        const settings = getSettingsManager().getAll();
        if (
          settings.chromeDevtoolsAttachEnabled
          && settings.chromeDevtoolsAttachProfileId?.trim() === profileId
        ) {
          return deriveManagedDebugPort(profileId);
        }
      } catch (error) {
        logger.warn('Failed to resolve chrome-devtools attach debug port; using a random port', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return undefined;
    },
  });
  const server = await initializeBrowserGatewayRpcServer({
    ...options,
    service: options.service ?? service,
  });
  setBrowserGatewayMcpBridgeAvailabilityProvider(() => Boolean(server.getSocketPath()));
  const socketPath = server.getSocketPath();
  if (socketPath) {
    const aioMcpCliPath = resolveAioMcpCliPath();
    if (!aioMcpCliPath) {
      // Without the SEA we have nothing to point Chrome's native-messaging
      // host registration at. The MCP bridge for the in-app browser
      // extension stays unregistered — degraded but non-fatal.
      logger.warn(
        'aio-mcp SEA binary not found — Chrome native-messaging host wrapper not installed',
      );
    } else {
      prepareBrowserExtensionNativeHostRuntime({
        userDataPath: options.userDataPath ?? app.getPath('userData'),
        socketPath,
        extensionToken: server.getExtensionToken(),
        hostCommand: {
          exe: aioMcpCliPath,
          args: ['native-host'],
        },
      });
    }
  }
}

export function isBrowserGatewayMcpBridgeAvailable(): boolean {
  return Boolean(getBrowserGatewayRpcSocketPath());
}
