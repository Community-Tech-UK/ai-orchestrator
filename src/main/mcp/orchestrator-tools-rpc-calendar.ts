import {
  AccountSchema,
  CalendarListAccountsToolArgsSchema,
  CalendarListCalendarsToolArgsSchema,
  CalendarListEventsToolArgsSchema,
  CalendarStatusToolArgsSchema,
  requireWritableAccountKey,
  type CalendarToolDependencies,
} from './orchestrator-calendar-tools';

export const CALENDAR_TOOL_NAMES = [
  'graph_calendar_connect',
  'graph_calendar_status',
  'graph_calendar_list_accounts',
  'graph_calendar_list_calendars',
  'graph_calendar_list_events',
  'graph_calendar_create_event',
  'graph_calendar_update_event',
  'graph_calendar_delete_event',
] as const;

/** Read-only calendar RPC routes for the server's generic validated dispatch. */
export const CALENDAR_READ_RPC_SPECS = [
  {
    method: 'orchestrator_tools.graph_calendar_status',
    toolName: 'graph_calendar_status',
    schema: CalendarStatusToolArgsSchema,
  },
  {
    method: 'orchestrator_tools.graph_calendar_list_accounts',
    toolName: 'graph_calendar_list_accounts',
    schema: CalendarListAccountsToolArgsSchema,
  },
  {
    method: 'orchestrator_tools.graph_calendar_list_calendars',
    toolName: 'graph_calendar_list_calendars',
    schema: CalendarListCalendarsToolArgsSchema,
  },
  {
    method: 'orchestrator_tools.graph_calendar_list_events',
    toolName: 'graph_calendar_list_events',
    schema: CalendarListEventsToolArgsSchema,
  },
] as const;

/**
 * Extracts and normalizes the `account` field from a raw (not yet
 * schema-validated) mutation payload, using the exact same `AccountSchema`
 * (`z.string().trim()...`) the real handler's own payload schema already
 * applies to this field (orchestrator-calendar-tools.ts). Routing both the
 * LT-192 precondition below and the real handler's account resolution
 * through this one schema means the two normalization rules cannot drift
 * apart — a hand-duplicated `.trim()` here previously did (a
 * whitespace-padded but otherwise valid account was rejected by this
 * precondition while the real, Zod-parsed handler would have accepted it).
 * Returns '' for a missing/invalid account so callers can produce their own
 * "account not connected" style error rather than a raw Zod one.
 */
export function extractRequestedAccount(payload: Record<string, unknown>): string {
  const parsed = AccountSchema.safeParse(payload['account']);
  return parsed.success ? parsed.data : '';
}

/**
 * LT-192: validates a calendar mutation's target account *before* the RPC
 * server requests human approval, so nobody is asked to approve (and no
 * unattended caller blocks on) a mutation that is guaranteed to fail because
 * the account is not connected or not writable. `graph_calendar_connect` is
 * exempt — connecting is how an account is created, so it must run with zero
 * accounts. Kept here (not in the RPC server) so the server does not need
 * direct knowledge of Graph account-resolution internals.
 */
export async function assertCalendarMutationAccountPrecondition(
  calendarTools: CalendarToolDependencies,
  method: string,
  payload: Record<string, unknown>,
): Promise<void> {
  if (method === 'orchestrator_tools.graph_calendar_connect') return;
  await requireWritableAccountKey(calendarTools, extractRequestedAccount(payload));
}

/**
 * Shared RPC dispatch for the four calendar-mutation methods: run the LT-192
 * account precondition, then request human approval, then (only if granted)
 * invoke the same-name tool. Lives here, not in the RPC server, so the
 * dispatcher stays a thin caller with no direct Graph account-resolution
 * knowledge.
 */
export async function dispatchCalendarMutation<M extends string>(
  deps: {
    calendarTools: CalendarToolDependencies;
    authorizeCalendarMutation: (request: { instanceId: string; method: M; payload: Record<string, unknown> }) => Promise<boolean>;
    dispatchSameNameTool: (method: M, params: { instanceId: string; payload: Record<string, unknown> }) => Promise<unknown>;
  },
  instanceId: string,
  method: M,
  payload: Record<string, unknown>,
): Promise<unknown> {
  await assertCalendarMutationAccountPrecondition(deps.calendarTools, method, payload);
  const authorized = await deps.authorizeCalendarMutation({ instanceId, method, payload });
  if (!authorized) throw new Error('calendar_operator_authorization_required');
  return deps.dispatchSameNameTool(method, { instanceId, payload });
}
