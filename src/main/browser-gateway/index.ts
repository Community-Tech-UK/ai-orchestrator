import { app } from 'electron';
import type { BrowserGatewayRpcServerOptions } from './browser-gateway-rpc-server';
import { initializeBrowserGatewayService } from './browser-gateway-service';
import {
  getBrowserGatewayRpcSocketPath,
  initializeBrowserGatewayRpcServer,
} from './browser-gateway-rpc-server';
import { prepareBrowserExtensionNativeHostRuntime } from './browser-extension-native-runtime';
import { setBrowserGatewayMcpBridgeAvailabilityProvider } from './browser-health-service';
import { getLogger } from '../logging/logger';
import { resolveAioMcpCliPath } from '../util/aio-mcp-cli-path';

const logger = getLogger('BrowserGatewayRuntime');

export * from './browser-audit-store';
export * from './browser-action-classifier';
export * from './browser-approval-store';
export * from './browser-gateway-service';
export * from './browser-gateway-rpc-client';
export * from './browser-gateway-rpc-server';
export * from './browser-extension-tab-store';
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

export async function initializeBrowserGatewayRuntime(
  options: BrowserGatewayRpcServerOptions = {},
): Promise<void> {
  const server = await initializeBrowserGatewayRpcServer(options);
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
        aioMcpCliPath,
      });
    }
  }
  initializeBrowserGatewayService();
}

export function isBrowserGatewayMcpBridgeAvailable(): boolean {
  return Boolean(getBrowserGatewayRpcSocketPath());
}
