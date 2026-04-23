import { getLogger } from '../logging/logger';
import type {
  DetectedFailure,
  FailureCategory,
  FailureSeverity,
  RecoveryAttempt,
  RecoveryOutcome,
  RecoveryRecipe,
} from '../../shared/types/error-recovery.types';
import {
  CheckpointType,
  RECOVERY_CONSTANTS,
  getFailureCategoryDefinition,
  normalizeDetectedFailure,
} from '../../shared/types/error-recovery.types';

const logger = getLogger('RecoveryRecipeEngine');

const { CIRCUIT_BREAKER_MAX_ATTEMPTS, CIRCUIT_BREAKER_WINDOW_MS } = RECOVERY_CONSTANTS;

/** Minimal checkpoint interface required by RecoveryRecipeEngine */
export interface ICheckpointManager {
  createCheckpoint(
    sessionId: string,
    type: CheckpointType,
    description?: string,
  ): Promise<{ id: string } | string | null>;
}

/** Minimal session continuity interface required by RecoveryRecipeEngine */
export interface ISessionContinuityManager {
  resumeSession(identifier: string, options?: Record<string, unknown>): Promise<unknown>;
}

export class RecoveryRecipeEngine {
  private recipes = new Map<FailureCategory, RecoveryRecipe>();
  private attempts = new Map<string, RecoveryAttempt[]>(); // instanceId → history

  constructor(
    private readonly checkpointManager: ICheckpointManager,
    private readonly sessionContinuity: ISessionContinuityManager,
  ) {}

  /** Register a recipe for a failure category */
  registerRecipe(recipe: RecoveryRecipe): void {
    const definition = getFailureCategoryDefinition(recipe.category);
    const normalizedRecipe = this.normalizeRecipeSeverity(recipe, definition.recoverySeverity);

    this.recipes.set(recipe.category, normalizedRecipe);
    logger.info('Registered recovery recipe', {
      category: recipe.category,
      description: recipe.description,
      errorCategory: definition.errorCategory,
    });
  }

  /** Main entry: detect + attempt recovery */
  async handleFailure(failure: DetectedFailure): Promise<RecoveryOutcome> {
    const normalizedFailure = normalizeDetectedFailure(failure);
    if (normalizedFailure.severity !== failure.severity) {
      logger.warn('Detected failure severity did not match canonical definition; normalizing', {
        category: failure.category,
        receivedSeverity: failure.severity,
        canonicalSeverity: normalizedFailure.severity,
        instanceId: failure.instanceId,
      });
    }

    const recipe = this.recipes.get(normalizedFailure.category);
    if (!recipe) {
      logger.warn('No recovery recipe for failure category', {
        category: normalizedFailure.category,
        errorCategory: getFailureCategoryDefinition(normalizedFailure.category).errorCategory,
      });
      return { status: 'escalated', reason: `No recipe registered for ${normalizedFailure.category}` };
    }

    // Global circuit breaker
    if (this.isCircuitBroken(normalizedFailure.instanceId)) {
      logger.warn('Global circuit breaker triggered', { instanceId: normalizedFailure.instanceId });
      return { status: 'escalated', reason: 'Global circuit breaker: too many recovery attempts in 10 minutes' };
    }

    // Per-category exhaustion check
    if (this.isExhausted(normalizedFailure.instanceId, normalizedFailure.category)) {
      logger.warn('Recovery attempts exhausted', {
        instanceId: normalizedFailure.instanceId,
        category: normalizedFailure.category,
      });
      return {
        status: 'escalated',
        reason: `Exhausted ${recipe.maxAutoRetries} retries for ${normalizedFailure.category}`,
      };
    }

    // Cooldown check
    const lastAttempt = this.getLastAttemptForCategory(normalizedFailure.instanceId, normalizedFailure.category);
    if (lastAttempt && recipe.cooldownMs > 0) {
      const elapsed = Date.now() - lastAttempt.attemptedAt;
      if (elapsed < recipe.cooldownMs) {
        const remainingSec = Math.round((recipe.cooldownMs - elapsed) / 1000);
        return { status: 'escalated', reason: `In cooldown: ${remainingSec}s remaining` };
      }
    }

    // Create safety checkpoint before recovery
    let checkpointId = 'none';
    try {
      const result = await this.checkpointManager.createCheckpoint(
        normalizedFailure.instanceId,
        CheckpointType.ERROR_RECOVERY,
        `Pre-recovery: ${normalizedFailure.category}`,
      );
      if (result !== null && result !== undefined) {
        checkpointId = typeof result === 'string' ? result : result.id;
      }
    } catch (err) {
      logger.warn('Failed to create pre-recovery checkpoint', { error: String(err) });
    }

    // Execute recovery recipe
    let outcome: RecoveryOutcome;
    try {
      outcome = await recipe.recover(normalizedFailure);
      logger.info('Recovery recipe executed', {
        category: normalizedFailure.category,
        instanceId: normalizedFailure.instanceId,
        outcome: outcome.status,
      });
    } catch (err) {
      outcome = { status: 'aborted', reason: `Recipe threw: ${String(err)}` };
      logger.error('Recovery recipe threw', undefined, {
        category: normalizedFailure.category,
        error: String(err),
      });
    }

    // Log attempt
    const attempt: RecoveryAttempt = {
      failureId: normalizedFailure.id,
      category: normalizedFailure.category,
      instanceId: normalizedFailure.instanceId,
      attemptedAt: Date.now(),
      outcome,
      checkpointId,
    };

    const history = this.attempts.get(failure.instanceId) ?? [];
    history.push(attempt);
    this.attempts.set(failure.instanceId, history);

    return outcome;
  }

  /** Query recovery history for an instance */
  getAttemptHistory(instanceId: string): RecoveryAttempt[] {
    return this.attempts.get(instanceId) ?? [];
  }

  /** Check if we've exhausted retries for this failure type on this instance */
  isExhausted(instanceId: string, category: FailureCategory): boolean {
    const recipe = this.recipes.get(category);
    if (!recipe) return false;

    const history = this.attempts.get(instanceId) ?? [];
    const categoryAttempts = history.filter(a => a.category === category);
    return categoryAttempts.length >= recipe.maxAutoRetries;
  }

  /** Clear attempt history for an instance (on termination) */
  clearHistory(instanceId: string): void {
    this.attempts.delete(instanceId);
  }

  // --- Private helpers ---

  private isCircuitBroken(instanceId: string): boolean {
    const history = this.attempts.get(instanceId) ?? [];
    const cutoff = Date.now() - CIRCUIT_BREAKER_WINDOW_MS;
    const recentAttempts = history.filter(a => a.attemptedAt > cutoff);
    return recentAttempts.length >= CIRCUIT_BREAKER_MAX_ATTEMPTS;
  }

  private getLastAttemptForCategory(instanceId: string, category: FailureCategory): RecoveryAttempt | null {
    const history = this.attempts.get(instanceId) ?? [];
    const categoryAttempts = history.filter(a => a.category === category);
    return categoryAttempts.length > 0 ? categoryAttempts[categoryAttempts.length - 1] : null;
  }

  private normalizeRecipeSeverity(recipe: RecoveryRecipe, expectedSeverity: FailureSeverity): RecoveryRecipe {
    if (recipe.severity === expectedSeverity) {
      return recipe;
    }

    logger.warn('Recovery recipe severity did not match canonical definition; normalizing', {
      category: recipe.category,
      receivedSeverity: recipe.severity,
      canonicalSeverity: expectedSeverity,
    });

    return {
      ...recipe,
      severity: expectedSeverity,
    };
  }
}
