/**
 * WS-C1 Workboard decision timeline — pure projection.
 *
 * Every builder here is a pure function over data already fetched from an
 * existing authoritative store (see `workboard-handlers.ts` for the reads).
 * Nothing in this file persists anything, subscribes to anything, or invents
 * a field a source doesn't actually have. Titles are deliberately plain
 * language, not internal enum values (James's preference — see AGENTS.md
 * "Plain language rule").
 */

import type { OperationalDecision } from '@contracts/schemas/workboard';
import type { LoopRunSummary, LoopStatus } from '../../shared/types/loop.types';
import type { LoopTerminalIntent } from '../../shared/types/loop-state.types';
import type { ProviderLimitEvent } from '../core/system/provider-limit-ledger';
import type { CompactionRecord } from '../context/compaction-epoch';
import type { AutomationRun } from '../../shared/types/automation.types';
import type { AdmissionRecord, AdmissionState } from '../session/session-admission-store';

/** Total entries kept per item, across every source, after merging. */
export const WORKBOARD_DECISIONS_MAX = 20;

function firstLine(text: string, maxChars = 140): string {
  const line = (text.split('\n')[0] ?? '').trim();
  return line.length > maxChars ? `${line.slice(0, maxChars - 1).trimEnd()}…` : line;
}

function providerLabel(provider: string): string {
  return provider.length > 0 ? provider.charAt(0).toUpperCase() + provider.slice(1) : provider;
}

// ---------------------------------------------------------------------------
// Source 1: provider-limit — src/main/core/system/provider-limit-ledger.ts
// (recorded by both src/main/orchestration/loop-provider-limit-handler.ts
// for loop runs and src/main/instance/instance-provider-limit-handler.ts for
// plain instance sessions — both write the same durable ledger row shape,
// keyed by `instanceId`, which holds either a loop run id or an instance id).
// ---------------------------------------------------------------------------

/**
 * One decision per recorded provider-limit event for this item. The event
 * matching `activeEventId` (the ledger's current `getActive()` result, when
 * any) is the one that may carry the resume action — never invented for a
 * historical/expired park.
 */
export function buildProviderLimitDecisions(
  events: readonly ProviderLimitEvent[],
  opts: { activeEventId: string | null; loopRunId?: string; loopResumable: boolean },
): OperationalDecision[] {
  return events.map((event) => {
    const label = providerLabel(event.provider);
    const isActive = opts.activeEventId !== null && event.id === opts.activeEventId;
    const decision: OperationalDecision = {
      id: `pl:${event.id}`,
      at: event.detectedAt,
      source: 'provider-limit',
      title: `Paused: ${label} hit its usage limit`,
      detail: `Recorded via ${event.source}`,
      resultingStatus: 'provider-limit',
      resumeAt: event.resumeAt,
    };
    if (isActive && opts.loopRunId && opts.loopResumable) {
      decision.operatorAction = { kind: 'resume-loop', label: 'Resume now', loopRunId: opts.loopRunId };
    }
    return decision;
  });
}

// ---------------------------------------------------------------------------
// Source 2: loop-gate — src/main/orchestration/loop-store.ts
// (durable `loop_terminal_intents` rows) + the run's own terminal status/
// endReason for a "needs you" outcome not backed by a specific intent.
// ---------------------------------------------------------------------------

const RESOLVED_INTENT_STATUSES = new Set(['accepted', 'rejected']);

function describeTerminalIntent(intent: LoopTerminalIntent): { title: string; resumeAt?: number | null } | null {
  if (!RESOLVED_INTENT_STATUSES.has(intent.status)) return null;
  const accepted = intent.status === 'accepted';
  switch (intent.kind) {
    case 'block':
      return { title: accepted ? 'Needs you — the agent raised a blocker' : 'Blocker dismissed automatically (self-refuted on a liveness check)' };
    case 'complete':
      return { title: accepted ? 'Declared complete' : 'Completion declined — needs another pass' };
    case 'fail':
      return { title: accepted ? 'Agent reported it could not proceed' : 'Failure report dismissed' };
    case 'wakeup':
      return {
        title: accepted ? 'Scheduled to wake up and continue' : 'Scheduled wake-up dismissed',
        resumeAt: intent.resumeAt ?? null,
      };
    default:
      return null;
  }
}

/** Plain-language titles for the loop's final "needs you" outcomes. Loops
 *  that finished cleanly (`completed`), were cancelled by the user, are
 *  still `running`/`paused`, or ended on `provider-limit` (covered by the
 *  provider-limit source instead) intentionally have no entry here. */
const LOOP_FINAL_OUTCOME_TITLES: Partial<Record<LoopStatus, string>> = {
  'completed-needs-review': 'Finished — flagged items for you to check',
  failed: 'Stopped — the run failed',
  error: 'Stopped — hit an error',
  'no-progress': 'Stopped — no progress across recent iterations',
  'cap-reached': 'Stopped — hit its iteration/cost cap without finishing',
  'cost-exceeded': 'Stopped — cost cap hit mid-review',
  'needs-human-arbitration': 'Needs you — builder and reviewer are deadlocked',
  'reviewer-unreliable': 'Needs you — the reviewer kept producing unusable output',
  'reviewer-unavailable': 'Needs you — no reviewer could be reached',
  'builder-unreliable': 'Needs you — the agent keeps declaring done without addressing findings',
};

export function buildLoopGateDecisions(
  intents: readonly LoopTerminalIntent[],
  summary: LoopRunSummary | null,
): OperationalDecision[] {
  const decisions: OperationalDecision[] = [];
  for (const intent of intents) {
    const described = describeTerminalIntent(intent);
    if (!described) continue;
    decisions.push({
      id: `lg:${intent.id}`,
      at: intent.receivedAt,
      source: 'loop-gate',
      title: described.title,
      detail: intent.statusReason ?? firstLine(intent.summary),
      resultingStatus: intent.status,
      resumeAt: described.resumeAt,
    });
  }

  if (summary) {
    const title = LOOP_FINAL_OUTCOME_TITLES[summary.status];
    if (title) {
      decisions.push({
        id: `lg:final:${summary.id}:${summary.endedAt ?? summary.startedAt}`,
        at: summary.endedAt ?? summary.startedAt,
        source: 'loop-gate',
        title,
        detail: summary.endReason ?? undefined,
        resultingStatus: summary.status,
        resumeAt: null,
      });
    }
  }

  return decisions;
}

// ---------------------------------------------------------------------------
// Source 3: compaction — src/main/context/compaction-coordinator.ts
// (in-memory per-instance `CompactionEpochTracker` history; informational
// only — compaction never changes a card's lane by itself).
// ---------------------------------------------------------------------------

export function buildCompactionDecisions(
  records: readonly CompactionRecord[],
  instanceId: string,
): OperationalDecision[] {
  return records.map((record) => ({
    id: `cx:${instanceId}:${record.epochId}`,
    at: record.timestamp,
    source: 'compaction',
    title: `Context compacted after ${record.turnsBeforeCompaction} turn${record.turnsBeforeCompaction === 1 ? '' : 's'}`,
  }));
}

// ---------------------------------------------------------------------------
// Source 4: automation — src/main/automations/automation-store.ts
// (`AutomationRun.attempt`/`maxAttempts`/`error`, the durable retry state).
// No fabricated next-retry time: the scheduler's jittered backoff isn't
// persisted on the run row, so `resumeAt` stays unset rather than guessed.
// ---------------------------------------------------------------------------

export function buildAutomationDecisions(run: AutomationRun | null): OperationalDecision[] {
  if (!run) return [];
  const isRetry = run.attempt > 1;
  const isFailed = run.status === 'failed';
  if (!isRetry && !isFailed) return [];

  const title = isRetry
    ? `Retried automatically — attempt ${run.attempt} of ${run.maxAttempts}`
    : `Automation failed${run.error ? ` — ${firstLine(run.error)}` : ''}`;

  return [{
    id: `am:${run.id}:${run.updatedAt}`,
    at: run.updatedAt,
    source: 'automation',
    title,
    detail: isRetry && run.error ? firstLine(run.error) : undefined,
    resultingStatus: run.status,
  }];
}

// ---------------------------------------------------------------------------
// Source 5: admission — src/main/session/session-admission-store.ts (WS-A1).
// Suppressed/expired/cancelled/failed send-admission rows are themselves
// operator-relevant decisions, not just a queue mechanic.
// ---------------------------------------------------------------------------

const ADMISSION_DECISION_STATES: ReadonlySet<AdmissionState> = new Set([
  'suppressed',
  'expired',
  'cancelled',
  'failed',
]);

function describeAdmission(record: AdmissionRecord): string {
  switch (record.state) {
    case 'suppressed':
      return `Message suppressed (from ${record.origin}) — ${record.suppressReason ?? 'duplicate or stale send'}`;
    case 'expired':
      return `Queued message expired before it could send (from ${record.origin})`;
    case 'cancelled':
      return `Queued message was cancelled (from ${record.origin})`;
    case 'failed':
      return `Send failed (from ${record.origin})${record.errorText ? ` — ${firstLine(record.errorText)}` : ''}`;
    default:
      return `Admission ${record.state} (from ${record.origin})`;
  }
}

export function buildAdmissionDecisions(records: readonly AdmissionRecord[]): OperationalDecision[] {
  return records
    .filter((record) => ADMISSION_DECISION_STATES.has(record.state))
    .map((record) => ({
      id: `ad:${record.admissionId}`,
      at: record.updatedAt,
      source: 'admission',
      title: describeAdmission(record),
      resultingStatus: record.state,
    }));
}

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

/** Flatten every source's decisions, newest first, bounded to the most
 *  recent {@link WORKBOARD_DECISIONS_MAX}. */
export function mergeOperationalDecisions(
  groups: readonly (readonly OperationalDecision[])[],
  max = WORKBOARD_DECISIONS_MAX,
): OperationalDecision[] {
  return groups
    .flat()
    .sort((a, b) => b.at - a.at || a.id.localeCompare(b.id))
    .slice(0, max);
}
