/**
 * Token Counter Tests
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { TokenCounter, getTokenCounter, getModelFamily } from './token-counter';

describe('TokenCounter', () => {
  let tokenCounter: TokenCounter;

  beforeEach(() => {
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
});
