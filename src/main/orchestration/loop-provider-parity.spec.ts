import { describe, expect, it } from 'vitest';
import { LoopProviderSchema } from '@contracts/schemas/loop';
import type { LoopProvider } from '../../shared/types/loop.types';
const ALL: Record<LoopProvider, true> = {
  claude: true, codex: true, gemini: true, antigravity: true, copilot: true, cursor: true, grok: true, opencode: true,
};
describe('loop provider contract parity', () => {
  it('keeps the TypeScript provider union and schema enum in sync', () => {
    expect([...LoopProviderSchema.options].sort()).toEqual(Object.keys(ALL).sort());
  });
});
