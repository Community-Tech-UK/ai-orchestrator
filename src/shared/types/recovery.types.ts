/**
 * Compatibility shim for the legacy recipe-recovery import path.
 *
 * Canonical recovery/failure contracts now live in `error-recovery.types.ts`.
 * Keep this file as a thin re-export layer so existing imports continue to
 * work while load-bearing code migrates to the canonical module.
 */
export type {
  DetectedFailure,
  FailureCategory,
  FailureCategoryDefinition,
  FailureSeverity,
  FailureSeverityForCategory,
  RecoveryAttempt,
  RecoveryOutcome,
  RecoveryRecipe,
} from './error-recovery.types';
export {
  FAILURE_CATEGORY_DEFINITIONS,
  RECOVERY_CONSTANTS,
  classifyDetectedFailure,
  createDetectedFailure,
  getFailureCategoryDefinition,
  normalizeDetectedFailure,
} from './error-recovery.types';
