import { describe, it, expect } from 'vitest';
import { IPC_CHANNELS } from '@contracts/channels/index';

describe('PROVIDER_RUNTIME_EVENT channel', () => {
  it('is registered', () => {
    expect(IPC_CHANNELS.PROVIDER_RUNTIME_EVENT).toBe('provider:runtime-event');
  });
});
