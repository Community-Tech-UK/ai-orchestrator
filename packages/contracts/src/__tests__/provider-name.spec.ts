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

  it('accepts namespaced plugin providers', () => {
    expect(ProviderNameSchema.safeParse('plugin:acme-cli').success).toBe(true);
  });

  it('rejects malformed plugin provider names', () => {
    for (const provider of ['plugin:', 'plugin:BadName', 'plugin:has space', 'plugin:../escape']) {
      expect(ProviderNameSchema.safeParse(provider).success).toBe(false);
    }
  });
});
