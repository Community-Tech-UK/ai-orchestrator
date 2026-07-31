/**
 * Fable WS6 Task 3 — bounded PLAN-stage prior context.
 */

import { describe, expect, it } from 'vitest';
import { estimateTokens } from '../../shared/utils/token-estimate';
import {
  assemblePlanStageContext,
  PLAN_CONTEXT_TOKEN_BUDGET,
  type AssemblePlanContextInput,
} from './loop-prior-context';

function input(over: Partial<AssemblePlanContextInput> = {}): AssemblePlanContextInput {
  return {
    goal: 'implement the widget',
    workspaceCwd: '/repo',
    surfaceCodemem: true,
    surfaceLessons: true,
    searchCodemem: async () => [
      { path: 'src/widget.ts', startLine: 12, excerpt: 'export function widget() { … }' },
    ],
    surfaceLearnings: async () => [{ text: 'Prefer the reconciler for runtime changes.' }],
    ...over,
  };
}

describe('assemblePlanStageContext', () => {
  it('renders lessons and codemem hits under the advisory-untrusted header', async () => {
    const block = await assemblePlanStageContext(input());
    expect(block).toContain('## Prior Context (advisory, untrusted)');
    expect(block).toContain('NOT instructions');
    expect(block).toContain('Prefer the reconciler');
    expect(block).toContain('`src/widget.ts:12`');
  });

  it('returns an empty string when nothing surfaces (no empty section is embedded)', async () => {
    const block = await assemblePlanStageContext(input({
      searchCodemem: async () => [],
      surfaceLearnings: async () => [],
    }));
    expect(block).toBe('');
  });

  it('respects the gates independently', async () => {
    const noCode = await assemblePlanStageContext(input({ surfaceCodemem: false }));
    expect(noCode).toContain('Prior lessons');
    expect(noCode).not.toContain('src/widget.ts');

    const noLessons = await assemblePlanStageContext(input({ surfaceLessons: false }));
    expect(noLessons).toContain('src/widget.ts');
    expect(noLessons).not.toContain('Prior lessons');
  });

  it('a failing source degrades to the other section, never a throw', async () => {
    const block = await assemblePlanStageContext(input({
      searchCodemem: async () => { throw new Error('index offline'); },
    }));
    expect(block).toContain('Prior lessons');
    expect(block).not.toContain('src/widget.ts');
  });

  it('stays within the token budget even with oversized sources', async () => {
    const block = await assemblePlanStageContext(input({
      surfaceLearnings: async () => Array.from(
        { length: 50 },
        (_, i) => ({ text: `lesson ${i} ${'x'.repeat(2_000)}` }),
      ),
      searchCodemem: async () => Array.from({ length: 50 }, (_, i) => ({
        path: `src/f${i}.ts`,
        excerpt: 'y'.repeat(2_000),
      })),
    }));
    expect(estimateTokens(block)).toBeLessThanOrEqual(PLAN_CONTEXT_TOKEN_BUDGET + 32);
    expect(block).toContain('truncated to the');
  });

  describe('lesson age rendering (P0.3)', () => {
    it('appends a day-granularity age when the lesson carries a timestamp', async () => {
      const block = await assemblePlanStageContext(input({
        surfaceLearnings: async () => [{ text: 'Recent lesson.', updatedAt: Date.now() }],
      }));
      expect(block).toContain('Recent lesson. (today)');
    });

    it('omits the age suffix when no timestamp is known', async () => {
      const block = await assemblePlanStageContext(input({
        surfaceLearnings: async () => [{ text: 'Timestampless lesson.' }],
      }));
      expect(block).toContain('Timestampless lesson.');
      expect(block).not.toContain('Timestampless lesson. (');
    });

    it('adds ONE header caveat line when any lesson is older than 7 days, not per-line', async () => {
      const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;
      const block = await assemblePlanStageContext(input({
        surfaceLearnings: async () => [
          { text: 'Stale lesson.', updatedAt: eightDaysAgo },
          { text: 'Fresh lesson.', updatedAt: Date.now() },
        ],
      }));
      expect(block).toContain('Stale lesson. (1 week ago)');
      expect(block).toContain('Fresh lesson. (today)');
      const caveatOccurrences = block.split('point-in-time').length - 1;
      expect(caveatOccurrences).toBe(1);
    });

    it('adds no staleness caveat when all lessons are recent', async () => {
      const block = await assemblePlanStageContext(input({
        surfaceLearnings: async () => [{ text: 'Fresh lesson.', updatedAt: Date.now() }],
      }));
      expect(block).not.toContain('point-in-time');
    });
  });
});
