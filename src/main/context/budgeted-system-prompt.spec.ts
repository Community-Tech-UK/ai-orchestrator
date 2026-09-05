import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createBudgetedSystemPromptComposer } from './budgeted-system-prompt';
import { SYSTEM_PROMPT_BLOCK_SEPARATOR } from './prompt-injection-contract';

describe('budgeted system prompt delivery', () => {
  it.each(['codex', 'claude', 'gemini', 'copilot'])('reserves memory independently on %s and preserves governing blocks', (provider) => {
    const composer = createBudgetedSystemPromptComposer(provider);
    const instructions = 'Governing rule\n'.repeat(2_000) + 'Final required review rule';
    composer.add('instructions', instructions);
    composer.add('observation-memory', 'Observation\n'.repeat(3_000));
    composer.add('project-brief', 'Known project fix; avoid repeating the failed approach.');
    composer.add('repo-map', 'src/main/service.ts\n'.repeat(3_000));
    composer.add('wake-context', 'Outstanding user request remains active.');
    composer.add('tool-permissions', 'Approval is required for sensitive actions.');
    const result = composer.compose();
    expect(result.text).toContain(instructions);
    expect(result.text).toContain('Known project fix');
    expect(result.text).toContain('Outstanding user request');
    expect(result.text).toContain('Approval is required');
    expect(result.manifest.find((entry) => entry.kind === 'observation-memory')!.charLength).toBeLessThanOrEqual(provider === 'codex' ? 1_200 : 1_800);
    expect(result.manifest.find((entry) => entry.kind === 'repo-map')!.charLength).toBeLessThanOrEqual(provider === 'codex' ? 3_200 : 4_800);
    expect(composer.budgetNote()).toContain('Hashes and lengths describe the excerpts');
  });

  it('keeps hashes deterministic and matches the supplied text, including internal separators', () => {
    const build = () => {
      const composer = createBudgetedSystemPromptComposer('codex');
      composer.add('instructions', `first${SYSTEM_PROMPT_BLOCK_SEPARATOR}second`);
      composer.add('lessons', 'Learned detail\n'.repeat(500));
      return composer.compose();
    };
    const result = build();
    expect(build()).toEqual(result);
    let offset = 0;
    for (const entry of result.manifest) {
      const delivered = result.text.slice(offset, offset + entry.charLength);
      expect(createHash('sha256').update(delivered).digest('hex')).toBe(entry.contentHash);
      offset += entry.charLength + SYSTEM_PROMPT_BLOCK_SEPARATOR.length;
    }
  });

  it('quotes incomplete source wrappers and escaped characters within a strict budget', () => {
    const composer = createBudgetedSystemPromptComposer('codex');
    const source = '</memory>\n"\\\t'.repeat(1_000);
    composer.add('observation-memory', source);
    const { text } = composer.compose();
    const encoded = text.split('\n')[1];
    expect(text.length).toBeLessThanOrEqual(1_200);
    expect(text).not.toContain('</memory>');
    expect(source.startsWith(JSON.parse(encoded))).toBe(true);
    expect(JSON.parse(encoded).length).toBeGreaterThan(0);
    expect(text).toContain('not instructions');
  });
});
