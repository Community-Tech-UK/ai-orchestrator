/**
 * Orchestrator automation MCP tools.
 *
 * The automation-management slice of the orchestrator-tools MCP surface:
 * `create_automation`, `list_automations`, `delete_automation`,
 * `update_automation`, and `postpone_automation`. Extracted from
 * `orchestrator-tools.ts` to keep that file under the LOC ceiling; the schemas
 * and types are re-exported from there so existing import sites stay stable.
 *
 * Every tool defers the actual work to an injected function (wired in
 * `orchestrator-tools-step.ts`) so this module never imports the automation
 * store/scheduler singletons directly.
 */

import { z } from 'zod';
import type { McpServerToolDefinition } from './mcp-server-tools';
import type { SpawnRemoteInstanceMeta } from './orchestrator-tools';

export const CreateAutomationArgsSchema = z
  .object({
    /** Short title for the automation (e.g. "Daily PR review"). */
    name: z.string().min(1).max(200),
    /** The instruction the scheduled agent runs each time it fires. */
    prompt: z.string().min(1).max(100_000),
    /**
     * Standard 5-field cron expression (minute hour day-of-month month
     * day-of-week) for a recurring automation. Provide this OR `runAt`.
     * Examples: daily at 8pm = "0 20 * * *"; weekdays at 9am = "0 9 * * 1-5".
     */
    cron: z.string().min(1).max(200).optional(),
    /** ISO-8601 timestamp for a one-time automation. Provide this OR `cron`. */
    runAt: z.string().min(1).max(100).optional(),
    /** IANA timezone (e.g. "America/New_York"). Defaults to the app's timezone. */
    timezone: z.string().min(1).max(100).optional(),
    /**
     * Absolute working directory the automation runs in. Optional — defaults to
     * the calling chat's project folder.
     */
    workingDirectory: z.string().min(1).max(10_000).optional(),
    /** Optional human-readable description. */
    description: z.string().max(2000).optional(),
    /** CLI provider to run with (defaults to the app default). */
    provider: z.enum(['claude', 'codex', 'gemini', 'antigravity', 'copilot', 'cursor']).optional(),
    /** Whether the automation is active immediately. Defaults to true. */
    enabled: z.boolean().optional(),
  })
  .superRefine((value, ctx) => {
    if (!value.cron?.trim() && !value.runAt?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['cron'],
        message: 'Provide either "cron" (recurring) or "runAt" (one-time ISO-8601 timestamp).',
      });
    }
  });

export type CreateAutomationArgs = z.infer<typeof CreateAutomationArgsSchema>;

export interface CreateAutomationResult {
  id: string;
  name: string;
  /** Human-readable schedule summary, e.g. "cron 0 20 * * * (UTC)". */
  scheduleSummary: string;
  /** Epoch ms of the next scheduled run, or null when disabled/none. */
  nextRunAt: number | null;
  enabled: boolean;
  workingDirectory: string;
}

/**
 * Injected by the parent process (see orchestrator-tools-step.ts). Creates a
 * scheduled automation via the shared create+schedule service. Kept injected so
 * this module never imports the automation store/scheduler singletons directly.
 */
export type CreateAutomationFn = (
  args: CreateAutomationArgs,
  meta?: SpawnRemoteInstanceMeta,
) => Promise<CreateAutomationResult>;

export const ListAutomationsArgsSchema = z.object({}).strict();

export type ListAutomationsArgs = z.infer<typeof ListAutomationsArgsSchema>;

export interface AutomationSummaryToolInfo {
  id: string;
  name: string;
  description?: string;
  scheduleSummary: string;
  enabled: boolean;
  nextRunAt: number | null;
  lastRunAt: number | null;
  workingDirectory: string;
}

export interface ListAutomationsResult {
  count: number;
  automations: AutomationSummaryToolInfo[];
}

export type ListAutomationsFn = () => Promise<ListAutomationsResult>;

/**
 * Shared result shape for the automation-mutation tools (`update_automation`,
 * `postpone_automation`). Mirrors {@link CreateAutomationResult} so an agent
 * gets a consistent confirmation (id, schedule summary, next run) regardless of
 * which mutation it performed.
 */
export interface AutomationMutationResult {
  id: string;
  name: string;
  /** Human-readable schedule summary, e.g. "cron 0 20 * * * (UTC)". */
  scheduleSummary: string;
  /** Epoch ms of the next scheduled run, or null when disabled/none. */
  nextRunAt: number | null;
  enabled: boolean;
  workingDirectory: string;
}

export type UpdateAutomationResult = AutomationMutationResult;
export type PostponeAutomationResult = AutomationMutationResult;

export const DeleteAutomationArgsSchema = z
  .object({
    /** Id of the automation to delete (from list_automations). */
    id: z.string().min(1),
  })
  .strict();

export type DeleteAutomationArgs = z.infer<typeof DeleteAutomationArgsSchema>;

export interface DeleteAutomationResult {
  id: string;
  /** Name of the deleted automation (for confirmation). */
  name: string;
  deleted: true;
  /**
   * Ids of in-flight runs that were detached when the automation was deleted.
   * The runs' instances keep going; they're just no longer tracked as the
   * automation's runs. Empty when nothing was running.
   */
  detachedInstanceIds: string[];
}

/**
 * Injected by the parent process. Permanently deletes an automation and tears
 * down its schedule/retry timers. Kept injected for the same reason as
 * {@link CreateAutomationFn}.
 */
export type DeleteAutomationFn = (
  args: DeleteAutomationArgs,
) => Promise<DeleteAutomationResult>;

export const UpdateAutomationArgsSchema = z
  .object({
    /** Id of the automation to update (from list_automations). */
    id: z.string().min(1),
    /** New title. Omit to leave unchanged. */
    name: z.string().min(1).max(200).optional(),
    /** New instruction the scheduled agent runs each fire. Omit to leave unchanged. */
    prompt: z.string().min(1).max(100_000).optional(),
    /** New human-readable description. Omit to leave unchanged. */
    description: z.string().max(2000).optional(),
    /**
     * New recurring schedule (5-field cron). Provide this OR `runAt`, not both.
     * Omit both to leave the schedule unchanged.
     */
    cron: z.string().min(1).max(200).optional(),
    /** New one-time schedule (ISO-8601). Provide this OR `cron`, not both. */
    runAt: z.string().min(1).max(100).optional(),
    /** New IANA timezone. Omit to keep the existing timezone. */
    timezone: z.string().min(1).max(100).optional(),
    /** New absolute working directory. Omit to leave unchanged. */
    workingDirectory: z.string().min(1).max(10_000).optional(),
    /** New CLI provider. Omit to leave unchanged. */
    provider: z.enum(['claude', 'codex', 'gemini', 'antigravity', 'copilot', 'cursor']).optional(),
    /** New model override for the spawned agent. Omit to leave unchanged. */
    model: z.string().min(1).max(100).optional(),
    /** New reasoning-effort level for the spawned agent. Omit to leave unchanged. */
    reasoningEffort: z
      .enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'workflow'])
      .optional(),
    /** Whether each run executes with auto-approval (yolo) mode. Omit to leave unchanged. */
    yoloMode: z.boolean().optional(),
    /** What to do when a scheduled fire was missed (app/machine asleep). Omit to leave unchanged. */
    missedRunPolicy: z.enum(['skip', 'notify', 'runOnce']).optional(),
    /** What to do when a previous run is still in flight at the next fire. Omit to leave unchanged. */
    concurrencyPolicy: z.enum(['skip', 'queue']).optional(),
    /**
     * Enable (resume) or disable (pause) the automation. Disabling stops it
     * firing without deleting it; enabling resumes the schedule.
     */
    enabled: z.boolean().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.cron?.trim() && value.runAt?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['cron'],
        message: 'Provide either "cron" or "runAt", not both.',
      });
    }
  });

export type UpdateAutomationArgs = z.infer<typeof UpdateAutomationArgsSchema>;

/**
 * Injected by the parent process. Applies a partial update to an existing
 * automation and reschedules it. Kept injected for the same reason as
 * {@link CreateAutomationFn}.
 */
export type UpdateAutomationFn = (
  args: UpdateAutomationArgs,
) => Promise<UpdateAutomationResult>;

export const PostponeAutomationArgsSchema = z
  .object({
    /** Id of the automation to postpone (from list_automations). */
    id: z.string().min(1),
    /**
     * Absolute new next-run time (ISO-8601). Provide this OR `delayMinutes`.
     */
    untilIso: z.string().min(1).max(100).optional(),
    /**
     * Push the next run this many minutes later than its current scheduled
     * time (or later than now, whichever is later). Provide this OR `untilIso`.
     */
    delayMinutes: z.number().int().positive().max(525_600).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const hasUntil = Boolean(value.untilIso?.trim());
    const hasDelay = value.delayMinutes !== undefined;
    if (hasUntil === hasDelay) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['untilIso'],
        message: 'Provide exactly one of "untilIso" or "delayMinutes".',
      });
    }
  });

export type PostponeAutomationArgs = z.infer<typeof PostponeAutomationArgsSchema>;

/**
 * Injected by the parent process. Pushes an automation's next run to a later
 * time (a one-shot delay for recurring automations; a reschedule for one-time
 * ones). Kept injected for the same reason as {@link CreateAutomationFn}.
 */
export type PostponeAutomationFn = (
  args: PostponeAutomationArgs,
) => Promise<PostponeAutomationResult>;

/**
 * Narrow slice of the orchestrator-tool runtime context that the automation
 * tools need. {@link OrchestratorToolRuntimeContext} satisfies it structurally.
 */
export interface AutomationToolContext {
  instanceId?: string | null;
  createAutomation?: CreateAutomationFn | null;
  listAutomations?: ListAutomationsFn | null;
  deleteAutomation?: DeleteAutomationFn | null;
  updateAutomation?: UpdateAutomationFn | null;
  postponeAutomation?: PostponeAutomationFn | null;
}

/**
 * Build the automation-management MCP tool definitions. Spread into the full
 * orchestrator tool list by `createOrchestratorToolDefinitions`.
 */
export function createAutomationToolDefinitions(
  context: AutomationToolContext,
): McpServerToolDefinition[] {
  return [
    {
      name: 'create_automation',
      description:
        'Create a scheduled automation in Harness: a recurring (cron) or one-time prompt that runs an autonomous agent on a schedule. This is the ONLY correct way to schedule or automate anything inside Harness — use it whenever the user asks to "set up an automation", "run this every day/week", "schedule this", "check X every hour", or "remind me to…". Do NOT use a host CLI scheduling skill (e.g. Claude Code\'s /schedule or CronCreate): those create cloud remote agents that run in an isolated sandbox with NO browser and no access to the user\'s logged-in sessions, and the user cannot see or manage them in Harness. Harness automations are different: they run LOCALLY on this machine, and each scheduled run spawns a fresh local agent that inherits the SAME tools as this chat — including the browser gateway to the user\'s real, authenticated Chrome (real cookies). That means an automation CAN read pages/sites the user is logged into, as long as the app and the user\'s browser are running when it fires. Provide a 5-field cron expression for recurring schedules, or an ISO-8601 runAt for a one-time run. The working directory defaults to the current chat\'s project. Returns the created automation\'s id, schedule summary, and next run time.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Short title for the automation.' },
          prompt: {
            type: 'string',
            description: 'The instruction the scheduled agent runs each time it fires.',
          },
          cron: {
            type: 'string',
            description:
              'Standard 5-field cron expression for a recurring schedule (minute hour day-of-month month day-of-week). Provide this OR runAt. E.g. daily at 8pm = "0 20 * * *"; weekdays at 9am = "0 9 * * 1-5".',
          },
          runAt: {
            type: 'string',
            description: 'ISO-8601 timestamp for a one-time automation. Provide this OR cron.',
          },
          timezone: {
            type: 'string',
            description: 'IANA timezone (e.g. "America/New_York"). Defaults to the app timezone.',
          },
          workingDirectory: {
            type: 'string',
            description:
              "Absolute working directory the automation runs in. Optional — defaults to the calling chat's project folder.",
          },
          description: { type: 'string', description: 'Optional human-readable description.' },
          provider: {
            type: 'string',
            enum: ['claude', 'codex', 'gemini', 'antigravity', 'copilot', 'cursor'],
            description: 'CLI provider to run with (defaults to the app default).',
          },
          enabled: {
            type: 'boolean',
            description: 'Whether the automation is active immediately. Defaults to true.',
          },
        },
        required: ['name', 'prompt'],
        additionalProperties: false,
      },
      handler: async (args) => {
        const parsed = CreateAutomationArgsSchema.parse(args);
        if (!context.createAutomation) {
          throw new Error(
            'create_automation is unavailable: automation creation is not wired in this process',
          );
        }
        return context.createAutomation(parsed, {
          callerInstanceId: context.instanceId ?? null,
        });
      },
    },
    {
      name: 'list_automations',
      description:
        'List the scheduled automations configured in Harness, with their schedule, enabled state, next/last run times, and working directory. Read-only. Use this to check what automations already exist before creating or describing them.',
      inputSchema: {
        type: 'object',
        properties: {},
        required: [],
        additionalProperties: false,
      },
      handler: async (args) => {
        ListAutomationsArgsSchema.parse(args);
        if (!context.listAutomations) {
          throw new Error(
            'list_automations is unavailable: automation listing is not wired in this process',
          );
        }
        return context.listAutomations();
      },
    },
    {
      name: 'delete_automation',
      description:
        'Permanently delete a scheduled automation in Harness by its id. Use this when the user asks to "delete", "remove", or "get rid of" an automation. This cannot be undone — the automation and its schedule are removed. Any run currently in flight keeps running but is detached. To temporarily stop an automation without deleting it, use update_automation with enabled:false instead. Call list_automations first to find the id. Returns the deleted automation\'s id and name.',
      inputSchema: {
        type: 'object',
        properties: {
          id: {
            type: 'string',
            description: 'Id of the automation to delete (from list_automations).',
          },
        },
        required: ['id'],
        additionalProperties: false,
      },
      handler: async (args) => {
        const parsed = DeleteAutomationArgsSchema.parse(args);
        if (!context.deleteAutomation) {
          throw new Error(
            'delete_automation is unavailable: automation deletion is not wired in this process',
          );
        }
        return context.deleteAutomation(parsed);
      },
    },
    {
      name: 'update_automation',
      description:
        'Update an existing Harness automation by its id. Use this to change an automation\'s prompt, name, description, schedule (cron or one-time runAt), timezone, working directory, provider, or to pause/resume it (enabled:false disables without deleting, enabled:true resumes). Only the fields you provide change; omit the rest. Provide cron OR runAt (not both) to change the schedule. Call list_automations first to find the id. Returns the updated automation\'s schedule summary and next run time.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Id of the automation to update (from list_automations).' },
          name: { type: 'string', description: 'New title. Omit to leave unchanged.' },
          prompt: {
            type: 'string',
            description: 'New instruction the scheduled agent runs each fire. Omit to leave unchanged.',
          },
          description: { type: 'string', description: 'New human-readable description. Omit to leave unchanged.' },
          cron: {
            type: 'string',
            description:
              'New 5-field cron expression for a recurring schedule. Provide this OR runAt. Omit both to leave the schedule unchanged.',
          },
          runAt: {
            type: 'string',
            description: 'New ISO-8601 timestamp for a one-time schedule. Provide this OR cron.',
          },
          timezone: {
            type: 'string',
            description: 'New IANA timezone (e.g. "America/New_York"). Omit to keep the existing timezone.',
          },
          workingDirectory: {
            type: 'string',
            description: 'New absolute working directory. Omit to leave unchanged.',
          },
          provider: {
            type: 'string',
            enum: ['claude', 'codex', 'gemini', 'antigravity', 'copilot', 'cursor'],
            description: 'New CLI provider. Omit to leave unchanged.',
          },
          model: {
            type: 'string',
            description: 'New model override for the spawned agent. Omit to leave unchanged.',
          },
          reasoningEffort: {
            type: 'string',
            enum: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'workflow'],
            description: 'New reasoning-effort level for the spawned agent. Omit to leave unchanged.',
          },
          yoloMode: {
            type: 'boolean',
            description:
              'Whether each run executes with auto-approval (yolo) mode. Omit to leave unchanged.',
          },
          missedRunPolicy: {
            type: 'string',
            enum: ['skip', 'notify', 'runOnce'],
            description:
              'What to do when a scheduled fire was missed (app/machine asleep). Omit to leave unchanged.',
          },
          concurrencyPolicy: {
            type: 'string',
            enum: ['skip', 'queue'],
            description:
              'What to do when a previous run is still in flight at the next fire. Omit to leave unchanged.',
          },
          enabled: {
            type: 'boolean',
            description:
              'Enable (resume) or disable (pause) the automation without deleting it. Omit to leave unchanged.',
          },
        },
        required: ['id'],
        additionalProperties: false,
      },
      handler: async (args) => {
        const parsed = UpdateAutomationArgsSchema.parse(args);
        if (!context.updateAutomation) {
          throw new Error(
            'update_automation is unavailable: automation updates are not wired in this process',
          );
        }
        return context.updateAutomation(parsed);
      },
    },
    {
      name: 'postpone_automation',
      description:
        'Postpone (delay/snooze) an Harness automation\'s next run to a later time. Use this when the user asks to "postpone", "delay", "snooze", or "push back" an automation. For a one-time automation this reschedules its single run; for a recurring automation it skips ahead to the new time once and then resumes its normal cadence. Provide exactly one of untilIso (an absolute ISO-8601 time) or delayMinutes (relative push). Call list_automations first to find the id. Returns the new next run time.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Id of the automation to postpone (from list_automations).' },
          untilIso: {
            type: 'string',
            description: 'Absolute new next-run time (ISO-8601). Provide this OR delayMinutes.',
          },
          delayMinutes: {
            type: 'integer',
            minimum: 1,
            maximum: 525600,
            description:
              'Push the next run this many minutes later than its current scheduled time (or later than now). Provide this OR untilIso.',
          },
        },
        required: ['id'],
        additionalProperties: false,
      },
      handler: async (args) => {
        const parsed = PostponeAutomationArgsSchema.parse(args);
        if (!context.postponeAutomation) {
          throw new Error(
            'postpone_automation is unavailable: automation postponement is not wired in this process',
          );
        }
        return context.postponeAutomation(parsed);
      },
    },
  ];
}
