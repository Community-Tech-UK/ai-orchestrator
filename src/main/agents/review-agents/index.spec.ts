import { describe, expect, it } from 'vitest';
import { designDriftAnalyzer, getReviewAgentById, testCoverageAnalyzer } from './index';

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

describe('design drift analyzer', () => {
  it('is registered and retrievable by id', () => {
    expect(getReviewAgentById('design-drift-analyzer')).toBe(designDriftAnalyzer);
  });

  it('reports by severity and only targets presentation files', () => {
    expect(designDriftAnalyzer.scoringSystem).toEqual({
      type: 'severity',
      levels: ['high', 'medium', 'low'],
      reportAll: true,
    });
    expect(designDriftAnalyzer.filePatterns).toContain('*.css');
    expect(designDriftAnalyzer.filePatterns).not.toContain('*.ts');
  });

  it('carries the quantified VibeCurb checklist and the AIO-original marker', () => {
    const prompt = designDriftAnalyzer.systemPromptAddition;
    expect(prompt).toContain('800ms');
    expect(prompt).toContain('-0.03em');
    expect(prompt).toContain('Elevate');
    expect(prompt).toContain('transform and opacity');
    expect(prompt).toContain('prefers-reduced-motion');
    // Glassmorphism is NOT on VibeCurb's forbidden list; it must stay marked
    // as an AIO addition so we never misattribute it.
    expect(prompt).toContain('AIO addition (not from VibeCurb)');
  });
});
