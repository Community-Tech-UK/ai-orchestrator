import {
  BrowserStartDeviceLoginRequestSchema,
  BrowserReadDeviceLoginRequestSchema,
  BrowserCancelDeviceLoginRequestSchema,
  BrowserFillDeviceLoginRequestSchema,
} from '@contracts/schemas/browser';
import { verifyBrowserDeviceLoginCapability } from './browser-device-login-capability';
import type { BrowserDeviceLoginOperationController } from './browser-device-login-operation';

export type BrowserDeviceLoginRpcController = Pick<BrowserDeviceLoginOperationController, 'start' | 'read' | 'cancel' | 'fill'>;

/** Device destinations are explicit and immutable; generic browser offload must not rewrite them. */
export async function dispatchBrowserDeviceLoginRpc(
  controller: BrowserDeviceLoginRpcController | undefined,
  method: string,
  params: { instanceId: string; deviceLoginCapabilityToken?: string; payload: Record<string, unknown> },
): Promise<unknown> {
  try {
    const generation = verifyBrowserDeviceLoginCapability(params.instanceId, params.deviceLoginCapabilityToken);
    if (!controller || !generation) throw new Error('device_login_request_refused');
    const owner = { sessionId: params.instanceId, generation };
    switch (method) {
      case 'browser.start_device_login':
        return await controller.start(BrowserStartDeviceLoginRequestSchema.parse(params.payload), owner);
      case 'browser.read_device_login':
        return await controller.read(BrowserReadDeviceLoginRequestSchema.parse(params.payload).loginHandle, owner);
      case 'browser.cancel_device_login':
        return await controller.cancel(BrowserCancelDeviceLoginRequestSchema.parse(params.payload).loginHandle, owner);
      case 'browser.fill_device_login':
        return await controller.fill(BrowserFillDeviceLoginRequestSchema.parse(params.payload), owner);
      default:
        throw new Error('device_login_request_refused');
    }
  } catch {
    // Neither parser details nor native/controller errors belong in model-visible output.
    throw new Error('device_login_request_refused');
  }
}
