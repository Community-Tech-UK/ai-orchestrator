import { describe, expect, it, vi } from 'vitest';

import { getLogger } from '../logging/logger';
import { ProviderContextActionExecutor } from './provider-context-action-executor';

describe('ProviderContextActionExecutor observability', () => {
  it('logs the instance, action, status, and proof for an executed provider action', async () => {
    const info = vi.spyOn(getLogger('ProviderContextAction'), 'info');
    const executor = new ProviderContextActionExecutor({
      'native-compaction': async () => ({ proof: 'observed' }),
    });

    await expect(executor.execute('native-compaction', { instanceId: 'inst-1' })).resolves.toEqual({
      status: 'executed',
      action: 'native-compaction',
      proof: 'observed',
    });
    expect(info).toHaveBeenCalledWith('Provider context action completed', expect.objectContaining({
      instanceId: 'inst-1',
      action: 'native-compaction',
      status: 'executed',
      proof: 'observed',
    }));
  });
});
