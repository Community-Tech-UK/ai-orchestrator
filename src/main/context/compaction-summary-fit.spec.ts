import { describe, expect, it } from 'vitest';
import { fitCompactionSummary } from './compaction-summary-fit';
import { buildCompactionPrompt, COMPACTION_SYSTEM_PROMPT } from './context-compaction-prompt';
import { getTokenCounter } from '../rlm/token-counter';

describe('compaction summary fitting work bounds', () => {
  it.each([1000, 2500])('fits %i older messages without repeatedly composing the growing full request', size => {
    const turns = Array.from({ length: size }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `Turn ${i} ` + 'word '.repeat(100) }));
    let compositions = 0;
    let processedChars = 0;
    const compose = (sample: readonly typeof turns[number][]) => {
      const user = buildCompactionPrompt(sample.map(turn => `[${turn.role}]: ${turn.content}`).join('\n\n'), 'Prior accessibility constraint.');
      compositions++;
      processedChars += user.length;
      return { system: COMPACTION_SYSTEM_PROMPT, user };
    };
    const fit = fitCompactionSummary(turns, 96000, compose);
    const request = compose(fit.turns);
    expect(getTokenCounter().countTokens(request.system) + getTokenCounter().countTokens(request.user)).toBeLessThanOrEqual(96000);
    expect(fit.turns[0]).toEqual(turns[0]);
    expect(fit.turns.at(-1)).toEqual(turns.at(-1));
    expect(fit.sampledCount).toBeLessThan(size);
    // Bound actual request construction volume, independent of machine speed.
    expect(compositions).toBeLessThanOrEqual(8);
    expect(processedChars).toBeLessThan(size * 600 * 8);
  });
});
