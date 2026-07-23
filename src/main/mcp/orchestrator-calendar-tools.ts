import { z } from 'zod';
import type { McpServerToolDefinition } from './mcp-server-tools';

const DEFAULT_WRITABLE_ACCOUNT_EMAILS = ['james@communitytech.co.uk'];
const AccountSchema = z.string().trim().min(1).max(320);
const CalendarIdSchema = z.string().trim().min(1).max(512);
const EventIdSchema = z.string().trim().min(1).max(512);
const CalendarWindowDateTimeSchema = z.string().datetime({ offset: true });
const GraphEventDateTimeValueSchema = z.string().regex(
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?$/,
  'Expected a Microsoft Graph local date-time without an offset',
);
const DateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD date');

const EventDateTimeSchema = z.object({
  dateTime: GraphEventDateTimeValueSchema,
  timeZone: z.string().trim().min(1).max(128),
}).strict();

const RecurrencePatternSchema = z.object({
  type: z.enum(['daily', 'weekly', 'absoluteMonthly', 'relativeMonthly', 'absoluteYearly', 'relativeYearly']),
  interval: z.number().int().min(1).max(366),
  month: z.number().int().min(1).max(12).optional(),
  dayOfMonth: z.number().int().min(1).max(31).optional(),
  daysOfWeek: z.array(z.enum(['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'])).min(1).max(7).optional(),
  firstDayOfWeek: z.enum(['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']).optional(),
  index: z.enum(['first', 'second', 'third', 'fourth', 'last']).optional(),
}).strict().superRefine((value, ctx) => {
  const requiredByType = {
    daily: [],
    weekly: ['daysOfWeek', 'firstDayOfWeek'],
    absoluteMonthly: ['dayOfMonth'],
    relativeMonthly: ['daysOfWeek'],
    absoluteYearly: ['dayOfMonth', 'month'],
    relativeYearly: ['daysOfWeek', 'month'],
  } satisfies Record<typeof value.type, (keyof typeof value)[]>;
  for (const field of requiredByType[value.type]) {
    if (value[field] === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [field],
        message: `${field} is required for ${value.type} recurrence`,
      });
    }
  }
  const allowedByType: Record<typeof value.type, ReadonlySet<string>> = {
    daily: new Set<string>(),
    weekly: new Set<string>(['daysOfWeek', 'firstDayOfWeek']),
    absoluteMonthly: new Set<string>(['dayOfMonth']),
    relativeMonthly: new Set<string>(['daysOfWeek', 'index']),
    absoluteYearly: new Set<string>(['dayOfMonth', 'month']),
    relativeYearly: new Set<string>(['daysOfWeek', 'index', 'month']),
  };
  const optionalFields = [
    'month',
    'dayOfMonth',
    'daysOfWeek',
    'firstDayOfWeek',
    'index',
  ] as const;
  for (const field of optionalFields) {
    if (value[field] !== undefined && !allowedByType[value.type].has(field)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [field],
        message: `${field} is not supported for ${value.type} recurrence`,
      });
    }
  }
});

const RecurrenceRangeSchema = z.object({
  type: z.enum(['endDate', 'noEnd', 'numbered']),
  startDate: DateSchema,
  endDate: DateSchema.optional(),
  numberOfOccurrences: z.number().int().min(1).max(10_000).optional(),
  recurrenceTimeZone: z.string().trim().min(1).max(128).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.type === 'endDate' && !value.endDate) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['endDate'], message: 'endDate is required for endDate recurrence' });
  }
  if (value.type === 'numbered' && value.numberOfOccurrences === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['numberOfOccurrences'], message: 'numberOfOccurrences is required for numbered recurrence' });
  }
});

const RecurrenceSchema = z.object({
  pattern: RecurrencePatternSchema,
  range: RecurrenceRangeSchema,
}).strict();

const AttendeeSchema = z.object({
  emailAddress: z.object({
    address: z.string().trim().email().max(320),
    name: z.string().trim().min(1).max(256).optional(),
  }).strict(),
  type: z.enum(['required', 'optional', 'resource']).optional(),
}).strict();

const EventFieldsSchema = z.object({
  subject: z.string().trim().min(1).max(255).optional(),
  body: z.object({
    contentType: z.enum(['text', 'html']),
    content: z.string().max(100_000),
  }).strict().optional(),
  start: EventDateTimeSchema.optional(),
  end: EventDateTimeSchema.optional(),
  location: z.object({ displayName: z.string().trim().max(512) }).strict().optional(),
  attendees: z.array(AttendeeSchema).max(100).optional(),
  recurrence: RecurrenceSchema.optional(),
  isAllDay: z.boolean().optional(),
}).strict();

export const CalendarConnectToolArgsSchema = z.object({}).strict();
export const CalendarStatusToolArgsSchema = z.object({}).strict();
export const CalendarListAccountsToolArgsSchema = z.object({}).strict();
export const CalendarListCalendarsToolArgsSchema = z.object({
  account: AccountSchema,
}).strict();
export const CalendarListEventsToolArgsSchema = z.object({
  account: AccountSchema,
  calendarId: CalendarIdSchema.optional(),
  start: CalendarWindowDateTimeSchema,
  end: CalendarWindowDateTimeSchema,
  top: z.number().int().min(1).max(100).optional(),
  filter: z.string().trim().min(1).max(2_000).optional(),
  search: z.string().trim().min(1).max(512).optional(),
}).strict();
export const CalendarCreateEventToolArgsSchema = z.object({
  account: AccountSchema,
  calendarId: CalendarIdSchema.optional(),
  ...EventFieldsSchema.shape,
  subject: z.string().trim().min(1).max(255),
  start: EventDateTimeSchema,
  end: EventDateTimeSchema,
}).strict().superRefine(validateRecurrenceStart);
export const CalendarUpdateEventToolArgsSchema = z.object({
  account: AccountSchema,
  calendarId: CalendarIdSchema.optional(),
  eventId: EventIdSchema,
  ...EventFieldsSchema.shape,
}).strict().refine((value) => Object.keys(eventFields(value)).length > 0, {
  message: 'At least one event field is required for an update',
}).superRefine(validateRecurrenceStart);
export const CalendarDeleteEventToolArgsSchema = z.object({
  account: AccountSchema,
  calendarId: CalendarIdSchema.optional(),
  eventId: EventIdSchema,
}).strict();

export type CalendarConnectToolArgs = z.infer<typeof CalendarConnectToolArgsSchema>;
export type CalendarStatusToolArgs = z.infer<typeof CalendarStatusToolArgsSchema>;
export type CalendarListAccountsToolArgs = z.infer<typeof CalendarListAccountsToolArgsSchema>;
export type CalendarListCalendarsToolArgs = z.infer<typeof CalendarListCalendarsToolArgsSchema>;
export type CalendarListEventsToolArgs = z.infer<typeof CalendarListEventsToolArgsSchema>;
export type CalendarCreateEventToolArgs = z.infer<typeof CalendarCreateEventToolArgsSchema>;
export type CalendarUpdateEventToolArgs = z.infer<typeof CalendarUpdateEventToolArgsSchema>;
export type CalendarDeleteEventToolArgs = z.infer<typeof CalendarDeleteEventToolArgsSchema>;

export interface CalendarAccount {
  accountKey: string;
  username: string;
  tenant?: string;
  tokenStatus?: string;
  scopes?: readonly string[];
  [key: string]: unknown;
}

/** Structural contract deliberately kept independent of the Graph implementation. */
export interface CalendarAuthManagerForTools {
  connectAccount(): Promise<CalendarAccount>;
  listAccounts(): Promise<readonly CalendarAccount[]>;
}

/** Structural contract deliberately kept independent of the Graph implementation. */
export interface CalendarGraphClientForTools {
  listCalendars(accountKey: string): Promise<unknown>;
  listEvents(accountKey: string, options: Omit<CalendarListEventsToolArgs, 'account'>): Promise<unknown>;
  createEvent(accountKey: string, event: CalendarEventFields, target?: CalendarEventTarget): Promise<unknown>;
  updateEvent(accountKey: string, eventId: string, event: CalendarEventFields, target?: CalendarEventTarget): Promise<unknown>;
  deleteEvent(accountKey: string, eventId: string, target?: CalendarEventTarget): Promise<unknown>;
}

export type CalendarEventFields = z.infer<typeof EventFieldsSchema>;
export interface CalendarEventTarget { calendarId?: string; }

export interface CalendarToolDependencies {
  authManager?: CalendarAuthManagerForTools | null;
  graphClient?: CalendarGraphClientForTools | null;
  /** Non-secret account-routing policy. Defaults to the Comtech business calendar only. */
  writableAccountEmails?: readonly string[];
}

const EMPTY_INPUT_SCHEMA = {
  type: 'object', properties: {}, required: [], additionalProperties: false,
} satisfies Record<string, unknown>;

const EVENT_FIELDS_INPUT_SCHEMA = {
  subject: { type: 'string', minLength: 1, maxLength: 255 },
  body: {
    type: 'object',
    properties: { contentType: { type: 'string', enum: ['text', 'html'] }, content: { type: 'string', maxLength: 100000 } },
    required: ['contentType', 'content'], additionalProperties: false,
  },
  start: dateTimeInputSchema(),
  end: dateTimeInputSchema(),
  location: {
    type: 'object', properties: { displayName: { type: 'string', maxLength: 512 } },
    required: ['displayName'], additionalProperties: false,
  },
  attendees: {
    type: 'array', maxItems: 100,
    items: {
      type: 'object',
      properties: {
        emailAddress: {
          type: 'object', properties: { address: { type: 'string', format: 'email' }, name: { type: 'string', maxLength: 256 } },
          required: ['address'], additionalProperties: false,
        },
        type: { type: 'string', enum: ['required', 'optional', 'resource'] },
      },
      required: ['emailAddress'], additionalProperties: false,
    },
  },
  recurrence: recurrenceInputSchema(),
  isAllDay: { type: 'boolean' },
};

export const CALENDAR_TOOL_SPECS = {
  graph_calendar_connect: {
    description: 'Open Microsoft sign-in to connect a calendar account. Returns account metadata only; tokens are never exposed.',
    inputSchema: EMPTY_INPUT_SCHEMA,
  },
  graph_calendar_status: {
    description: 'Report connected Microsoft Graph calendar accounts, token status, and granted scopes without exposing token data.',
    inputSchema: EMPTY_INPUT_SCHEMA,
  },
  graph_calendar_list_accounts: {
    description: 'List connected Microsoft Graph calendar accounts. This is read-only and never returns token data.',
    inputSchema: EMPTY_INPUT_SCHEMA,
  },
  graph_calendar_list_calendars: {
    description: 'List calendars available to one connected Microsoft account.',
    inputSchema: objectInputSchema({ account: stringInputSchema(1, 320) }, ['account']),
  },
  graph_calendar_list_events: {
    description: 'List events in a bounded time window for one Microsoft calendar, optionally filtered with an OData filter or searched by subject.',
    inputSchema: objectInputSchema({
      account: stringInputSchema(1, 320), calendarId: stringInputSchema(1, 512),
      start: { type: 'string', format: 'date-time' }, end: { type: 'string', format: 'date-time' },
      top: { type: 'integer', minimum: 1, maximum: 100 }, filter: stringInputSchema(1, 2000),
      search: stringInputSchema(1, 512),
    }, ['account', 'start', 'end']),
  },
  graph_calendar_create_event: {
    description: 'Create an event on an agent-writable Microsoft calendar. The RPC server separately requires operator approval.',
    inputSchema: objectInputSchema({ account: stringInputSchema(1, 320), calendarId: stringInputSchema(1, 512), ...EVENT_FIELDS_INPUT_SCHEMA }, ['account', 'subject', 'start', 'end']),
  },
  graph_calendar_update_event: {
    description: 'Update an event on an agent-writable Microsoft calendar. The RPC server separately requires operator approval.',
    inputSchema: objectInputSchema({ account: stringInputSchema(1, 320), calendarId: stringInputSchema(1, 512), eventId: stringInputSchema(1, 512), ...EVENT_FIELDS_INPUT_SCHEMA }, ['account', 'eventId']),
  },
  graph_calendar_delete_event: {
    description: 'Delete an event from an agent-writable Microsoft calendar. The RPC server separately requires operator approval.',
    inputSchema: objectInputSchema({ account: stringInputSchema(1, 320), calendarId: stringInputSchema(1, 512), eventId: stringInputSchema(1, 512) }, ['account', 'eventId']),
  },
} satisfies Record<string, { description: string; inputSchema: Record<string, unknown> }>;

export function createCalendarToolDefinitions(
  dependencies: CalendarToolDependencies = {},
): McpServerToolDefinition[] {
  return [
    {
      name: 'graph_calendar_connect', ...CALENDAR_TOOL_SPECS.graph_calendar_connect,
      handler: async (args) => {
        CalendarConnectToolArgsSchema.parse(args);
        return withFriendlyReauth(async () => sanitizeCalendarResult(
          await requireAuth(dependencies).connectAccount(),
        ))();
      },
    },
    {
      name: 'graph_calendar_status', ...CALENDAR_TOOL_SPECS.graph_calendar_status,
      handler: async (args) => {
        CalendarStatusToolArgsSchema.parse(args);
        return withFriendlyReauth(async () => ({ accounts: sanitizeCalendarResult(await requireAuth(dependencies).listAccounts()) }))();
      },
    },
    {
      name: 'graph_calendar_list_accounts', ...CALENDAR_TOOL_SPECS.graph_calendar_list_accounts,
      handler: async (args) => {
        CalendarListAccountsToolArgsSchema.parse(args);
        return withFriendlyReauth(async () => sanitizeCalendarResult(await requireAuth(dependencies).listAccounts()))();
      },
    },
    {
      name: 'graph_calendar_list_calendars', ...CALENDAR_TOOL_SPECS.graph_calendar_list_calendars,
      handler: async (args) => withFriendlyReauth(async () => {
        const parsed = CalendarListCalendarsToolArgsSchema.parse(args);
        return sanitizeCalendarResult(await requireGraph(dependencies).listCalendars(
          await resolveAccountKey(dependencies, parsed.account),
        ));
      })(),
    },
    {
      name: 'graph_calendar_list_events', ...CALENDAR_TOOL_SPECS.graph_calendar_list_events,
      handler: async (args) => withFriendlyReauth(async () => {
        const parsed = CalendarListEventsToolArgsSchema.parse(args);
        const { account, ...options } = parsed;
        return sanitizeCalendarResult(await requireGraph(dependencies).listEvents(
          await resolveAccountKey(dependencies, account), options,
        ));
      })(),
    },
    {
      name: 'graph_calendar_create_event', ...CALENDAR_TOOL_SPECS.graph_calendar_create_event,
      handler: async (args) => withFriendlyReauth(async () => {
        const parsed = CalendarCreateEventToolArgsSchema.parse(args);
        const accountKey = await requireWritableAccountKey(dependencies, parsed.account);
        return sanitizeCalendarResult(await requireGraph(dependencies).createEvent(
          accountKey, eventFields(parsed), calendarTarget(parsed.calendarId),
        ));
      })(),
    },
    {
      name: 'graph_calendar_update_event', ...CALENDAR_TOOL_SPECS.graph_calendar_update_event,
      handler: async (args) => withFriendlyReauth(async () => {
        const parsed = CalendarUpdateEventToolArgsSchema.parse(args);
        const accountKey = await requireWritableAccountKey(dependencies, parsed.account);
        return sanitizeCalendarResult(await requireGraph(dependencies).updateEvent(
          accountKey, parsed.eventId, eventFields(parsed), calendarTarget(parsed.calendarId),
        ));
      })(),
    },
    {
      name: 'graph_calendar_delete_event', ...CALENDAR_TOOL_SPECS.graph_calendar_delete_event,
      handler: async (args) => withFriendlyReauth(async () => {
        const parsed = CalendarDeleteEventToolArgsSchema.parse(args);
        const accountKey = await requireWritableAccountKey(dependencies, parsed.account);
        return sanitizeCalendarResult(await requireGraph(dependencies).deleteEvent(
          accountKey, parsed.eventId, calendarTarget(parsed.calendarId),
        ));
      })(),
    },
  ];
}

function eventFields(value: Record<string, unknown>): CalendarEventFields {
  const { subject, body, start, end, location, attendees, recurrence, isAllDay } = value;
  return omitUndefined({ subject, body, start, end, location, attendees, recurrence, isAllDay }) as CalendarEventFields;
}

function validateRecurrenceStart(
  value: {
    start?: { dateTime: string };
    recurrence?: { range: { startDate: string } };
  },
  ctx: z.RefinementCtx,
): void {
  if (!value.recurrence) return;
  if (!value.start) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['start'],
      message: 'start is required when setting recurrence',
    });
    return;
  }
  if (value.recurrence.range.startDate !== value.start.dateTime.slice(0, 10)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['recurrence', 'range', 'startDate'],
      message: 'recurrence startDate must match the event start date',
    });
  }
}

function calendarTarget(calendarId: string | undefined): CalendarEventTarget {
  return calendarId === undefined ? {} : { calendarId };
}

function requireAuth(dependencies: CalendarToolDependencies): CalendarAuthManagerForTools {
  if (!dependencies.authManager) unavailable('GraphAuthManager');
  return dependencies.authManager;
}

function requireGraph(dependencies: CalendarToolDependencies): CalendarGraphClientForTools {
  if (!dependencies.graphClient) unavailable('GraphClient');
  return dependencies.graphClient;
}

function unavailable(dependency: 'GraphAuthManager' | 'GraphClient'): never {
  throw new Error(`calendar tools are unavailable: ${dependency} is not wired in this process`);
}

async function resolveAccountKey(dependencies: CalendarToolDependencies, requested: string): Promise<string> {
  const account = (await requireAuth(dependencies).listAccounts()).find((candidate) =>
    candidate.accountKey === requested || candidate.username.toLowerCase() === requested.toLowerCase(),
  );
  if (!account) throw new Error(`Microsoft calendar account is not connected: ${requested}`);
  return account.accountKey;
}

async function requireWritableAccountKey(dependencies: CalendarToolDependencies, requested: string): Promise<string> {
  const permitted = new Set((dependencies.writableAccountEmails ?? DEFAULT_WRITABLE_ACCOUNT_EMAILS)
    .map((email) => email.trim().toLowerCase()));
  const accounts = await requireAuth(dependencies).listAccounts();
  const account = accounts.find((candidate) =>
    candidate.accountKey === requested || candidate.username.toLowerCase() === requested.toLowerCase(),
  );
  if (!account || !permitted.has(account.username.toLowerCase())) {
    throw new Error(`Calendar mutation is not permitted for agent calendar mutations: ${requested}`);
  }
  return account.accountKey;
}

function withFriendlyReauth<T>(operation: () => Promise<T>): () => Promise<T> {
  return async () => {
    try {
      return await operation();
    } catch (error) {
      if (isReauthRequired(error)) {
        throw new Error('Microsoft Graph authentication has expired. Run graph_calendar_connect to reconnect the account.');
      }
      throw error;
    }
  };
}

function isReauthRequired(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /reauth_required|invalid_grant|interaction_required|login_required/i.test(message);
}

function sanitizeCalendarResult(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeCalendarResult);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([key]) => !isSensitiveCalendarField(key))
    .map(([key, child]) => [key, sanitizeCalendarResult(child)]));
}

function isSensitiveCalendarField(key: string): boolean {
  const normalized = key.replace(/[^a-z]/gi, '').toLowerCase();
  if (normalized === 'tokenstatus' || normalized === 'tokentype') return false;
  return normalized.includes('token')
    || normalized === 'authorization'
    || normalized.includes('secret')
    || normalized.includes('password');
}

function omitUndefined<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as Partial<T>;
}

function stringInputSchema(minLength: number, maxLength: number) {
  return { type: 'string', minLength, maxLength };
}

function objectInputSchema(properties: Record<string, unknown>, required: string[]) {
  return { type: 'object', properties, required, additionalProperties: false };
}

function dateTimeInputSchema() {
  return objectInputSchema({
    dateTime: {
      type: 'string',
      pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,7})?$',
    },
    timeZone: stringInputSchema(1, 128),
  }, ['dateTime', 'timeZone']);
}

function recurrenceInputSchema() {
  return objectInputSchema({
    pattern: objectInputSchema({
      type: { type: 'string', enum: ['daily', 'weekly', 'absoluteMonthly', 'relativeMonthly', 'absoluteYearly', 'relativeYearly'] },
      interval: { type: 'integer', minimum: 1, maximum: 366 }, month: { type: 'integer', minimum: 1, maximum: 12 },
      dayOfMonth: { type: 'integer', minimum: 1, maximum: 31 },
      daysOfWeek: { type: 'array', minItems: 1, maxItems: 7, items: { type: 'string' } },
      firstDayOfWeek: { type: 'string' }, index: { type: 'string', enum: ['first', 'second', 'third', 'fourth', 'last'] },
    }, ['type', 'interval']),
    range: objectInputSchema({
      type: { type: 'string', enum: ['endDate', 'noEnd', 'numbered'] }, startDate: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
      endDate: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' }, numberOfOccurrences: { type: 'integer', minimum: 1, maximum: 10000 },
      recurrenceTimeZone: stringInputSchema(1, 128),
    }, ['type', 'startDate']),
  }, ['pattern', 'range']);
}
