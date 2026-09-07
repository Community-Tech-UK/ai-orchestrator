import { describe, it, expect, vi } from 'vitest';
import type { ServerResponse } from 'http';
import { handleRevokeDeviceRequest } from './mobile-gateway-device-token-handlers';
import type { MobileDeviceRegistry } from './mobile-device-registry';

function deps(revoked = true) {
  const revokeDevice = vi.fn().mockReturnValue(revoked);
  const sendJson = vi.fn();
  return {
    deps: { registry: { revokeDevice } as unknown as MobileDeviceRegistry, sendJson },
    revokeDevice,
    sendJson,
  };
}

const res = {} as ServerResponse;

describe('handleRevokeDeviceRequest', () => {
  it('revokes the calling device when it asks for "me"', () => {
    const { deps: d, revokeDevice, sendJson } = deps();

    handleRevokeDeviceRequest(d, res, 'me', 'device-a');

    expect(revokeDevice).toHaveBeenCalledWith('device-a');
    expect(sendJson).toHaveBeenCalledWith(res, 200, { revoked: true });
  });

  it('revokes when the device names its own id explicitly', () => {
    const { deps: d, revokeDevice, sendJson } = deps();

    handleRevokeDeviceRequest(d, res, 'device-a', 'device-a');

    expect(revokeDevice).toHaveBeenCalledWith('device-a');
    expect(sendJson).toHaveBeenCalledWith(res, 200, { revoked: true });
  });

  /**
   * The security boundary: one paired phone must never be able to cut off
   * another. Revoking someone else's device stays a desktop-only action.
   */
  it('refuses to revoke a different device and touches nothing', () => {
    const { deps: d, revokeDevice, sendJson } = deps();

    handleRevokeDeviceRequest(d, res, 'device-b', 'device-a');

    expect(revokeDevice).not.toHaveBeenCalled();
    expect(sendJson).toHaveBeenCalledWith(res, 403, { error: 'Can only revoke your own device' });
  });

  it('always revokes the authenticated id, never the value from the path', () => {
    const { deps: d, revokeDevice } = deps();

    handleRevokeDeviceRequest(d, res, 'me', 'device-a');

    expect(revokeDevice).toHaveBeenCalledTimes(1);
    expect(revokeDevice).not.toHaveBeenCalledWith('me');
  });

  it('reports honestly when the device was already gone', () => {
    const { deps: d, sendJson } = deps(false);

    handleRevokeDeviceRequest(d, res, 'me', 'device-a');

    expect(sendJson).toHaveBeenCalledWith(res, 200, { revoked: false });
  });
});
