import { describe, it, expect } from 'vitest';
import { OutputClassifier } from './output-classifier';

describe('OutputClassifier', () => {
  const classifier = new OutputClassifier();

  describe('classify', () => {
    it('classifies fenced code blocks as code', () => {
      const result = classifier.classify('Here is the fix:\n```typescript\nconst x = 1;\nconst y = 2;\n```');
      expect(result.type).toBe('code');
      expect(result.shouldReview).toBe(true);
    });

    it('classifies file edit summaries as code even without fenced blocks', () => {
      const result = classifier.classify(
        'I updated the implementation by editing `src/main/foo.ts` and creating `src/shared/bar.ts` to support the new flow.'
      );
      expect(result.type).toBe('code');
      expect(result.shouldReview).toBe(true);
      expect(result.fileCount).toBe(2);
    });

    it('classifies numbered step lists as plan', () => {
      const result = classifier.classify('## Implementation Plan\n1. Create the service\n2. Add tests\n3. Wire IPC\n4. Build UI\n5. Integration test\n6. Deploy');
      expect(result.type).toBe('plan');
      expect(result.shouldReview).toBe(true);
    });

    it('classifies architecture keywords as architecture', () => {
      const result = classifier.classify('## System Design\nThe data flow goes from the API gateway through the message queue to the worker pool. Component diagram:\n```\nAPI -> Queue -> Worker\n```');
      expect(result.type).toBe('architecture');
      expect(result.shouldReview).toBe(true);
      expect(result.isComplex).toBe(true);
    });

    it('classifies short text as conversation', () => {
      const result = classifier.classify('Sure, I can help with that. Let me look into this for you.');
      expect(result.type).toBe('conversation');
    });

    it('skips output below minimum length', () => {
      const result = classifier.classify('Done.');
      expect(result.type).toBe('conversation');
      expect(result.shouldReview).toBe(false);
    });

    it('does not review conversation type', () => {
      const result = classifier.classify('That sounds like a good approach. Let me know if you have questions about anything else.');
      expect(result.shouldReview).toBe(false);
    });
  });

  describe('complexity scoring', () => {
    it('marks large code blocks as complex', () => {
      const lines = Array.from({ length: 120 }, (_, i) => `  const line${i} = ${i};`);
      const result = classifier.classify('```typescript\n' + lines.join('\n') + '\n```');
      expect(result.isComplex).toBe(true);
      expect(result.codeLineCount).toBeGreaterThan(100);
    });

    it('marks plans with >5 steps as complex', () => {
      const result = classifier.classify('Plan:\n1. Step one\n2. Step two\n3. Step three\n4. Step four\n5. Step five\n6. Step six\n7. Step seven');
      expect(result.isComplex).toBe(true);
    });

    it('auto-escalates security keywords', () => {
      const result = classifier.classify('```typescript\nconst query = `SELECT * FROM users WHERE id = ${userId}`;\n// This has sql injection risk\n```');
      expect(result.isComplex).toBe(true);
    });

    it('counts files touched', () => {
      const result = classifier.classify('```typescript\nconst x = 1;\n```\nCreate `src/foo.ts`\nModify `src/bar.ts`\nEdit `src/baz.ts`\nUpdate `src/qux.ts`');
      expect(result.fileCount).toBeGreaterThanOrEqual(4);
      expect(result.isComplex).toBe(true);
    });

    it('deduplicates repeated mentions of the same touched file', () => {
      const result = classifier.classify(
        '```typescript\nconst x = 1;\n```\nUpdate `src/foo.ts`\nEdit `src/foo.ts`\nModify `src/bar.ts`'
      );
      expect(result.fileCount).toBe(2);
    });
  });
});
