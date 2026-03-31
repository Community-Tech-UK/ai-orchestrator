import { describe, it, expect, beforeEach } from 'vitest';
import { ChildErrorClassifier } from '../child-error-classifier';

describe('ChildErrorClassifier', () => {
  let classifier: ChildErrorClassifier;

  beforeEach(() => {
    ChildErrorClassifier._resetForTesting();
    classifier = ChildErrorClassifier.getInstance();
  });

  it('classifies timeout errors', () => {
    const result = classifier.classify('Operation timed out after 30000ms', 'busy');
    expect(result.category).toBe('timeout');
    expect(result.retryable).toBe(true);
    expect(result.suggestedAction).toBe('retry');
  });

  it('classifies context overflow', () => {
    const result = classifier.classify('context_length_exceeded: token limit reached', 'busy');
    expect(result.category).toBe('context_overflow');
    expect(result.retryable).toBe(true);
    expect(result.suggestedAction).toBe('retry_different_model');
  });

  it('classifies process crashes', () => {
    const result = classifier.classify('Process exited with code 1', 'busy');
    expect(result.category).toBe('process_crash');
    expect(result.retryable).toBe(true);
    expect(result.suggestedAction).toBe('retry');
  });

  it('classifies rate limiting', () => {
    const result = classifier.classify('429 Too Many Requests', 'busy');
    expect(result.category).toBe('rate_limited');
    expect(result.retryable).toBe(true);
    expect(result.suggestedAction).toBe('retry_different_provider');
  });

  it('classifies auth failures as non-retryable', () => {
    const result = classifier.classify('401 Unauthorized: Invalid API key', 'error');
    expect(result.category).toBe('auth_failure');
    expect(result.retryable).toBe(false);
    expect(result.suggestedAction).toBe('escalate_to_user');
  });

  it('classifies network errors', () => {
    const result = classifier.classify('ECONNREFUSED: connect ECONNREFUSED 127.0.0.1:443', 'error');
    expect(result.category).toBe('network_error');
    expect(result.retryable).toBe(true);
    expect(result.suggestedAction).toBe('retry');
  });

  it('classifies stuck instances', () => {
    const result = classifier.classify('Instance detected as stuck', 'busy', true);
    expect(result.category).toBe('stuck');
    expect(result.retryable).toBe(true);
    expect(result.suggestedAction).toBe('retry');
  });

  it('classifies task-reported failures', () => {
    const result = classifier.classify('Task failed: tests did not pass', 'idle');
    expect(result.category).toBe('task_failure');
    expect(result.retryable).toBe(true);
    expect(result.suggestedAction).toBe('retry');
  });

  it('classifies unknown errors', () => {
    const result = classifier.classify('some random gibberish xyz', 'error');
    expect(result.category).toBe('unknown');
    expect(result.retryable).toBe(false);
    expect(result.suggestedAction).toBe('escalate_to_user');
  });
});
