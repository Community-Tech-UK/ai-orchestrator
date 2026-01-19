/**
 * Skills Module
 * Skill loading, registration, and trigger matching
 */

// Core skill registry
export { SkillRegistry, getSkillRegistry } from './skill-registry';

// Phase 6: Skill loading and matching
export { SkillLoader, getSkillLoader } from './skill-loader';
export type {
  SkillLoadOptions,
  SkillLoadLevel,
} from './skill-loader';

export { TriggerMatcher, getTriggerMatcher } from './trigger-matcher';
export type {
  TriggerMatch,
  TriggerMatchOptions,
} from './trigger-matcher';

// Enhanced skill matching with auto-activation
export { SkillMatcher } from './skill-matcher';
export type {
  SkillMatchContext,
  SkillSuggestion,
  CustomCommand,
  IntentAnalysis,
  AutoActivatePreferences,
} from './skill-matcher';
