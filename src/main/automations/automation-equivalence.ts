/**
 * Idempotency for agent-initiated automation creation.
 *
 * Agents repeatedly call `create_automation` for what is conceptually the *same*
 * recurring check, each time with a slightly reworded name. Because creation is
 * a plain INSERT (see `AutomationStore.create`), that produced piles of
 * near-identical automations in a single workspace: ten "hourly server watch"
 * shells instead of one automation with a running history of hourly runs.
 *
 * One automation is already a running tally: every run hangs off its
 * `automationId` with its own `output_summary`/timestamp. So the fix is to
 * funnel repeat creates into the existing automation rather than to organise the
 * duplicates after the fact. This module computes the equivalence key used by
 * the `create_automation` tool to detect and reuse an existing match.
 *
 * The name is deliberately NOT part of the key: inconsistent agent-generated
 * names are exactly what caused the pile-up.
 */

import type {
  Automation,
  AutomationAction,
  AutomationSchedule,
  CreateAutomationInput,
} from '../../shared/types/automation.types';
import { toWorkspaceId } from '../../shared/utils/workspace-key';

function scheduleKey(schedule: AutomationSchedule): string {
  return schedule.type === 'cron'
    ? `cron|${schedule.expression}|${schedule.timezone}`
    : `once|${schedule.runAt}|${schedule.timezone ?? ''}`;
}

/**
 * Strict equivalence key: workspace + schedule + exact prompt + provider. More
 * fields in the key means fewer false merges; we start strict and only loosen
 * (e.g. to semantic prompt matching) if agents keep varying the prompt text.
 *
 * Encoded with JSON.stringify so no field-separator character can collide with
 * content inside a field (prompts are arbitrary text).
 */
export function automationEquivalenceKey(
  workspaceId: string,
  schedule: AutomationSchedule,
  action: Pick<AutomationAction, 'prompt' | 'provider'>,
): string {
  return JSON.stringify([
    workspaceId,
    scheduleKey(schedule),
    (action.prompt ?? '').trim(),
    action.provider ?? '',
  ]);
}

/**
 * Find an existing active, schedule-triggered automation equivalent to `input`,
 * or `null` when none matches. On a tie the earliest-created automation wins so
 * the keeper (and its accumulated run history) is stable across repeat creates.
 *
 * Webhook-triggered inputs never dedupe: they are route-scoped and legitimately
 * distinct even with an identical prompt.
 */
export function findEquivalentAutomation(
  candidates: readonly Automation[],
  input: CreateAutomationInput,
): Automation | null {
  if (input.trigger && input.trigger.kind !== 'schedule') {
    return null;
  }
  const targetKey = automationEquivalenceKey(
    toWorkspaceId(input.action.workingDirectory),
    input.schedule,
    input.action,
  );
  let keeper: Automation | null = null;
  for (const candidate of candidates) {
    if (!candidate.active || candidate.trigger.kind !== 'schedule') {
      continue;
    }
    const key = automationEquivalenceKey(
      candidate.workspaceId,
      candidate.schedule,
      candidate.action,
    );
    if (key !== targetKey) {
      continue;
    }
    if (
      keeper === null ||
      candidate.createdAt < keeper.createdAt ||
      (candidate.createdAt === keeper.createdAt && candidate.id < keeper.id)
    ) {
      keeper = candidate;
    }
  }
  return keeper;
}
