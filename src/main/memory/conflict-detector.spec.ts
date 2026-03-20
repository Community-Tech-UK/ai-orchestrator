import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ConflictDetector, getConflictDetector } from './conflict-detector';

describe('ConflictDetector', () => {
  beforeEach(() => {
    ConflictDetector._resetForTesting();
  });

  afterEach(() => {
    ConflictDetector._resetForTesting();
  });

  // ============ Singleton ============

  it('returns the same instance via getInstance', () => {
    const a = getConflictDetector();
    const b = getConflictDetector();
    expect(a).toBe(b);
  });

  it('returns a fresh instance after _resetForTesting', () => {
    const a = getConflictDetector();
    ConflictDetector._resetForTesting();
    const b = getConflictDetector();
    expect(a).not.toBe(b);
  });

  // ============ Negation ============

  it('detects direct negation: "X is enabled" vs "X is not enabled"', () => {
    const detector = getConflictDetector();
    const result = detector.heuristicCheck(
      'The feature is not enabled',
      'The feature is enabled'
    );
    expect(result).not.toBeNull();
    expect(result!.type).toBe('negation');
    expect(result!.confidence).toBe(0.85);
    expect(result!.conflictingSegments.newContent).toBe('The feature is not enabled');
    expect(result!.conflictingSegments.existingContent).toBe('The feature is enabled');
  });

  it('detects negation: "cannot" vs "can"', () => {
    const detector = getConflictDetector();
    const result = detector.heuristicCheck(
      'The service cannot connect to the database',
      'The service can connect to the database'
    );
    expect(result).not.toBeNull();
    expect(result!.type).toBe('negation');
  });

  it('detects negation: "does not" vs "does"', () => {
    const detector = getConflictDetector();
    const result = detector.heuristicCheck(
      'The cache does not expire automatically',
      'The cache does expire automatically'
    );
    expect(result).not.toBeNull();
    expect(result!.type).toBe('negation');
  });

  it('detects negation when existing entry contains negation and new does not', () => {
    const detector = getConflictDetector();
    const result = detector.heuristicCheck(
      'Authentication is required',
      'Authentication is not required'
    );
    expect(result).not.toBeNull();
    expect(result!.type).toBe('negation');
  });

  it('detects negation with contracted form: "isn\'t"', () => {
    const detector = getConflictDetector();
    const result = detector.heuristicCheck(
      "The module isn't loaded",
      'The module is loaded'
    );
    expect(result).not.toBeNull();
    expect(result!.type).toBe('negation');
  });

  // ============ Value Change ============

  it('detects numeric value change: "timeout is 30" vs "timeout is 60"', () => {
    const detector = getConflictDetector();
    const result = detector.heuristicCheck(
      'The timeout is 60 seconds',
      'The timeout is 30 seconds'
    );
    expect(result).not.toBeNull();
    expect(result!.type).toBe('value_change');
    expect(result!.confidence).toBe(0.9);
    expect(result!.explanation).toMatch(/timeout/);
    expect(result!.explanation).toMatch(/30/);
    expect(result!.explanation).toMatch(/60/);
  });

  it('detects value change with "=" notation', () => {
    const detector = getConflictDetector();
    const result = detector.heuristicCheck(
      'max_retries = 5',
      'max_retries = 3'
    );
    expect(result).not.toBeNull();
    expect(result!.type).toBe('value_change');
    expect(result!.confidence).toBe(0.9);
  });

  it('detects value change with ":" notation', () => {
    const detector = getConflictDetector();
    const result = detector.heuristicCheck(
      'port: 8080',
      'port: 3000'
    );
    expect(result).not.toBeNull();
    expect(result!.type).toBe('value_change');
    expect(result!.confidence).toBe(0.9);
  });

  it('does not flag identical values as a conflict', () => {
    const detector = getConflictDetector();
    const result = detector.heuristicCheck(
      'The timeout is 30 seconds',
      'The timeout is 30 seconds'
    );
    // Identical values for the same key should not produce a value_change conflict.
    // (May be null, or could trigger another check, but not value_change)
    if (result !== null) {
      expect(result.type).not.toBe('value_change');
    }
  });

  // ============ Antonym ============

  it('detects antonym pair: "cache is enabled" vs "cache is disabled"', () => {
    const detector = getConflictDetector();
    const result = detector.heuristicCheck(
      'The cache is enabled by default',
      'The cache is disabled by default'
    );
    expect(result).not.toBeNull();
    expect(result!.type).toBe('antonym');
    expect(result!.confidence).toBe(0.7);
    expect(result!.explanation).toMatch(/enabled|disabled/);
  });

  it('detects antonym pair: "feature flag is true" vs "feature flag is false"', () => {
    const detector = getConflictDetector();
    const result = detector.heuristicCheck(
      'The feature flag value is true',
      'The feature flag value is false'
    );
    expect(result).not.toBeNull();
    expect(result!.type).toBe('antonym');
  });

  it('does not flag antonyms without shared context (fewer than 2 common significant words)', () => {
    const detector = getConflictDetector();
    // "enabled" and "disabled" appear but there is no shared context
    const result = detector.heuristicCheck(
      'enabled',
      'disabled'
    );
    // No shared context words — should be null
    expect(result).toBeNull();
  });

  // ============ Null / Ambiguous Cases ============

  it('returns null for completely unrelated statements', () => {
    const detector = getConflictDetector();
    const result = detector.heuristicCheck(
      'The sky is blue',
      'The database uses PostgreSQL'
    );
    expect(result).toBeNull();
  });

  it('returns null for compatible (non-conflicting) statements', () => {
    const detector = getConflictDetector();
    const result = detector.heuristicCheck(
      'The API is fast',
      'The API is efficient'
    );
    expect(result).toBeNull();
  });

  it('returns null for empty new content', () => {
    const detector = getConflictDetector();
    const result = detector.heuristicCheck('', 'Some existing content');
    expect(result).toBeNull();
  });

  it('returns null for empty existing content', () => {
    const detector = getConflictDetector();
    const result = detector.heuristicCheck('Some new content', '');
    expect(result).toBeNull();
  });

  it('returns null when both inputs are empty', () => {
    const detector = getConflictDetector();
    const result = detector.heuristicCheck('', '');
    expect(result).toBeNull();
  });

  it('returns null for very short (trivial) inputs', () => {
    const detector = getConflictDetector();
    const result = detector.heuristicCheck('no', 'yes');
    expect(result).toBeNull();
  });

  it('returns null for additive/non-conflicting information', () => {
    const detector = getConflictDetector();
    const result = detector.heuristicCheck(
      'The server supports HTTP/2',
      'The server supports HTTP/1.1'
    );
    expect(result).toBeNull();
  });

  // ============ conflictingSegments ============

  it('preserves original (un-normalized) content in conflictingSegments', () => {
    const detector = getConflictDetector();
    const newContent = 'The   Feature IS NOT enabled.';
    const existingContent = 'The   Feature IS enabled.';
    const result = detector.heuristicCheck(newContent, existingContent);
    expect(result).not.toBeNull();
    expect(result!.conflictingSegments.newContent).toBe(newContent);
    expect(result!.conflictingSegments.existingContent).toBe(existingContent);
  });

  // ============ normalize helper ============

  it('normalize lowercases and collapses whitespace', () => {
    const detector = getConflictDetector();
    expect(detector.normalize('  Hello   World  ')).toBe('hello world');
  });

  it('normalize converts contractions', () => {
    const detector = getConflictDetector();
    expect(detector.normalize("isn't")).toBe('isnt');
    expect(detector.normalize("can't")).toBe('cannot');
    expect(detector.normalize("don't")).toBe('dont');
  });

  // ============ extractSentences helper ============

  it('extractSentences splits on periods and newlines', () => {
    const detector = getConflictDetector();
    const sentences = detector.extractSentences('First sentence. Second sentence\nThird sentence');
    expect(sentences.length).toBe(3);
  });

  it('extractSentences filters trivially short segments', () => {
    const detector = getConflictDetector();
    const sentences = detector.extractSentences('ok. This is a valid sentence.');
    // "ok" is too short (length <= 5) and should be filtered out
    expect(sentences.every(s => s.length > 5)).toBe(true);
  });

  // ============ getSignificantWords helper ============

  it('getSignificantWords filters stop words', () => {
    const detector = getConflictDetector();
    const words = detector.getSignificantWords('the quick brown fox');
    expect(words).not.toContain('the');
    expect(words).toContain('quick');
    expect(words).toContain('brown');
  });

  it('getSignificantWords filters words shorter than 3 chars', () => {
    const detector = getConflictDetector();
    const words = detector.getSignificantWords('go do it now');
    expect(words.every(w => w.length >= 3)).toBe(true);
  });
});
