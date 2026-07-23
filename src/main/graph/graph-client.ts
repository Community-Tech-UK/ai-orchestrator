const GRAPH_BASE_URL = 'https://graph.microsoft.com/v1.0';
const GRAPH_TIME_ZONE_PREFERENCE = 'outlook.timezone="Europe/London"';
const GRAPH_MAX_RETRY_ATTEMPTS = 3;
const GRAPH_RETRY_BACKOFF_BASE_MS = 1_000;

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;
type GraphRecord = Record<string, unknown>;

export interface GraphAccessTokenProvider {
  getAccessToken(accountKey: string): Promise<string>;
}

export interface GraphClientOptions {
  tokenProvider: GraphAccessTokenProvider;
  fetch?: FetchLike;
  baseUrl?: string;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
}

export interface GraphListEventsInput {
  calendarId?: string;
  start: string;
  end: string;
  top?: number;
  filter?: string;
  /** Case-sensitive subject search translated to an escaped OData contains filter. */
  search?: string;
}

export interface GraphEventTarget {
  calendarId?: string;
}

interface GraphCollectionResponse {
  value?: unknown;
  '@odata.nextLink'?: unknown;
}

export class GraphClient {
  private readonly tokenProvider: GraphAccessTokenProvider;
  private readonly fetchImpl: FetchLike;
  private readonly baseUrl: string;
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;

  constructor(options: GraphClientOptions) {
    this.tokenProvider = options.tokenProvider;
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    this.baseUrl = (options.baseUrl ?? GRAPH_BASE_URL).replace(/\/$/, '');
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? defaultSleep;
  }

  async listCalendars(accountKey: string): Promise<GraphRecord[]> {
    return this.listCollection(accountKey, '/me/calendars');
  }

  async listEvents(accountKey: string, input: GraphListEventsInput): Promise<GraphRecord[]> {
    const url = new URL(`${this.baseUrl}${this.pathForCalendar(input.calendarId, 'calendarView')}`);
    url.searchParams.set('startDateTime', input.start);
    url.searchParams.set('endDateTime', input.end);
    if (input.top !== undefined) {
      url.searchParams.set('$top', String(input.top));
    }
    const filters: string[] = [];
    if (input.filter) {
      filters.push(input.search ? `(${input.filter})` : input.filter);
    }
    if (input.search) {
      filters.push(`contains(subject,'${escapeODataString(input.search)}')`);
    }
    if (filters.length > 0) {
      url.searchParams.set('$filter', filters.join(' and '));
    }

    return this.listCollection(accountKey, url.toString());
  }

  private async listCollection(accountKey: string, initialUrl: string): Promise<GraphRecord[]> {
    const values: GraphRecord[] = [];
    let nextUrl: string | undefined = initialUrl;
    while (nextUrl) {
      const response: GraphCollectionResponse = await this.request(accountKey, 'GET', nextUrl);
      values.push(...collectionValues(response));
      nextUrl = typeof response['@odata.nextLink'] === 'string'
        ? response['@odata.nextLink']
        : undefined;
    }
    return values;
  }

  getEvent(accountKey: string, eventId: string, target: GraphEventTarget = {}): Promise<GraphRecord> {
    return this.request(accountKey, 'GET', this.pathForCalendar(target.calendarId, `events/${encode(eventId)}`));
  }

  createEvent(accountKey: string, event: GraphRecord, target: GraphEventTarget = {}): Promise<GraphRecord> {
    return this.request(accountKey, 'POST', this.pathForCalendar(target.calendarId, 'events'), {
      // Graph de-duplicates retried client submissions carrying the same
      // transactionId. Calendar RPC calls still send POST exactly once.
      json: { ...event, transactionId: randomUUID() },
    });
  }

  updateEvent(
    accountKey: string,
    eventId: string,
    event: GraphRecord,
    target: GraphEventTarget = {},
  ): Promise<GraphRecord> {
    return this.request(accountKey, 'PATCH', this.pathForCalendar(target.calendarId, `events/${encode(eventId)}`), {
      json: event,
    });
  }

  async deleteEvent(accountKey: string, eventId: string, target: GraphEventTarget = {}): Promise<void> {
    await this.request(accountKey, 'DELETE', this.pathForCalendar(target.calendarId, `events/${encode(eventId)}`));
  }

  private async request<T>(
    accountKey: string,
    method: string,
    pathOrUrl: string,
    options: { json?: unknown } = {},
  ): Promise<T> {
    const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${this.baseUrl}${pathOrUrl}`;
    if (new URL(url).origin !== new URL(this.baseUrl).origin) {
      throw new Error('graph_api_error:invalid_url_origin');
    }
    const token = await this.tokenProvider.getAccessToken(accountKey);
    const headers = {
      accept: 'application/json',
      authorization: `Bearer ${token}`,
      prefer: GRAPH_TIME_ZONE_PREFERENCE,
      ...(options.json === undefined ? {} : { 'content-type': 'application/json' }),
    };

    for (let attempt = 0; attempt < GRAPH_MAX_RETRY_ATTEMPTS; attempt++) {
      const response = await this.fetchImpl(url, {
        method,
        headers,
        ...(options.json === undefined ? {} : { body: JSON.stringify(options.json) }),
      });
      if (
        method === 'GET' &&
        (response.status === 429 || response.status === 503) &&
        attempt < GRAPH_MAX_RETRY_ATTEMPTS - 1
      ) {
        await this.sleep(retryDelay(response.headers.get('retry-after'), attempt, this.now()));
        continue;
      }
      return parseGraphResponse<T>(response, token);
    }

    throw new Error('graph_api_error:retry_exhausted');
  }

  private pathForCalendar(calendarId: string | undefined, suffix: string): string {
    return calendarId
      ? `/me/calendars/${encode(calendarId)}/${suffix}`
      : `/me/${suffix}`;
  }
}

function collectionValues(response: GraphCollectionResponse): GraphRecord[] {
  return Array.isArray(response.value)
    ? response.value.filter(isGraphRecord)
    : [];
}

async function parseGraphResponse<T>(response: Response, token: string): Promise<T> {
  if (response.status === 204) {
    return undefined as T;
  }
  const text = await response.text();
  const parsed = parseJson(text);
  if (response.ok) {
    return parsed as T;
  }
  throw new Error(`graph_api_error:${response.status}:${redactToken(summarizeGraphError(parsed, text), token)}`);
}

function retryDelay(retryAfter: string | null, attempt: number, now: number): number {
  if (retryAfter && /^\d+$/.test(retryAfter)) {
    return Number(retryAfter) * 1_000;
  }
  if (retryAfter) {
    const retryAt = Date.parse(retryAfter);
    if (!Number.isNaN(retryAt)) {
      return Math.max(0, retryAt - now);
    }
  }
  return GRAPH_RETRY_BACKOFF_BASE_MS * 2 ** attempt;
}

function parseJson(text: string): unknown {
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function summarizeGraphError(parsed: unknown, fallback: string): string {
  if (isGraphRecord(parsed) && isGraphRecord(parsed['error'])) {
    const message = parsed['error']['message'];
    if (typeof message === 'string') {
      return message;
    }
  }
  return fallback.slice(0, 500);
}

function redactToken(value: string, token: string): string {
  return value
    .split(token).join('[REDACTED]')
    .replace(/Bearer\s+[^\s"']+/gi, 'Bearer [REDACTED]')
    .replace(/\beyJ[^\s"']*/g, '[REDACTED-JWT]');
}

function isGraphRecord(value: unknown): value is GraphRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function encode(value: string): string {
  return encodeURIComponent(value);
}

function escapeODataString(value: string): string {
  return value.replace(/'/g, "''");
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref?.();
  });
}
import { randomUUID } from 'node:crypto';
