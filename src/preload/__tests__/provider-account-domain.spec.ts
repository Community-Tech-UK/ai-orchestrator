import { describe, expect, it, vi } from 'vitest';
import type { IpcRenderer } from 'electron';
import { ProviderAccountQuotaSessionPayloadSchema } from '../../../packages/contracts/src/schemas/provider-account.schemas';
import { createProviderAccountDomain } from '../domains/provider-account.preload';
import { IPC_CHANNELS } from '../generated/channels';

describe('provider account usage-session bridge', () => {
  it.each(['connect', 'disconnect'] as const)('sends a valid authenticated %s request without session credentials', async (action) => {
    const invoke = vi.fn(async (channel: string, payload: unknown) => {
      expect(channel).toBe('provider-account:quota-session');
      const request = ProviderAccountQuotaSessionPayloadSchema.parse(payload);
      expect(request).toEqual({
        provider: 'opencode',
        profileId: 'mimo-spare',
        action,
        ipcAuthToken: 'test-placeholder',
      });
      return { success: true };
    });
    const domain = createProviderAccountDomain({ invoke } as unknown as IpcRenderer, IPC_CHANNELS, (payload = {}) => ({
      ...payload,
      ipcAuthToken: 'test-placeholder',
    }));

    await expect(domain.manageProviderAccountQuotaSession('mimo-spare', action)).resolves.toEqual({ success: true });
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});
