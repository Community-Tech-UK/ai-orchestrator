import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Instance } from '../../shared/types/instance.types';

const runtime = vi.hoisted(() => ({ getCoordinator: vi.fn() }));
vi.mock('../context-evidence/context-evidence-coordinator', () => ({
  getContextEvidenceCoordinator: runtime.getCoordinator,
}));

import { resolveOrchestratorToolsEvidenceContext } from './orchestrator-tools-evidence-context';

describe('orchestrator-tools instance evidence context', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runtime.getCoordinator.mockReturnValue({ id: 'synthetic-coordinator' });
  });

  it('keeps disabled and missing instance contexts inert without initializing the coordinator', () => {
    expect(resolveOrchestratorToolsEvidenceContext(undefined)).toBeNull();
    expect(resolveOrchestratorToolsEvidenceContext(source())).toBeNull();
    expect(resolveOrchestratorToolsEvidenceContext(source('off'))).toBeNull();
    expect(runtime.getCoordinator).not.toHaveBeenCalled();
  });

  it.each(['shadow', 'enforce'] as const)('retains %s mode when ownership is unresolved', (mode) => {
    const context = resolveOrchestratorToolsEvidenceContext(source(mode));
    expect(context).toMatchObject({ mode, conversationId: null });
    expect(runtime.getCoordinator).toHaveBeenCalledTimes(1);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    'does not send invalid provider capacity %s to evidence capture', (total) => {
      const instance = source('enforce', total);
      instance.contextEvidence!.conversationId = 'synthetic-canonical-conversation';
      const context = resolveOrchestratorToolsEvidenceContext(instance);
      expect(context?.conversationId).toBe('synthetic-canonical-conversation');
      expect(context).not.toHaveProperty('providerWindowTokens');
    },
  );

  it('preserves valid provider capacity for capture budgeting', () => {
    expect(resolveOrchestratorToolsEvidenceContext(source('enforce', 200_000)))
      .toHaveProperty('providerWindowTokens', 200_000);
  });
});

function source(
  mode?: NonNullable<Instance['contextEvidence']>['mode'],
  total = 0,
): Pick<Instance, 'contextEvidence' | 'contextUsage'> {
  return {
    contextEvidence: mode ? { mode, captureFailureCount: 0 } : undefined,
    contextUsage: { used: 0, total, percentage: 0 },
  };
}
