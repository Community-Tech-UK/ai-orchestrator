/**
 * Contracts for `aio-mcp copilot-account` — the READ surface over GitHub
 * Copilot account routing.
 *
 * Read-only by design, and that is a security boundary rather than an
 * oversight. `copilotAccountProfiles` and `copilotAccountRoutingRules` are
 * `PRIVILEGED_CLI_OPERATOR_ONLY_KEYS`: they decide WHICH GitHub identity
 * services a repository, and this CLI cannot tell the operator apart from an
 * agent (`$AIO_MCP` is injected into every agent shell). An agent able to add a
 * profile or move the default could route enterprise code through a personal
 * seat — the exact mistake the routing feature exists to prevent.
 *
 * Inspecting the routing is safe and is the thing that is actually hard to do
 * today, so that is what this exposes. Every result below is field-picked to
 * carry no filesystem path and no token: a Copilot profile HOME must never
 * leave the main process, and unlike the IPC handlers this output can be piped,
 * pasted into a chat, or committed to a log.
 */

import { z } from 'zod';

export const COPILOT_ACCOUNT_CLI_METHODS = {
  list: 'orchestrator_tools.copilot_account.list',
  rules: 'orchestrator_tools.copilot_account.rules',
  route: 'orchestrator_tools.copilot_account.route',
  doctor: 'orchestrator_tools.copilot_account.doctor',
} as const;

export type CopilotAccountCliMethod =
  (typeof COPILOT_ACCOUNT_CLI_METHODS)[keyof typeof COPILOT_ACCOUNT_CLI_METHODS];

export const CopilotAccountCliEmptyPayloadSchema = z.object({}).strict();

export const COPILOT_CLI_ORIGINS = [
  'interactive', 'automation', 'review', 'verification', 'loop',
  'workflow', 'consensus', 'failover', 'internal',
] as const;

export const CopilotAccountCliRoutePayloadSchema = z
  .object({
    workingDirectory: z.string().trim().min(1).max(4096),
    origin: z.enum(COPILOT_CLI_ORIGINS).optional(),
  })
  .strict();

/** No `home`, no token, no path — see the module note. */
export const CopilotAccountCliProfileSchema = z
  .object({
    id: z.string(),
    label: z.string(),
    expectedLogin: z.string().nullable(),
    host: z.string(),
    accountKind: z.string(),
    scopePolicy: z.string(),
    automationPolicy: z.string(),
    isDefault: z.boolean(),
    isLegacy: z.boolean().optional(),
    bindingState: z.string(),
    observedLogin: z.string().optional(),
  })
  .strict();

export const CopilotAccountCliRuleSchema = z
  .object({
    id: z.string(),
    profileId: z.string(),
    kind: z.string(),
    target: z.string(),
    isProtected: z.boolean(),
  })
  .strict();

export const CopilotAccountCliRouteSchema = z
  .object({
    ok: z.boolean(),
    profileId: z.string().nullable(),
    profileLabel: z.string().nullable(),
    /** Why this account was chosen, or why the workspace is blocked. */
    source: z.string().nullable(),
    detail: z.string().nullable(),
    /** Echoed back, because the answer DEPENDS on it: an automation-origin
     *  spawn can be refused by a policy an interactive one never sees. A
     *  preview that hides its assumption is a preview that misleads. */
     origin: z.string(),
  })
  .strict();

export const CopilotAccountCliDoctorSchema = z
  .object({
    aggregate: z.string(),
    nodeId: z.string(),
    legacyMigrationInUse: z.boolean(),
    ambientTokenVariablesPresent: z.array(z.string()),
    unreachableRuleIds: z.array(z.string()),
    conflictingRuleIds: z.array(z.string()),
    warnings: z.array(z.string()),
  })
  .strict();

export const CopilotAccountCliProfileListSchema =
  z.array(CopilotAccountCliProfileSchema).max(200);
export const CopilotAccountCliRuleListSchema = z.array(CopilotAccountCliRuleSchema).max(2_000);

export type CopilotAccountCliProfile = z.infer<typeof CopilotAccountCliProfileSchema>;
export type CopilotAccountCliRule = z.infer<typeof CopilotAccountCliRuleSchema>;
export type CopilotAccountCliRoute = z.infer<typeof CopilotAccountCliRouteSchema>;
export type CopilotAccountCliDoctor = z.infer<typeof CopilotAccountCliDoctorSchema>;

/** Implemented in the app; the CLI only ever calls these four. */
export interface CopilotAccountCliOperations {
  list(): Promise<CopilotAccountCliProfile[]>;
  rules(): Promise<CopilotAccountCliRule[]>;
  route(workingDirectory: string, origin?: string): Promise<CopilotAccountCliRoute>;
  doctor(): Promise<CopilotAccountCliDoctor>;
}
