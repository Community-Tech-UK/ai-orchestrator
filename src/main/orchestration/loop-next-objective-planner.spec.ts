import { describe, expect, it, vi } from 'vitest';
import { createAuxiliaryNextObjectivePlanner, parseNextObjectivePlannerOutput } from './loop-next-objective-planner';

describe('loop next-objective planner', () => {
  it('parses a JSON objective from model output', () => {
    expect(parseNextObjectivePlannerOutput('{"objective":"Inspect the retry path next"}')).toBe('Inspect the retry path next');
  });

  it('falls back to plain text when the model does not return JSON', () => {
    expect(parseNextObjectivePlannerOutput('Inspect the retry path next.')).toBe('Inspect the retry path next.');
  });

  it('uses the auxiliary loopScoring slot to produce the next objective', async () => {
    const generate = vi.fn().mockResolvedValue({
      text: '{"objective":"Inspect retry handling before touching UI"}',
      decision: {
        slot: 'loopScoring',
        provider: 'ollama',
        source: 'local',
        reason: 'test',
        allowFrontierFallback: true,
      },
    });
    const planner = createAuxiliaryNextObjectivePlanner({ generate });

    const result = await planner({
      lastOutput: 'I fixed the parser and one retry test still fails.',
      originalGoal: 'Fix all retry failures',
      seq: 3,
    });

    expect(result).toBe('Inspect retry handling before touching UI');
    expect(generate).toHaveBeenCalledWith(
      'loopScoring',
      expect.stringContaining('next concrete objective'),
      expect.stringContaining('Fix all retry failures'),
    );
  });
});
