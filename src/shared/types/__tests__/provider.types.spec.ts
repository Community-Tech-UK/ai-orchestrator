import { describe, it, expectTypeOf } from 'vitest';
import type { ProviderSessionOptions } from '@shared/types/provider.types';

describe('ProviderSessionOptions', () => {
  it('includes optional instanceId for event envelope correlation', () => {
    const opts: ProviderSessionOptions = {
      workingDirectory: '/tmp',
      instanceId: 'inst-42',
    };
    expectTypeOf(opts.instanceId).toEqualTypeOf<string | undefined>();
  });
});
