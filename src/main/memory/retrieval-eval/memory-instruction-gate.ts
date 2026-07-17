/**
 * WS16 — provenance gate for instruction-tier memory use.
 *
 * Agent-derived memories carry no human sign-off, so they must never be
 * injected into system-prompt-tier content (where a model treats them as
 * authoritative instructions). They may only appear inside clearly-labelled
 * ADVISORY blocks. This helper is the single enforcement point: assembly of
 * system-tier content filters candidate memories through `admitToSystemTier`.
 *
 * Gated by the `memoryInstructionGate` setting (default ON). Turning it off
 * is an explicit operator choice that lets agent-derived items reach the
 * system tier — logged, never silent.
 */

import type { LessonProvenance } from '../lesson-store';

export type MemoryTier = 'system' | 'advisory';

export interface ProvenancedMemory {
  id: string;
  provenance: LessonProvenance;
}

/**
 * Whether a memory may be assembled into the given tier. Advisory always
 * admits (it is the labelled, non-authoritative surface). System tier admits
 * only human-trusted provenance when the gate is enabled.
 */
export function admitToTier(
  provenance: LessonProvenance,
  tier: MemoryTier,
  gateEnabled: boolean,
): boolean {
  if (tier === 'advisory') return true;
  if (!gateEnabled) return true; // operator opted out (logged by the caller)
  return provenance === 'user-authored' || provenance === 'imported';
}

/**
 * Filter candidate memories for a target tier. Returns the admitted items and
 * the ids that were blocked (for audit/logging).
 */
export function filterMemoriesForTier<T extends ProvenancedMemory>(
  memories: readonly T[],
  tier: MemoryTier,
  gateEnabled: boolean,
): { admitted: T[]; blocked: string[] } {
  const admitted: T[] = [];
  const blocked: string[] = [];
  for (const memory of memories) {
    if (admitToTier(memory.provenance, tier, gateEnabled)) {
      admitted.push(memory);
    } else {
      blocked.push(memory.id);
    }
  }
  return { admitted, blocked };
}
