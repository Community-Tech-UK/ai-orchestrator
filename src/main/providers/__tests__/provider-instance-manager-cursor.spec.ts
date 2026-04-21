import { describe, it, expect } from 'vitest';
import { ProviderInstanceManager, DEFAULT_PROVIDER_CONFIGS } from '../provider-instance-manager';

describe('ProviderInstanceManager — cursor', () => {
  it('DEFAULT_PROVIDER_CONFIGS includes cursor entry', () => {
    expect(DEFAULT_PROVIDER_CONFIGS.cursor).toMatchObject({
      type: 'cursor',
      name: 'Cursor CLI',
    });
  });

  it('mapCliToProviderType maps cursor → cursor', () => {
    const m = new ProviderInstanceManager();
    expect((m as unknown as { cliToProviderType: Record<string, string> })
      .cliToProviderType.cursor).toBe('cursor');
  });
});
