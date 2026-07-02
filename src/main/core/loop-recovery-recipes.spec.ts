import { beforeEach, describe, expect, it } from 'vitest';
import { RecoveryActionType } from '../../shared/types/error-recovery.types';
import {
  _resetRecoveryRecipesForTesting,
  clearLoopRecoveryAttempts,
  decideRecoveryRecipe,
  getRecoveryRecipe,
} from './loop-recovery-recipes';

describe('loop-recovery-recipes', () => {
  beforeEach(() => {
    _resetRecoveryRecipesForTesting();
  });

  describe('getRecoveryRecipe (catalog)', () => {
    it('returns undefined for uncatalogued reasons', () => {
      expect(getRecoveryRecipe('auth')).toBeUndefined();
      expect(getRecoveryRecipe('billing')).toBeUndefined();
      expect(getRecoveryRecipe('unknown')).toBeUndefined();
    });

    it('every catalogued recipe has maxAttempts 1 and BLOCKED escalation', () => {
      const reasons = ['provider_runtime', 'context_overflow', 'prompt_delivery', 'tool_runtime', 'session_resume', 'stale_worktree'] as const;
      for (const reason of reasons) {
        const recipe = getRecoveryRecipe(reason);
        expect(recipe, `expected a recipe for ${reason}`).toBeDefined();
        expect(recipe!.maxAttempts).toBe(1);
        expect(recipe!.escalation).toBe('BLOCKED');
        expect(recipe!.steps.length).toBeGreaterThan(0);
        for (const step of recipe!.steps) {
          expect(['safe', 'destructive']).toContain(step.class);
        }
      }
    });

    it('classifies every stale_worktree step correctly: report is safe, reset/rebase is destructive', () => {
      const recipe = getRecoveryRecipe('stale_worktree')!;
      const destructive = recipe.steps.filter(s => s.class === 'destructive');
      const safe = recipe.steps.filter(s => s.class === 'safe');
      expect(safe.length).toBeGreaterThan(0);
      expect(destructive.length).toBeGreaterThan(0);
      for (const step of destructive) {
        expect(step.command).toBeTruthy();
      }
    });
  });

  describe('decideRecoveryRecipe', () => {
    it('falls through to no-recipe for uncatalogued classifications', () => {
      const decision = decideRecoveryRecipe({
        loopRunId: 'loop-1',
        seq: 1,
        reason: 'auth',
        allowDestructiveOps: false,
      });
      expect(decision.kind).toBe('no-recipe');
      expect(decision.recipe).toBeUndefined();
      expect(decision.record.outcome).toBe('no-recipe');
    });

    it('runs a recipe with only safe steps once, then escalates on the second occurrence in the same run', () => {
      const first = decideRecoveryRecipe({
        loopRunId: 'loop-2',
        seq: 1,
        reason: 'provider_runtime',
        allowDestructiveOps: false,
      });
      expect(first.kind).toBe('attempt');
      expect(first.safeSteps.length).toBeGreaterThan(0);
      expect(first.safeSteps.every(s => s.class === 'safe')).toBe(true);
      expect(first.record.attemptNumber).toBe(1);
      expect(first.record.outcome).toBe('attempted');

      const second = decideRecoveryRecipe({
        loopRunId: 'loop-2',
        seq: 2,
        reason: 'provider_runtime',
        allowDestructiveOps: false,
      });
      expect(second.kind).toBe('escalate');
      expect(second.safeSteps).toEqual([]);
      expect(second.record.outcome).toBe('escalated');
    });

    it('tracks attempts independently per loop run', () => {
      const runA = decideRecoveryRecipe({ loopRunId: 'run-a', seq: 1, reason: 'tool_runtime', allowDestructiveOps: false });
      const runB = decideRecoveryRecipe({ loopRunId: 'run-b', seq: 1, reason: 'tool_runtime', allowDestructiveOps: false });
      expect(runA.kind).toBe('attempt');
      expect(runB.kind).toBe('attempt');
    });

    it('tracks attempts independently per reason within the same loop run', () => {
      const first = decideRecoveryRecipe({ loopRunId: 'loop-3', seq: 1, reason: 'tool_runtime', allowDestructiveOps: false });
      const other = decideRecoveryRecipe({ loopRunId: 'loop-3', seq: 2, reason: 'session_resume', allowDestructiveOps: false });
      expect(first.kind).toBe('attempt');
      expect(other.kind).toBe('attempt');
    });

    it('never returns a destructive step as an auto-runnable safe step, even when allowDestructiveOps is true', () => {
      const decision = decideRecoveryRecipe({
        loopRunId: 'loop-4',
        seq: 1,
        reason: 'stale_worktree',
        allowDestructiveOps: true,
      });
      expect(decision.kind).toBe('attempt');
      expect(decision.safeSteps.every(s => s.class === 'safe')).toBe(true);
      expect(decision.proposedDestructiveSteps.length).toBeGreaterThan(0);
      expect(decision.proposedDestructiveSteps.every(s => s.class === 'destructive')).toBe(true);
      // Destructive steps are proposals only — never mixed into safeSteps.
      for (const step of decision.proposedDestructiveSteps) {
        expect(decision.safeSteps).not.toContain(step);
      }
    });

    it('does not propose destructive steps when allowDestructiveOps is false', () => {
      const decision = decideRecoveryRecipe({
        loopRunId: 'loop-5',
        seq: 1,
        reason: 'stale_worktree',
        allowDestructiveOps: false,
      });
      expect(decision.proposedDestructiveSteps).toEqual([]);
    });

    it('emits a structured audit record on every call, including no-recipe and escalate paths', () => {
      const noRecipe = decideRecoveryRecipe({ loopRunId: 'loop-6', seq: 1, reason: 'auth', allowDestructiveOps: false });
      expect(noRecipe.record).toMatchObject({ loopRunId: 'loop-6', seq: 1, reason: 'auth', outcome: 'no-recipe' });

      decideRecoveryRecipe({ loopRunId: 'loop-6', seq: 2, reason: 'session_resume', allowDestructiveOps: false });
      const escalated = decideRecoveryRecipe({ loopRunId: 'loop-6', seq: 3, reason: 'session_resume', allowDestructiveOps: false });
      expect(escalated.record).toMatchObject({ loopRunId: 'loop-6', seq: 3, reason: 'session_resume', outcome: 'escalated' });
      expect(typeof escalated.record.timestamp).toBe('number');
    });

    it('reuses the existing RecoveryActionType taxonomy for step types', () => {
      const recipe = getRecoveryRecipe('provider_runtime')!;
      expect(Object.values(RecoveryActionType)).toContain(recipe.steps[0]!.type);
    });
  });

  describe('clearLoopRecoveryAttempts', () => {
    it('resets the one-attempt gate for a specific loop run so a fresh run can attempt again', () => {
      decideRecoveryRecipe({ loopRunId: 'loop-7', seq: 1, reason: 'tool_runtime', allowDestructiveOps: false });
      clearLoopRecoveryAttempts('loop-7');
      const afterClear = decideRecoveryRecipe({ loopRunId: 'loop-7', seq: 2, reason: 'tool_runtime', allowDestructiveOps: false });
      expect(afterClear.kind).toBe('attempt');
    });
  });
});
