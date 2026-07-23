import { describe, expect, it, vi } from 'vitest';
import {
  CALENDAR_TOOL_SPECS,
  createCalendarToolDefinitions,
  type CalendarAuthManagerForTools,
  type CalendarGraphClientForTools,
} from './orchestrator-calendar-tools';

const BUSINESS_ACCOUNT = 'james@communitytech.co.uk';
const FAMILY_ACCOUNT = 'shutupandshave@hotmail.com';

function toolByName(
  name: string,
  overrides: {
    authManager?: CalendarAuthManagerForTools;
    graphClient?: CalendarGraphClientForTools;
    writableAccountEmails?: readonly string[];
  } = {},
) {
  const authManager = overrides.authManager ?? authStub();
  const graphClient = overrides.graphClient ?? graphStub();
  const tool = createCalendarToolDefinitions({
    authManager,
    graphClient,
    writableAccountEmails: overrides.writableAccountEmails,
  }).find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`Missing tool: ${name}`);
  return { tool, authManager, graphClient };
}

function authStub(): CalendarAuthManagerForTools {
  return {
    connectAccount: vi.fn(async () => ({
      accountKey: 'business-key',
      username: BUSINESS_ACCOUNT,
      tenant: 'communitytech.co.uk',
      tokenStatus: 'valid',
      scopes: ['Calendars.ReadWrite'],
      accessToken: 'must-not-leave-the-main-process',
    })),
    listAccounts: vi.fn(async () => [
      {
        accountKey: 'business-key',
        username: BUSINESS_ACCOUNT,
        tenant: 'communitytech.co.uk',
        tokenStatus: 'valid',
        scopes: ['Calendars.ReadWrite'],
        accessToken: 'must-not-leave-the-main-process',
      },
      {
        accountKey: 'family-key',
        username: FAMILY_ACCOUNT,
        tokenStatus: 'valid',
      },
    ]),
  };
}

function graphStub(): CalendarGraphClientForTools {
  return {
    listCalendars: vi.fn(async () => ({ value: [{ id: 'calendar-1', name: 'Work' }] })),
    listEvents: vi.fn(async () => ({ value: [{ id: 'event-1', subject: 'Planning' }] })),
    createEvent: vi.fn(async () => ({ id: 'event-1', subject: 'Planning' })),
    updateEvent: vi.fn(async () => ({ id: 'event-1', subject: 'Updated planning' })),
    deleteEvent: vi.fn(async () => ({ ok: true })),
  };
}

const eventInput = {
  account: BUSINESS_ACCOUNT,
  calendarId: 'calendar-1',
  subject: 'Spark MI reminder',
  start: { dateTime: '2026-08-01T09:00:00', timeZone: 'Europe/London' },
  end: { dateTime: '2026-08-01T10:00:00', timeZone: 'Europe/London' },
};

describe('orchestrator calendar MCP tools', () => {
  it('exports the eight final names with raw JSON schemas', () => {
    expect(Object.keys(CALENDAR_TOOL_SPECS)).toEqual([
      'graph_calendar_connect',
      'graph_calendar_status',
      'graph_calendar_list_accounts',
      'graph_calendar_list_calendars',
      'graph_calendar_list_events',
      'graph_calendar_create_event',
      'graph_calendar_update_event',
      'graph_calendar_delete_event',
    ]);
    expect(createCalendarToolDefinitions({ authManager: authStub(), graphClient: graphStub() }))
      .toHaveLength(8);
    for (const spec of Object.values(CALENDAR_TOOL_SPECS)) {
      expect(spec.inputSchema).toMatchObject({ type: 'object', additionalProperties: false });
    }
  });

  it('returns account metadata without token payloads when connecting or reporting status', async () => {
    const { tool: connect } = toolByName('graph_calendar_connect');
    const { tool: status } = toolByName('graph_calendar_status');

    const connected = await connect.handler({});
    const current = await status.handler({});

    expect(connected).toMatchObject({ username: BUSINESS_ACCOUNT, tokenStatus: 'valid' });
    expect(current).toMatchObject({
      accounts: expect.arrayContaining([expect.objectContaining({ username: BUSINESS_ACCOUNT })]),
    });
    expect(JSON.stringify({ connected, current })).not.toContain('must-not-leave-the-main-process');
  });

  it('maps reauthentication failures to a friendly connect instruction', async () => {
    const authManager: CalendarAuthManagerForTools = {
      connectAccount: vi.fn(),
      listAccounts: vi.fn(async () => {
        throw new Error('reauth_required');
      }),
    };
    const { tool } = toolByName('graph_calendar_status', { authManager });

    await expect(tool.handler({})).rejects.toThrow(
      'Microsoft Graph authentication has expired. Run graph_calendar_connect to reconnect the account.',
    );
  });

  it('validates calendar read arguments strictly before calling Graph', async () => {
    const { tool, graphClient } = toolByName('graph_calendar_list_events');

    await expect(tool.handler({
      account: BUSINESS_ACCOUNT,
      start: 'not-a-date',
      end: '2026-08-01T10:00:00Z',
      unexpected: true,
    })).rejects.toThrow();
    expect(graphClient.listEvents).not.toHaveBeenCalled();
  });

  it('passes an explicit subject search through to the Graph client', async () => {
    const { tool, graphClient } = toolByName('graph_calendar_list_events');

    await tool.handler({
      account: BUSINESS_ACCOUNT,
      start: '2026-08-01T00:00:00Z',
      end: '2026-09-01T00:00:00Z',
      search: "James's return",
    });

    expect(graphClient.listEvents).toHaveBeenCalledWith('business-key', {
      start: '2026-08-01T00:00:00Z',
      end: '2026-09-01T00:00:00Z',
      search: "James's return",
    });
  });

  it('passes recurrence through on a writable account', async () => {
    const { tool, graphClient } = toolByName('graph_calendar_create_event');
    const recurrence = {
      pattern: { type: 'absoluteMonthly', interval: 1, dayOfMonth: 1 },
      range: { type: 'noEnd', startDate: '2026-08-01', recurrenceTimeZone: 'Europe/London' },
    };

    await tool.handler({ ...eventInput, recurrence });

    expect(graphClient.createEvent).toHaveBeenCalledWith('business-key', {
      subject: 'Spark MI reminder',
      start: eventInput.start,
      end: eventInput.end,
      recurrence,
    }, { calendarId: 'calendar-1' });
  });

  it('rejects Graph-invalid event date-times and recurrence contracts locally', async () => {
    const { tool: create, graphClient } = toolByName('graph_calendar_create_event');
    const { tool: update } = toolByName('graph_calendar_update_event');
    const range = { type: 'noEnd', startDate: '2026-08-01' };

    await expect(create.handler({
      ...eventInput,
      start: { dateTime: '2026-08-01T09:00:00+01:00', timeZone: 'Europe/London' },
    })).rejects.toThrow();
    await expect(create.handler({
      ...eventInput,
      recurrence: { pattern: { type: 'absoluteMonthly', interval: 1 }, range },
    })).rejects.toThrow(/dayOfMonth/);
    await expect(create.handler({
      ...eventInput,
      recurrence: {
        pattern: { type: 'weekly', interval: 1, daysOfWeek: ['friday'] },
        range,
      },
    })).rejects.toThrow(/firstDayOfWeek/);
    await expect(create.handler({
      ...eventInput,
      recurrence: {
        pattern: { type: 'absoluteYearly', interval: 1, dayOfMonth: 1 },
        range,
      },
    })).rejects.toThrow(/month/);
    await expect(create.handler({
      ...eventInput,
      recurrence: {
        pattern: { type: 'daily', interval: 1, dayOfMonth: 1 },
        range,
      },
    })).rejects.toThrow(/not supported/);
    await expect(create.handler({
      ...eventInput,
      recurrence: {
        pattern: { type: 'daily', interval: 1 },
        range: { type: 'noEnd', startDate: '2026-08-02' },
      },
    })).rejects.toThrow(/startDate/);
    await expect(update.handler({
      account: BUSINESS_ACCOUNT,
      eventId: 'event-1',
      recurrence: { pattern: { type: 'daily', interval: 1 }, range },
    })).rejects.toThrow(/start is required/);
    expect(graphClient.createEvent).not.toHaveBeenCalled();
    expect(graphClient.updateEvent).not.toHaveBeenCalled();
  });

  it('refuses calendar mutations outside the injected or default business-account allowlist', async () => {
    const { tool, graphClient } = toolByName('graph_calendar_create_event');

    await expect(tool.handler({ ...eventInput, account: FAMILY_ACCOUNT })).rejects.toThrow(
      /not permitted for agent calendar mutations/,
    );
    expect(graphClient.createEvent).not.toHaveBeenCalled();

    const custom = toolByName('graph_calendar_delete_event', {
      writableAccountEmails: ['other@example.test'],
    });
    await expect(custom.tool.handler({
      account: BUSINESS_ACCOUNT,
      calendarId: 'calendar-1',
      eventId: 'event-1',
    })).rejects.toThrow(/not permitted for agent calendar mutations/);
  });
});
