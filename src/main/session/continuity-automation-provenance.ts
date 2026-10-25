import type { ContinuityAutomationProvenance } from './session-continuity.types';

/**
 * Read the automation provenance the runner stamps on `instance.metadata`
 * (automation-runner.ts, automation-hidden-outcome.ts). Undefined for any
 * session that no automation started.
 */
export function automationProvenanceFromMetadata(
  metadata: Record<string, unknown> | undefined,
): ContinuityAutomationProvenance | undefined {
  const automationId = metadata?.['automationId'];
  if (typeof automationId !== 'string' || !automationId.trim()) return undefined;
  const automationRunId = metadata?.['automationRunId'];
  const automationSourceRunId = metadata?.['automationSourceRunId'];
  return {
    automationId,
    ...(typeof automationRunId === 'string' && automationRunId ? { automationRunId } : {}),
    ...(typeof automationSourceRunId === 'string' && automationSourceRunId ? { automationSourceRunId } : {}),
    ...(metadata?.['automationHidden'] === true ? { hidden: true } : {}),
    ...(metadata?.['automationRunSucceeded'] === true ? { runSucceeded: true } : {}),
    ...(metadata?.['automationRevealed'] === true ? { revealed: true } : {}),
  };
}

/**
 * The inverse, so History applies its own automation rules (`isAutomation`,
 * `isHiddenAutomation`) to a session rebuilt from its autosave.
 */
export function automationMetadataFromProvenance(
  provenance: ContinuityAutomationProvenance | undefined,
): Record<string, unknown> {
  if (!provenance?.automationId) return {};
  return {
    automationId: provenance.automationId,
    ...(provenance.automationRunId ? { automationRunId: provenance.automationRunId } : {}),
    ...(provenance.automationSourceRunId ? { automationSourceRunId: provenance.automationSourceRunId } : {}),
    ...(provenance.hidden === true ? { automationHidden: true } : {}),
    ...(provenance.runSucceeded === true ? { automationRunSucceeded: true } : {}),
    ...(provenance.revealed === true ? { automationRevealed: true } : {}),
  };
}
