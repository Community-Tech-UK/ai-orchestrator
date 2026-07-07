import * as crypto from 'crypto';

const PLAY_BASE_URL = 'https://androidpublisher.googleapis.com';
const PLAY_UPLOAD_BASE_URL = 'https://androidpublisher.googleapis.com/upload';
const GOOGLE_TOKEN_URI = 'https://oauth2.googleapis.com/token';
const ACCESS_TOKEN_REFRESH_SKEW_MS = 60_000;

export const ANDROID_PUBLISHER_SCOPE = 'https://www.googleapis.com/auth/androidpublisher';

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;
type FetchBody = NonNullable<RequestInit['body']>;
type PlayRequestBody = FetchBody | Uint8Array;

export interface GoogleServiceAccountCredentials {
  clientEmail: string;
  privateKeyId: string;
  privateKey: string;
  tokenUri?: string;
}

export interface GoogleServiceAccountAssertionInput {
  serviceAccount: GoogleServiceAccountCredentials;
  scope: string;
  nowSeconds?: number;
}

export interface GoogleServiceAccountTokenProviderOptions {
  serviceAccount: GoogleServiceAccountCredentials;
  scope?: string;
  fetch?: FetchLike;
  now?: () => number;
}

export interface PlayAccessTokenProvider {
  getAccessToken(): Promise<string>;
}

export interface PlayDeveloperClientOptions {
  tokenProvider: PlayAccessTokenProvider;
  fetch?: FetchLike;
  baseUrl?: string;
  uploadBaseUrl?: string;
}

export interface UploadBundleInput {
  packageName: string;
  editId: string;
  aab: Uint8Array | ArrayBuffer | Blob | string;
  contentType?: string;
}

export interface UpdateTrackInput {
  packageName: string;
  editId: string;
  track: string;
  releases: Array<Record<string, unknown>>;
}

export interface CommitEditInput {
  packageName: string;
  editId: string;
  changesInReviewBehavior?: 'CANCEL_IN_REVIEW_AND_SUBMIT' | 'ERROR_IF_IN_REVIEW';
  changesNotSentForReview?: boolean;
}

export function buildGoogleServiceAccountAssertion(
  input: GoogleServiceAccountAssertionInput,
): string {
  const nowSeconds = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const tokenUri = input.serviceAccount.tokenUri ?? GOOGLE_TOKEN_URI;
  const header = base64url(JSON.stringify({
    alg: 'RS256',
    kid: input.serviceAccount.privateKeyId,
    typ: 'JWT',
  }));
  const claims = base64url(JSON.stringify({
    iss: input.serviceAccount.clientEmail,
    scope: input.scope,
    aud: tokenUri,
    iat: nowSeconds,
    exp: nowSeconds + 3_600,
  }));
  const signingInput = `${header}.${claims}`;
  const signature = crypto.sign(
    'RSA-SHA256',
    Buffer.from(signingInput),
    crypto.createPrivateKey(input.serviceAccount.privateKey),
  );
  return `${signingInput}.${base64url(signature)}`;
}

export class GoogleServiceAccountTokenProvider implements PlayAccessTokenProvider {
  private readonly serviceAccount: GoogleServiceAccountCredentials;
  private readonly scope: string;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;
  private cachedToken: { token: string; expiresAt: number } | null = null;

  constructor(options: GoogleServiceAccountTokenProviderOptions) {
    this.serviceAccount = options.serviceAccount;
    this.scope = options.scope ?? ANDROID_PUBLISHER_SCOPE;
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    this.now = options.now ?? Date.now;
  }

  async getAccessToken(): Promise<string> {
    const nowMs = this.now();
    if (this.cachedToken && this.cachedToken.expiresAt - nowMs > ACCESS_TOKEN_REFRESH_SKEW_MS) {
      return this.cachedToken.token;
    }
    const assertion = buildGoogleServiceAccountAssertion({
      serviceAccount: this.serviceAccount,
      scope: this.scope,
      nowSeconds: Math.floor(nowMs / 1000),
    });
    const body = new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    });
    const response = await this.fetchImpl(this.serviceAccount.tokenUri ?? GOOGLE_TOKEN_URI, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    const parsed = await parseJsonResponse<{
      access_token?: string;
      expires_in?: number;
      token_type?: string;
    }>(response, 'google_oauth_token_error', [assertion, this.serviceAccount.privateKey]);
    if (!parsed.access_token) {
      throw new Error('google_oauth_token_error:missing_access_token');
    }
    this.cachedToken = {
      token: parsed.access_token,
      expiresAt: nowMs + Math.max(0, parsed.expires_in ?? 0) * 1000,
    };
    return parsed.access_token;
  }
}

export class PlayDeveloperClient {
  private readonly tokenProvider: PlayAccessTokenProvider;
  private readonly fetchImpl: FetchLike;
  private readonly baseUrl: string;
  private readonly uploadBaseUrl: string;

  constructor(options: PlayDeveloperClientOptions) {
    this.tokenProvider = options.tokenProvider;
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    this.baseUrl = options.baseUrl ?? PLAY_BASE_URL;
    this.uploadBaseUrl = options.uploadBaseUrl ?? PLAY_UPLOAD_BASE_URL;
  }

  createEdit(packageName: string): Promise<unknown> {
    return this.request(
      'POST',
      `${this.apiPath(packageName)}/edits`,
    );
  }

  uploadBundle(input: UploadBundleInput): Promise<unknown> {
    const url = new URL(
      `${this.uploadBaseUrl}${this.apiPath(input.packageName)}/edits/${encodeURIComponent(input.editId)}/bundles`,
    );
    url.searchParams.set('uploadType', 'media');
    return this.request('POST', url.toString(), {
      body: input.aab,
      headers: { 'content-type': input.contentType ?? 'application/octet-stream' },
    });
  }

  updateTrack(input: UpdateTrackInput): Promise<unknown> {
    return this.request(
      'PUT',
      `${this.apiPath(input.packageName)}/edits/${encodeURIComponent(input.editId)}/tracks/${encodeURIComponent(input.track)}`,
      {
        json: {
          track: input.track,
          releases: input.releases,
        },
      },
    );
  }

  commitEdit(input: CommitEditInput): Promise<unknown> {
    const url = new URL(
      `${this.baseUrl}${this.apiPath(input.packageName)}/edits/${encodeURIComponent(input.editId)}:commit`,
    );
    if (input.changesInReviewBehavior) {
      url.searchParams.set('changesInReviewBehavior', input.changesInReviewBehavior);
    }
    if (input.changesNotSentForReview !== undefined) {
      url.searchParams.set('changesNotSentForReview', String(input.changesNotSentForReview));
    }
    return this.request('POST', url.toString());
  }

  private async request(
    method: string,
    pathOrUrl: string,
    options: { json?: unknown; body?: PlayRequestBody; headers?: Record<string, string> } = {},
  ): Promise<unknown> {
    const token = await this.tokenProvider.getAccessToken();
    const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${this.baseUrl}${pathOrUrl}`;
    const headers = {
      accept: 'application/json',
      authorization: `Bearer ${token}`,
      ...(options.json === undefined ? {} : { 'content-type': 'application/json' }),
      ...(options.headers ?? {}),
    };
    const response = await this.fetchImpl(url, {
      method,
      headers,
      ...(options.json === undefined ? {} : { body: JSON.stringify(options.json) }),
      ...(options.body === undefined ? {} : { body: toFetchBody(options.body) }),
    });
    return parseJsonResponse(response, 'play_developer_api_error', [token]);
  }

  private apiPath(packageName: string): string {
    return `/androidpublisher/v3/applications/${encodeURIComponent(packageName)}`;
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
  throw new Error(`${errorPrefix}:${response.status}:${redactSecrets(summarizeApiError(parsed, text), redactions)}`);
}

function summarizeApiError(parsed: unknown, fallback: string): string {
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const record = parsed as Record<string, unknown>;
    const error = record['error'];
    if (error && typeof error === 'object' && !Array.isArray(error)) {
      const message = (error as Record<string, unknown>)['message'];
      if (typeof message === 'string') {
        return message;
      }
    }
    const errorDescription = record['error_description'];
    if (typeof errorDescription === 'string') {
      return errorDescription;
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

function toFetchBody(body: PlayRequestBody): FetchBody {
  if (body instanceof Uint8Array) {
    return body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as FetchBody;
  }
  return body;
}

function base64url(input: Buffer | string): string {
  const buffer = typeof input === 'string' ? Buffer.from(input, 'utf-8') : input;
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
