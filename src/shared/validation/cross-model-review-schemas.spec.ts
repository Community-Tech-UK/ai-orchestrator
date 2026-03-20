import { describe, expect, it } from 'vitest';
import {
  ReviewDismissPayloadSchema,
  ReviewActionPayloadSchema,
  ReviewResultJsonSchema,
} from './cross-model-review-schemas';

describe('CrossModelReviewSchemas', () => {
  describe('ReviewDismissPayloadSchema', () => {
    it('accepts valid dismiss payload', () => {
      const result = ReviewDismissPayloadSchema.safeParse({
        reviewId: 'review-123',
        instanceId: 'inst-456',
      });
      expect(result.success).toBe(true);
    });

    it('rejects missing reviewId', () => {
      const result = ReviewDismissPayloadSchema.safeParse({
        instanceId: 'inst-456',
      });
      expect(result.success).toBe(false);
    });

    it('rejects empty reviewId', () => {
      const result = ReviewDismissPayloadSchema.safeParse({
        reviewId: '',
        instanceId: 'inst-456',
      });
      expect(result.success).toBe(false);
    });
  });

  describe('ReviewActionPayloadSchema', () => {
    it('accepts valid action payload', () => {
      const result = ReviewActionPayloadSchema.safeParse({
        reviewId: 'review-123',
        instanceId: 'inst-456',
        action: 'ask-primary',
      });
      expect(result.success).toBe(true);
    });

    it('accepts all valid action types', () => {
      for (const action of ['dismiss', 'ask-primary', 'show-full', 'start-debate']) {
        const result = ReviewActionPayloadSchema.safeParse({
          reviewId: 'review-123',
          instanceId: 'inst-456',
          action,
        });
        expect(result.success).toBe(true);
      }
    });

    it('rejects invalid action type', () => {
      const result = ReviewActionPayloadSchema.safeParse({
        reviewId: 'review-123',
        instanceId: 'inst-456',
        action: 'invalid-action',
      });
      expect(result.success).toBe(false);
    });
  });

  describe('ReviewResultJsonSchema', () => {
    const validResult = {
      correctness: { reasoning: 'Looks correct', score: 4, issues: [] },
      completeness: { reasoning: 'Complete', score: 4, issues: [] },
      security: { reasoning: 'No issues', score: 4, issues: [] },
      consistency: { reasoning: 'Consistent', score: 4, issues: [] },
      overall_verdict: 'APPROVE',
      summary: 'All good',
    };

    it('accepts valid structured review JSON', () => {
      const result = ReviewResultJsonSchema.safeParse(validResult);
      expect(result.success).toBe(true);
    });

    it('rejects score above range (5)', () => {
      const result = ReviewResultJsonSchema.safeParse({
        ...validResult,
        correctness: { reasoning: 'ok', score: 5, issues: [] },
      });
      expect(result.success).toBe(false);
    });

    it('rejects score below range (0)', () => {
      const result = ReviewResultJsonSchema.safeParse({
        ...validResult,
        correctness: { reasoning: 'ok', score: 0, issues: [] },
      });
      expect(result.success).toBe(false);
    });

    it('rejects non-integer score', () => {
      const result = ReviewResultJsonSchema.safeParse({
        ...validResult,
        correctness: { reasoning: 'ok', score: 2.5, issues: [] },
      });
      expect(result.success).toBe(false);
    });

    it('rejects invalid verdict', () => {
      const result = ReviewResultJsonSchema.safeParse({
        ...validResult,
        overall_verdict: 'MAYBE',
      });
      expect(result.success).toBe(false);
    });
  });
});
