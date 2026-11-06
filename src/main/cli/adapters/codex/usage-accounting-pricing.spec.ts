import { describe, expect, it } from 'vitest';
import { CodexUsageAccounting } from './usage-accounting';
import { getModelRate } from '../../../../shared/data/model-pricing';

const raw = (input: number, output: number) => ({ inputTokens: input, outputTokens: output, totalTokens: input + output });
describe('Codex per-request premium accounting', () => {
  it('prices mixed short and long requests independently and deduplicates notifications', () => {
    const tracker = new CodexUsageAccounting();
    tracker.beginTurn('root');
    tracker.observe('root', raw(200_000, 1000), raw(200_000, 1000), false, 1_000_000);
    tracker.observe('root', raw(500_000, 2000), raw(300_000, 1000), false, 1_000_000);
    tracker.observe('root', raw(500_000, 2000), raw(300_000, 1000), false, 1_000_000);
    const rate = getModelRate('gpt-6-astra');
    expect(tracker.take('gpt-6-astra')?.cost).toBeCloseTo((200_000 * rate.input + 1000 * rate.output + 300_000 * rate.input * 2 + 1000 * rate.output * 1.5) / 1e6);
    tracker.beginTurn('root');
    tracker.observe('root', raw(700_000, 3000), raw(200_000, 1000));
    expect(tracker.take('gpt-6-astra')?.cost).toBeCloseTo((200_000 * rate.input + 1000 * rate.output) / 1e6);
  });
  it('does not infer the premium from a large aggregate of small requests', () => {
    const tracker = new CodexUsageAccounting();
    tracker.beginTurn('root');
    for (let index = 1; index <= 3; index++) tracker.observe('root', raw(index * 200_000, index * 1000), raw(200_000, 1000));
    expect(tracker.take('gpt-6-astra')?.cost).toBeCloseTo(6.15);
  });
  it('rejects an aggregate masquerading as last when it exceeds the reported request window', () => {
    const tracker = new CodexUsageAccounting();
    tracker.beginTurn('root');
    tracker.observe('root', raw(500_000, 1000), raw(500_000, 1000), false, 258_400);
    expect(tracker.take('gpt-6-astra')).toMatchObject({ cost: 5.05, isEstimated: true });
  });
});
