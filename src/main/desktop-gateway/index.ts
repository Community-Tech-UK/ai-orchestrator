import { app } from 'electron';
import { getPermissionRegistry } from '../orchestration/permission-registry';
import {
  initializeDesktopGatewayRpcServer,
  type DesktopGatewayRpcServerOptions,
} from './desktop-gateway-rpc-server';
import {
  initializeDesktopGatewayService,
  type DesktopGatewayServiceOptions,
} from './desktop-gateway-service';

export * from './desktop-app-policy';
export * from './desktop-gateway-audit-store';
export * from './desktop-grant-store';
export * from './desktop-gateway-rpc-client';
export * from './desktop-gateway-rpc-server';
export * from './desktop-gateway-service';
export * from './desktop-input-controller';
export * from './desktop-mcp-config';
export * from './desktop-mcp-tools';
export * from './desktop-redaction';
export * from './desktop-session-lock';
export * from './platform/desktop-driver';

export interface DesktopGatewayRuntimeOptions
  extends DesktopGatewayRpcServerOptions,
    DesktopGatewayServiceOptions {}

export async function initializeDesktopGatewayRuntime(
  options: DesktopGatewayRuntimeOptions = {},
): Promise<void> {
  const userDataPath = options.userDataPath ?? app.getPath('userData');
  const service = options.service ?? initializeDesktopGatewayService({
    ...options,
    userDataPath,
    permissionRegistry: options.permissionRegistry ?? getPermissionRegistry(),
  });
  await initializeDesktopGatewayRpcServer({
    ...options,
    userDataPath,
    service,
  });
}
