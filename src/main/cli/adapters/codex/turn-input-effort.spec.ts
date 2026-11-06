import { describe, expect, it } from 'vitest';
import { buildCodexTurnInputDispatch } from './turn-input-dispatch';

describe('Codex effort admission', () => {
  it.each(['loop', 'plan-queue', 'automation', 'review'] as const)('clamps ultra for %s', (sessionKind) => {
    expect(buildCodexTurnInputDispatch({ sessionKind, reasoningEffort: 'ultra' }, undefined, () => true, () => true).turnParams)
      .toMatchObject({ effort: 'max' });
  });
  it.each(['chat', 'child'] as const)('preserves requested ultra for %s', (sessionKind) => {
    expect(buildCodexTurnInputDispatch({ sessionKind, reasoningEffort: 'ultra' }, undefined, () => true, () => true).turnParams)
      .toMatchObject({ effort: 'ultra' });
  });
});
