import { describe, expect, it, vi } from 'vitest';
import { advertiseCoordinatorAddresses } from './coordinator-address-advertiser';
import { CoordinatorAddressesParamsSchema } from './rpc-schemas';

describe('advertiseCoordinatorAddresses', () => {
  it('sends the current URLs as a service-scoped notification the worker schema accepts', async () => {
    const sendNotification = vi.fn(() => true);
    await advertiseCoordinatorAddresses('node-1', {
      resolveUrls: async () => ['ws://mac.ts.net:4878', 'ws://192.168.0.156:4878'],
      sendNotification,
    });

    expect(sendNotification).toHaveBeenCalledWith(
      'node-1',
      'node.coordinatorAddresses',
      { urls: ['ws://mac.ts.net:4878', 'ws://192.168.0.156:4878'] },
      'service',
    );
    const params = (sendNotification.mock.calls[0] as unknown[])[2];
    expect(CoordinatorAddressesParamsSchema.safeParse(params).success).toBe(true);
  });

  it('sends nothing when no address is known', async () => {
    const sendNotification = vi.fn(() => true);
    await advertiseCoordinatorAddresses('node-1', { resolveUrls: async () => [], sendNotification });
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it('never rejects when address resolution fails', async () => {
    const sendNotification = vi.fn(() => true);
    await expect(advertiseCoordinatorAddresses('node-1', {
      resolveUrls: async () => { throw new Error('tailscale hung'); },
      sendNotification,
    })).resolves.toBeUndefined();
    expect(sendNotification).not.toHaveBeenCalled();
  });
});
