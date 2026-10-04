import type { Instance } from '../../shared/types/instance.types';
import { getContextEvidenceCoordinator } from '../context-evidence/context-evidence-coordinator';
import type { OrchestratorEvidenceToolContext } from '../mcp/orchestrator-evidence-tools';

/** Preserve enabled enforcement even when canonical ownership is unresolved. */
export function resolveOrchestratorToolsEvidenceContext(
  instance: Pick<Instance, 'contextEvidence' | 'contextUsage'> | undefined,
): Omit<OrchestratorEvidenceToolContext, 'instanceId'> | null {
  const state = instance?.contextEvidence;
  if (!instance || !state || state.mode === 'off') return null;
  const providerWindowTokens = instance.contextUsage.total;
  return {
    coordinator: getContextEvidenceCoordinator(),
    conversationId: state.conversationId ?? null,
    mode: state.mode,
    ...(Number.isSafeInteger(providerWindowTokens) && providerWindowTokens > 0
      ? { providerWindowTokens }
      : {}),
  };
}
