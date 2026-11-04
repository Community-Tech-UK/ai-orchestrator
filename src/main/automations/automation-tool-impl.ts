import { assertBoundedAutomationDestination, verifiedAutomationModel } from './automation-execution-authority';
import { enforceAutomationAuthority, type AutomationCallerAuthority } from './automation-agent-authority';
import { isDeepStrictEqual } from 'node:util';
import { CLAUDE_MODELS } from '../../shared/types/provider.types';
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
import { z } from 'zod';
import {
  AutomationCreatePayloadSchema,
  AutomationUpdatePayloadSchema,
} from '@contracts/schemas/automation';
import { computeNextFireAt } from './automation-schedule';
import { validateCronExpression } from './automation-schedule';
import { findEquivalentAutomation } from './automation-equivalence';
import type { AutomationStore } from './automation-store';
import type { AutomationEventMap } from './automation-events';
import { resolveNewAutomationModelSelection } from '../../shared/automations/new-automation-model-default';

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
  resolveCaller?: (id: string) => AutomationCallerAuthority | undefined;
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


/**
 * LT-031: the MCP write path is the one automation entry point that does NOT
 * validate before writing — the IPC handler runs `AutomationCreatePayloadSchema`
 * / `AutomationUpdatePayloadSchema` first (`automation-handlers.ts`), this one
 * wrote straight to the store. That asymmetry is what let a value save
 * successfully and then fail `AutomationChangedEventSchema`, so
 * `validateRendererEventPayload` dropped the `automation:changed` event and the
 * Automations UI silently kept showing the stale automation.
 *
 * Two field-level instances of that were fixed by hand (`description`,
 * `workingDirectory`). This closes the CLASS: any future MCP arg looser than its
 * entity counterpart now fails loudly here, at the write, instead of silently
 * losing the UI update.
 *
 * Deliberately validates the **mapped input**, not the raw args: the MCP arg
 * shape is flat (`cron`/`runAt`/`workingDirectory`/`prompt`) while the payload
 * shape is nested (`schedule`/`action`), and the mapping above does real work
 * (cron validation, `Date.parse`, defaulting the working directory). Only after
 * that mapping is there a payload-shaped object to check.
 */
function assertWritablePayload(
  schema: z.ZodType,
  value: unknown,
  operation: 'create' | 'update' | 'postpone',
): void {
  const parsed = schema.safeParse(value);
  if (parsed.success) return;
  const detail = parsed.error.issues
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('; ');
  throw new Error(
    `Cannot ${operation} automation: the values are valid as tool arguments but would be `
    + `rejected when the app broadcasts the change, so the UI would silently go stale. ${detail}`,
  );
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
      const caller = meta?.callerInstanceId ? deps.resolveCaller?.(meta.callerInstanceId) : undefined;
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
          ...(meta ? { provider: args.provider } : resolveNewAutomationModelSelection({ provider: args.provider })),
          ...((!args.provider || args.provider === 'claude') && /\b(check|monitor|watch|poll)\b/i.test(`${args.name} ${args.prompt}`)
            && (!meta || verifiedAutomationModel(caller?.provider ?? '', caller?.currentModel)?.tier !== 'fast')
            ? { provider: 'claude' as const, model: CLAUDE_MODELS.SONNET, reasoningEffort: 'low' as const } : {}),
          ...(args.maxRunMinutes !== undefined ? { maxRunMinutes: args.maxRunMinutes } : {}),
          ...(args.maxProcessedTokens !== undefined ? { maxProcessedTokens: args.maxProcessedTokens } : {}),
          ...(args.slowWhenUnchanged !== undefined ? { slowWhenUnchanged: args.slowWhenUnchanged } : {}),
        },
        ...(args.hidden !== undefined ? { hidden: args.hidden } : {}),
      };

      if (meta) input.action = enforceAutomationAuthority(input.action, caller);

      // Idempotency: agents re-issue create_automation for the same recurring
      // check with a reworded name, piling up near-identical shells. If an
      // equivalent active automation already exists (same workspace + schedule +
      // prompt + provider), reuse it so its run history keeps accumulating as one
      // running tally instead of fragmenting across duplicate shells.
      const existing = findEquivalentAutomation(await store.list(), input);
      if (existing) {
        if (meta) {
          const checked = enforceAutomationAuthority(existing.action, meta.callerInstanceId ? deps.resolveCaller?.(meta.callerInstanceId) : undefined);
          assertBoundedAutomationDestination(checked, existing.destination);
          // Pin inherited defaults before acknowledging reuse; never rewrite higher authority silently.
          await store.update(existing.id, { action: checked }, undefined);
        }
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

      assertWritablePayload(AutomationCreatePayloadSchema, input, 'create');

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
    updateAutomation: async (args, meta) => {
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

      const enabled = args.enabled ?? existing.enabled;
      const scheduleChanged = scheduleProvided && !isDeepStrictEqual(schedule, existing.schedule);
      const enabling = enabled && !existing.enabled;
      // Scheduling and policy changes can dispatch the saved instructions just
      // as surely as replacing them. Reductions and disabled edits remain safe.
      const executionTransition = enabled && existing.active && (enabling || scheduleChanged
        || (args.missedRunPolicy === 'runOnce' && existing.missedRunPolicy !== 'runOnce')
        || (args.concurrencyPolicy === 'queue' && existing.concurrencyPolicy !== 'queue'));
      const actionChanged =
        args.maxRunMinutes !== undefined || args.maxProcessedTokens !== undefined || args.slowWhenUnchanged !== undefined ||
        args.prompt !== undefined ||
        args.provider !== undefined ||
        args.model !== undefined ||
        args.reasoningEffort !== undefined ||
        args.yoloMode !== undefined ||
        Boolean(args.workingDirectory?.trim());
      let action = actionChanged || (meta && executionTransition)
        ? {
            ...existing.action,
            ...(args.maxRunMinutes !== undefined ? { maxRunMinutes: args.maxRunMinutes } : {}),
            ...(args.maxProcessedTokens !== undefined ? { maxProcessedTokens: args.maxProcessedTokens } : {}),
            ...(args.slowWhenUnchanged !== undefined ? { slowWhenUnchanged: args.slowWhenUnchanged } : {}),
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

      if (action && !meta) action = { ...action, executionAuthority: undefined };
      if (action && meta) {
        action = enforceAutomationAuthority(action, meta.callerInstanceId ? deps.resolveCaller?.(meta.callerInstanceId) : undefined);
        assertBoundedAutomationDestination(action, existing.destination);
      }
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
        ...(args.hidden !== undefined ? { hidden: args.hidden } : {}),
      };

      const effectiveSchedule = scheduleProvided ? schedule : existing.schedule;
      // Metadata and action edits must not undo a deliberate postponement or
      // monitor backoff by recomputing its next fire from the base cadence.
      const nextFireAt =
        !enabled || !existing.active ? null
          : scheduleChanged || enabling ? computeNextFireAt(effectiveSchedule, now()) : existing.nextFireAt;

      assertWritablePayload(
        AutomationUpdatePayloadSchema.shape.updates,
        updates,
        'update',
      );

      const updated = await store.update(args.id, updates, nextFireAt);
      scheduler.schedule(updated);
      events.emitChanged({ automation: updated, automationId: updated.id, type: 'updated' });
      if (enabled && existing.active && updated.trigger.kind === 'schedule' && (actionChanged || executionTransition)) {
        await deps.handlePastOneTime(updated);
      }
      const fresh = (await store.get(updated.id)) ?? updated;
      return summarizeAutomation(fresh);
    },

    // Backs the `postpone_automation` MCP tool: push the next run to a later
    // time. For one-time automations this rewrites the schedule's runAt; for
    // recurring ones it sets a one-shot next_fire_at (the cron cadence resumes
    // after that fire).
    postponeAutomation: async (args, meta) => {
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

      // An absolute "postpone" time can actually bring work forward or rearm
      // a consumed schedule. A genuine delay preserves the human's authority.
      const action = meta && (existing.nextFireAt === null || newFireAt < existing.nextFireAt)
        ? enforceAutomationAuthority(existing.action, meta.callerInstanceId ? deps.resolveCaller?.(meta.callerInstanceId) : undefined)
        : undefined;
      if (action) assertBoundedAutomationDestination(action, existing.destination);
      let automation: Automation;
      if (existing.schedule.type === 'oneTime') {
        const schedule: AutomationSchedule = {
          type: 'oneTime',
          runAt: newFireAt,
          timezone: existing.schedule.timezone,
        };
        assertWritablePayload(
          AutomationUpdatePayloadSchema.shape.updates,
          { schedule, ...(action ? { action } : {}) },
          'postpone',
        );
        automation = await store.update(args.id, { schedule, ...(action ? { action } : {}) }, newFireAt, currentNow);
      } else if (action) {
        automation = await store.update(args.id, { action }, newFireAt, currentNow);
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
