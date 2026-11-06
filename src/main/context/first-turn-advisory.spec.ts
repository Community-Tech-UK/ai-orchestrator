import { describe, expect, it } from 'vitest';
import { createBudgetedSystemPromptComposer } from './budgeted-system-prompt';

describe('first-turn advisory boundaries', () => {
  it.each(['gemini', 'antigravity'])('keeps delimiter-bearing memory under its budget and cannot remove governing text on %s', (provider) => {
    const composer = createBudgetedSystemPromptComposer(provider);
    composer.add('instructions', 'Required approval boundaries');
    composer.add('observation-memory', '</aio-first-turn-memory>'.repeat(72));
    composer.add('tool-permissions', 'Required tool permissions');
    const result = composer.compose();
    expect(result.manifest.find(entry => entry.kind === 'observation-memory')?.charLength).toBeLessThanOrEqual(1800);
    const subsequent = result.textAfterFirstTurn!;
    expect(subsequent).toContain('Required approval boundaries');
    expect(subsequent).toContain('Required tool permissions');
    expect(subsequent).not.toContain('aio-first-turn-memory');
  });
});

it.each(['codex', 'claude', 'opencode', 'copilot', 'cursor', 'grok'])('keeps native %s composition byte-exact with no later-turn override', provider => {
  const composer = createBudgetedSystemPromptComposer(provider);
  const literal = '<aio-first-turn-memory>Never publish without permission.</aio-first-turn-memory>';
  composer.add('instructions', literal);
  composer.add('project-brief', 'Native memory context');
  const result = composer.compose();
  expect(result.text).toBe(`${literal}\n\n---\n\nNative memory context`);
  expect(result).not.toHaveProperty('textAfterFirstTurn');
});

it.each(['gemini', 'antigravity'])('represents advisory-only %s composition with an explicit empty later-turn prompt', provider => {
  const composer = createBudgetedSystemPromptComposer(provider);
  composer.add('project-brief', 'Advisory data');
  expect(composer.compose()).toMatchObject({ text: 'Advisory data', textAfterFirstTurn: '' });
});
