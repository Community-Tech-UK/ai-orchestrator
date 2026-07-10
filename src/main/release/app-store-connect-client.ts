import * as crypto from 'crypto';

const ASC_BASE_URL = 'https://api.appstoreconnect.apple.com';
const ASC_AUDIENCE = 'appstoreconnect-v1';
const ASC_MAX_TOKEN_TTL_SECONDS = 20 * 60;
const ASC_UPLOAD_TIMEOUT_MS = 60_000;
const ASC_MAX_UPLOAD_TIMEOUT_MS = 120_000;

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface AppStoreConnectJwtInput {
  keyId: string;
  issuerId: string;
  privateKey: string;
  nowSeconds?: number;
  ttlSeconds?: number;
  scope?: string[];
}

export interface AppStoreConnectClientOptions {
  keyId: string;
  issuerId: string;
  privateKey: string;
  baseUrl?: string;
  fetch?: FetchLike;
  nowSeconds?: () => number;
}

export interface AppStoreConnectRequestOptions {
  method?: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  scope?: string[];
}

export interface AppStoreConnectAssetUploadInput {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: Uint8Array | ArrayBuffer | Blob | string;
  timeoutMs?: number;
}

export function buildAppStoreConnectJwt(input: AppStoreConnectJwtInput): string {
  const nowSeconds = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const ttlSeconds = Math.min(
    input.ttlSeconds ?? ASC_MAX_TOKEN_TTL_SECONDS,
    ASC_MAX_TOKEN_TTL_SECONDS,
  );
  const header = base64url(JSON.stringify({
    alg: 'ES256',
    kid: input.keyId,
    typ: 'JWT',
  }));
  const claims = base64url(JSON.stringify({
    iss: input.issuerId,
    iat: nowSeconds,
    exp: nowSeconds + ttlSeconds,
    aud: ASC_AUDIENCE,
    ...(input.scope && input.scope.length > 0 ? { scope: input.scope } : {}),
  }));
  const signingInput = `${header}.${claims}`;
  const signature = crypto.sign('sha256', Buffer.from(signingInput), {
    key: crypto.createPrivateKey(input.privateKey),
    dsaEncoding: 'ieee-p1363',
  });
  return `${signingInput}.${base64url(signature)}`;
}

export class AppStoreConnectClient {
  private readonly keyId: string;
  private readonly issuerId: string;
  private readonly privateKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly nowSeconds: () => number;

  constructor(options: AppStoreConnectClientOptions) {
    this.keyId = options.keyId;
    this.issuerId = options.issuerId;
    this.privateKey = options.privateKey;
    this.baseUrl = options.baseUrl ?? ASC_BASE_URL;
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    this.nowSeconds = options.nowSeconds ?? (() => Math.floor(Date.now() / 1000));
  }

  async request<T = unknown>(
    path: string,
    options: AppStoreConnectRequestOptions = {},
  ): Promise<T> {
    const method = options.method ?? 'GET';
    const url = new URL(path, this.baseUrl);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }
    const token = buildAppStoreConnectJwt({
      keyId: this.keyId,
      issuerId: this.issuerId,
      privateKey: this.privateKey,
      nowSeconds: this.nowSeconds(),
      scope: options.scope,
    });
    const response = await this.fetchImpl(url.toString(), {
      method,
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${token}`,
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
    return parseJsonResponse<T>(
      response,
      'app_store_connect_api_error',
      [token, this.privateKey],
    );
  }

  async uploadAssetPart(input: AppStoreConnectAssetUploadInput): Promise<void> {
    const url = parseUploadUrl(input.url);
    const timeoutMs = Math.min(
      Math.max(input.timeoutMs ?? ASC_UPLOAD_TIMEOUT_MS, 1),
      ASC_MAX_UPLOAD_TIMEOUT_MS,
    );
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), timeoutMs);
    try {
      const response = await this.fetchImpl(url.toString(), {
        method: input.method,
        redirect: 'error',
        headers: { ...input.headers },
        body: input.body as RequestInit['body'],
        signal: abortController.signal,
      });
      if (!response.ok) {
        const text = await response.text();
        const summary = summarizeApiError(parseJson(text), text);
        throw new Error(
          `app_store_connect_upload_error:${response.status}:${redactUploadError(summary, url)}`,
        );
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('app_store_connect_upload_error:')) {
        throw error;
      }
      const reason = abortController.signal.aborted
        ? 'timeout'
        : redactUploadError(error instanceof Error ? error.message : String(error), url);
      throw new Error(`app_store_connect_upload_error:network:${reason}`);
    } finally {
      clearTimeout(timeout);
    }
  }
}

async function parseJsonResponse<T>(
  response: Response,
  errorPrefix: string,
  redactions: string[],
): Promise<T> {
  const text = await response.text();
  const parsed = parseJson(text);
  if (response.ok) {
    return parsed as T;
  }
  const summary = summarizeApiError(parsed, text);
  throw new Error(`${errorPrefix}:${response.status}:${redactSecrets(summary, redactions)}`);
}

function summarizeApiError(parsed: unknown, fallback: string): string {
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const record = parsed as Record<string, unknown>;
    const errors = record['errors'];
    if (Array.isArray(errors)) {
      const details = errors
        .map((error) => typeof error === 'object' && error
          ? String((error as Record<string, unknown>)['detail'] ?? '')
          : '')
        .filter(Boolean);
      if (details.length > 0) {
        return details.join('; ');
      }
    }
    const error = record['error'];
    if (error && typeof error === 'object' && !Array.isArray(error)) {
      const message = (error as Record<string, unknown>)['message'];
      if (typeof message === 'string') {
        return message;
      }
    }
  }
  return fallback.slice(0, 500);
}

function parseJson(text: string): unknown {
  if (!text) {
    return {};
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function redactSecrets(value: string, secrets: string[]): string {
  let redacted = value
    .replace(/\beyJ[^\s"']*/g, '[REDACTED-JWT]')
    .replace(/\bya29\.[^\s"']+/g, '[REDACTED-OAUTH-TOKEN]');
  for (const secret of secrets) {
    if (secret) {
      redacted = redacted.split(secret).join('[REDACTED]');
    }
  }
  return redacted;
}

function parseUploadUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('app_store_connect_upload_url_invalid:malformed');
  }
  if (url.protocol !== 'https:') {
    throw new Error('app_store_connect_upload_url_invalid:https_required');
  }
  return url;
}

function redactUploadError(value: string, url: URL): string {
  const querySecrets = [...url.searchParams.values()];
  const redacted = redactSecrets(value, [url.toString(), ...querySecrets]);
  return redacted.replace(/\?[^\s"']*/g, '?[REDACTED]');
}

function base64url(input: Buffer | string): string {
  const buffer = typeof input === 'string' ? Buffer.from(input, 'utf-8') : input;
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
