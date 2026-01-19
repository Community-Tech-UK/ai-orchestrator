/**
 * Agents Module
 * Review agents, specialists, and agent coordination
 */

// Phase 6: Review coordination
export { ReviewCoordinator, getReviewCoordinator } from './review-coordinator';
export type {
  ReviewCoordinatorConfig,
  ReviewResult,
  CoordinatedReviewSummary,
  CoordinatedReview,
} from './review-coordinator';

// Phase 7.3: Specialists
export { SpecialistRegistryManager, getSpecialistRegistry } from './specialists/specialist-registry';

// Re-export specialist types from shared
export type {
  SpecialistRecommendation,
  SpecialistProfile,
  SpecialistInstance,
  SpecialistFinding,
  SpecialistMetrics,
} from '../../shared/types/specialist.types';

// Specialist profiles
export * from './specialists/profiles';
