import type { IncomingMessage, ServerResponse } from 'http';
import { readJsonBody } from './mobile-gateway-http-utils';
import type { MobileDeviceRegistry } from './mobile-device-registry';

interface DeviceTokenHandlerDeps {
  registry: MobileDeviceRegistry;
  sendJson: (res: ServerResponse, statusCode: number, payload: unknown) => void;
}

/** POST /api/devices/:id/apns-token — register the device's APNs push token. */
export async function handleApnsTokenRequest(
  deps: DeviceTokenHandlerDeps,
  req: IncomingMessage,
  res: ServerResponse,
  deviceId: string,
  authedDeviceId: string,
): Promise<void> {
  if (deviceId !== authedDeviceId) {
    deps.sendJson(res, 403, { error: 'Can only set the APNs token for your own device' });
    return;
  }
  const body = (await readJsonBody(req)) as { apnsToken?: unknown };
  const apnsToken = typeof body.apnsToken === 'string' ? body.apnsToken.trim() : '';
  if (!apnsToken) {
    deps.sendJson(res, 400, { error: 'apnsToken required' });
    return;
  }
  const ok = deps.registry.setApnsToken(deviceId, apnsToken);
  deps.sendJson(res, ok ? 200 : 404, ok ? { ok: true } : { error: 'Device not found' });
}

/**
 * POST /api/devices/:id/live-activity-token — register (or clear, with an
 * empty token) the per-activity APNs push token for a session's lock-screen
 * Live Activity, so status changes keep the activity fresh while the app is
 * suspended.
 */
export async function handleLiveActivityTokenRequest(
  deps: DeviceTokenHandlerDeps,
  req: IncomingMessage,
  res: ServerResponse,
  deviceId: string,
  authedDeviceId: string,
): Promise<void> {
  if (deviceId !== authedDeviceId) {
    deps.sendJson(res, 403, { error: 'Can only set Live Activity tokens for your own device' });
    return;
  }
  const body = (await readJsonBody(req)) as { instanceId?: unknown; token?: unknown };
  const instanceId = typeof body.instanceId === 'string' ? body.instanceId.trim() : '';
  const token = typeof body.token === 'string' ? body.token.trim() : '';
  if (!instanceId) {
    deps.sendJson(res, 400, { error: 'instanceId required' });
    return;
  }
  const ok = deps.registry.setLiveActivityToken(deviceId, instanceId, token);
  deps.sendJson(res, ok ? 200 : 404, ok ? { ok: true } : { error: 'Device not found' });
}
