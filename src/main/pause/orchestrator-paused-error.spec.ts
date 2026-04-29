import { describe, expect, it } from 'vitest';
import { OrchestratorPausedError, isOrchestratorPausedError } from './orchestrator-paused-error';

describe('OrchestratorPausedError', () => {
  it('extends Error and carries the message', () => {
    const error = new OrchestratorPausedError('blocked');

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('blocked');
    expect(error.name).toBe('OrchestratorPausedError');
    expect(error.code).toBe('ORCHESTRATOR_PAUSED');
  });

  it('is detectable via isOrchestratorPausedError', () => {
    expect(isOrchestratorPausedError(new OrchestratorPausedError('paused'))).toBe(true);
    expect(isOrchestratorPausedError(new Error('paused'))).toBe(false);
    expect(isOrchestratorPausedError('paused')).toBe(false);
    expect(isOrchestratorPausedError(null)).toBe(false);
  });

  it('carries hostname when provided', () => {
    const error = new OrchestratorPausedError('blocked', { hostname: 'api.anthropic.com' });

    expect(error.hostname).toBe('api.anthropic.com');
  });
});
