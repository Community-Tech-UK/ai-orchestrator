import { describe, expect, it } from 'vitest';
import {
  ErrorCategory,
  ErrorSeverity,
  classifyDetectedFailure,
  createDetectedFailure,
  getFailureCategoryDefinition,
  normalizeDetectedFailure,
} from './error-recovery.types';

describe('error-recovery failure bridge', () => {
  it('derives canonical severity when creating a detected failure', () => {
    const failure = createDetectedFailure({
      id: 'fail-1',
      category: 'agent_stuck_waiting',
      instanceId: 'inst-1',
      detectedAt: 123,
      context: {},
    });

    expect(failure.severity).toBe('degraded');
  });

  it('normalizes inconsistent detected failures back to the canonical severity', () => {
    const normalized = normalizeDetectedFailure({
      id: 'fail-2',
      category: 'provider_auth_expired',
      instanceId: 'inst-2',
      detectedAt: 456,
      context: {},
      severity: 'recoverable',
    } as never);

    expect(normalized.severity).toBe('fatal');
  });

  it('maps recipe-level failures onto the canonical classified-error model', () => {
    const failure = createDetectedFailure({
      id: 'fail-3',
      category: 'context_window_exhausted',
      instanceId: 'inst-3',
      detectedAt: 789,
      context: { message: 'Exceeded token budget' },
    });

    const classified = classifyDetectedFailure(failure, 'idle-monitor', { laneId: 'lane-1' });
    const definition = getFailureCategoryDefinition('context_window_exhausted');

    expect(classified.category).toBe(ErrorCategory.RESOURCE);
    expect(classified.severity).toBe(ErrorSeverity.WARNING);
    expect(classified.recoverable).toBe(true);
    expect(classified.userMessage).toBe(definition.defaultUserMessage);
    expect(classified.technicalDetails).toBe('Exceeded token budget');
    expect(classified.metadata).toMatchObject({
      failureCategory: 'context_window_exhausted',
      instanceId: 'inst-3',
      laneId: 'lane-1',
    });
  });
});
