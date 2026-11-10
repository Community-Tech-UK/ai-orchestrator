import { writeFileSync } from 'node:fs';

/**
 * The module stand-ins every `plan-queue-coordinator*.spec.ts` file installs, and the switches tests flip.
 * This file imports none of the modules it replaces, so a spec can load it from inside `vi.mock`:
 *
 *   vi.mock('./plan-queue-landing', async (original) =>
 *     (await import('./plan-queue-coordinator.test-mocks')).withLandingHooks(await original()));
 */

type GateReceipts = typeof import('./plan-queue-gate-receipts');
type Landing = typeof import('./plan-queue-landing');
type WorktreeIntegration = typeof import('../workspace/git/worktree-integration');

export const machineGates = { failItem: false, timeOutItem: false };

// These repositories exercise Git and session ownership. Command execution is
// controlled here; the gate runner has its own execution and receipt coverage.
export function withScriptedGates(actual: GateReceipts): GateReceipts {
  return { ...actual, PlanQueueGateRunner: class extends actual.PlanQueueGateRunner {
    constructor() { super(async (_command, cwd) => machineGates.timeOutItem && cwd.includes('/queue/')
      ? { exitCode: 1, output: '', timedOut: true }
      : machineGates.failItem && cwd.includes('/queue/')
      ? { exitCode: 1, output: 'src/feature.ts(1,1): error TS2322: New failure', timedOut: false }
      : { exitCode: 0, output: '✓ 1 files · 1 tests passed in 0s', timedOut: false }); }
  } };
}

export const landing = { active: 0, max: 0, hang: false, hung: false, hangPromotion: false, hookTimeout: false, conflict: false, baseMovesOnce: null as (() => void) | null, mergeCheckTimeout: false, mergeChecks: 0 };

export function withLandingHooks(actual: Landing): Landing {
  return {
    ...actual,
    runPostMergeGate: (...args: Parameters<typeof actual.runPostMergeGate>) => {
      landing.mergeChecks += 1;
      if (landing.mergeCheckTimeout) writeFileSync(`${args[1]}/left-by-killed-check.txt`, 'partial\n');
      return landing.mergeCheckTimeout
        ? Promise.resolve({ ok: false as const, command: 'npm run typecheck:spec', output: '', timedOut: true }) : actual.runPostMergeGate(...args);
    },
    landItemBranch: async (...args: Parameters<typeof actual.landItemBranch>) => {
      if (landing.hang) {
        landing.hung = true;
        return new Promise<never>(() => undefined);
      }
      if (landing.conflict) return { status: 'conflict' as const, conflictFiles: ['shared.txt'] };
      if (landing.baseMovesOnce) {
        const move = landing.baseMovesOnce;
        landing.baseMovesOnce = null;
        move();
        return { status: 'conflict' as const, conflictFiles: ['shared.txt'] };
      }
      if (landing.hookTimeout) {
        return { status: 'hook-failed' as const, output: '[plan queue] the pre-commit hook timed out after 3600000ms', timedOut: true };
      }
      landing.active += 1;
      landing.max = Math.max(landing.max, landing.active);
      try {
        return await actual.landItemBranch(...args);
      } finally {
        landing.active -= 1;
      }
    },
  };
}

// A crash after the landing commit was built and recorded, before it reached the base branch.
export function withPromotionHook(actual: WorktreeIntegration): WorktreeIntegration {
  return {
    ...actual,
    promoteIntegrationBranch: async (...args: Parameters<typeof actual.promoteIntegrationBranch>) => {
      if (landing.hangPromotion) {
        landing.hung = true;
        return new Promise<never>(() => undefined);
      }
      return actual.promoteIntegrationBranch(...args);
    },
  };
}
