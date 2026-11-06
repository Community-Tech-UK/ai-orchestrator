import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { computeTokenCost } from '../../src/shared/data/model-pricing';
// @ts-expect-error standalone Node audit module
import { compareTranscriptCosts } from '../claude-transcript-cost-comparison.mjs';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));
function compare(model: string, usage: object, prices = {}) {
  const root = mkdtempSync(join(tmpdir(), 'claude-pricing-')); dirs.push(root);
  writeFileSync(join(root, 'session.jsonl'), JSON.stringify({ type: 'assistant', sessionId: 'session',
    timestamp: '2026-10-26T12:00:00Z', message: { id: 'message', model, usage } }));
  return compareTranscriptCosts({ roots: [root], rows: [], start: Date.parse('2026-10-26'),
    end: Date.parse('2026-10-27'), prices });
}

describe('versioned transcript prices', () => {
  it.each(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1',
    'claude-opus-5', 'claude-opus-4-8', 'claude-opus-4-20250514', 'claude-sonnet-5',
    'claude-3-5-haiku-20241022', 'opus', 'sonnet', 'haiku'])('matches application input/output/read pricing for %s', model => {
    const result = compare(model, { input_tokens: 1_000_000, output_tokens: 1_000_000, cache_read_input_tokens: 1_000_000 });
    expect(result.transcript).toBeCloseTo(computeTokenCost(model, { inputTokens: 1_000_000,
      outputTokens: 1_000_000, cacheReadTokens: 1_000_000 }));
  });
  it('prices Opus 5.5 cache reads at twenty cents per million', () => {
    expect(compare('claude-opus-5-5', { cache_read_input_tokens: 1_000_000 }).transcript).toBe(0.2);
  });
  it('keeps native five-minute and one-hour cache writes distinct', () => {
    expect(compare('claude-opus-5-5', { cache_creation_input_tokens: 3_000_000,
      cache_creation: { ephemeral_5m_input_tokens: 1_000_000, ephemeral_1h_input_tokens: 1_000_000 } }).transcript).toBe(18);
  });
  it('inherits model cache ratios for a base-only override and accepts explicit cache rates', () => {
    const usage = { cache_read_input_tokens: 1_000_000, cache_creation_input_tokens: 1_000_000 };
    expect(compare('claude-opus-5-5', usage, { 'claude-opus-5-5': { input: 8, output: 40 } }).transcript).toBe(10.4);
    expect(compare('claude-opus-5-5', usage, { 'claude-opus-5-5': {
      input: 8, output: 40, cacheRead: 0.3, cacheWrite: 6, cacheWrite1h: 12,
    } }).transcript).toBe(6.3);
  });
  it.each([NaN, -1, '0.2'])('rejects invalid explicit cache price %s', cacheRead => {
    expect(() => compare('claude-opus-5-5', {}, { 'claude-opus-5-5': { input: 4, output: 20, cacheRead } })).toThrow('Invalid price');
  });
  it('leaves unknown model versions unpriced', () => {
    const result = compare('claude-opus-99', { input_tokens: 1 });
    expect(result.unpricedModels).toEqual(['claude-opus-99']);
    expect(result.exceeded).toBe(true);
  });
});
