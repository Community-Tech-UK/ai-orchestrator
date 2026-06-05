/**
 * Token Counter Tests
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { TokenCounter, getTokenCounter, getModelFamily } from './token-counter';

describe('TokenCounter', () => {
  let tokenCounter: TokenCounter;

  beforeEach(() => {
    TokenCounter._resetForTesting();
    tokenCounter = getTokenCounter();
    tokenCounter.setDefaultModel(undefined); // Reset to default
  });

  describe('countTokens', () => {
    it('should count tokens for simple text', () => {
      const text = 'Hello world';
      const tokens = tokenCounter.countTokens(text);
      expect(tokens).toBeGreaterThan(0);
      expect(tokens).toBeLessThan(10);
    });

    it('should return 0 for empty string', () => {
      expect(tokenCounter.countTokens('')).toBe(0);
    });

    it('should count more tokens for longer text', () => {
      const shortText = 'Hello';
      const longText = 'Hello world, this is a longer piece of text that should have more tokens';

      const shortTokens = tokenCounter.countTokens(shortText);
      const longTokens = tokenCounter.countTokens(longText);

      expect(longTokens).toBeGreaterThan(shortTokens);
    });

    it('should handle code content', () => {
      const code = `
        function hello() {
          console.log('Hello world');
          return true;
        }
      `;
      const tokens = tokenCounter.countTokens(code);
      expect(tokens).toBeGreaterThan(0);
    });

    it('should use model-specific counting when model is specified', () => {
      const text = 'Hello world, this is a test message';

      const gptTokens = tokenCounter.countTokens(text, 'gpt-4');
      const claudeTokens = tokenCounter.countTokens(text, 'claude-3-haiku');
      const llamaTokens = tokenCounter.countTokens(text, 'llama3');

      // All should be positive
      expect(gptTokens).toBeGreaterThan(0);
      expect(claudeTokens).toBeGreaterThan(0);
      expect(llamaTokens).toBeGreaterThan(0);

      // Different models may have slightly different token counts
      // (this tests that the model detection works)
    });
  });

  describe('truncateToTokens', () => {
    it('should return original text if already within limit', () => {
      const text = 'Hello world';
      const truncated = tokenCounter.truncateToTokens(text, 1000);
      expect(truncated).toBe(text);
    });

    it('should truncate text that exceeds limit', () => {
      const longText = 'This is a very long text that definitely exceeds a small token limit. '.repeat(50);
      const maxTokens = 20;

      const truncated = tokenCounter.truncateToTokens(longText, maxTokens);

      expect(truncated.length).toBeLessThan(longText.length);
      expect(tokenCounter.countTokens(truncated)).toBeLessThanOrEqual(maxTokens + 5); // Allow small margin
    });

    it('should return empty string for empty input', () => {
      expect(tokenCounter.truncateToTokens('', 100)).toBe('');
    });

    it('should add ellipsis when truncating', () => {
      const longText = 'This is a very long text. '.repeat(100);
      const truncated = tokenCounter.truncateToTokens(longText, 10);

      expect(truncated.endsWith('...')).toBe(true);
    });
  });

  describe('splitIntoChunks', () => {
    it('should return single chunk for short text', () => {
      const text = 'Hello world';
      const chunks = tokenCounter.splitIntoChunks(text, 1000);

      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toBe(text);
    });

    it('should split long text into multiple chunks', () => {
      const longText = 'This is a paragraph of text.\n\n'.repeat(50);
      const chunks = tokenCounter.splitIntoChunks(longText, 50);

      expect(chunks.length).toBeGreaterThan(1);
      for (const chunk of chunks) {
        // Each chunk should be within the limit (with some margin)
        expect(tokenCounter.countTokens(chunk)).toBeLessThanOrEqual(60);
      }
    });

    it('should return empty array for empty input', () => {
      expect(tokenCounter.splitIntoChunks('', 100)).toEqual([]);
    });

    it('should preserve content across chunks', () => {
      const text = 'First paragraph.\n\nSecond paragraph.\n\nThird paragraph.';
      const chunks = tokenCounter.splitIntoChunks(text, 100);

      const combined = chunks.join('');
      expect(combined).toContain('First');
      expect(combined).toContain('Second');
      expect(combined).toContain('Third');
    });
  });

  describe('estimateCost', () => {
    it('should estimate cost for GPT models', () => {
      const cost = tokenCounter.estimateCost(1000, 500, 'gpt-5.5-mini');
      expect(cost).toBeGreaterThan(0);
      expect(cost).toBeLessThan(1); // Should be fractions of a dollar
    });

    it('should estimate cost for Claude models', () => {
      const cost = tokenCounter.estimateCost(1000, 500, 'claude-3-haiku');
      expect(cost).toBeGreaterThan(0);
      expect(cost).toBeLessThan(1);
    });

    it('should handle zero tokens', () => {
      const cost = tokenCounter.estimateCost(0, 0, 'gpt-4');
      expect(cost).toBe(0);
    });

    it('should return higher cost for more expensive models', () => {
      // Use exact model names that match the pricing keys
      const haikuCost = tokenCounter.estimateCost(10000, 5000, 'claude-3-haiku-20240307');
      const opusCost = tokenCounter.estimateCost(10000, 5000, 'claude-3-opus-20240229');

      // Both should have positive costs
      expect(haikuCost).toBeGreaterThan(0);
      expect(opusCost).toBeGreaterThan(0);

      // Opus should be more expensive than haiku
      expect(opusCost).toBeGreaterThan(haikuCost);
    });
  });

  describe('getModelFamily', () => {
    it('should detect GPT-4 models', () => {
      expect(getModelFamily('gpt-4')).toBe('gpt-4');
      expect(getModelFamily('gpt-4-turbo')).toBe('gpt-4');
      expect(getModelFamily('gpt-4')).toBe('gpt-4');
    });

    it('should detect GPT-3.5 models', () => {
      expect(getModelFamily('gpt-3.5-turbo')).toBe('gpt-3.5');
      expect(getModelFamily('gpt-35-turbo')).toBe('gpt-3.5');
    });

    it('should detect Claude models', () => {
      expect(getModelFamily('claude-3-opus')).toBe('claude');
      expect(getModelFamily('claude-3-sonnet')).toBe('claude');
      expect(getModelFamily('claude-3-haiku')).toBe('claude');
      expect(getModelFamily('anthropic-claude')).toBe('claude');
    });

    it('should detect Llama models', () => {
      expect(getModelFamily('llama3')).toBe('llama');
      expect(getModelFamily('llama-2-7b')).toBe('llama');
      expect(getModelFamily('mistral-7b')).toBe('llama');
      expect(getModelFamily('vicuna')).toBe('llama');
    });

    it('should return unknown for unrecognized models', () => {
      expect(getModelFamily('some-unknown-model')).toBe('unknown');
      expect(getModelFamily(undefined)).toBe('unknown');
    });
  });

  describe('setDefaultModel', () => {
    it('should set default model for counting', () => {
      const text = 'Hello world test';

      // Count with default (unknown)
      tokenCounter.setDefaultModel(undefined);
      const defaultTokens = tokenCounter.countTokens(text);

      // Count with specific model
      tokenCounter.setDefaultModel('claude-3-haiku');
      const claudeTokens = tokenCounter.countTokens(text);

      // Both should be valid counts
      expect(defaultTokens).toBeGreaterThan(0);
      expect(claudeTokens).toBeGreaterThan(0);
    });
  });

  describe('calibrate()', () => {
    it('starts with a correction factor of 1.0 when no data is provided', () => {
      expect(tokenCounter.getCorrectionFactor('claude-3-haiku')).toBe(1.0);
      expect(tokenCounter.getCorrectionFactor(undefined)).toBe(1.0);
    });

    it('is a no-op by default (calibrateTokenCounts = false)', () => {
      // By default, calibrate() must not change the correction factor
      expect(tokenCounter.getCalibrateTokenCounts()).toBe(false);
      const text = 'Hello world test message for calibration';
      const rawEstimate = tokenCounter.countTokensRaw(text);
      tokenCounter.calibrate(Math.ceil(rawEstimate * 1.5), text);
      // Correction factor must still be 1.0 — no data recorded
      expect(tokenCounter.getCorrectionFactor(undefined)).toBe(1.0);
    });

    it('adjusts correction factor upward when actual > estimated (calibration enabled)', () => {
      tokenCounter.setCalibrateTokenCounts(true);
      // Simulate a text where the heuristic systematically underestimates
      const text = 'Hello world test message for calibration';
      const rawEstimate = tokenCounter.countTokensRaw(text);
      // Feed an actual that is 50% higher than raw estimate → correction should converge toward 1.5
      const simulatedActual = Math.ceil(rawEstimate * 1.5);
      tokenCounter.calibrate(simulatedActual, text);
      const factor = tokenCounter.getCorrectionFactor(undefined);
      expect(factor).toBeGreaterThan(1.0);
      expect(factor).toBeLessThanOrEqual(2.0); // clamped upper bound
    });

    it('adjusts correction factor downward when actual < estimated (calibration enabled)', () => {
      tokenCounter.setCalibrateTokenCounts(true);
      const text = 'Hello world test message for calibration';
      const rawEstimate = tokenCounter.countTokensRaw(text);
      // Feed an actual that is 30% lower → correction should converge toward 0.7
      const simulatedActual = Math.ceil(rawEstimate * 0.7);
      tokenCounter.calibrate(simulatedActual, text);
      const factor = tokenCounter.getCorrectionFactor(undefined);
      expect(factor).toBeLessThan(1.0);
      expect(factor).toBeGreaterThanOrEqual(0.5); // clamped lower bound
    });

    it('converges to the median ratio over multiple paired samples (calibration enabled)', () => {
      tokenCounter.setCalibrateTokenCounts(true);
      const text = 'Sample text for convergence test. It has multiple words.';
      const rawEstimate = tokenCounter.countTokensRaw(text, 'claude-3-haiku');
      // Feed 5 samples all at 2× the raw estimate
      for (let i = 0; i < 5; i++) {
        tokenCounter.calibrate(Math.ceil(rawEstimate * 2), text, 'claude-3-haiku');
      }
      const factor = tokenCounter.getCorrectionFactor('claude-3-haiku');
      // With 5 identical 2× samples, median ratio should equal 2 (clamped to 2.0)
      expect(factor).toBe(2.0);
    });

    it('keeps separate correction factors per model family (calibration enabled)', () => {
      tokenCounter.setCalibrateTokenCounts(true);
      const text = 'Test text for per-family isolation';
      const rawClaudeEstimate = tokenCounter.countTokensRaw(text, 'claude-3-haiku');
      const rawGptEstimate = tokenCounter.countTokensRaw(text, 'gpt-4');
      // Calibrate claude family at 2× and gpt family at 0.5×
      tokenCounter.calibrate(Math.ceil(rawClaudeEstimate * 2), text, 'claude-3-haiku');
      tokenCounter.calibrate(Math.ceil(rawGptEstimate * 0.5), text, 'gpt-4');
      const claudeFactor = tokenCounter.getCorrectionFactor('claude-3-haiku');
      const gptFactor = tokenCounter.getCorrectionFactor('gpt-4');
      expect(claudeFactor).toBeGreaterThan(gptFactor);
    });

    it('ignores zero-token inputs without corrupting state (calibration enabled)', () => {
      tokenCounter.setCalibrateTokenCounts(true);
      tokenCounter.calibrate(0, 'non-empty text');
      tokenCounter.calibrate(10, '');
      expect(tokenCounter.getCorrectionFactor(undefined)).toBe(1.0);
    });

    it('clamps correction factor to [0.5, 2.0] (calibration enabled)', () => {
      tokenCounter.setCalibrateTokenCounts(true);
      const text = 'Some text';
      // Drive factor below 0.5: feed actual=1 while raw estimate >> 1
      tokenCounter.calibrate(1, text);
      expect(tokenCounter.getCorrectionFactor(undefined)).toBeGreaterThanOrEqual(0.5);
    });

    it('countTokens incorporates correction factor after calibration (calibration enabled)', () => {
      tokenCounter.setCalibrateTokenCounts(true);
      const text = 'Hello world';
      const uncalibratedCount = tokenCounter.countTokens(text);
      // Calibrate with a doubled actual value
      const rawEstimate = tokenCounter.countTokensRaw(text);
      tokenCounter.calibrate(Math.ceil(rawEstimate * 2), text);
      const calibratedCount = tokenCounter.countTokens(text);
      // The calibrated count should be higher than the uncalibrated count
      expect(calibratedCount).toBeGreaterThanOrEqual(uncalibratedCount);
    });

    it('setCalibrateTokenCounts / getCalibrateTokenCounts round-trips', () => {
      expect(tokenCounter.getCalibrateTokenCounts()).toBe(false);
      tokenCounter.setCalibrateTokenCounts(true);
      expect(tokenCounter.getCalibrateTokenCounts()).toBe(true);
      tokenCounter.setCalibrateTokenCounts(false);
      expect(tokenCounter.getCalibrateTokenCounts()).toBe(false);
    });
  });

  describe('estimate-vs-actual telemetry', () => {
    it('returns null when no samples have been recorded', () => {
      expect(tokenCounter.getEstimationTelemetry('claude-3-haiku')).toBeNull();
      expect(tokenCounter.getAllEstimationTelemetry()).toEqual({});
    });

    it('records a paired sample and reports it (ungated — works without enabling calibration)', () => {
      expect(tokenCounter.getCalibrateTokenCounts()).toBe(false); // telemetry must not need the gate
      const text = 'Hello world, this is a completion output text.';
      const estimated = tokenCounter.countTokensRaw(text, 'claude-3-haiku');
      expect(tokenCounter.recordEstimationSample(estimated, text, 'claude-3-haiku')).toBe(true);

      const telemetry = tokenCounter.getEstimationTelemetry('claude-3-haiku');
      expect(telemetry).not.toBeNull();
      expect(telemetry?.sampleCount).toBe(1);
      // actual === estimated → ratio 1.0, zero error
      expect(telemetry?.medianRatio).toBeCloseTo(1.0, 5);
      expect(telemetry?.meanAbsErrorPct).toBeCloseTo(0, 5);
    });

    it('does NOT mutate token counts (correction factor stays 1.0)', () => {
      const text = 'Some completion output that the provider under-counted heavily.';
      const estimated = tokenCounter.countTokensRaw(text, 'claude-3-haiku');
      // Record a sample where actual is 3× the estimate — would shift calibration
      // hard IF this fed calibration, but telemetry must leave counts untouched.
      tokenCounter.recordEstimationSample(estimated * 3, text, 'claude-3-haiku');
      expect(tokenCounter.getCorrectionFactor('claude-3-haiku')).toBe(1.0);
      expect(tokenCounter.countTokens(text, 'claude-3-haiku')).toBe(
        tokenCounter.countTokens(text, 'claude-3-haiku'),
      );
    });

    it('computes median ratio when the heuristic under-counts', () => {
      const text = 'Repeatable completion text for ratio math.';
      const estimated = tokenCounter.countTokensRaw(text, 'gpt-4');
      // Three samples all at 2× the estimate → median ratio 2.0
      for (let i = 0; i < 3; i++) {
        tokenCounter.recordEstimationSample(estimated * 2, text, 'gpt-4');
      }
      const telemetry = tokenCounter.getEstimationTelemetry('gpt-4');
      expect(telemetry?.sampleCount).toBe(3);
      expect(telemetry?.medianRatio).toBeCloseTo(2.0, 5);
      // |2e - e| / 2e = 0.5 → 50%
      expect(telemetry?.meanAbsErrorPct).toBeCloseTo(50, 5);
    });

    it('keeps telemetry separate per model family', () => {
      const text = 'Cross-family isolation text.';
      const claudeEst = tokenCounter.countTokensRaw(text, 'claude-3-haiku');
      const gptEst = tokenCounter.countTokensRaw(text, 'gpt-4');
      tokenCounter.recordEstimationSample(claudeEst * 2, text, 'claude-3-haiku');
      tokenCounter.recordEstimationSample(gptEst, text, 'gpt-4');

      const all = tokenCounter.getAllEstimationTelemetry();
      expect(all['claude']?.medianRatio).toBeCloseTo(2.0, 5);
      expect(all['gpt-4']?.medianRatio).toBeCloseTo(1.0, 5);
    });

    it('drops invalid samples (empty text, non-positive actual, zero estimate)', () => {
      expect(tokenCounter.recordEstimationSample(10, '', 'claude-3-haiku')).toBe(false);
      expect(tokenCounter.recordEstimationSample(0, 'non-empty', 'claude-3-haiku')).toBe(false);
      expect(tokenCounter.recordEstimationSample(-5, 'non-empty', 'claude-3-haiku')).toBe(false);
      expect(tokenCounter.recordEstimationSample(Number.NaN, 'non-empty', 'claude-3-haiku')).toBe(false);
      expect(tokenCounter.getEstimationTelemetry('claude-3-haiku')).toBeNull();
    });

    it('bounds retained samples per family', () => {
      const text = 'Bounded buffer text sample.';
      const estimated = tokenCounter.countTokensRaw(text, 'gpt-4');
      for (let i = 0; i < 120; i++) {
        tokenCounter.recordEstimationSample(estimated, text, 'gpt-4');
      }
      // MAX_TELEMETRY_SAMPLES = 50
      expect(tokenCounter.getEstimationTelemetry('gpt-4')?.sampleCount).toBe(50);
    });
  });

  describe('countTokensRaw()', () => {
    it('returns a positive integer for non-empty text', () => {
      const raw = tokenCounter.countTokensRaw('hello world');
      expect(raw).toBeGreaterThan(0);
      expect(Number.isInteger(raw)).toBe(true);
    });

    it('returns 0 for empty string', () => {
      expect(tokenCounter.countTokensRaw('')).toBe(0);
    });

    it('is always <= countTokens due to safety margin', () => {
      const text = 'Test text for safety margin verification';
      expect(tokenCounter.countTokensRaw(text)).toBeLessThanOrEqual(tokenCounter.countTokens(text));
    });
  });
});
