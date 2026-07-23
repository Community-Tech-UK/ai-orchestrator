/**
 * Skill observability types shared between main and renderer.
 *
 * Mirrors the persistence-layer shapes in
 * `src/main/persistence/rlm/rlm-skill-attribution.ts` and the IPC payloads in
 * `@contracts/schemas/provider` / `@contracts/schemas/observability`.
 */

export type SkillControlMode = 'enabled' | 'suggest-only' | 'disabled';

export type SkillMatchedBy = 'trigger' | 'embedding' | 'explicit';

/** One recorded skill injection/activation. */
export interface SkillActivationRecord {
  id: string;
  skillName: string;
  skillSource: string;
  instanceId: string | null;
  sessionId: string | null;
  turnKey: string | null;
  matchedBy: SkillMatchedBy;
  matchedTrigger: string | null;
  matchScore: number | null;
  tokensInjected: number;
  autoSelected: boolean;
  createdAt: number;
}

/** Persistent per-skill control (kill-switch state). */
export interface SkillControlRecord {
  skillName: string;
  mode: SkillControlMode;
  reason: string | null;
  updatedAt: number;
}

/** Per-skill aggregate served by the health-summary IPC. */
export interface SkillHealthEntry {
  skillName: string;
  totalActivations: number;
  totalTokens: number;
  lastUsedAt: number | null;
  byTrigger: number;
  byEmbedding: number;
  byExplicit: number;
  /**
   * Activations followed by an instance error within the correlation window.
   * Correlation, not causation — always label it that way in UI.
   */
  precededErrors: number;
}
