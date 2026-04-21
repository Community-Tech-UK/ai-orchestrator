import { describe, it, expect } from 'vitest';
import { ProviderNameSchema } from '../schemas/provider-runtime-events.schemas';

describe('ProviderNameSchema', () => {
  it('accepts cursor', () => {
    expect(ProviderNameSchema.safeParse('cursor').success).toBe(true);
  });
  it('still accepts all pre-existing names', () => {
    for (const p of ['claude', 'codex', 'gemini', 'copilot', 'anthropic-api']) {
      expect(ProviderNameSchema.safeParse(p).success).toBe(true);
    }
  });
});
