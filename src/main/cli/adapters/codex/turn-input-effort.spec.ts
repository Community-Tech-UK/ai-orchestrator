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

describe('Codex reasoning summary request', () => {
  it('asks for a reasoning summary on every turn, with or without an effort', () => {
    expect(buildCodexTurnInputDispatch({}, undefined, () => true, () => true).turnParams).toEqual({ summary: 'auto' });
    expect(buildCodexTurnInputDispatch({ reasoningEffort: 'high' }, undefined, () => true, () => true).turnParams)
      .toMatchObject({ summary: 'auto', effort: 'high' });
  });
});
