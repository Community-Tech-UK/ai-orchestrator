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

/**
 * DELETE /api/devices/:id — drop this device's pairing.
 *
 * Self-service only. Removing a host on the phone used to leave a live bearer
 * token on the Mac until its TTL lapsed, so the desktop's paired-device list
 * filled up with entries the owner had already deleted. `me` is accepted so a
 * client that has forgotten its own id can still unpair. A device may never
 * revoke another one — that stays a desktop-only action.
 */
export function handleRevokeDeviceRequest(
  deps: DeviceTokenHandlerDeps,
  res: ServerResponse,
  deviceId: string,
  authedDeviceId: string,
): void {
  if (deviceId !== 'me' && deviceId !== authedDeviceId) {
    deps.sendJson(res, 403, { error: 'Can only revoke your own device' });
    return;
  }
  // Always revoke the authenticated device, never the path value.
  const revoked = deps.registry.revokeDevice(authedDeviceId);
  deps.sendJson(res, 200, { revoked });
}

/**
 * Dispatch every `/api/devices/...` route, mirroring `handleMobileQueueRoutes`.
 * Returns true when the request was handled, so the server's routing block stays
 * one line per route group rather than growing a stanza per endpoint.
 */
export async function handleMobileDeviceRoutes(
  deps: DeviceTokenHandlerDeps,
  req: IncomingMessage,
  res: ServerResponse,
  segments: string[],
  method: string,
  authedDeviceId: string,
): Promise<boolean> {
  if (segments[1] !== 'devices') return false;

  if (segments.length === 3 && method === 'DELETE') {
    handleRevokeDeviceRequest(deps, res, decodeURIComponent(segments[2]), authedDeviceId);
    return true;
  }
  if (segments.length === 4 && method === 'POST') {
    const targetDeviceId = decodeURIComponent(segments[2]);
    if (segments[3] === 'apns-token') {
      await handleApnsTokenRequest(deps, req, res, targetDeviceId, authedDeviceId);
      return true;
    }
    if (segments[3] === 'live-activity-token') {
      await handleLiveActivityTokenRequest(deps, req, res, targetDeviceId, authedDeviceId);
      return true;
    }
  }
  return false;
}
