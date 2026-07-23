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

// The orphaned SkillMatcher/TriggerMatcher pair was deleted 2026-07-23 (spec
// decision D3a): its blocklist/suggest-only/min-confidence concepts now live
// on the REAL selection path — SkillAttributionService controls honoured by
// SkillsLoader.detectRelevantSkills, and the min-confidence trigger gate.
export {
  SkillAttributionService,
  getSkillAttribution,
} from './skill-attribution-service';
