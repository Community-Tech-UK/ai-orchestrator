import { describe, expect, it } from 'vitest';
import { GraphClient, type GraphClientOptions } from './graph-client';

const TEST_ACCOUNT_KEY = 'account-key';
const TEST_TOKEN = 'test-token';

describe('GraphClient', () => {
  it('lists calendars with the delegated token and London timezone preference', async () => {
    const requests: { url: string; init: RequestInit }[] = [];
    const client = createClient({
      fetch: async (url, init) => {
        requests.push({ url: String(url), init: init ?? {} });
        return jsonResponse({ value: [{ id: 'calendar-1', name: 'Work' }] });
      },
    });

    await expect(client.listCalendars(TEST_ACCOUNT_KEY)).resolves.toEqual([
      { id: 'calendar-1', name: 'Work' },
    ]);

    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe('https://graph.microsoft.com/v1.0/me/calendars');
    expect(requests[0].init).toMatchObject({ method: 'GET' });
    expect(requests[0].init.headers).toMatchObject({
      accept: 'application/json',
      authorization: `Bearer ${TEST_TOKEN}`,
      prefer: 'outlook.timezone="Europe/London"',
    });
  });

  it('lists every calendar page from same-origin Graph next links', async () => {
    let attempts = 0;
    const client = createClient({
      fetch: async () => {
        attempts += 1;
        return attempts === 1
          ? jsonResponse({
            value: [{ id: 'calendar-1' }],
            '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/calendars?$skiptoken=next',
          })
          : jsonResponse({ value: [{ id: 'calendar-2' }] });
      },
    });

    await expect(client.listCalendars(TEST_ACCOUNT_KEY)).resolves.toEqual([
      { id: 'calendar-1' },
      { id: 'calendar-2' },
    ]);
    expect(attempts).toBe(2);
  });

  it('lists every calendar-view page using the Graph next link and requested window options', async () => {
    const requests: { url: string; init: RequestInit }[] = [];
    const client = createClient({
      fetch: async (url, init) => {
        requests.push({ url: String(url), init: init ?? {} });
        if (requests.length === 1) {
          return jsonResponse({
            value: [{ id: 'event-1' }],
            '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/calendars/calendar-1/calendarView?$skiptoken=next',
          });
        }
        return jsonResponse({ value: [{ id: 'event-2' }] });
      },
    });

    await expect(client.listEvents(TEST_ACCOUNT_KEY, {
      calendarId: 'calendar-1',
      start: '2026-07-01T00:00:00Z',
      end: '2026-08-01T00:00:00Z',
      top: 25,
      filter: "contains(subject,'Spark')",
      search: "James's return",
    } as never)).resolves.toEqual([{ id: 'event-1' }, { id: 'event-2' }]);

    const firstUrl = new URL(requests[0].url);
    expect(firstUrl.pathname).toBe('/v1.0/me/calendars/calendar-1/calendarView');
    expect(firstUrl.searchParams.get('startDateTime')).toBe('2026-07-01T00:00:00Z');
    expect(firstUrl.searchParams.get('endDateTime')).toBe('2026-08-01T00:00:00Z');
    expect(firstUrl.searchParams.get('$top')).toBe('25');
    expect(firstUrl.searchParams.get('$filter')).toBe(
      "(contains(subject,'Spark')) and contains(subject,'James''s return')",
    );
    expect(requests[1].url).toBe('https://graph.microsoft.com/v1.0/me/calendars/calendar-1/calendarView?$skiptoken=next');
    expect(requests.every((request) =>
      (request.init.headers as Record<string, string>)['authorization'] === `Bearer ${TEST_TOKEN}`,
    )).toBe(true);
  });

  it('gets, creates, updates, and deletes events on the selected calendar', async () => {
    const requests: { url: string; init: RequestInit }[] = [];
    const recurrence = {
      pattern: { type: 'absoluteMonthly', interval: 1, dayOfMonth: 15 },
      range: { type: 'noEnd', startDate: '2026-07-15' },
    };
    const event = {
      subject: 'Spark MI reminder',
      start: { dateTime: '2026-07-15T09:00:00', timeZone: 'Europe/London' },
      end: { dateTime: '2026-07-15T09:30:00', timeZone: 'Europe/London' },
      recurrence,
    };
    const client = createClient({
      fetch: async (url, init) => {
        requests.push({ url: String(url), init: init ?? {} });
        if (init?.method === 'DELETE') return new Response(null, { status: 204 });
        return jsonResponse({ id: 'event-1', ...event });
      },
    });

    await expect(client.getEvent(TEST_ACCOUNT_KEY, 'event-1', { calendarId: 'calendar-1' }))
      .resolves.toMatchObject({ id: 'event-1' });
    await expect(client.createEvent(TEST_ACCOUNT_KEY, event, { calendarId: 'calendar-1' }))
      .resolves.toMatchObject({ recurrence });
    await expect(client.updateEvent(TEST_ACCOUNT_KEY, 'event-1', { recurrence }, { calendarId: 'calendar-1' }))
      .resolves.toMatchObject({ recurrence });
    await expect(client.deleteEvent(TEST_ACCOUNT_KEY, 'event-1', { calendarId: 'calendar-1' }))
      .resolves.toBeUndefined();

    expect(requests.map((request) => [request.init.method, request.url])).toEqual([
      ['GET', 'https://graph.microsoft.com/v1.0/me/calendars/calendar-1/events/event-1'],
      ['POST', 'https://graph.microsoft.com/v1.0/me/calendars/calendar-1/events'],
      ['PATCH', 'https://graph.microsoft.com/v1.0/me/calendars/calendar-1/events/event-1'],
      ['DELETE', 'https://graph.microsoft.com/v1.0/me/calendars/calendar-1/events/event-1'],
    ]);
    expect(JSON.parse(String(requests[1].init.body))).toEqual({
      ...event,
      transactionId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
    expect(requests[2].init.body).toBe(JSON.stringify({ recurrence }));
    expect(requests.slice(1, 3).every((request) =>
      (request.init.headers as Record<string, string>)['content-type'] === 'application/json',
    )).toBe(true);
  });

  it('retries a 429 after its Retry-After delay', async () => {
    const delays: number[] = [];
    let attempts = 0;
    const client = createClient({
      sleep: async (milliseconds) => { delays.push(milliseconds); },
      fetch: async () => {
        attempts += 1;
        return attempts === 1
          ? jsonResponse({ error: { message: 'rate limited' } }, 429, { 'retry-after': '2' })
          : jsonResponse({ value: [{ id: 'calendar-1' }] });
      },
    });

    await expect(client.listCalendars(TEST_ACCOUNT_KEY)).resolves.toEqual([{ id: 'calendar-1' }]);
    expect(attempts).toBe(2);
    expect(delays).toEqual([2_000]);
  });

  it('never retries a mutation after an ambiguous Graph failure', async () => {
    let attempts = 0;
    const client = createClient({
      fetch: async () => {
        attempts += 1;
        return attempts === 1
          ? jsonResponse({ error: { message: 'service unavailable' } }, 503)
          : jsonResponse({ id: 'duplicate-event' });
      },
    });

    await expect(client.createEvent(TEST_ACCOUNT_KEY, {
      subject: 'One approval, one send',
    })).rejects.toThrow('graph_api_error:503');
    expect(attempts).toBe(1);
  });

  it('refuses pagination links outside the configured Graph origin', async () => {
    let attempts = 0;
    const client = createClient({
      fetch: async () => {
        attempts += 1;
        if (attempts > 1) {
          throw new Error('delegated token would leave the configured Graph origin');
        }
        return jsonResponse({
          value: [{ id: 'event-1' }],
          '@odata.nextLink': 'https://untrusted.example.test/steal',
        });
      },
    });

    await expect(client.listEvents(TEST_ACCOUNT_KEY, {
      start: '2026-07-01T00:00:00Z',
      end: '2026-08-01T00:00:00Z',
    })).rejects.toThrow('graph_api_error:invalid_url_origin');
    expect(attempts).toBe(1);
  });

  it('retries a 503 after an HTTP-date Retry-After delay', async () => {
    const delays: number[] = [];
    let attempts = 0;
    const now = Date.parse('2026-07-23T12:00:00Z');
    const client = createClient({
      now: () => now,
      sleep: async (milliseconds) => { delays.push(milliseconds); },
      fetch: async () => {
        attempts += 1;
        return attempts === 1
          ? jsonResponse({ error: { message: 'service unavailable' } }, 503, {
            'retry-after': 'Thu, 23 Jul 2026 12:00:03 GMT',
          })
          : jsonResponse({ value: [{ id: 'calendar-1' }] });
      },
    });

    await expect(client.listCalendars(TEST_ACCOUNT_KEY)).resolves.toEqual([{ id: 'calendar-1' }]);
    expect(attempts).toBe(2);
    expect(delays).toEqual([3_000]);
  });

  it('redacts delegated tokens from Graph API errors', async () => {
    const client = createClient({
      fetch: async () => jsonResponse({
        error: { message: `request denied for ${TEST_TOKEN}` },
      }, 403),
    });

    await expect(client.listCalendars(TEST_ACCOUNT_KEY)).rejects.toThrow('graph_api_error:403');
    await expect(client.listCalendars(TEST_ACCOUNT_KEY)).rejects.not.toThrow(TEST_TOKEN);
  });
});

function createClient(options: Omit<GraphClientOptions, 'tokenProvider'>) {
  return new GraphClient({
    tokenProvider: { getAccessToken: async () => TEST_TOKEN },
    ...options,
  });
}

function jsonResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}
