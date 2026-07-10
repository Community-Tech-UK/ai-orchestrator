import { describe, expect, it } from 'vitest';
import { testCoverageAnalyzer } from './index';

describe('built-in review agent scoring', () => {
  it('uses the shared 0-100 confidence convention for test coverage findings', () => {
    expect(testCoverageAnalyzer.scoringSystem).toEqual({
      type: 'confidence',
      min: 0,
      max: 100,
      threshold: 70,
    });
    expect(testCoverageAnalyzer.systemPromptAddition).toContain('confidence');
    expect(testCoverageAnalyzer.systemPromptAddition).toContain('0-100');
  });
});
