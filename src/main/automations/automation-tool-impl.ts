/**
 * Implementations backing the automation MCP tools (`create_automation`,
 * `list_automations`, `delete_automation`, `update_automation`,
 * `postpone_automation`).
 *
 * Extracted from `orchestrator-tools-step.ts` so the logic is unit/integration
 * testable against a real in-memory {@link AutomationStore} without booting the
 * RPC server. Dependencies are injected (store/scheduler/runner/events + a few
 * helper fns) so production wires the singletons while tests pass fakes.
 */

import type {
  Automation,
  AutomationSchedule,
  CreateAutomationInput,
  UpdateAutomationInput,
} from '../../shared/types/automation.types';
import type {
  CreateAutomationFn,
  DeleteAutomationFn,
  ListAutomationsFn,
  PostponeAutomationFn,
  UpdateAutomationFn,
  AutomationMutationResult,
} from '../mcp/orchestrator-automation-tools';
import { computeNextFireAt } from './automation-schedule';
import { validateCronExpression } from './automation-schedule';
import { findEquivalentAutomation } from './automation-equivalence';
import type { AutomationStore } from './automation-store';
import type { AutomationEventMap } from './automation-events';

/** Minimal scheduler surface the automation tools depend on. */
export interface AutomationToolScheduler {
  schedule(automation: Automation): void;
  deactivate(automationId: string): void;
}

/** Minimal runner surface the automation tools depend on. */
export interface AutomationToolRunner {
  untrackInstances(instanceIds: string[]): void;
}

/** Minimal events surface the automation tools depend on. */
export interface AutomationToolEvents {
  emitChanged(event: AutomationEventMap['changed']): void;
}

export interface AutomationToolImplDeps {
  store: AutomationStore;
  scheduler: AutomationToolScheduler;
  runner: AutomationToolRunner;
  events: AutomationToolEvents;
  /**
   * Creates an automation via the shared create+schedule service (so events fire
   * and the Automations UI updates live). Production passes
   * `createAutomationWithScheduling`.
   */
  createWithScheduling: (input: CreateAutomationInput) => Promise<Automation | null>;
  /**
   * Settles a now-past one-time automation per its missed-run policy. Production
   * passes `handlePastOneTimeAutomation`.
   */
  handlePastOneTime: (automation: Automation) => Promise<void>;
  /**
   * Resolves the working directory for a caller instance id (used to default the
   * automation's working directory when the agent omits it). Returns undefined
   * when the caller has no project folder.
   */
  resolveWorkingDirectory: (callerInstanceId: string | null) => string | undefined;
  /** Returns the local IANA timezone; defaults to the host timezone. */
  resolveTimezone?: () => string;
  /** Clock injection for deterministic tests. Defaults to `Date.now`. */
  now?: () => number;
}

export interface AutomationToolImplementations {
  createAutomation: CreateAutomationFn;
  listAutomations: ListAutomationsFn;
  deleteAutomation: DeleteAutomationFn;
  updateAutomation: UpdateAutomationFn;
  postponeAutomation: PostponeAutomationFn;
}

function scheduleSummaryOf(schedule: AutomationSchedule): string {
  return schedule.type === 'cron'
    ? `cron ${schedule.expression} (${schedule.timezone})`
    : `once at ${new Date(schedule.runAt).toISOString()}`;
}

/**
 * Build the confirmation summary returned by the automation mutation tools
 * (update/postpone). Mirrors the shape produced by `create_automation` and
 * `list_automations` (enabled = enabled && active) so an agent gets a
 * consistent view regardless of which tool it called.
 */
function summarizeAutomation(automation: Automation): AutomationMutationResult {
  return {
    id: automation.id,
    name: automation.name,
    scheduleSummary: scheduleSummaryOf(automation.schedule),
    nextRunAt: automation.nextFireAt,
    enabled: automation.enabled && automation.active,
    workingDirectory: automation.action.workingDirectory,
  };
}

export function createAutomationToolImplementations(
  deps: AutomationToolImplDeps,
): AutomationToolImplementations {
  const { store, scheduler, runner, events } = deps;
  const now = deps.now ?? ((): number => Date.now());
  const resolveTimezone =
    deps.resolveTimezone ??
    ((): string => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');

  return {
    // Backs the `create_automation` MCP tool: build a CreateAutomationInput from
    // the agent-supplied args and route it through the same create+schedule
    // service the IPC handler uses. Working directory defaults to the calling
    // chat's project when the agent omits it.
    createAutomation: async (args, meta) => {
      const workingDirectory =
        args.workingDirectory?.trim() ||
        deps.resolveWorkingDirectory(meta?.callerInstanceId ?? null)?.trim() ||
        '';
      if (!workingDirectory) {
        throw new Error(
          'create_automation requires a workingDirectory; this session has no project folder set.',
        );
      }
      const timezone = args.timezone?.trim() || resolveTimezone();

      let schedule: AutomationSchedule;
      if (args.cron?.trim()) {
        const expression = args.cron.trim();
        try {
          const next = validateCronExpression(expression, timezone);
          if (!next) {
            throw new Error('no upcoming run time');
          }
        } catch (error) {
          throw new Error(
            `Invalid cron expression "${expression}" (${timezone}): ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
        schedule = { type: 'cron', expression, timezone };
      } else {
        const runAt = Date.parse(args.runAt ?? '');
        if (Number.isNaN(runAt)) {
          throw new Error('runAt must be an ISO-8601 timestamp.');
        }
        schedule = { type: 'oneTime', runAt, timezone };
      }

      const input: CreateAutomationInput = {
        name: args.name,
        description: args.description,
        enabled: args.enabled ?? true,
        schedule,
        concurrencyPolicy: 'skip',
        action: {
          prompt: args.prompt,
          workingDirectory,
          provider: args.provider,
        },
      };

      // Idempotency: agents re-issue create_automation for the same recurring
      // check with a reworded name, piling up near-identical shells. If an
      // equivalent active automation already exists (same workspace + schedule +
      // prompt + provider), reuse it so its run history keeps accumulating as one
      // running tally instead of fragmenting across duplicate shells.
      const existing = findEquivalentAutomation(await store.list(), input);
      if (existing) {
        return {
          id: existing.id,
          name: existing.name,
          scheduleSummary: scheduleSummaryOf(existing.schedule),
          nextRunAt: existing.nextFireAt,
          enabled: existing.enabled,
          workingDirectory: existing.action.workingDirectory,
          reused: true,
        };
      }

      const automation = await deps.createWithScheduling(input);
      if (!automation) {
        throw new Error('Failed to create automation.');
      }
      return {
        id: automation.id,
        name: automation.name,
        scheduleSummary: scheduleSummaryOf(schedule),
        nextRunAt: automation.nextFireAt,
        enabled: automation.enabled,
        workingDirectory,
      };
    },

    // Backs the read-only `list_automations` MCP tool.
    listAutomations: async () => {
      const automations = await store.list();
      return {
        count: automations.length,
        automations: automations.map((a) => ({
          id: a.id,
          name: a.name,
          ...(a.description ? { description: a.description } : {}),
          scheduleSummary: scheduleSummaryOf(a.schedule),
          enabled: a.enabled && a.active,
          nextRunAt: a.nextFireAt,
          lastRunAt: a.lastFiredAt,
          workingDirectory: a.action.workingDirectory,
        })),
      };
    },

    // Backs the `delete_automation` MCP tool: mirror the IPC delete handler
    // (store.delete → untrack runs → deactivate scheduler/retry timers → emit a
    // `deleted` change so the Automations UI updates live).
    deleteAutomation: async (args) => {
      const existing = await store.get(args.id);
      if (!existing) {
        throw new Error(`Automation not found: ${args.id}`);
      }
      const { runningInstanceIds } = await store.delete(args.id);
      runner.untrackInstances(runningInstanceIds);
      scheduler.deactivate(args.id);
      events.emitChanged({ automation: null, automationId: args.id, type: 'deleted' });
      return {
        id: args.id,
        name: existing.name,
        deleted: true,
        detachedInstanceIds: runningInstanceIds,
      };
    },

    // Backs the `update_automation` MCP tool: apply a partial update and
    // reschedule, mirroring the IPC update handler (compute next fire from the
    // effective schedule, persist, reschedule, emit `updated`, then settle any
    // now-past one-time schedule).
    updateAutomation: async (args) => {
      const existing = await store.get(args.id);
      if (!existing) {
        throw new Error(`Automation not found: ${args.id}`);
      }

      const timezone = args.timezone?.trim() || existing.schedule.timezone || resolveTimezone();

      const scheduleProvided = Boolean(
        args.cron?.trim() || args.runAt?.trim() || args.timezone?.trim(),
      );
      let schedule: AutomationSchedule = existing.schedule;
      if (args.cron?.trim()) {
        const expression = args.cron.trim();
        try {
          const next = validateCronExpression(expression, timezone);
          if (!next) {
            throw new Error('no upcoming run time');
          }
        } catch (error) {
          throw new Error(
            `Invalid cron expression "${expression}" (${timezone}): ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
        schedule = { type: 'cron', expression, timezone };
      } else if (args.runAt?.trim()) {
        const runAt = Date.parse(args.runAt);
        if (Number.isNaN(runAt)) {
          throw new Error('runAt must be an ISO-8601 timestamp.');
        }
        schedule = { type: 'oneTime', runAt, timezone };
      } else if (args.timezone?.trim()) {
        // Timezone-only change: keep the same schedule kind/value.
        schedule = { ...existing.schedule, timezone };
      }

      const actionChanged =
        args.prompt !== undefined ||
        args.provider !== undefined ||
        args.model !== undefined ||
        args.reasoningEffort !== undefined ||
        args.yoloMode !== undefined ||
        Boolean(args.workingDirectory?.trim());
      const action = actionChanged
        ? {
            ...existing.action,
            ...(args.prompt !== undefined ? { prompt: args.prompt } : {}),
            ...(args.provider !== undefined ? { provider: args.provider } : {}),
            ...(args.model !== undefined ? { model: args.model } : {}),
            ...(args.reasoningEffort !== undefined
              ? { reasoningEffort: args.reasoningEffort }
              : {}),
            ...(args.yoloMode !== undefined ? { yoloMode: args.yoloMode } : {}),
            ...(args.workingDirectory?.trim()
              ? { workingDirectory: args.workingDirectory.trim() }
              : {}),
          }
        : undefined;

      const updates: UpdateAutomationInput = {
        ...(args.name !== undefined ? { name: args.name } : {}),
        ...(args.description !== undefined ? { description: args.description } : {}),
        ...(args.enabled !== undefined ? { enabled: args.enabled } : {}),
        ...(args.missedRunPolicy !== undefined ? { missedRunPolicy: args.missedRunPolicy } : {}),
        ...(args.concurrencyPolicy !== undefined
          ? { concurrencyPolicy: args.concurrencyPolicy }
          : {}),
        ...(scheduleProvided ? { schedule } : {}),
        ...(action ? { action } : {}),
      };

      const enabled = args.enabled ?? existing.enabled;
      const effectiveSchedule = scheduleProvided ? schedule : existing.schedule;
      const nextFireAt =
        enabled && existing.active ? computeNextFireAt(effectiveSchedule, now()) : null;

      const updated = await store.update(args.id, updates, nextFireAt);
      scheduler.schedule(updated);
      events.emitChanged({ automation: updated, automationId: updated.id, type: 'updated' });
      await deps.handlePastOneTime(updated);
      const fresh = (await store.get(updated.id)) ?? updated;
      return summarizeAutomation(fresh);
    },

    // Backs the `postpone_automation` MCP tool: push the next run to a later
    // time. For one-time automations this rewrites the schedule's runAt; for
    // recurring ones it sets a one-shot next_fire_at (the cron cadence resumes
    // after that fire).
    postponeAutomation: async (args) => {
      const existing = await store.get(args.id);
      if (!existing) {
        throw new Error(`Automation not found: ${args.id}`);
      }
      if (!existing.enabled || !existing.active) {
        throw new Error(
          'Cannot postpone a disabled/inactive automation. Enable it first with update_automation { enabled: true }.',
        );
      }

      const currentNow = now();
      let newFireAt: number;
      if (args.untilIso?.trim()) {
        const parsed = Date.parse(args.untilIso);
        if (Number.isNaN(parsed)) {
          throw new Error('untilIso must be an ISO-8601 timestamp.');
        }
        if (parsed <= currentNow) {
          throw new Error('untilIso must be in the future.');
        }
        newFireAt = parsed;
      } else {
        const base = Math.max(existing.nextFireAt ?? currentNow, currentNow);
        newFireAt = base + (args.delayMinutes ?? 0) * 60_000;
      }

      let automation: Automation;
      if (existing.schedule.type === 'oneTime') {
        const schedule: AutomationSchedule = {
          type: 'oneTime',
          runAt: newFireAt,
          timezone: existing.schedule.timezone,
        };
        automation = await store.update(args.id, { schedule }, newFireAt, currentNow);
      } else {
        store.setNextFireAt(args.id, newFireAt, currentNow);
        const fetched = await store.get(args.id);
        if (!fetched) {
          throw new Error(`Automation disappeared during postpone: ${args.id}`);
        }
        automation = fetched;
      }
      scheduler.schedule(automation);
      events.emitChanged({ automation, automationId: automation.id, type: 'updated' });
      return summarizeAutomation(automation);
    },
  };
}
