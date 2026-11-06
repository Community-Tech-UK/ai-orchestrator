import { describe, expect, it } from 'vitest';
import { ProviderRuntimeEventSchema } from '@contracts/schemas/provider-runtime-events';
import { mapAdapterRuntimeEvent } from './adapter-runtime-event-bridge';

describe('failed turn completion transport', () => {
  it('retains the failed-turn flag through the normalizer and validated IPC contract', () => {
    const mapped = mapAdapterRuntimeEvent('complete', [{
      role: 'assistant', content: 'Partial reply.', metadata: { turnErrored: true },
    }]);
    expect(mapped?.event).toMatchObject({ kind: 'complete', turnErrored: true });
    expect(ProviderRuntimeEventSchema.parse(mapped?.event)).toMatchObject({ kind: 'complete', turnErrored: true });
  });

  it('does not mark successful completion as a failed turn', () => {
    expect(mapAdapterRuntimeEvent('complete', [{ content: 'Ready.' }])?.event)
      .not.toHaveProperty('turnErrored');
  });
});
