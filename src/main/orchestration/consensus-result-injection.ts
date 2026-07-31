/**
 * consensus-result-injection.ts
 *
 * Admission-gated consensus_query completion write-back (A5), extracted from
 * OrchestrationHandler. The provider fan-out this follows can take
 * seconds-to-minutes; by the time it settles, the requesting instance may
 * have moved to waiting_for_permission, interrupting, or quota-parked for a
 * reason unrelated to this command. The initial 'dispatching' ack (sent
 * synchronously while the instance's own tool call is still being processed)
 * is NOT gated — that happens inline with the current turn and carries no
 * comparable risk.
 *
 * `injectResponse` itself is synchronous (it only emits 'inject-response';
 * the real adapter-level send happens later, decoupled, in
 * instance-orchestration.ts) so there is no promise to await here — the
 * admission row is marked delivered immediately after the emit as a
 * best-effort signal, not a confirmed adapter ack.
 */

import { getLogger } from '../logging/logger';
import { getSessionAdmissionService, type RedeliveryContext } from '../session/session-admission-service';

const logger = getLogger('OrchestrationHandler');

/** Capabilities this module needs from OrchestrationHandler. */
export interface ConsensusResultInjectionDeps {
  injectResponse(instanceId: string, action: string, success: boolean, data: unknown): void;
}

export function injectConsensusResult(
  deps: ConsensusResultInjectionDeps,
  instanceId: string,
  success: boolean,
  data: Record<string, unknown>,
): void {
  const message = typeof data['message'] === 'string' ? data['message'] : 'Consensus query completed.';
  const outcome = getSessionAdmissionService().admitAutomatedWrite({
    instanceId,
    origin: 'consensus',
    message,
    sourceMetadata: { success, data },
  });
  if (outcome.kind === 'suppressed') {
    logger.warn('Consensus result injection suppressed pending instance readiness', {
      instanceId,
      reason: outcome.reason,
      admissionId: outcome.admissionId,
    });
    return;
  }
  deps.injectResponse(instanceId, 'consensus_query', success, data);
  getSessionAdmissionService().markDelivered(outcome.admissionId);
}

export function handleConsensusRedelivery(
  deps: ConsensusResultInjectionDeps,
  ctx: RedeliveryContext,
): void {
  const meta = ctx.sourceMetadata as { success?: boolean; data?: Record<string, unknown> } | undefined;
  if (!meta?.data) {
    logger.warn('Consensus redelivery missing response payload; dropping', {
      instanceId: ctx.instanceId,
      admissionId: ctx.admissionId,
    });
    return;
  }
  deps.injectResponse(ctx.instanceId, 'consensus_query', Boolean(meta.success), meta.data);
  getSessionAdmissionService().markDelivered(ctx.admissionId);
}
