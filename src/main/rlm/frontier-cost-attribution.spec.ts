import { beforeEach, describe, expect, it, vi } from 'vitest';
import { recordModelCall } from '../core/system/model-call-recorder';
import { recordCorrelatedFrontierAttribution } from './frontier-cost-attribution';

vi.mock('../core/system/model-call-recorder', () => ({ recordModelCall: vi.fn() }));
vi.mock('./token-counter', () => ({ getTokenCounter: () => ({ countTokens: () => 1 }) }));

describe('frontier cost attribution model identity', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    ['Claude Opus 5.5 (High)', 'claude-opus-5-5'],
    ['Claude Sonnet 5.5 (Medium)', 'claude-sonnet-5-5'],
  ])('records %s using its first-party pricing identity', (model, expectedModel) => {
    recordCorrelatedFrontierAttribution({
      taskType: 'auto-title',
      provider: 'antigravity',
      model,
      inputTexts: ['Summarize this session'],
      outputText: 'Build check',
      usage: { inputTokens: 10, outputTokens: 2 },
    });

    expect(recordModelCall).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'anthropic',
      model: expectedModel,
      usage: expect.objectContaining({ inputTokens: 10, outputTokens: 2 }),
      isEstimated: false,
    }));
  });
});
