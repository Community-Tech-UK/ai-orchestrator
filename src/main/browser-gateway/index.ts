import type { BrowserGatewayRpcServerOptions } from './browser-gateway-rpc-server';
import { initializeBrowserGatewayService } from './browser-gateway-service';
import {
  getBrowserGatewayRpcSocketPath,
  initializeBrowserGatewayRpcServer,
} from './browser-gateway-rpc-server';
import { setBrowserGatewayMcpBridgeAvailabilityProvider } from './browser-health-service';

export * from './browser-audit-store';
export * from './browser-action-classifier';
export * from './browser-approval-store';
export * from './browser-gateway-service';
export * from './browser-gateway-rpc-client';
export * from './browser-gateway-rpc-server';
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
  initializeBrowserGatewayService();
}

export function isBrowserGatewayMcpBridgeAvailable(): boolean {
  return Boolean(getBrowserGatewayRpcSocketPath());
}
