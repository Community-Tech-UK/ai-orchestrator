/**
 * What `plan_queue_status` adds with `evidence: true`: the words the Plan Queue page shows for a run, each job's
 * commits and check receipts, and the run's stored timeline. This lets an agent check a run for itself, finished ones
 * included, without reading the database or asking James to look.
 */

import type { PlanQueueItemDto, PlanQueueRunDto } from '@contracts/schemas/plan-queue';
import { planQueueCheckGroupLabel, planQueueChecksLabel, planQueueDocumentLabel } from '../../shared/utils/plan-queue-item-display';
import { planQueueStageLine } from '../../shared/utils/plan-queue-stage-text';
import type { PlanQueueItemEvent } from './plan-queue-history-store';

/** Newest events kept; a long run's reply must still fit in one tool result. */
export const PLAN_QUEUE_EVIDENCE_EVENT_LIMIT = 500;

function itemEvidence(item: PlanQueueItemDto, now: number) {
  const step = planQueueStageLine(item, now);
  const checkedTogether = planQueueCheckGroupLabel(item);
  return {
    itemId: item.id,
    document: planQueueDocumentLabel(item.documentPath),
    onPage: {
      ...(step ? { step: step.text, stepHint: step.hint } : {}),
      ...(checkedTogether ? { checkedTogether } : {}),
    },
    baseCommit: item.baseCommit,
    checkpointCommit: item.checkpointCommit,
    landedCommit: item.landedCommit,
    // The output tail is the only long field, and each member of a group would repeat it.
    receipts: (item.verdict?.gatesRun ?? []).map(({ tail: _tail, ...receipt }) => receipt),
  };
}

/** `events` come newest first and may hold one more than the limit, which is how a shortened timeline is noticed. */
export function describeRunEvidence(run: PlanQueueRunDto, events: readonly PlanQueueItemEvent[], now: number) {
  const documents = new Map(run.items.map(item => [item.id, planQueueDocumentLabel(item.documentPath)]));
  const checks = planQueueChecksLabel(run.checks);
  return {
    startedAt: new Date(run.startedAt).toISOString(),
    endedAt: run.endedAt === null ? null : new Date(run.endedAt).toISOString(),
    settings: {
      workerSlots: run.config.workerSlots,
      verificationSlots: run.config.verificationSlots,
      checkBatchSize: run.config.checkBatchSize,
      maxRounds: run.config.maxRounds,
      verifierGates: run.config.verifierGates,
      postMergeGate: run.config.postMergeGate,
    },
    onPage: checks ? { checks } : {},
    items: run.items.map(item => itemEvidence(item, now)),
    timeline: events.slice(0, PLAN_QUEUE_EVIDENCE_EVENT_LIMIT).reverse().map(event => ({
      at: new Date(event.at).toISOString(),
      document: documents.get(event.itemId) ?? event.itemId,
      from: event.fromState,
      to: event.toState,
      round: event.round,
      ...(event.reason ? { reason: event.reason } : {}),
      ...(event.detailHead ? { detail: event.detailHead } : {}),
    })),
    ...(events.length > PLAN_QUEUE_EVIDENCE_EVENT_LIMIT ? { earlierEventsLeftOut: true } : {}),
  };
}
