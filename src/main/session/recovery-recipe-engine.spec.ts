import { describe, it, expect, beforeEach, vi } from 'vitest';
import { RecoveryRecipeEngine } from './recovery-recipe-engine';
import type { DetectedFailure, RecoveryRecipe, RecoveryOutcome } from '../../shared/types/recovery.types';

// Mock CheckpointManager
const mockCheckpointManager = {
  createCheckpoint: vi.fn().mockResolvedValue('checkpoint-123'),
};

// Mock SessionContinuityManager
const mockSessionContinuity = {
  resumeSession: vi.fn().mockResolvedValue(null),
};

function createFailure(overrides: Partial<DetectedFailure> = {}): DetectedFailure {
  return {
    id: `fail-${Date.now()}`,
    category: 'agent_stuck_blocked',
    instanceId: 'inst-1',
    detectedAt: Date.now(),
    context: {},
    severity: 'recoverable',
    ...overrides,
  };
}

function createRecipe(overrides: Partial<RecoveryRecipe> = {}): RecoveryRecipe {
  return {
    category: 'agent_stuck_blocked',
    severity: 'recoverable',
    maxAutoRetries: 2,
    cooldownMs: 0,
    recover: vi.fn().mockResolvedValue({ status: 'recovered', action: 'Sent interrupt' }),
    description: 'Test recipe',
    ...overrides,
  };
}

describe('RecoveryRecipeEngine', () => {
  let engine: RecoveryRecipeEngine;

  beforeEach(() => {
    vi.clearAllMocks();
    engine = new RecoveryRecipeEngine(
      mockCheckpointManager as any,
      mockSessionContinuity as any,
    );
  });

  it('should execute registered recipe for matching failure category', async () => {
    const recipe = createRecipe();
    engine.registerRecipe(recipe);

    const outcome = await engine.handleFailure(createFailure());

    expect(recipe.recover).toHaveBeenCalledOnce();
    expect(outcome.status).toBe('recovered');
  });

  it('should create checkpoint before executing recovery', async () => {
    engine.registerRecipe(createRecipe());

    await engine.handleFailure(createFailure());

    expect(mockCheckpointManager.createCheckpoint).toHaveBeenCalledOnce();
    expect(mockCheckpointManager.createCheckpoint).toHaveBeenCalledWith(
      'inst-1',
      'RECOVERY_ACTION',
      expect.stringContaining('agent_stuck_blocked'),
    );
  });

  it('should escalate when no recipe is registered', async () => {
    const outcome = await engine.handleFailure(createFailure({ category: 'provider_auth_expired' }));

    expect(outcome.status).toBe('escalated');
  });

  it('should escalate after exhausting max retries', async () => {
    const recipe = createRecipe({ maxAutoRetries: 1 });
    engine.registerRecipe(recipe);

    // First attempt succeeds
    await engine.handleFailure(createFailure());
    expect(recipe.recover).toHaveBeenCalledTimes(1);

    // Second attempt: exhausted
    const outcome = await engine.handleFailure(createFailure());
    expect(outcome.status).toBe('escalated');
    expect(recipe.recover).toHaveBeenCalledTimes(1); // Not called again
  });

  it('should respect cooldown between attempts', async () => {
    const recipe = createRecipe({ cooldownMs: 60_000 });
    engine.registerRecipe(recipe);

    // First attempt
    await engine.handleFailure(createFailure());
    expect(recipe.recover).toHaveBeenCalledTimes(1);

    // Immediate second attempt: skipped due to cooldown
    const outcome = await engine.handleFailure(createFailure());
    expect(outcome.status).toBe('escalated');
    expect((outcome as any).reason).toContain('cooldown');
  });

  it('should trigger global circuit breaker after too many attempts', async () => {
    // Register recipes for multiple categories
    engine.registerRecipe(createRecipe({ category: 'agent_stuck_blocked', maxAutoRetries: 3 }));
    engine.registerRecipe(createRecipe({ category: 'process_exited_unexpected', maxAutoRetries: 3 }));
    engine.registerRecipe(createRecipe({ category: 'context_window_exhausted', maxAutoRetries: 3 }));

    // Fire 5 failures rapidly (exceeds circuit breaker threshold)
    for (let i = 0; i < 3; i++) {
      await engine.handleFailure(createFailure({ id: `f-blocked-${i}`, category: 'agent_stuck_blocked' }));
    }
    await engine.handleFailure(createFailure({ id: 'f-exit-1', category: 'process_exited_unexpected' }));
    await engine.handleFailure(createFailure({ id: 'f-exit-2', category: 'process_exited_unexpected' }));

    // 6th attempt should hit circuit breaker
    const outcome = await engine.handleFailure(createFailure({ id: 'f-ctx-1', category: 'context_window_exhausted' }));
    expect(outcome.status).toBe('escalated');
    expect((outcome as any).reason).toContain('circuit breaker');
  });

  it('should track attempt history per instance', async () => {
    engine.registerRecipe(createRecipe());
    await engine.handleFailure(createFailure());

    const history = engine.getAttemptHistory('inst-1');
    expect(history).toHaveLength(1);
    expect(history[0].category).toBe('agent_stuck_blocked');
    expect(history[0].outcome.status).toBe('recovered');
  });

  it('should report exhausted state correctly', async () => {
    engine.registerRecipe(createRecipe({ maxAutoRetries: 1 }));

    expect(engine.isExhausted('inst-1', 'agent_stuck_blocked')).toBe(false);

    await engine.handleFailure(createFailure());
    expect(engine.isExhausted('inst-1', 'agent_stuck_blocked')).toBe(true);
  });
});
