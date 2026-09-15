/**
 * Short-lived Codex app-server probe for one account-pool profile (decision D7).
 *
 * Spawns `codex -c cli_auth_credentials_store=file app-server` with
 * `CODEX_HOME=<profile home>`, reads `account/read` (identity) and
 * `account/rateLimits/read` (windows), and closes. Harness never handles a
 * token: the CLI reads its own `auth.json`. Raw responses are parsed
 * field-by-field and never logged. One probe per home at a time; a concurrent
 * request shares the in-flight result.
 */

import type { ProviderQuotaSnapshot } from '../../../shared/types/provider-quota.types';
import { CODEX_STRIPPED_AUTH_ENV_VARS } from '../../cli/adapters/adapter-spawn-helpers';
import { CODEX_FILE_CREDENTIAL_STORE_OVERRIDE } from '../../cli/adapters/account-pool/account-adapter-guards';
import {
  codexQuotaSnapshot,
  parseCodexAccountRateLimitsRead,
  parseCodexAccountRead,
  type CodexRateLimitSnapshot,
} from '../../cli/adapters/codex/account-rate-limits';
import { getSafeEnvForTrustedProcess } from '../../security/env-filter';
import { getLogger } from '../../logging/logger';

const logger = getLogger('CodexAccountProbe');

export const CODEX_ACCOUNT_PROBE_TIMEOUT_MS = 10_000;

export interface CodexAccountProbeResult {
  identity: { email: string | null; planType: string | null; accountId: string | null };
  rateLimits: CodexRateLimitSnapshot | null;
  ordinaryUsageAllowed: boolean | null;
}

/** Minimal client surface the probe needs; the real app-server client satisfies it. */
export interface CodexProbeClient {
  request(method: 'account/read', params: { refreshToken?: boolean }, timeoutMs?: number): Promise<unknown>;
  request(method: 'account/rateLimits/read', params: undefined, timeoutMs?: number): Promise<unknown>;
  close(): Promise<void>;
}

export type CodexProbeConnector = (home: string, env: NodeJS.ProcessEnv) => Promise<CodexProbeClient>;

const defaultConnector: CodexProbeConnector = async (home, env) => {
  const { connectToAppServer } = await import('../../cli/adapters/codex/app-server-client');
  return connectToAppServer(home, {
    env,
    disableBroker: true,
    configOverrides: [CODEX_FILE_CREDENTIAL_STORE_OVERRIDE],
  }) as unknown as CodexProbeClient;
};

const inFlight = new Map<string, Promise<CodexAccountProbeResult>>();

export function buildCodexProbeEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...getSafeEnvForTrustedProcess() };
  for (const key of CODEX_STRIPPED_AUTH_ENV_VARS) delete env[key];
  env['CODEX_HOME'] = home;
  return env;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Codex account probe timed out after ${timeoutMs}ms`)), timeoutMs);
      timer.unref?.();
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export async function probeCodexAccount(
  home: string,
  options: { connector?: CodexProbeConnector; timeoutMs?: number } = {},
): Promise<CodexAccountProbeResult> {
  const pending = inFlight.get(home);
  if (pending) return pending;
  const run = runProbe(home, options).finally(() => inFlight.delete(home));
  inFlight.set(home, run);
  return run;
}

async function runProbe(
  home: string,
  options: { connector?: CodexProbeConnector; timeoutMs?: number },
): Promise<CodexAccountProbeResult> {
  const timeoutMs = options.timeoutMs ?? CODEX_ACCOUNT_PROBE_TIMEOUT_MS;
  const connector = options.connector ?? defaultConnector;
  let client: CodexProbeClient | null = null;
  let connecting: Promise<CodexProbeClient> | null = null;
  try {
    return await withTimeout((async () => {
      connecting = connector(home, buildCodexProbeEnv(home));
      client = await connecting;
      const account = parseCodexAccountRead(await client.request('account/read', { refreshToken: false }, timeoutMs));
      const limits = parseCodexAccountRateLimitsRead(await client.request('account/rateLimits/read', undefined, timeoutMs));
      return {
        identity: {
          email: account.email,
          planType: account.planType ?? limits.rateLimits?.planType ?? null,
          accountId: limits.accountId,
        },
        rateLimits: limits.rateLimits,
        ordinaryUsageAllowed: limits.ordinaryUsageAllowed,
      };
    })(), timeoutMs);
  } catch (error) {
    // Message only: an app-server stderr excerpt could echo config, never a token,
    // but keep the log bounded anyway.
    logger.warn('Codex account probe failed', {
      error: (error instanceof Error ? error.message : String(error)).split('\n')[0]?.slice(0, 200),
    });
    throw error;
  } finally {
    if (client) {
      await (client as CodexProbeClient).close().catch(() => undefined);
    } else if (connecting) {
      // Timed out while still connecting: close the app-server whenever it does come up,
      // so a slow spawn never leaves an orphaned process holding the profile home.
      void (connecting as Promise<CodexProbeClient>).then((late) => late.close()).catch(() => undefined);
    }
  }
}

/** Quota snapshot from a probe result, for the per-profile quota service entry. */
export function codexProbeQuotaSnapshot(result: CodexAccountProbeResult): Omit<ProviderQuotaSnapshot, 'takenAt' | 'source'> | null {
  if (!result.rateLimits) return null;
  return codexQuotaSnapshot(result.rateLimits);
}
